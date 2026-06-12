#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
    physical_from: z.number().optional(),
    physical_to: z.number().optional(),
});
const fixtureProfileSchema = z.object({
    schema: z.literal("bbb.dmx.fixture.profile.v1"),
    key: z.string().min(1),
    manufacturer: z.string(),
    model: z.string(),
    photometry: photometrySchema,
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
            ranges: z.array(parameterRangeSchema).min(2).optional(),
            default: z.number().int().min(0).optional(),
        })).optional(),
    })).refine((modes) => Object.keys(modes).length > 0, "at least one mode is required"),
});
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
function asArray(value) {
    if (value === undefined || value === null)
        return [];
    return Array.isArray(value) ? value : [value];
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function child(node, key) {
    if (!isObject(node))
        return undefined;
    return node[key];
}
function attr(node, names) {
    if (!isObject(node))
        return undefined;
    for (const name of names) {
        const value = node[name];
        if (value !== undefined && value !== null && typeof value !== "object") {
            const text = String(value).trim();
            if (text.length > 0)
                return text;
        }
    }
    return undefined;
}
function numberAttr(node, names) {
    const text = attr(node, names);
    if (text === undefined)
        return undefined;
    return parseDmxValue(text);
}
function floatAttr(node, names) {
    const text = attr(node, names);
    if (text === undefined)
        return undefined;
    const value = Number(text.replace(",", "."));
    return Number.isFinite(value) ? value : undefined;
}
function textOf(node) {
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean")
        return String(node);
    if (isObject(node)) {
        const text = node["#text"];
        if (typeof text === "string" || typeof text === "number" || typeof text === "boolean")
            return String(text);
    }
    return undefined;
}
function findNodes(node, tagName) {
    const out = [];
    const visit = (value) => {
        if (Array.isArray(value)) {
            for (const entry of value)
                visit(entry);
            return;
        }
        if (!isObject(value))
            return;
        for (const [key, childValue] of Object.entries(value)) {
            if (key === tagName)
                out.push(...asArray(childValue));
            visit(childValue);
        }
    };
    visit(node);
    return out;
}
function firstNode(root, tagName) {
    return findNodes(root, tagName)[0];
}
function slug(input, fallback = "unnamed") {
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
function sanitizeKey(input, fallback = "unnamed") {
    return slug(input, fallback).slice(0, 96);
}
function stripExt(name) {
    return path.basename(name).replace(/\.[^.]+$/, "");
}
function parseDmxValue(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return undefined;
    const first = trimmed.split(/[\s,;]+/)[0] ?? trimmed;
    const numerator = first.split("/")[0] ?? first;
    const value = Number(numerator);
    if (!Number.isFinite(value))
        return undefined;
    return Math.round(value);
}
function parseOffsetList(text) {
    if (!text)
        return [];
    const values = text
        .split(/[\s,;]+/)
        .map((part) => parseDmxValue(part))
        .filter((value) => value !== undefined && value > 0 && value <= 512);
    return Array.from(new Set(values)).sort((a, b) => a - b);
}
function normalizeAttributeName(raw, fallback) {
    const value = (raw ?? fallback).trim();
    const lower = value.toLowerCase();
    const pairs = [
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
    for (const [pattern, key] of pairs) {
        if (pattern.test(lower))
            return key;
    }
    return sanitizeKey(value, fallback);
}
function channelSuffix(index, total) {
    if (total <= 1)
        return "";
    if (total === 2)
        return index === 0 ? ".coarse" : ".fine";
    if (total === 3)
        return index === 0 ? ".coarse" : index === 1 ? ".middle" : ".fine";
    return `.byte${index + 1}`;
}
function parameterTypeForWidth(width) {
    if (width >= 3)
        return "u24";
    if (width === 2)
        return "u16";
    return "u8";
}
function byteOrderForWidth(width) {
    if (width === 2)
        return "coarsefine";
    if (width === 3)
        return "coarsemidfine";
    return undefined;
}
function defaultForWidth(width, channelDefaults) {
    if (width <= 1)
        return channelDefaults[0] ?? 0;
    if (width === 2)
        return ((channelDefaults[0] ?? 0) << 8) + (channelDefaults[1] ?? 0);
    if (width >= 3)
        return ((channelDefaults[0] ?? 0) << 16) + ((channelDefaults[1] ?? 0) << 8) + (channelDefaults[2] ?? 0);
    return 0;
}
function parseDmxValueParts(text) {
    if (!text)
        return undefined;
    const first = text.trim().split(/[\s,;]+/)[0];
    if (!first)
        return undefined;
    const [valueText, bytesText] = first.split("/");
    const value = Number(valueText);
    if (!Number.isFinite(value))
        return undefined;
    const parsedBytes = bytesText === undefined ? undefined : Number(bytesText);
    const bytes = parsedBytes !== undefined && Number.isFinite(parsedBytes) && parsedBytes > 0 ? Math.round(parsedBytes) : undefined;
    return { value: Math.round(value), bytes };
}
function domainMaxForWidth(width) {
    const byteWidth = Math.max(1, Math.min(Math.round(width), 3));
    return Math.pow(256, byteWidth) - 1;
}
function dmxValueForWidth(text, width) {
    const parts = parseDmxValueParts(text);
    if (!parts)
        return undefined;
    const targetMax = domainMaxForWidth(width);
    const sourceBytes = Math.max(1, Math.min(parts.bytes ?? width, 4));
    const sourceMax = Math.pow(256, sourceBytes) - 1;
    const scaled = sourceBytes === Math.max(1, Math.min(width, 4))
        ? parts.value
        : Math.round((parts.value / sourceMax) * targetMax);
    return Math.max(0, Math.min(targetMax, scaled));
}
function expandDmxBytes(text, width) {
    const parts = parseDmxValueParts(text);
    if (!parts)
        return undefined;
    const sourceBytes = Math.max(1, Math.min(parts.bytes ?? width, 4));
    const bytes = [];
    for (let index = sourceBytes - 1; index >= 0; index--) {
        bytes.push((parts.value >> (index * 8)) & 0xff);
    }
    while (bytes.length < width)
        bytes.push(0);
    return bytes.slice(0, width);
}
function dmxBytesForChannel(channelNode, functionNode, width) {
    const defaultText = attr(channelNode, ["Default", "default", "DMXDefault", "DefaultValue"])
        ?? attr(functionNode, ["Default", "default", "DMXDefault", "DefaultValue"])
        ?? attr(functionNode, ["DMXFrom", "dmxFrom"]);
    const values = expandDmxBytes(defaultText, width) ?? Array(width).fill(0);
    return values.map((value) => Math.max(0, Math.min(255, value)));
}
function logicalChannelForChannel(channelNode) {
    return asArray(child(channelNode, "LogicalChannel"))[0];
}
function channelFunctionsForChannel(channelNode) {
    const logical = logicalChannelForChannel(channelNode);
    const logicalFunctions = logical ? asArray(child(logical, "ChannelFunction")) : [];
    if (logicalFunctions.length > 0)
        return logicalFunctions;
    const directFunctions = asArray(child(channelNode, "ChannelFunction"));
    return directFunctions;
}
function functionForChannel(channelNode) {
    const logical = logicalChannelForChannel(channelNode);
    const functions = channelFunctionsForChannel(channelNode);
    return functions[0] ?? logical ?? channelNode;
}
function attributeForChannel(channelNode) {
    const logical = asArray(child(channelNode, "LogicalChannel"))[0];
    const fn = functionForChannel(channelNode);
    return attr(fn, ["Attribute", "attribute", "Name", "name"])
        ?? attr(logical, ["Attribute", "attribute", "Name", "name"])
        ?? attr(channelNode, ["Attribute", "attribute", "Name", "name"]);
}
function physicalRangeDegrees(channelNode) {
    const fn = functionForChannel(channelNode);
    const from = floatAttr(fn, ["PhysicalFrom", "physicalFrom"]);
    const to = floatAttr(fn, ["PhysicalTo", "physicalTo"]);
    if (from === undefined || to === undefined)
        return undefined;
    const range = Math.abs(to - from);
    return Number.isFinite(range) && range > 0 ? range : undefined;
}
function channelSetsForFunction(functionNode) {
    const direct = asArray(child(functionNode, "ChannelSet"));
    const wrapped = asArray(child(child(functionNode, "ChannelSets"), "ChannelSet"));
    return [...direct, ...wrapped];
}
function nodeName(node) {
    return attr(node, ["Name", "name", "LongName", "longName", "Label", "label"]) ?? textOf(node);
}
function channelFunctionAttribute(functionNode, fallback) {
    return attr(functionNode, ["Attribute", "attribute", "Name", "name"]) ?? fallback;
}
function rangeFunctionSlug(attributeName, label, functionName) {
    const combined = [attributeName, functionName, label].filter(Boolean).join(" ").toLowerCase();
    const labelLower = (label ?? "").toLowerCase();
    const nameLower = (functionName ?? "").toLowerCase();
    if (/closed|close|blackout|black out|shut/.test(labelLower))
        return "closed";
    if (/\bopen\b/.test(labelLower))
        return "open";
    if (/random|rnd/.test(combined) && /shutter|strobe/.test(combined))
        return "random";
    if (/pulse/.test(combined) && /shutter|strobe/.test(combined))
        return "pulse";
    if (/strobe/.test(combined))
        return "strobe";
    if (/closed|close|blackout/.test(nameLower))
        return "closed";
    if (/\bopen\b/.test(nameLower))
        return "open";
    if (/shutter/.test(combined))
        return "open";
    return slug(label ?? functionName ?? attributeName ?? "range", "range");
}
function rangePhysical(node, fallbackNode) {
    const physicalFrom = floatAttr(node, ["PhysicalFrom", "physicalFrom"]) ?? floatAttr(fallbackNode, ["PhysicalFrom", "physicalFrom"]);
    const physicalTo = floatAttr(node, ["PhysicalTo", "physicalTo"]) ?? floatAttr(fallbackNode, ["PhysicalTo", "physicalTo"]);
    const out = {};
    if (physicalFrom !== undefined && Number.isFinite(physicalFrom))
        out.physical_from = physicalFrom;
    if (physicalTo !== undefined && Number.isFinite(physicalTo))
        out.physical_to = physicalTo;
    return out;
}
function parameterRangesForChannel(channelNode, width) {
    const logical = logicalChannelForChannel(channelNode);
    const logicalAttribute = attr(logical, ["Attribute", "attribute", "Name", "name"]);
    const functionNodes = channelFunctionsForChannel(channelNode);
    if (functionNodes.length === 0)
        return undefined;
    const functionStarts = functionNodes
        .map((node, index) => ({
        node,
        index,
        from: dmxValueForWidth(attr(node, ["DMXFrom", "dmxFrom", "DmxFrom", "From", "from"]), width) ?? (index === 0 ? 0 : undefined),
    }))
        .filter((entry) => entry.from !== undefined)
        .sort((a, b) => a.from - b.from || a.index - b.index);
    if (functionStarts.length === 0)
        return undefined;
    const domainMax = domainMaxForWidth(width);
    const ranges = [];
    let hasSubdivision = false;
    for (let index = 0; index < functionStarts.length; index++) {
        const entry = functionStarts[index];
        const next = functionStarts[index + 1];
        const functionFrom = Math.max(0, Math.min(domainMax, entry.from));
        const functionTo = Math.max(functionFrom, Math.min(domainMax, (next?.from ?? (domainMax + 1)) - 1));
        const functionName = nodeName(entry.node);
        const attributeName = channelFunctionAttribute(entry.node, logicalAttribute);
        const setStarts = channelSetsForFunction(entry.node)
            .map((node, setIndex) => ({
            node,
            index: setIndex,
            label: nodeName(node),
            from: dmxValueForWidth(attr(node, ["DMXFrom", "dmxFrom", "DmxFrom", "From", "from"]), width) ?? (setIndex === 0 ? functionFrom : undefined),
        }))
            .filter((set) => set.from !== undefined)
            .sort((a, b) => a.from - b.from || a.index - b.index);
        if (1 < setStarts.length) {
            hasSubdivision = true;
            for (let setIndex = 0; setIndex < setStarts.length; setIndex++) {
                const setEntry = setStarts[setIndex];
                const nextSet = setStarts[setIndex + 1];
                const from = Math.max(functionFrom, Math.min(functionTo, setEntry.from));
                const to = Math.max(from, Math.min(functionTo, (nextSet?.from ?? (functionTo + 1)) - 1));
                ranges.push({
                    from,
                    to,
                    function: rangeFunctionSlug(attributeName, setEntry.label, functionName),
                    ...(setEntry.label ? { label: setEntry.label } : {}),
                    ...rangePhysical(setEntry.node, entry.node),
                });
            }
        }
        else {
            ranges.push({
                from: functionFrom,
                to: functionTo,
                function: rangeFunctionSlug(attributeName, setStarts[0]?.label, functionName),
                ...(setStarts[0]?.label ?? functionName ? { label: setStarts[0]?.label ?? functionName } : {}),
                ...rangePhysical(entry.node, entry.node),
            });
        }
    }
    if (functionStarts.length <= 1 && !hasSubdivision)
        return undefined;
    const normalized = ranges
        .filter((range) => range.from <= range.to)
        .sort((a, b) => a.from - b.from || a.to - b.to)
        .map((range) => ({
        ...range,
        from: Math.max(0, Math.min(domainMax, range.from)),
        to: Math.max(0, Math.min(domainMax, range.to)),
    }));
    return normalized.length >= 2 ? normalized : undefined;
}
function modeChannels(modeNode) {
    const direct = child(child(modeNode, "DMXChannels"), "DMXChannel");
    const channels = asArray(direct);
    if (channels.length > 0)
        return channels;
    return findNodes(modeNode, "DMXChannel");
}
function firstFiniteNumber(...values) {
    for (const value of values) {
        if (value === undefined)
            continue;
        const number = Number(value.replace(",", "."));
        if (Number.isFinite(number))
            return number;
    }
    return undefined;
}
function photometryFromGdtf(fixtureType) {
    const beam = firstNode(fixtureType, "Beam");
    if (!beam)
        return undefined;
    const photometry = {};
    const beamAngle = firstFiniteNumber(attr(beam, ["BeamAngle", "beamAngle"]));
    const fieldAngle = firstFiniteNumber(attr(beam, ["FieldAngle", "fieldAngle"]));
    const beamRadius = firstFiniteNumber(attr(beam, ["BeamRadius", "beamRadius"]));
    const luminousFlux = firstFiniteNumber(attr(beam, ["LuminousFlux", "luminousFlux"]));
    const colorTemperature = firstFiniteNumber(attr(beam, ["ColorTemperature", "colorTemperature"]));
    if (beamAngle !== undefined && 0 < beamAngle)
        photometry.beam_angle_degrees = beamAngle;
    if (fieldAngle !== undefined && 0 < fieldAngle)
        photometry.field_angle_degrees = fieldAngle;
    if (beamRadius !== undefined && 0 <= beamRadius)
        photometry.beam_radius = beamRadius;
    if (luminousFlux !== undefined && 0 <= luminousFlux)
        photometry.luminous_flux = luminousFlux;
    if (colorTemperature !== undefined && 0 < colorTemperature)
        photometry.color_temperature = colorTemperature;
    return Object.keys(photometry).length > 0 ? photometry : undefined;
}
function profileFromGdtfXml(xml, source, prefix) {
    const doc = parser.parse(xml);
    const fixtureType = firstNode(doc, "FixtureType") ?? doc;
    const manufacturer = attr(fixtureType, ["Manufacturer", "manufacturer", "Company", "Vendor"]) ?? "Unknown";
    const model = attr(fixtureType, ["LongName", "Name", "ShortName", "Model", "model"]) ?? stripExt(source);
    const profileKey = sanitizeKey([prefix, manufacturer, model].filter(Boolean).join("."));
    const dmxModes = asArray(child(child(fixtureType, "DMXModes"), "DMXMode"));
    const looseModes = dmxModes.length > 0 ? dmxModes : findNodes(fixtureType, "DMXMode");
    const modes = {};
    for (const [modeIndex, modeNode] of looseModes.entries()) {
        const label = attr(modeNode, ["Name", "name", "LongName", "Label"]) ?? `mode_${modeIndex + 1}`;
        const modeKey = sanitizeKey(label, `mode${modeIndex + 1}`);
        const channelNodes = modeChannels(modeNode);
        const channelsByOffset = new Map();
        const usedParameterKeys = new Set();
        const parameterChannels = new Map();
        for (const [channelIndex, channelNode] of channelNodes.entries()) {
            const offsets = parseOffsetList(attr(channelNode, ["Offset", "offset", "DMXOffset", "dmxOffset", "Address", "address"]));
            if (offsets.length === 0)
                continue;
            const attributeName = attributeForChannel(channelNode);
            const baseParamKey = normalizeAttributeName(attributeName, `channel${channelIndex + 1}`);
            const paramKey = uniqueKey(baseParamKey, usedParameterKeys);
            const fn = functionForChannel(channelNode);
            const range = physicalRangeDegrees(channelNode);
            const defaults = dmxBytesForChannel(channelNode, fn, offsets.length);
            const ranges = parameterRangesForChannel(channelNode, offsets.length);
            const keys = [];
            offsets.forEach((offset, byteIndex) => {
                const key = `${paramKey}${channelSuffix(byteIndex, offsets.length)}`;
                const defaultValue = defaults[byteIndex] ?? 0;
                const labelText = attributeName ?? paramKey;
                const existing = channelsByOffset.get(offset);
                if (!existing) {
                    keys.push(key);
                    channelsByOffset.set(offset, { offset, key, default: defaultValue, label: labelText });
                }
            });
            if (keys.length > 0) {
                const existing = parameterChannels.get(paramKey);
                if (existing) {
                    existing.keys.push(...keys);
                    existing.defaults.push(...defaults);
                    if (existing.range === undefined && range !== undefined)
                        existing.range = range;
                    if (existing.ranges === undefined && ranges !== undefined)
                        existing.ranges = ranges;
                }
                else {
                    parameterChannels.set(paramKey, { keys, defaults, range, ranges });
                }
            }
        }
        const channels = Array.from(channelsByOffset.values()).sort((a, b) => a.offset - b.offset);
        if (channels.length === 0)
            continue;
        const parameters = {};
        for (const [paramKey, info] of parameterChannels) {
            const uniqueKeys = Array.from(new Set(info.keys)).filter((key) => channels.some((channel) => channel.key === key));
            if (uniqueKeys.length === 0)
                continue;
            const width = Math.min(uniqueKeys.length, 3);
            const parameter = {
                type: parameterTypeForWidth(width),
                default: defaultForWidth(width, info.defaults),
            };
            if (width === 1)
                parameter.channel = uniqueKeys[0];
            else {
                parameter.channels = uniqueKeys.slice(0, width);
                parameter.byte_order = byteOrderForWidth(width);
            }
            if ((paramKey === "pan" || paramKey.startsWith("pan_") || paramKey === "tilt" || paramKey.startsWith("tilt_")) && info.range !== undefined) {
                parameter.range_degrees = info.range;
            }
            if (info.ranges && info.ranges.length >= 2) {
                parameter.ranges = info.ranges;
            }
            parameters[paramKey] = parameter;
        }
        const explicitFootprint = numberAttr(modeNode, ["DMXFootprint", "Footprint", "footprint"]);
        const footprint = explicitFootprint && explicitFootprint > 0 ? explicitFootprint : Math.max(...channels.map((channel) => channel.offset));
        modes[modeKey] = { label, footprint, channels, parameters };
    }
    if (Object.keys(modes).length === 0) {
        throw new Error(`No DMX modes/channels found in ${source}`);
    }
    const profile = {
        schema: "bbb.dmx.fixture.profile.v1",
        key: profileKey,
        manufacturer,
        model,
        modes,
    };
    const photometry = photometryFromGdtf(fixtureType);
    if (photometry)
        profile.photometry = photometry;
    fixtureProfileSchema.parse(profile);
    return { profile, source, suggestedFile: `${profile.key}.json` };
}
async function gdtfXmlFromZip(data, source) {
    const zip = await JSZip.loadAsync(data);
    const description = zip.file(/(^|\/)description\.xml$/i)[0] ?? zip.file(/\.xml$/i)[0];
    if (!description)
        throw new Error(`No description.xml found in ${source}`);
    return description.async("string");
}
async function convertGdtfFile(file, prefix) {
    const data = await readFile(file);
    const xml = await gdtfXmlFromZip(data, file);
    return { profiles: [profileFromGdtfXml(xml, path.basename(file), prefix)], patch: undefined, warnings: [] };
}
async function convertGdtfXmlFile(file, prefix) {
    const xml = await readFile(file, "utf8");
    return { profiles: [profileFromGdtfXml(xml, path.basename(file), prefix)], patch: undefined, warnings: [] };
}
function uniqueKey(base, used) {
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    for (let index = 2;; index++) {
        const candidate = `${base}_${index}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
}
function uniqueFixtureId(raw, fallback, used) {
    const base = sanitizeKey(raw, fallback).replace(/\./g, "_");
    return uniqueKey(base, used);
}
function vectorLength(vector) {
    return Math.hypot(vector[0], vector[1], vector[2]);
}
function normalizeVector(vector) {
    const length = vectorLength(vector);
    if (!Number.isFinite(length) || length <= 1.0e-9)
        return undefined;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
}
function radiansToDegrees(radians) {
    const degrees = radians * 180.0 / Math.PI;
    return Math.abs(degrees) < 1.0e-9 ? 0 : degrees;
}
function parseMvrMatrix(node) {
    const matrixText = textOf(child(node, "Matrix"));
    if (!matrixText)
        return undefined;
    const groups = Array.from(matrixText.matchAll(/\{([^{}]+)\}/g)).map((match) => {
        const values = (match[1] ?? "").split(/[,;\s]+/).filter(Boolean).map((value) => Number(value));
        if (values.length < 3 || values.some((value) => !Number.isFinite(value)))
            return undefined;
        return [values[0], values[1], values[2]];
    });
    if (groups.length < 4 || groups.some((group) => group === undefined))
        return undefined;
    const u = normalizeVector(groups[0]);
    const v = normalizeVector(groups[1]);
    const w = normalizeVector(groups[2]);
    const t = groups[3];
    if (!u || !v || !w)
        return undefined;
    const m00 = u[0];
    const m10 = u[1];
    const m20 = u[2];
    const m21 = v[2];
    const m22 = w[2];
    const vY = v[1];
    const wY = w[1];
    let rx;
    let ry;
    let rz;
    if (Math.abs(m20) < 1.0 - 1.0e-9) {
        ry = Math.asin(-m20);
        rx = Math.atan2(m21, m22);
        rz = Math.atan2(m10, m00);
    }
    else {
        ry = m20 < 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
        rx = Math.atan2(-wY, vY);
        rz = 0;
    }
    return {
        position: [t[0] / 1000.0, t[1] / 1000.0, t[2] / 1000.0],
        rotation: [radiansToDegrees(rx), radiansToDegrees(ry), radiansToDegrees(rz)],
    };
}
function parseAddress(raw, rawUniverse) {
    if (!raw)
        return undefined;
    const universeText = rawUniverse?.trim();
    const universeValue = universeText ? Number(universeText) : undefined;
    const pair = raw.match(/^(\d+)\s*[.:/]\s*(\d+)$/);
    if (pair) {
        return { universe: Number(pair[1]), address: Number(pair[2]) };
    }
    const number = parseDmxValue(raw);
    if (number === undefined || number <= 0)
        return undefined;
    if (universeValue !== undefined && Number.isFinite(universeValue) && universeValue > 0) {
        return { universe: Math.round(universeValue), address: number };
    }
    if (number > 512) {
        return { universe: Math.floor((number - 1) / 512) + 1, address: ((number - 1) % 512) + 1 };
    }
    return { universe: 1, address: number };
}
function fixturePosition(node) {
    const matrix = parseMvrMatrix(node);
    if (matrix)
        return matrix.position;
    const x = floatAttr(node, ["X", "x", "PositionX", "PosX"]);
    const y = floatAttr(node, ["Y", "y", "PositionY", "PosY"]);
    const z = floatAttr(node, ["Z", "z", "PositionZ", "PosZ"]);
    if (x !== undefined && y !== undefined && z !== undefined)
        return [x, y, z];
    const position = child(node, "Position") ?? child(node, "Location");
    const px = floatAttr(position, ["X", "x"]);
    const py = floatAttr(position, ["Y", "y"]);
    const pz = floatAttr(position, ["Z", "z"]);
    if (px !== undefined && py !== undefined && pz !== undefined)
        return [px, py, pz];
    return undefined;
}
function fixtureRotation(node) {
    const matrix = parseMvrMatrix(node);
    if (matrix)
        return matrix.rotation;
    const rx = floatAttr(node, ["Rx", "RX", "RotationX", "RotX"]);
    const ry = floatAttr(node, ["Ry", "RY", "RotationY", "RotY"]);
    const rz = floatAttr(node, ["Rz", "RZ", "RotationZ", "RotZ"]);
    if (rx !== undefined && ry !== undefined && rz !== undefined)
        return [rx, ry, rz];
    const rotation = child(node, "Rotation");
    const x = floatAttr(rotation, ["X", "x", "Rx", "rx"]);
    const y = floatAttr(rotation, ["Y", "y", "Ry", "ry"]);
    const z = floatAttr(rotation, ["Z", "z", "Rz", "rz"]);
    if (x !== undefined && y !== undefined && z !== undefined)
        return [x, y, z];
    return undefined;
}
function uniquifyProfiles(profiles) {
    const counts = new Map();
    return profiles.map((entry) => {
        const base = entry.profile.key;
        const count = (counts.get(base) ?? 0) + 1;
        counts.set(base, count);
        if (count === 1)
            return entry;
        const key = sanitizeKey(`${base}.${sanitizeKey(stripExt(entry.source), String(count))}`);
        return {
            ...entry,
            profile: { ...entry.profile, key },
            suggestedFile: `${key}.json`,
        };
    });
}
function profileKeyFromSpec(spec, profiles) {
    if (!spec)
        return profiles[0]?.profile.key;
    const specSlug = sanitizeKey(stripExt(spec));
    const exact = profiles.find((entry) => entry.profile.key === specSlug || entry.profile.key.endsWith(`.${specSlug}`));
    if (exact)
        return exact.profile.key;
    const byFile = profiles.find((entry) => sanitizeKey(stripExt(entry.source)) === specSlug || entry.profile.key.includes(specSlug));
    return byFile?.profile.key ?? profiles[0]?.profile.key;
}
function defaultMode(profile, requested) {
    const modes = Object.keys(profile.modes);
    if (requested) {
        const requestedKey = sanitizeKey(requested);
        const found = modes.find((mode) => mode === requestedKey || sanitizeKey(profile.modes[mode]?.label ?? mode) === requestedKey);
        if (found)
            return found;
    }
    return modes[0] ?? "default";
}
function buildPatchFromMvrScene(xml, profiles, warnings, source) {
    const doc = parser.parse(xml);
    const fixtureNodes = findNodes(doc, "Fixture");
    const fixtures = [];
    const usedFixtureIds = new Set();
    for (const [index, fixture] of fixtureNodes.entries()) {
        const id = attr(fixture, ["FixtureID", "fixtureID", "UnitNumber", "Name", "name", "UUID", "uuid"]) ?? `fixture_${index + 1}`;
        const spec = attr(fixture, ["GDTFSpec", "gdtfSpec", "GdtfSpec", "FixtureTypeId", "FixtureTypeID", "Profile"]);
        const profileKey = profileKeyFromSpec(spec, profiles);
        if (!profileKey) {
            warnings.push({ source, message: `Skipped fixture ${id}: no converted profile available` });
            continue;
        }
        const profile = profiles.find((entry) => entry.profile.key === profileKey)?.profile;
        if (!profile)
            continue;
        const mode = defaultMode(profile, attr(fixture, ["GDTFMode", "gdtfMode", "Mode", "DMXMode"]));
        const addressNode = asArray(child(child(fixture, "Addresses"), "Address"))[0] ?? asArray(child(fixture, "Address"))[0];
        const universeRaw = attr(fixture, ["Universe", "universe", "DMXUniverse", "DmxUniverse"])
            ?? attr(addressNode, ["Universe", "universe", "DMXUniverse", "DmxUniverse"]);
        const addressRaw = attr(fixture, ["Address", "address", "DMXAddress", "DmxAddress", "StartAddress"])
            ?? attr(addressNode, ["Address", "address", "DMXAddress", "DmxAddress", "StartAddress"])
            ?? textOf(addressNode);
        const parsed = parseAddress(addressRaw, universeRaw);
        if (!parsed) {
            warnings.push({ source, message: `Skipped fixture ${id}: no usable DMX address` });
            continue;
        }
        const entry = {
            id: uniqueFixtureId(id, `fixture_${index + 1}`, usedFixtureIds),
            profile: profileKey,
            mode,
            universe: parsed.universe,
            address: parsed.address,
        };
        const position = fixturePosition(fixture);
        if (position)
            entry.position = position;
        const rotation = fixtureRotation(fixture);
        if (rotation)
            entry.rotation = rotation;
        fixtures.push(entry);
    }
    if (fixtures.length === 0)
        return undefined;
    return {
        schema: "bbb.dmx.patch.v2",
        coordinates: "gdtf",
        profiles: [],
        fixtures,
    };
}
async function convertMvrFile(file, prefix) {
    const data = await readFile(file);
    const zip = await JSZip.loadAsync(data);
    const warnings = [];
    const profiles = [];
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    for (const entry of entries.filter((entry) => entry.name.toLowerCase().endsWith(".gdtf"))) {
        try {
            const gdtfData = await entry.async("nodebuffer");
            const xml = await gdtfXmlFromZip(gdtfData, entry.name);
            profiles.push(profileFromGdtfXml(xml, path.basename(entry.name), prefix));
        }
        catch (error) {
            warnings.push({ source: entry.name, message: error instanceof Error ? error.message : String(error) });
        }
    }
    const uniqueProfiles = uniquifyProfiles(profiles);
    const sceneEntry = zip.file(/(^|\/)GeneralSceneDescription\.xml$/i)[0]
        ?? zip.file(/scene.*\.xml$/i)[0]
        ?? entries.find((entry) => entry.name.toLowerCase().endsWith(".xml"));
    let patch;
    if (sceneEntry) {
        const xml = await sceneEntry.async("string");
        patch = buildPatchFromMvrScene(xml, uniqueProfiles, warnings, sceneEntry.name);
    }
    else {
        warnings.push({ source: file, message: "No MVR scene XML found; converted embedded GDTF profiles only" });
    }
    return { profiles: uniqueProfiles, patch, warnings };
}
async function convertMa3File(file, prefix) {
    const xml = await readFile(file, "utf8");
    try {
        return { profiles: [profileFromGdtfXml(xml, path.basename(file), prefix)], patch: undefined, warnings: [{ source: file, message: "MA3 conversion uses the generic DMXMode/DMXChannel XML subset; verify output manually." }] };
    }
    catch (error) {
        throw new Error(`MA3 XML conversion failed. Exported MA3 fixture formats vary; provide XML containing DMXMode/DMXChannel-like nodes. ${error instanceof Error ? error.message : String(error)}`);
    }
}
function inferFormat(file, requested) {
    if (requested !== "auto")
        return requested;
    const lower = file.toLowerCase();
    if (lower.endsWith(".gdtf"))
        return "gdtf";
    if (lower.endsWith(".mvr"))
        return "mvr";
    if (lower.endsWith(".xml"))
        return "gdtf-xml";
    throw new Error(`Cannot infer format for ${file}; pass --format gdtf|gdtf-xml|mvr|ma3`);
}
async function convertInput(file, options) {
    const format = inferFormat(file, options.format);
    switch (format) {
        case "gdtf": return convertGdtfFile(file, options.profilePrefix);
        case "gdtf-xml": return convertGdtfXmlFile(file, options.profilePrefix);
        case "mvr": return convertMvrFile(file, options.profilePrefix);
        case "ma3": return convertMa3File(file, options.profilePrefix);
        default: throw new Error(`Unsupported format: ${format}`);
    }
}
async function writeJson(file, value, pretty, overwrite) {
    const json = JSON.stringify(value, null, pretty ? 2 : 0) + "\n";
    try {
        if (!overwrite) {
            await writeFile(file, json, { flag: "wx" });
            return;
        }
    }
    catch (error) {
        if (error.code === "EEXIST") {
            throw new Error(`Refusing to overwrite ${file}; pass --overwrite`);
        }
        throw error;
    }
    await writeFile(file, json);
}
function relativeProfilePath(patchFile, profileFile) {
    const relative = path.relative(path.dirname(patchFile), profileFile).replace(/\\/g, "/");
    return relative.startsWith(".") ? relative : `./${relative}`;
}
async function writeResult(result, options) {
    const fixtureDir = path.resolve(options.outDir, options.fixtureDir);
    await mkdir(fixtureDir, { recursive: true });
    const profilePaths = new Map();
    for (const entry of result.profiles) {
        const profilePath = path.join(fixtureDir, entry.suggestedFile);
        await writeJson(profilePath, entry.profile, options.pretty, options.overwrite);
        profilePaths.set(entry.profile.key, profilePath);
        console.log(`profile ${entry.profile.key} -> ${profilePath}`);
    }
    if (result.patch && options.patch) {
        const patchPath = path.resolve(options.outDir, options.patch);
        await mkdir(path.dirname(patchPath), { recursive: true });
        const patch = {
            ...result.patch,
            profiles: Array.from(profilePaths.values()).map((profilePath) => relativeProfilePath(patchPath, profilePath)),
        };
        await writeJson(patchPath, patch, options.pretty, options.overwrite);
        console.log(`patch -> ${patchPath}`);
    }
    for (const warning of result.warnings) {
        console.warn(`warning ${warning.source}: ${warning.message}`);
    }
    if (options.strict && result.warnings.length > 0) {
        throw new Error(`${result.warnings.length} warning(s) emitted in --strict mode`);
    }
}
function parseFormat(value) {
    const allowed = new Set(["auto", "gdtf", "gdtf-xml", "mvr", "ma3"]);
    if (!allowed.has(value))
        throw new InvalidArgumentError(`expected one of ${Array.from(allowed).join(", ")}`);
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
    .action(async (input, opts) => {
    const options = {
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
    .action(async (input, opts) => {
    const options = {
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
program.parseAsync(process.argv).catch((error) => {
    console.error(`bbb-dmx-convert: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
