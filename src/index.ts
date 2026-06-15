#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const photometrySchema = z.object({
  beam_angle_degrees: z.number().positive().optional(),
  field_angle_degrees: z.number().positive().optional(),
  beam_radius: z.number().min(0).optional(),
  luminous_flux: z.number().min(0).optional(),
  color_temperature: z.number().positive().optional(),
}).optional();

const parameterRangeSchema = z.object({
  from: z.number().int().min(0).max(16777215),
  to: z.number().int().min(0).max(16777215),
  function: z.string().min(1),
  label: z.string().optional(),
  wheel: z.string().min(1).optional(),
  wheel_slot: z.number().int().min(1).optional(),
  physical_from: z.number().optional(),
  physical_to: z.number().optional(),
});

const wheelSlotSchema = z.object({
  index: z.number().int().min(1),
  id: z.string().optional(),
  label: z.string().optional(),
  kind: z.string().optional(),
  rgb: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]).optional(),
  cie_xyY: z.tuple([z.number(), z.number(), z.number()]).optional(),
  filter: z.string().optional(),
  media: z.string().optional(),
});

const fixtureProfileSchema = z.object({
  schema: z.literal("bbb.dmx.fixture.profile.v1"),
  key: z.string().min(1),
  manufacturer: z.string(),
  model: z.string(),
  photometry: photometrySchema,
  wheels: z.array(z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    type: z.enum(["color", "gobo", "animation", "prism", "generic"]).optional(),
    slots: z.array(wheelSlotSchema).optional(),
  })).optional(),
  modes: z.record(z.object({
    label: z.string(),
    footprint: z.number().int().min(1),
    channels: z.array(z.object({
      offset: z.number().int().min(1).max(512),
      key: z.string().min(1),
      default: z.number().int().min(0).max(255).optional(),
      label: z.string().optional(),
      hold: z.boolean().optional(),
    })).min(1),
    parameters: z.record(z.object({
      type: z.enum(["u8", "u16", "u24", "enum"]),
      channel: z.string().optional(),
      channels: z.array(z.string()).optional(),
      byte_order: z.enum(["coarsefine", "finecoarse", "coarsemidfine", "finemidcoarse"]).optional(),
      range_degrees: z.number().optional(),
      wheel: z.string().min(1).optional(),
      ranges: z.array(parameterRangeSchema).min(2).optional(),
      default: z.number().int().min(0).optional(),
    })).optional(),
  })).refine((modes) => Object.keys(modes).length > 0, "at least one mode is required"),
});

type FixtureProfile = z.infer<typeof fixtureProfileSchema>;
type FixtureMode = FixtureProfile["modes"][string];
type FixtureChannel = FixtureMode["channels"][number];
type FixtureParameter = NonNullable<FixtureMode["parameters"]>[string];

type PatchFile = {
  schema: "bbb.dmx.patch.v2";
  coordinates: "gdtf";
  profiles: string[];
  fixtures: Array<{
    id: string;
    profile: string;
    mode: string;
    universe: number;
    address: number;
    position?: [number, number, number];
    rotation?: [number, number, number];
  }>;
};

type Warning = { source: string; message: string };
type ConvertedProfile = { profile: FixtureProfile; source: string; suggestedFile: string };
type ConvertResult = { profiles: ConvertedProfile[]; patch: PatchFile | undefined; warnings: Warning[] };

type ConvertOptions = {
  format: string;
  outDir: string;
  fixtureDir: string;
  patch: string | undefined;
  overwrite: boolean;
  pretty: boolean;
  strict: boolean;
  profilePrefix: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if(value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function child(node: unknown, key: string): unknown {
  if(!isObject(node)) return undefined;
  return node[key];
}

function attr(node: unknown, names: string[]): string | undefined {
  if(!isObject(node)) return undefined;
  for(const name of names) {
    const value = node[name];
    if(value !== undefined && value !== null && typeof value !== "object") {
      const text = String(value).trim();
      if(text.length > 0) return text;
    }
  }
  return undefined;
}

function numberAttr(node: unknown, names: string[]): number | undefined {
  const text = attr(node, names);
  if(text === undefined) return undefined;
  return parseDmxValue(text);
}

function floatAttr(node: unknown, names: string[]): number | undefined {
  const text = attr(node, names);
  if(text === undefined) return undefined;
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

function textOf(node: unknown): string | undefined {
  if(typeof node === "string" || typeof node === "number" || typeof node === "boolean") return String(node);
  if(isObject(node)) {
    const text = node["#text"];
    if(typeof text === "string" || typeof text === "number" || typeof text === "boolean") return String(text);
  }
  return undefined;
}

function findNodes(node: unknown, tagName: string): unknown[] {
  const out: unknown[] = [];
  const visit = (value: unknown): void => {
    if(Array.isArray(value)) {
      for(const entry of value) visit(entry);
      return;
    }
    if(!isObject(value)) return;
    for(const [key, childValue] of Object.entries(value)) {
      if(key === tagName) out.push(...asArray(childValue));
      visit(childValue);
    }
  };
  visit(node);
  return out;
}

function firstNode(root: unknown, tagName: string): unknown | undefined {
  return findNodes(root, tagName)[0];
}

function slug(input: string, fallback = "unnamed"): string {
  const value = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  return value.length > 0 ? value : fallback;
}

function sanitizeKey(input: string, fallback = "unnamed"): string {
  return slug(input, fallback).slice(0, 96);
}

function stripExt(name: string): string {
  return path.basename(name).replace(/\.[^.]+$/, "");
}

function parseDmxValue(text: string): number | undefined {
  const trimmed = text.trim();
  if(trimmed.length === 0) return undefined;
  const first = trimmed.split(/[\s,;]+/)[0] ?? trimmed;
  const numerator = first.split("/")[0] ?? first;
  const value = Number(numerator);
  if(!Number.isFinite(value)) return undefined;
  return Math.round(value);
}

function parseOffsetList(text: string | undefined): number[] {
  if(!text) return [];
  const values = text
    .split(/[\s,;]+/)
    .map((part) => parseDmxValue(part))
    .filter((value): value is number => value !== undefined && value > 0 && value <= 512);
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function normalizeAttributeName(raw: string | undefined, fallback: string): string {
  const value = (raw ?? fallback).trim();
  const lower = value.toLowerCase();
  const pairs: Array<[RegExp, string]> = [
    [/^pan$|panrotate|pan rotate|^p\b/, "pan"],
    [/^tilt$|tiltrotate|tilt rotate|^t\b/, "tilt"],
    [/dimmer|intensity|master/, "dimmer"],
    [/shutter|strobe/, "shutter"],
    [/coloradd[_\s-]*r|additive.*red|\bred\b|^r$/, "red"],
    [/coloradd[_\s-]*g|additive.*green|\bgreen\b|^g$/, "green"],
    [/coloradd[_\s-]*b|additive.*blue|\bblue\b|^b$/, "blue"],
    [/white|coloradd[_\s-]*w|^w$/, "white"],
    [/amber|coloradd[_\s-]*a|^a$/, "amber"],
    [/uv|ultraviolet/, "uv"],
    [/cyan/, "cyan"],
    [/magenta/, "magenta"],
    [/yellow/, "yellow"],
    [/zoom/, "zoom"],
    [/focus/, "focus"],
    [/iris/, "iris"],
    [/gobo/, "gobo"],
    [/colorwheel|color wheel|^color$/, "color"],
    [/cto|ctb|ctc|color temperature/, "ctc"],
    [/prism/, "prism"],
    [/frost/, "frost"],
    [/speed/, "speed"],
  ];
  for(const [pattern, key] of pairs) {
    if(pattern.test(lower)) return key;
  }
  return sanitizeKey(value, fallback);
}

function channelSuffix(index: number, total: number): string {
  if(total <= 1) return "";
  if(total === 2) return index === 0 ? ".coarse" : ".fine";
  if(total === 3) return index === 0 ? ".coarse" : index === 1 ? ".middle" : ".fine";
  return `.byte${index + 1}`;
}

function parameterTypeForWidth(width: number): FixtureParameter["type"] {
  if(width >= 3) return "u24";
  if(width === 2) return "u16";
  return "u8";
}

function byteOrderForWidth(width: number): FixtureParameter["byte_order"] | undefined {
  if(width === 2) return "coarsefine";
  if(width === 3) return "coarsemidfine";
  return undefined;
}

function defaultForWidth(width: number, channelDefaults: number[]): number {
  if(width <= 1) return channelDefaults[0] ?? 0;
  if(width === 2) return ((channelDefaults[0] ?? 0) << 8) + (channelDefaults[1] ?? 0);
  if(width >= 3) return ((channelDefaults[0] ?? 0) << 16) + ((channelDefaults[1] ?? 0) << 8) + (channelDefaults[2] ?? 0);
  return 0;
}


function parseDmxValueParts(text: string | undefined): { value: number; bytes: number | undefined } | undefined {
  if(!text) return undefined;
  const first = text.trim().split(/[\s,;]+/)[0];
  if(!first) return undefined;
  const [valueText, bytesText] = first.split("/");
  const value = Number(valueText);
  if(!Number.isFinite(value)) return undefined;
  const parsedBytes = bytesText === undefined ? undefined : Number(bytesText);
  const bytes = parsedBytes !== undefined && Number.isFinite(parsedBytes) && parsedBytes > 0 ? Math.round(parsedBytes) : undefined;
  return { value: Math.round(value), bytes };
}

function domainMaxForWidth(width: number): number {
  const byteWidth = Math.max(1, Math.min(Math.round(width), 3));
  return Math.pow(256, byteWidth) - 1;
}

function dmxValueForWidth(text: string | undefined, width: number): number | undefined {
  const parts = parseDmxValueParts(text);
  if(!parts) return undefined;
  const targetMax = domainMaxForWidth(width);
  const sourceBytes = Math.max(1, Math.min(parts.bytes ?? width, 4));
  const sourceMax = Math.pow(256, sourceBytes) - 1;
  const scaled = sourceBytes === Math.max(1, Math.min(width, 4))
    ? parts.value
    : Math.round((parts.value / sourceMax) * targetMax);
  return Math.max(0, Math.min(targetMax, scaled));
}

function expandDmxBytes(text: string | undefined, width: number): number[] | undefined {
  const parts = parseDmxValueParts(text);
  if(!parts) return undefined;
  const sourceBytes = Math.max(1, Math.min(parts.bytes ?? width, 4));
  const bytes: number[] = [];
  for(let index = sourceBytes - 1; index >= 0; index--) {
    bytes.push((parts.value >> (index * 8)) & 0xff);
  }
  while(bytes.length < width) bytes.push(0);
  return bytes.slice(0, width);
}

function dmxBytesForChannel(channelNode: unknown, functionNode: unknown, width: number): number[] {
  const defaultText = attr(channelNode, ["Default", "default", "DMXDefault", "DefaultValue"])
    ?? attr(functionNode, ["Default", "default", "DMXDefault", "DefaultValue"])
    ?? attr(functionNode, ["DMXFrom", "dmxFrom"]);
  const values = expandDmxBytes(defaultText, width) ?? Array(width).fill(0);
  return values.map((value) => Math.max(0, Math.min(255, value)));
}

function logicalChannelForChannel(channelNode: unknown): unknown | undefined {
  return asArray(child(channelNode, "LogicalChannel"))[0];
}

function channelFunctionsForChannel(channelNode: unknown): unknown[] {
  const logical = logicalChannelForChannel(channelNode);
  const logicalFunctions = logical ? asArray(child(logical, "ChannelFunction")) : [];
  if(logicalFunctions.length > 0) return logicalFunctions;
  const directFunctions = asArray(child(channelNode, "ChannelFunction"));
  return directFunctions;
}

function functionForChannel(channelNode: unknown): unknown {
  const logical = logicalChannelForChannel(channelNode);
  const functions = channelFunctionsForChannel(channelNode);
  return functions[0] ?? logical ?? channelNode;
}

function attributeForChannel(channelNode: unknown): string | undefined {
  const logical = asArray(child(channelNode, "LogicalChannel"))[0];
  const fn = functionForChannel(channelNode);
  return attr(fn, ["Attribute", "attribute", "Name", "name"])
    ?? attr(logical, ["Attribute", "attribute", "Name", "name"])
    ?? attr(channelNode, ["Attribute", "attribute", "Name", "name"]);
}

function physicalRangeDegrees(channelNode: unknown): number | undefined {
  const fn = functionForChannel(channelNode);
  const from = floatAttr(fn, ["PhysicalFrom", "physicalFrom"]);
  const to = floatAttr(fn, ["PhysicalTo", "physicalTo"]);
  if(from === undefined || to === undefined) return undefined;
  const range = Math.abs(to - from);
  return Number.isFinite(range) && range > 0 ? range : undefined;
}

function channelSetsForFunction(functionNode: unknown): unknown[] {
  const direct = asArray(child(functionNode, "ChannelSet"));
  const wrapped = asArray(child(child(functionNode, "ChannelSets"), "ChannelSet"));
  return [...direct, ...wrapped];
}

function nodeName(node: unknown): string | undefined {
  return attr(node, ["Name", "name", "LongName", "longName", "Label", "label"]) ?? textOf(node);
}

function channelFunctionAttribute(functionNode: unknown, fallback: string | undefined): string | undefined {
  return attr(functionNode, ["Attribute", "attribute", "Name", "name"]) ?? fallback;
}

function rangeFunctionSlug(attributeName: string | undefined, label: string | undefined, functionName: string | undefined): string {
  const combined = [attributeName, functionName, label].filter(Boolean).join(" ").toLowerCase();
  const labelLower = (label ?? "").toLowerCase();
  const nameLower = (functionName ?? "").toLowerCase();
  if(/closed|close|blackout|black out|shut/.test(labelLower)) return "closed";
  if(/\bopen\b/.test(labelLower)) return "open";
  if(/random|rnd/.test(combined) && /shutter|strobe/.test(combined)) return "random";
  if(/pulse/.test(combined) && /shutter|strobe/.test(combined)) return "pulse";
  if(/strobe/.test(combined)) return "strobe";
  if(/closed|close|blackout/.test(nameLower)) return "closed";
  if(/\bopen\b/.test(nameLower)) return "open";
  if(/shutter/.test(combined)) return "open";
  return slug(label ?? functionName ?? attributeName ?? "range", "range");
}

function rangePhysical(node: unknown, fallbackNode: unknown): Pick<NonNullable<FixtureParameter["ranges"]>[number], "physical_from" | "physical_to"> {
  const physicalFrom = floatAttr(node, ["PhysicalFrom", "physicalFrom"]) ?? floatAttr(fallbackNode, ["PhysicalFrom", "physicalFrom"]);
  const physicalTo = floatAttr(node, ["PhysicalTo", "physicalTo"]) ?? floatAttr(fallbackNode, ["PhysicalTo", "physicalTo"]);
  const out: Pick<NonNullable<FixtureParameter["ranges"]>[number], "physical_from" | "physical_to"> = {};
  if(physicalFrom !== undefined && Number.isFinite(physicalFrom)) out.physical_from = physicalFrom;
  if(physicalTo !== undefined && Number.isFinite(physicalTo)) out.physical_to = physicalTo;
  return out;
}

type ParameterRangeInfo = {
  ranges: FixtureParameter["ranges"];
  wheel: string | undefined;
};

function wheelNameForFunction(functionNode: unknown): string | undefined {
  const raw = attr(functionNode, ["Wheel", "wheel", "WheelName", "wheelName"]);
  return raw ? sanitizeKey(raw, raw) : undefined;
}

function wheelSlotIndexForNode(node: unknown): number | undefined {
  const value = numberAttr(node, ["WheelSlotIndex", "wheelSlotIndex", "WheelSlot", "wheelSlot", "Slot", "slot"]);
  return value !== undefined && Number.isFinite(value) && 0 < value ? Math.round(value) : undefined;
}

function parameterRangesForChannel(channelNode: unknown, width: number): ParameterRangeInfo | undefined {
  const logical = logicalChannelForChannel(channelNode);
  const logicalAttribute = attr(logical, ["Attribute", "attribute", "Name", "name"]);
  const functionNodes = channelFunctionsForChannel(channelNode);
  if(functionNodes.length === 0) return undefined;

  const functionStarts = functionNodes
    .map((node, index) => ({
      node,
      index,
      from: dmxValueForWidth(attr(node, ["DMXFrom", "dmxFrom", "DmxFrom", "From", "from"]), width) ?? (index === 0 ? 0 : undefined),
    }))
    .filter((entry): entry is { node: unknown; index: number; from: number } => entry.from !== undefined)
    .sort((a, b) => a.from - b.from || a.index - b.index);

  if(functionStarts.length === 0) return undefined;
  const domainMax = domainMaxForWidth(width);
  const ranges: NonNullable<FixtureParameter["ranges"]> = [];
  let wheel: string | undefined;
  let hasSubdivision = false;

  for(let index = 0; index < functionStarts.length; index++) {
    const entry = functionStarts[index]!;
    const next = functionStarts[index + 1];
    const functionFrom = Math.max(0, Math.min(domainMax, entry.from));
    const functionTo = Math.max(functionFrom, Math.min(domainMax, (next?.from ?? (domainMax + 1)) - 1));
    const functionName = nodeName(entry.node);
    const attributeName = channelFunctionAttribute(entry.node, logicalAttribute);
    const functionWheel = wheelNameForFunction(entry.node);
    if(wheel === undefined && functionWheel !== undefined) wheel = functionWheel;
    const setStarts = channelSetsForFunction(entry.node)
      .map((node, setIndex) => ({
        node,
        index: setIndex,
        label: nodeName(node),
        from: dmxValueForWidth(attr(node, ["DMXFrom", "dmxFrom", "DmxFrom", "From", "from"]), width) ?? (setIndex === 0 ? functionFrom : undefined),
      }))
      .filter((set): set is { node: unknown; index: number; label: string | undefined; from: number } => set.from !== undefined)
      .sort((a, b) => a.from - b.from || a.index - b.index);

    if(1 < setStarts.length) {
      hasSubdivision = true;
      for(let setIndex = 0; setIndex < setStarts.length; setIndex++) {
        const setEntry = setStarts[setIndex]!;
        const nextSet = setStarts[setIndex + 1];
        const from = Math.max(functionFrom, Math.min(functionTo, setEntry.from));
        const to = Math.max(from, Math.min(functionTo, (nextSet?.from ?? (functionTo + 1)) - 1));
        const wheelSlot = wheelSlotIndexForNode(setEntry.node);
        ranges.push({
          from,
          to,
          function: rangeFunctionSlug(attributeName, setEntry.label, functionName),
          ...(setEntry.label ? { label: setEntry.label } : {}),
          ...(functionWheel ? { wheel: functionWheel } : {}),
          ...(wheelSlot !== undefined ? { wheel_slot: wheelSlot } : {}),
          ...rangePhysical(setEntry.node, entry.node),
        });
      }
    } else {
      const wheelSlot = wheelSlotIndexForNode(entry.node);
      ranges.push({
        from: functionFrom,
        to: functionTo,
        function: rangeFunctionSlug(attributeName, setStarts[0]?.label, functionName),
        ...(setStarts[0]?.label ?? functionName ? { label: setStarts[0]?.label ?? functionName } : {}),
        ...(functionWheel ? { wheel: functionWheel } : {}),
        ...(wheelSlot !== undefined ? { wheel_slot: wheelSlot } : {}),
        ...rangePhysical(entry.node, entry.node),
      });
    }
  }

  if(functionStarts.length <= 1 && !hasSubdivision) return undefined;
  const normalized = ranges
    .filter((range) => range.from <= range.to)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((range) => ({
      ...range,
      from: Math.max(0, Math.min(domainMax, range.from)),
      to: Math.max(0, Math.min(domainMax, range.to)),
    }));
  return normalized.length >= 2 ? { ranges: normalized, wheel } : undefined;
}

function modeChannels(modeNode: unknown): unknown[] {
  const direct = child(child(modeNode, "DMXChannels"), "DMXChannel");
  const channels = asArray(direct);
  if(channels.length > 0) return channels;
  return findNodes(modeNode, "DMXChannel");
}

function firstFiniteNumber(...values: Array<string | undefined>): number | undefined {
  for(const value of values) {
    if(value === undefined) continue;
    const number = Number(value.replace(",", "."));
    if(Number.isFinite(number)) return number;
  }
  return undefined;
}

function parseColorNumbers(text: string | undefined): number[] | undefined {
  if(text === undefined) return undefined;
  const values = text
    .replace(/[{}]/g, " ")
    .split(/[\s,;]+/)
    .map((part) => Number(part.replace(",", ".")))
    .filter((value) => Number.isFinite(value));
  return values.length >= 3 ? values.slice(0, 3) : undefined;
}

function colorNameToRgb(name: string | undefined): [number, number, number] | undefined {
  const normalized = (name ?? "").toLowerCase();
  if(/\bopen\b|white/.test(normalized)) return [255, 255, 255];
  if(/red/.test(normalized)) return [255, 0, 0];
  if(/green/.test(normalized)) return [0, 255, 0];
  if(/blue/.test(normalized)) return [0, 0, 255];
  if(/cyan/.test(normalized)) return [0, 255, 255];
  if(/magenta|pink/.test(normalized)) return [255, 0, 255];
  if(/yellow/.test(normalized)) return [255, 255, 0];
  if(/amber|orange/.test(normalized)) return [255, 115, 0];
  if(/lime/.test(normalized)) return [115, 255, 0];
  if(/purple|violet|\buv\b/.test(normalized)) return [115, 0, 255];
  return undefined;
}

function wheelTypeFromName(name: string): NonNullable<NonNullable<FixtureProfile["wheels"]>[number]["type"]> {
  const normalized = name.toLowerCase();
  if(/color|colour|cto|ctb|ctc/.test(normalized)) return "color";
  if(/gobo/.test(normalized)) return "gobo";
  if(/anim/.test(normalized)) return "animation";
  if(/prism/.test(normalized)) return "prism";
  return "generic";
}

function fixtureWheelsFromGdtf(fixtureType: unknown): FixtureProfile["wheels"] {
  const wheelNodes = asArray(child(child(fixtureType, "Wheels"), "Wheel"));
  const looseWheelNodes = wheelNodes.length > 0 ? wheelNodes : findNodes(fixtureType, "Wheel");
  const wheels: NonNullable<FixtureProfile["wheels"]> = [];
  for(const [wheelIndex, wheelNode] of looseWheelNodes.entries()) {
    const label = attr(wheelNode, ["Name", "name", "LongName", "longName", "Label", "label"]) ?? `Wheel ${wheelIndex + 1}`;
    const id = sanitizeKey(label, `wheel${wheelIndex + 1}`);
    const slotNodes = [
      ...asArray(child(wheelNode, "Slot")),
      ...asArray(child(child(wheelNode, "Slots"), "Slot")),
    ];
    const slots: NonNullable<NonNullable<FixtureProfile["wheels"]>[number]["slots"]> = [];
    for(const [slotIndex, slotNode] of slotNodes.entries()) {
      const slotLabel = attr(slotNode, ["Name", "name", "LongName", "longName", "Label", "label"]) ?? `Slot ${slotIndex + 1}`;
      const colorValues = parseColorNumbers(attr(slotNode, ["Color", "color", "ColorCIE", "colorCIE", "CIE", "cie"]));
      const rgbValues = parseColorNumbers(attr(slotNode, ["RGB", "rgb", "sRGB", "srgb"]));
      const namedRgb = colorNameToRgb(slotLabel);
      const slot: NonNullable<NonNullable<FixtureProfile["wheels"]>[number]["slots"]>[number] = {
        index: slotIndex + 1,
        id: sanitizeKey(slotLabel, `slot${slotIndex + 1}`),
        label: slotLabel,
        kind: /\bopen\b/i.test(slotLabel) ? "open" : "color",
      };
      if(rgbValues) {
        slot.rgb = [
          Math.max(0, Math.min(255, Math.round(rgbValues[0]!))),
          Math.max(0, Math.min(255, Math.round(rgbValues[1]!))),
          Math.max(0, Math.min(255, Math.round(rgbValues[2]!))),
        ];
      } else if(colorValues) {
        slot.cie_xyY = [colorValues[0]!, colorValues[1]!, colorValues[2]!];
      } else if(namedRgb) {
        slot.rgb = namedRgb;
      }
      const filter = attr(slotNode, ["Filter", "filter"]);
      const media = attr(slotNode, ["MediaFileName", "mediaFileName", "Media", "media"]);
      if(filter) slot.filter = filter;
      if(media) slot.media = media;
      slots.push(slot);
    }
    wheels.push({
      id,
      label,
      type: wheelTypeFromName(label),
      ...(slots.length > 0 ? { slots } : {}),
    });
  }
  return wheels.length > 0 ? wheels : undefined;
}

function photometryFromGdtf(fixtureType: unknown): FixtureProfile["photometry"] {
  const beam = firstNode(fixtureType, "Beam");
  if(!beam) return undefined;
  const photometry: NonNullable<FixtureProfile["photometry"]> = {};
  const beamAngle = firstFiniteNumber(attr(beam, ["BeamAngle", "beamAngle"]));
  const fieldAngle = firstFiniteNumber(attr(beam, ["FieldAngle", "fieldAngle"]));
  const beamRadius = firstFiniteNumber(attr(beam, ["BeamRadius", "beamRadius"]));
  const luminousFlux = firstFiniteNumber(attr(beam, ["LuminousFlux", "luminousFlux"]));
  const colorTemperature = firstFiniteNumber(attr(beam, ["ColorTemperature", "colorTemperature"]));
  if(beamAngle !== undefined && 0 < beamAngle) photometry.beam_angle_degrees = beamAngle;
  if(fieldAngle !== undefined && 0 < fieldAngle) photometry.field_angle_degrees = fieldAngle;
  if(beamRadius !== undefined && 0 <= beamRadius) photometry.beam_radius = beamRadius;
  if(luminousFlux !== undefined && 0 <= luminousFlux) photometry.luminous_flux = luminousFlux;
  if(colorTemperature !== undefined && 0 < colorTemperature) photometry.color_temperature = colorTemperature;
  return Object.keys(photometry).length > 0 ? photometry : undefined;
}

function profileFromGdtfXml(xml: string, source: string, prefix: string): ConvertedProfile {
  const doc = parser.parse(xml) as unknown;
  const fixtureType = firstNode(doc, "FixtureType") ?? doc;
  const manufacturer = attr(fixtureType, ["Manufacturer", "manufacturer", "Company", "Vendor"]) ?? "Unknown";
  const model = attr(fixtureType, ["LongName", "Name", "ShortName", "Model", "model"]) ?? stripExt(source);
  const profileKey = sanitizeKey([prefix, manufacturer, model].filter(Boolean).join("."));
  const dmxModes = asArray(child(child(fixtureType, "DMXModes"), "DMXMode"));
  const looseModes = dmxModes.length > 0 ? dmxModes : findNodes(fixtureType, "DMXMode");

  const modes: FixtureProfile["modes"] = {};
  for(const [modeIndex, modeNode] of looseModes.entries()) {
    const label = attr(modeNode, ["Name", "name", "LongName", "Label"]) ?? `mode_${modeIndex + 1}`;
    const modeKey = sanitizeKey(label, `mode${modeIndex + 1}`);
    const channelNodes = modeChannels(modeNode);
    const channelsByOffset = new Map<number, FixtureChannel>();
    const usedParameterKeys = new Set<string>();
    const parameterChannels = new Map<string, { keys: string[]; defaults: number[]; range: number | undefined; ranges: FixtureParameter["ranges"] | undefined; wheel: string | undefined }>();

    for(const [channelIndex, channelNode] of channelNodes.entries()) {
      const offsets = parseOffsetList(attr(channelNode, ["Offset", "offset", "DMXOffset", "dmxOffset", "Address", "address"]));
      if(offsets.length === 0) continue;
      const attributeName = attributeForChannel(channelNode);
      const baseParamKey = normalizeAttributeName(attributeName, `channel${channelIndex + 1}`);
      const paramKey = uniqueKey(baseParamKey, usedParameterKeys);
      const fn = functionForChannel(channelNode);
      const range = physicalRangeDegrees(channelNode);
      const defaults = dmxBytesForChannel(channelNode, fn, offsets.length);
      const rangeInfo = parameterRangesForChannel(channelNode, offsets.length);
      const keys: string[] = [];

      offsets.forEach((offset, byteIndex) => {
        const key = `${paramKey}${channelSuffix(byteIndex, offsets.length)}`;
        const defaultValue = defaults[byteIndex] ?? 0;
        const labelText = attributeName ?? paramKey;
        const existing = channelsByOffset.get(offset);
        if(!existing) {
          keys.push(key);
          channelsByOffset.set(offset, { offset, key, default: defaultValue, label: labelText });
        }
      });

      if(keys.length > 0) {
        const existing = parameterChannels.get(paramKey);
        if(existing) {
          existing.keys.push(...keys);
          existing.defaults.push(...defaults);
          if(existing.range === undefined && range !== undefined) existing.range = range;
          if(existing.ranges === undefined && rangeInfo?.ranges !== undefined) existing.ranges = rangeInfo.ranges;
          if(existing.wheel === undefined && rangeInfo?.wheel !== undefined) existing.wheel = rangeInfo.wheel;
        } else {
          parameterChannels.set(paramKey, { keys, defaults, range, ranges: rangeInfo?.ranges, wheel: rangeInfo?.wheel });
        }
      }
    }

    const channels = Array.from(channelsByOffset.values()).sort((a, b) => a.offset - b.offset);
    if(channels.length === 0) continue;
    const parameters: NonNullable<FixtureMode["parameters"]> = {};
    for(const [paramKey, info] of parameterChannels) {
      const uniqueKeys = Array.from(new Set(info.keys)).filter((key) => channels.some((channel) => channel.key === key));
      if(uniqueKeys.length === 0) continue;
      const width = Math.min(uniqueKeys.length, 3);
      const parameter: FixtureParameter = {
        type: parameterTypeForWidth(width),
        default: defaultForWidth(width, info.defaults),
      };
      if(width === 1) parameter.channel = uniqueKeys[0];
      else {
        parameter.channels = uniqueKeys.slice(0, width);
        parameter.byte_order = byteOrderForWidth(width);
      }
      if((paramKey === "pan" || paramKey.startsWith("pan_") || paramKey === "tilt" || paramKey.startsWith("tilt_")) && info.range !== undefined) {
        parameter.range_degrees = info.range;
      }
      if(info.wheel !== undefined) {
        parameter.wheel = info.wheel;
      }
      if(info.ranges && info.ranges.length >= 2) {
        parameter.ranges = info.ranges;
      }
      parameters[paramKey] = parameter;
    }
    const explicitFootprint = numberAttr(modeNode, ["DMXFootprint", "Footprint", "footprint"]);
    const footprint = explicitFootprint && explicitFootprint > 0 ? explicitFootprint : Math.max(...channels.map((channel) => channel.offset));
    modes[modeKey] = { label, footprint, channels, parameters };
  }

  if(Object.keys(modes).length === 0) {
    throw new Error(`No DMX modes/channels found in ${source}`);
  }

  const profile: FixtureProfile = {
    schema: "bbb.dmx.fixture.profile.v1",
    key: profileKey,
    manufacturer,
    model,
    modes,
  };
  const photometry = photometryFromGdtf(fixtureType);
  if(photometry) profile.photometry = photometry;
  const wheels = fixtureWheelsFromGdtf(fixtureType);
  if(wheels) profile.wheels = wheels;
  fixtureProfileSchema.parse(profile);
  return { profile, source, suggestedFile: `${profile.key}.json` };
}

async function gdtfXmlFromZip(data: Buffer, source: string): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const description = zip.file(/(^|\/)description\.xml$/i)[0] ?? zip.file(/\.xml$/i)[0];
  if(!description) throw new Error(`No description.xml found in ${source}`);
  return description.async("string");
}

async function convertGdtfFile(file: string, prefix: string): Promise<ConvertResult> {
  const data = await readFile(file);
  const xml = await gdtfXmlFromZip(data, file);
  return { profiles: [profileFromGdtfXml(xml, path.basename(file), prefix)], patch: undefined, warnings: [] };
}

async function convertGdtfXmlFile(file: string, prefix: string): Promise<ConvertResult> {
  const xml = await readFile(file, "utf8");
  return { profiles: [profileFromGdtfXml(xml, path.basename(file), prefix)], patch: undefined, warnings: [] };
}


type Vec3 = [number, number, number];
type MvrTransform = { position: Vec3; rotation: Vec3 };

function uniqueKey(base: string, used: Set<string>): string {
  if(!used.has(base)) {
    used.add(base);
    return base;
  }
  for(let index = 2; ; index++) {
    const candidate = `${base}_${index}`;
    if(!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function uniqueFixtureId(raw: string, fallback: string, used: Set<string>): string {
  const base = sanitizeKey(raw, fallback).replace(/\./g, "_");
  return uniqueKey(base, used);
}

function vectorLength(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalizeVector(vector: Vec3): Vec3 | undefined {
  const length = vectorLength(vector);
  if(!Number.isFinite(length) || length <= 1.0e-9) return undefined;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function radiansToDegrees(radians: number): number {
  const degrees = radians * 180.0 / Math.PI;
  return Math.abs(degrees) < 1.0e-9 ? 0 : degrees;
}

function parseMvrMatrix(node: unknown): MvrTransform | undefined {
  const matrixText = textOf(child(node, "Matrix"));
  if(!matrixText) return undefined;
  const groups = Array.from(matrixText.matchAll(/\{([^{}]+)\}/g)).map((match) => {
    const values = (match[1] ?? "").split(/[,;\s]+/).filter(Boolean).map((value) => Number(value));
    if(values.length < 3 || values.some((value) => !Number.isFinite(value))) return undefined;
    return [values[0], values[1], values[2]] as Vec3;
  });
  if(groups.length < 4 || groups.some((group) => group === undefined)) return undefined;
  const u = normalizeVector(groups[0] as Vec3);
  const v = normalizeVector(groups[1] as Vec3);
  const w = normalizeVector(groups[2] as Vec3);
  const t = groups[3] as Vec3;
  if(!u || !v || !w) return undefined;

  const m00 = u[0];
  const m10 = u[1];
  const m20 = u[2];
  const m21 = v[2];
  const m22 = w[2];
  const vY = v[1];
  const wY = w[1];

  let rx: number;
  let ry: number;
  let rz: number;
  if(Math.abs(m20) < 1.0 - 1.0e-9) {
    ry = Math.asin(-m20);
    rx = Math.atan2(m21, m22);
    rz = Math.atan2(m10, m00);
  } else {
    ry = m20 < 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    rx = Math.atan2(-wY, vY);
    rz = 0;
  }

  return {
    position: [t[0] / 1000.0, t[1] / 1000.0, t[2] / 1000.0],
    rotation: [radiansToDegrees(rx), radiansToDegrees(ry), radiansToDegrees(rz)],
  };
}

function parseAddress(raw: string | undefined, rawUniverse?: string): { universe: number; address: number } | undefined {
  if(!raw) return undefined;
  const universeText = rawUniverse?.trim();
  const universeValue = universeText ? Number(universeText) : undefined;
  const pair = raw.match(/^(\d+)\s*[.:/]\s*(\d+)$/);
  if(pair) {
    return { universe: Number(pair[1]), address: Number(pair[2]) };
  }
  const number = parseDmxValue(raw);
  if(number === undefined || number <= 0) return undefined;
  if(universeValue !== undefined && Number.isFinite(universeValue) && universeValue > 0) {
    return { universe: Math.round(universeValue), address: number };
  }
  if(number > 512) {
    return { universe: Math.floor((number - 1) / 512) + 1, address: ((number - 1) % 512) + 1 };
  }
  return { universe: 1, address: number };
}

function fixturePosition(node: unknown): [number, number, number] | undefined {
  const matrix = parseMvrMatrix(node);
  if(matrix) return matrix.position;
  const x = floatAttr(node, ["X", "x", "PositionX", "PosX"]);
  const y = floatAttr(node, ["Y", "y", "PositionY", "PosY"]);
  const z = floatAttr(node, ["Z", "z", "PositionZ", "PosZ"]);
  if(x !== undefined && y !== undefined && z !== undefined) return [x, y, z];
  const position = child(node, "Position") ?? child(node, "Location");
  const px = floatAttr(position, ["X", "x"]);
  const py = floatAttr(position, ["Y", "y"]);
  const pz = floatAttr(position, ["Z", "z"]);
  if(px !== undefined && py !== undefined && pz !== undefined) return [px, py, pz];
  return undefined;
}

function fixtureRotation(node: unknown): [number, number, number] | undefined {
  const matrix = parseMvrMatrix(node);
  if(matrix) return matrix.rotation;
  const rx = floatAttr(node, ["Rx", "RX", "RotationX", "RotX"]);
  const ry = floatAttr(node, ["Ry", "RY", "RotationY", "RotY"]);
  const rz = floatAttr(node, ["Rz", "RZ", "RotationZ", "RotZ"]);
  if(rx !== undefined && ry !== undefined && rz !== undefined) return [rx, ry, rz];
  const rotation = child(node, "Rotation");
  const x = floatAttr(rotation, ["X", "x", "Rx", "rx"]);
  const y = floatAttr(rotation, ["Y", "y", "Ry", "ry"]);
  const z = floatAttr(rotation, ["Z", "z", "Rz", "rz"]);
  if(x !== undefined && y !== undefined && z !== undefined) return [x, y, z];
  return undefined;
}


function uniquifyProfiles(profiles: ConvertedProfile[]): ConvertedProfile[] {
  const counts = new Map<string, number>();
  return profiles.map((entry) => {
    const base = entry.profile.key;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    if(count === 1) return entry;
    const key = sanitizeKey(`${base}.${sanitizeKey(stripExt(entry.source), String(count))}`);
    return {
      ...entry,
      profile: { ...entry.profile, key },
      suggestedFile: `${key}.json`,
    };
  });
}

function profileKeyFromSpec(spec: string | undefined, profiles: ConvertedProfile[]): string | undefined {
  if(!spec) return profiles[0]?.profile.key;
  const specSlug = sanitizeKey(stripExt(spec));
  const exact = profiles.find((entry) => entry.profile.key === specSlug || entry.profile.key.endsWith(`.${specSlug}`));
  if(exact) return exact.profile.key;
  const byFile = profiles.find((entry) => sanitizeKey(stripExt(entry.source)) === specSlug || entry.profile.key.includes(specSlug));
  return byFile?.profile.key ?? profiles[0]?.profile.key;
}

function defaultMode(profile: FixtureProfile, requested?: string): string {
  const modes = Object.keys(profile.modes);
  if(requested) {
    const requestedKey = sanitizeKey(requested);
    const found = modes.find((mode) => mode === requestedKey || sanitizeKey(profile.modes[mode]?.label ?? mode) === requestedKey);
    if(found) return found;
  }
  return modes[0] ?? "default";
}

function buildPatchFromMvrScene(xml: string, profiles: ConvertedProfile[], warnings: Warning[], source: string): PatchFile | undefined {
  const doc = parser.parse(xml) as unknown;
  const fixtureNodes = findNodes(doc, "Fixture");
  const fixtures: PatchFile["fixtures"] = [];
  const usedFixtureIds = new Set<string>();
  for(const [index, fixture] of fixtureNodes.entries()) {
    const id = attr(fixture, ["FixtureID", "fixtureID", "UnitNumber", "Name", "name", "UUID", "uuid"]) ?? `fixture_${index + 1}`;
    const spec = attr(fixture, ["GDTFSpec", "gdtfSpec", "GdtfSpec", "FixtureTypeId", "FixtureTypeID", "Profile"]);
    const profileKey = profileKeyFromSpec(spec, profiles);
    if(!profileKey) {
      warnings.push({ source, message: `Skipped fixture ${id}: no converted profile available` });
      continue;
    }
    const profile = profiles.find((entry) => entry.profile.key === profileKey)?.profile;
    if(!profile) continue;
    const mode = defaultMode(profile, attr(fixture, ["GDTFMode", "gdtfMode", "Mode", "DMXMode"]));
    const addressNode = asArray(child(child(fixture, "Addresses"), "Address"))[0] ?? asArray(child(fixture, "Address"))[0];
    const universeRaw = attr(fixture, ["Universe", "universe", "DMXUniverse", "DmxUniverse"])
      ?? attr(addressNode, ["Universe", "universe", "DMXUniverse", "DmxUniverse"]);
    const addressRaw = attr(fixture, ["Address", "address", "DMXAddress", "DmxAddress", "StartAddress"])
      ?? attr(addressNode, ["Address", "address", "DMXAddress", "DmxAddress", "StartAddress"])
      ?? textOf(addressNode);
    const parsed = parseAddress(addressRaw, universeRaw);
    if(!parsed) {
      warnings.push({ source, message: `Skipped fixture ${id}: no usable DMX address` });
      continue;
    }
    const entry: PatchFile["fixtures"][number] = {
      id: uniqueFixtureId(id, `fixture_${index + 1}`, usedFixtureIds),
      profile: profileKey,
      mode,
      universe: parsed.universe,
      address: parsed.address,
    };
    const position = fixturePosition(fixture);
    if(position) entry.position = position;
    const rotation = fixtureRotation(fixture);
    if(rotation) entry.rotation = rotation;
    fixtures.push(entry);
  }
  if(fixtures.length === 0) return undefined;
  return {
    schema: "bbb.dmx.patch.v2",
    coordinates: "gdtf",
    profiles: [],
    fixtures,
  };
}

async function convertMvrFile(file: string, prefix: string): Promise<ConvertResult> {
  const data = await readFile(file);
  const zip = await JSZip.loadAsync(data);
  const warnings: Warning[] = [];
  const profiles: ConvertedProfile[] = [];
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  for(const entry of entries.filter((entry) => entry.name.toLowerCase().endsWith(".gdtf"))) {
    try {
      const gdtfData = await entry.async("nodebuffer");
      const xml = await gdtfXmlFromZip(gdtfData, entry.name);
      profiles.push(profileFromGdtfXml(xml, path.basename(entry.name), prefix));
    } catch(error) {
      warnings.push({ source: entry.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const uniqueProfiles = uniquifyProfiles(profiles);
  const sceneEntry = zip.file(/(^|\/)GeneralSceneDescription\.xml$/i)[0]
    ?? zip.file(/scene.*\.xml$/i)[0]
    ?? entries.find((entry) => entry.name.toLowerCase().endsWith(".xml"));
  let patch: PatchFile | undefined;
  if(sceneEntry) {
    const xml = await sceneEntry.async("string");
    patch = buildPatchFromMvrScene(xml, uniqueProfiles, warnings, sceneEntry.name);
  } else {
    warnings.push({ source: file, message: "No MVR scene XML found; converted embedded GDTF profiles only" });
  }
  return { profiles: uniqueProfiles, patch, warnings };
}

async function convertMa3File(file: string, prefix: string): Promise<ConvertResult> {
  const xml = await readFile(file, "utf8");
  try {
    return { profiles: [profileFromGdtfXml(xml, path.basename(file), prefix)], patch: undefined, warnings: [{ source: file, message: "MA3 conversion uses the generic DMXMode/DMXChannel XML subset; verify output manually." }] };
  } catch(error) {
    throw new Error(`MA3 XML conversion failed. Exported MA3 fixture formats vary; provide XML containing DMXMode/DMXChannel-like nodes. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function inferFormat(file: string, requested: string): string {
  if(requested !== "auto") return requested;
  const lower = file.toLowerCase();
  if(lower.endsWith(".gdtf")) return "gdtf";
  if(lower.endsWith(".mvr")) return "mvr";
  if(lower.endsWith(".xml")) return "gdtf-xml";
  throw new Error(`Cannot infer format for ${file}; pass --format gdtf|gdtf-xml|mvr|ma3`);
}

async function convertInput(file: string, options: ConvertOptions): Promise<ConvertResult> {
  const format = inferFormat(file, options.format);
  switch(format) {
    case "gdtf": return convertGdtfFile(file, options.profilePrefix);
    case "gdtf-xml": return convertGdtfXmlFile(file, options.profilePrefix);
    case "mvr": return convertMvrFile(file, options.profilePrefix);
    case "ma3": return convertMa3File(file, options.profilePrefix);
    default: throw new Error(`Unsupported format: ${format}`);
  }
}

async function writeJson(file: string, value: unknown, pretty: boolean, overwrite: boolean): Promise<void> {
  const json = JSON.stringify(value, null, pretty ? 2 : 0) + "\n";
  try {
    if(!overwrite) {
      await writeFile(file, json, { flag: "wx" });
      return;
    }
  } catch(error) {
    if((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite ${file}; pass --overwrite`);
    }
    throw error;
  }
  await writeFile(file, json);
}

function relativeProfilePath(patchFile: string, profileFile: string): string {
  const relative = path.relative(path.dirname(patchFile), profileFile).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function writeResult(result: ConvertResult, options: ConvertOptions): Promise<void> {
  const fixtureDir = path.resolve(options.outDir, options.fixtureDir);
  await mkdir(fixtureDir, { recursive: true });
  const profilePaths = new Map<string, string>();
  for(const entry of result.profiles) {
    const profilePath = path.join(fixtureDir, entry.suggestedFile);
    await writeJson(profilePath, entry.profile, options.pretty, options.overwrite);
    profilePaths.set(entry.profile.key, profilePath);
    console.log(`profile ${entry.profile.key} -> ${profilePath}`);
  }
  if(result.patch && options.patch) {
    const patchPath = path.resolve(options.outDir, options.patch);
    await mkdir(path.dirname(patchPath), { recursive: true });
    const patch: PatchFile = {
      ...result.patch,
      profiles: Array.from(profilePaths.values()).map((profilePath) => relativeProfilePath(patchPath, profilePath)),
    };
    await writeJson(patchPath, patch, options.pretty, options.overwrite);
    console.log(`patch -> ${patchPath}`);
  }
  for(const warning of result.warnings) {
    console.warn(`warning ${warning.source}: ${warning.message}`);
  }
  if(options.strict && result.warnings.length > 0) {
    throw new Error(`${result.warnings.length} warning(s) emitted in --strict mode`);
  }
}

function parseFormat(value: string): string {
  const allowed = new Set(["auto", "gdtf", "gdtf-xml", "mvr", "ma3"]);
  if(!allowed.has(value)) throw new InvalidArgumentError(`expected one of ${Array.from(allowed).join(", ")}`);
  return value;
}

const program = new Command();
program
  .name("bbb-dmx-convert")
  .description("Convert GDTF/MVR/MA3 fixture datasets to bbb.dmx JSON profiles and patches.")
  .version("0.1.0");

program.command("convert")
  .argument("<input>", "input .gdtf, .mvr, GDTF description XML, or compatible MA3 XML")
  .option("-f, --format <format>", "auto|gdtf|gdtf-xml|mvr|ma3", parseFormat, "auto")
  .option("-o, --out-dir <dir>", "output root directory", "converted")
  .option("--fixture-dir <dir>", "fixture profile subdirectory under --out-dir", "fixtures")
  .option("--patch <file>", "write patch JSON for scene formats such as MVR")
  .option("--profile-prefix <prefix>", "prefix added to generated profile keys", "")
  .option("--overwrite", "overwrite existing output files", false)
  .option("--strict", "fail if warnings were emitted", false)
  .option("--no-pretty", "write compact JSON")
  .action(async (input: string, opts: Record<string, unknown>) => {
    const options: ConvertOptions = {
      format: String(opts.format ?? "auto"),
      outDir: String(opts.outDir ?? "converted"),
      fixtureDir: String(opts.fixtureDir ?? "fixtures"),
      patch: opts.patch === undefined ? undefined : String(opts.patch),
      overwrite: Boolean(opts.overwrite),
      pretty: opts.pretty !== false,
      strict: Boolean(opts.strict),
      profilePrefix: String(opts.profilePrefix ?? ""),
    };
    const result = await convertInput(input, options);
    await writeResult(result, options);
  });

program.command("inspect")
  .argument("<input>", "input file")
  .option("-f, --format <format>", "auto|gdtf|gdtf-xml|mvr|ma3", parseFormat, "auto")
  .action(async (input: string, opts: Record<string, unknown>) => {
    const options: ConvertOptions = {
      format: String(opts.format ?? "auto"),
      outDir: ".",
      fixtureDir: ".",
      patch: undefined,
      overwrite: false,
      pretty: true,
      strict: false,
      profilePrefix: "",
    };
    const result = await convertInput(input, options);
    console.log(JSON.stringify({
      profiles: result.profiles.map((entry) => ({ key: entry.profile.key, source: entry.source, modes: Object.keys(entry.profile.modes) })),
      patchFixtures: result.patch?.fixtures.length ?? 0,
      warnings: result.warnings,
    }, null, 2));
  });

function isCliEntrypoint(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if(isCliEntrypoint()) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(`bbb-dmx-convert: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export type { FixtureProfile, FixtureMode, FixtureChannel, FixtureParameter, PatchFile, Warning, ConvertedProfile, ConvertResult, ConvertOptions };
export { convertInput, inferFormat };
