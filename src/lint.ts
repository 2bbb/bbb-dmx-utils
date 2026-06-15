#!/usr/bin/env node
import { Command } from "commander";
import { Ajv2020 } from "ajv/dist/2020.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Severity = "error" | "warning";
type Diagnostic = { severity: Severity; file: string; message: string };
type LintDocument = { name: string; data: unknown };
type LintMemoryOptions = { schemaDir?: string; strict?: boolean };
type JsonObject = Record<string, unknown>;
type FixtureProfile = {
  schema: "bbb.dmx.fixture.profile.v1";
  key: string;
  modes: Record<string, {
    footprint: number;
    channels: Array<{ offset: number; key: string }>;
    parameters?: Record<string, {
      type: string;
      channel?: string;
      channels?: string[];
      wheel?: string;
      ranges?: Array<{ from: number; to: number; function: string; label?: string; wheel?: string; wheel_slot?: number; physical_from?: number; physical_to?: number }>;
    }>;
  }>;
};
type PatchFile = {
  schema: "bbb.dmx.patch.v2";
  coordinates?: "gdtf";
  profiles?: string[];
  fixtures: Array<{ id: string; profile: string; mode: string; universe: number; address: number }>;
};

type Options = {
  strict: boolean;
  json: boolean;
  schemaDir: string;
  fixtureDir: string[];
};

const schemaById: Record<string, string> = {
  "bbb.dmx.fixture.profile.v1": "bbb.dmx.fixture.profile.v1.schema.json",
  "bbb.dmx.patch.v2": "bbb.dmx.patch.v2.schema.json",
  "bbb.dmx.matrixmap.v1": "bbb.dmx.matrixmap.v1.schema.json",
  "bbb.dmx.palette.v1": "bbb.dmx.palette.v1.schema.json",
  "bbb.dmx.scene.v1": "bbb.dmx.scene.v1.schema.json",
  "bbb.dmx.curve.v1": "bbb.dmx.curve.v1.schema.json",
  "bbb.dmx.mask.v1": "bbb.dmx.mask.v1.schema.json",
  "bbb.dmx.assert.v1": "bbb.dmx.assert.v1.schema.json",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "..");

function defaultSchemaDir(): string {
  const packagedSchemas = path.join(defaultRepoRoot, "schemas");
  if(existsSync(packagedSchemas)) return packagedSchemas;
  return path.join(defaultRepoRoot, "libs/bbb-dmx/schemas");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

async function loadAjv(schemaDir: string): Promise<Ajv2020> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for(const fileName of Object.values(schemaById)) {
    const schemaPath = path.join(schemaDir, fileName);
    const schema = await readJsonFile(schemaPath);
    ajv.addSchema(schema as object, schemaPath);
  }
  return ajv;
}

function schemaId(value: unknown): string | undefined {
  if(!isObject(value)) return undefined;
  const schema = value.schema;
  return typeof schema === "string" ? schema : undefined;
}

function schemaPathForId(schema: string, schemaDir: string): string | undefined {
  const fileName = schemaById[schema];
  return fileName ? path.join(schemaDir, fileName) : undefined;
}

function add(diags: Diagnostic[], severity: Severity, file: string, message: string): void {
  diags.push({ severity, file, message });
}

function domainMaxForParameterType(type: string): number | undefined {
  if(type === "u16") return 65535;
  if(type === "u24") return 16777215;
  if(type === "u8" || type === "enum") return 255;
  return undefined;
}

function formatAjvPath(instancePath: string): string {
  return instancePath.length > 0 ? instancePath : "/";
}

function validateSchema(ajv: Ajv2020, file: string, data: unknown, diagnostics: Diagnostic[], schemaDir: string): boolean {
  const id = schemaId(data);
  if(!id) {
    add(diagnostics, "error", file, "missing top-level schema string");
    return false;
  }
  const schemaPath = schemaPathForId(id, schemaDir);
  if(!schemaPath) {
    add(diagnostics, "error", file, `unsupported schema '${id}'`);
    return false;
  }
  const validator = ajv.getSchema(schemaPath);
  if(!validator) {
    add(diagnostics, "error", file, `internal error: schema not loaded for '${id}'`);
    return false;
  }
  const ok = validator(data) as boolean;
  if(!ok) {
    for(const error of validator.errors ?? []) {
      add(diagnostics, "error", file, `${formatAjvPath(error.instancePath)} ${error.message ?? "schema validation failed"}`);
    }
  }
  return ok;
}

function lintProfile(profile: FixtureProfile, file: string, diagnostics: Diagnostic[]): void {
  for(const [modeKey, mode] of Object.entries(profile.modes)) {
    const offsets = new Set<number>();
    const channelKeys = new Set<string>();
    for(const channel of mode.channels) {
      if(channel.offset > mode.footprint) {
        add(diagnostics, "error", file, `profile '${profile.key}' mode '${modeKey}' channel '${channel.key}' offset ${channel.offset} exceeds footprint ${mode.footprint}`);
      }
      if(offsets.has(channel.offset)) {
        add(diagnostics, "error", file, `profile '${profile.key}' mode '${modeKey}' has duplicate channel offset ${channel.offset}`);
      }
      offsets.add(channel.offset);
      if(channelKeys.has(channel.key)) {
        add(diagnostics, "error", file, `profile '${profile.key}' mode '${modeKey}' has duplicate channel key '${channel.key}'`);
      }
      channelKeys.add(channel.key);
    }
    for(const [paramKey, parameter] of Object.entries(mode.parameters ?? {})) {
      const refs = parameter.channel ? [parameter.channel] : (parameter.channels ?? []);
      for(const ref of refs) {
        if(!channelKeys.has(ref)) {
          add(diagnostics, "error", file, `profile '${profile.key}' mode '${modeKey}' parameter '${paramKey}' references unknown channel '${ref}'`);
        }
      }
      const expected = parameter.type === "u16" ? 2 : parameter.type === "u24" ? 3 : parameter.type === "u8" || parameter.type === "enum" ? 1 : undefined;
      if(expected !== undefined && refs.length !== expected) {
        add(diagnostics, "error", file, `profile '${profile.key}' mode '${modeKey}' parameter '${paramKey}' type '${parameter.type}' has ${refs.length} channel reference(s), expected ${expected}`);
      }
      const domainMax = domainMaxForParameterType(parameter.type);
      if(parameter.ranges && domainMax !== undefined) {
        const sortedRanges = [...parameter.ranges].sort((a, b) => a.from - b.from || a.to - b.to);
        for(const range of sortedRanges) {
          if(range.from > range.to) {
            add(diagnostics, "error", file, `profile '${profile.key}' mode '${modeKey}' parameter '${paramKey}' range ${range.function} has from ${range.from} greater than to ${range.to}`);
          }
          if(range.from < 0 || range.to > domainMax) {
            add(diagnostics, "error", file, `profile '${profile.key}' mode '${modeKey}' parameter '${paramKey}' range ${range.function} [${range.from}, ${range.to}] exceeds ${parameter.type} domain 0..${domainMax}`);
          }
        }
        if(sortedRanges.length > 0) {
          const firstRange = sortedRanges[0]!;
          if(firstRange.from > 0) {
            add(diagnostics, "warning", file, `profile '${profile.key}' mode '${modeKey}' parameter '${paramKey}' ranges start at ${firstRange.from}, leaving gap 0..${firstRange.from - 1}`);
          }
          for(let index = 1; index < sortedRanges.length; index++) {
            const previous = sortedRanges[index - 1]!;
            const current = sortedRanges[index]!;
            if(current.from <= previous.to) {
              add(diagnostics, "warning", file, `profile '${profile.key}' mode '${modeKey}' parameter '${paramKey}' ranges overlap at ${current.from} (${previous.function} -> ${current.function})`);
            } else if(previous.to + 1 < current.from) {
              add(diagnostics, "warning", file, `profile '${profile.key}' mode '${modeKey}' parameter '${paramKey}' ranges have gap ${previous.to + 1}..${current.from - 1}`);
            }
          }
          const lastRange = sortedRanges[sortedRanges.length - 1]!;
          if(lastRange.to < domainMax) {
            add(diagnostics, "warning", file, `profile '${profile.key}' mode '${modeKey}' parameter '${paramKey}' ranges end at ${lastRange.to}, leaving gap ${lastRange.to + 1}..${domainMax}`);
          }
        }
      }
    }
  }
}

async function tryLoadProfile(file: string, ajv: Ajv2020, schemaDir: string, diagnostics: Diagnostic[]): Promise<FixtureProfile | undefined> {
  try {
    const data = await readJsonFile(file);
    if(schemaId(data) !== "bbb.dmx.fixture.profile.v1") {
      add(diagnostics, "error", file, "profile reference does not point to a fixture profile JSON file");
      return undefined;
    }
    if(!validateSchema(ajv, file, data, diagnostics, schemaDir)) return undefined;
    const profile = data as FixtureProfile;
    lintProfile(profile, file, diagnostics);
    return profile;
  } catch(error) {
    add(diagnostics, "error", file, `cannot read profile: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function candidateProfilePaths(patchFile: string, profileRef: string, fixtureDirs: string[]): string[] {
  const out: string[] = [];
  if(profileRef.endsWith(".json") || profileRef.includes("/") || profileRef.includes("\\")) {
    out.push(path.resolve(path.dirname(patchFile), profileRef));
    if(!path.isAbsolute(profileRef)) out.push(path.resolve(profileRef));
  } else {
    const fileName = `${profileRef}.json`;
    out.push(path.resolve(path.dirname(patchFile), "../fixtures", fileName));
    out.push(path.resolve(path.dirname(patchFile), "fixtures", fileName));
    out.push(path.resolve("fixtures", fileName));
    for(const dir of fixtureDirs) out.push(path.resolve(dir, fileName));
  }
  return Array.from(new Set(out));
}

async function loadProfilesForPatch(patch: PatchFile, patchFile: string, ajv: Ajv2020, options: Options, diagnostics: Diagnostic[]): Promise<Map<string, FixtureProfile>> {
  const profiles = new Map<string, FixtureProfile>();
  const loadedFiles = new Set<string>();

  const loadRef = async (ref: string): Promise<void> => {
    const candidates = candidateProfilePaths(patchFile, ref, options.fixtureDir);
    const found = candidates.find((candidate) => existsSync(candidate));
    if(!found) {
      add(diagnostics, "error", patchFile, `cannot resolve profile '${ref}' for patch; tried ${candidates.map((candidate) => path.relative(process.cwd(), candidate)).join(", ")}`);
      return;
    }
    const realFound = path.resolve(found);
    if(loadedFiles.has(realFound)) return;
    loadedFiles.add(realFound);
    const profile = await tryLoadProfile(realFound, ajv, options.schemaDir, diagnostics);
    if(!profile) return;
    if(profiles.has(profile.key)) {
      add(diagnostics, "error", realFound, `duplicate loaded profile key '${profile.key}'`);
    }
    profiles.set(profile.key, profile);
  };

  for(const ref of patch.profiles ?? []) await loadRef(ref);
  for(const fixture of patch.fixtures) {
    if(!profiles.has(fixture.profile)) await loadRef(fixture.profile);
  }
  return profiles;
}


function lintPatchAgainstProfiles(patch: PatchFile, file: string, profiles: Map<string, FixtureProfile>, diagnostics: Diagnostic[], reportMissingProfiles = true): void {
  const fixtureIds = new Set<string>();
  for(const fixture of patch.fixtures) {
    if(fixtureIds.has(fixture.id)) add(diagnostics, "error", file, `duplicate fixture id '${fixture.id}'`);
    fixtureIds.add(fixture.id);
  }

  const occupied = new Map<string, string>();
  for(const fixture of patch.fixtures) {
    const profile = profiles.get(fixture.profile);
    if(!profile) {
      if(reportMissingProfiles) add(diagnostics, "error", file, `fixture '${fixture.id}' references unknown profile '${fixture.profile}'`);
      continue;
    }
    const mode = profile.modes[fixture.mode];
    if(!mode) {
      add(diagnostics, "error", file, `fixture '${fixture.id}' references unknown mode '${fixture.mode}' on profile '${fixture.profile}'`);
      continue;
    }
    const end = fixture.address + mode.footprint - 1;
    if(end > 512) {
      add(diagnostics, "error", file, `fixture '${fixture.id}' footprint ${mode.footprint} at address ${fixture.address} exceeds universe ${fixture.universe} channel 512`);
    }
    for(let address = fixture.address; address <= Math.min(end, 512); address++) {
      const key = `${fixture.universe}:${address}`;
      const previous = occupied.get(key);
      if(previous) {
        add(diagnostics, "error", file, `fixture '${fixture.id}' overlaps '${previous}' at universe ${fixture.universe} channel ${address}`);
      } else {
        occupied.set(key, fixture.id);
      }
    }
  }
}

async function lintPatch(patch: PatchFile, file: string, ajv: Ajv2020, options: Options, diagnostics: Diagnostic[]): Promise<void> {
  const profiles = await loadProfilesForPatch(patch, file, ajv, options, diagnostics);
  lintPatchAgainstProfiles(patch, file, profiles, diagnostics, false);
}

async function lintFile(file: string, ajv: Ajv2020, options: Options, diagnostics: Diagnostic[]): Promise<void> {
  let data: unknown;
  try {
    data = await readJsonFile(file);
  } catch(error) {
    add(diagnostics, "error", file, `cannot parse JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if(!validateSchema(ajv, file, data, diagnostics, options.schemaDir)) return;
  const id = schemaId(data);
  if(id === "bbb.dmx.fixture.profile.v1") lintProfile(data as FixtureProfile, file, diagnostics);
  if(id === "bbb.dmx.patch.v2") await lintPatch(data as PatchFile, file, ajv, options, diagnostics);
}

async function lintDocumentsInMemory(documents: LintDocument[], options: LintMemoryOptions = {}): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
  const schemaDir = path.resolve(options.schemaDir ?? defaultSchemaDir());
  const ajv = await loadAjv(schemaDir);
  const diagnostics: Diagnostic[] = [];
  const profiles = new Map<string, FixtureProfile>();
  const patches: Array<{ file: string; patch: PatchFile }> = [];

  for(const doc of documents) {
    const file = typeof doc.name === "string" && doc.name.length > 0 ? doc.name : "unnamed.json";
    const data = doc.data;
    if(!validateSchema(ajv, file, data, diagnostics, schemaDir)) continue;
    const id = schemaId(data);
    if(id === "bbb.dmx.fixture.profile.v1") {
      const profile = data as FixtureProfile;
      lintProfile(profile, file, diagnostics);
      if(profiles.has(profile.key)) add(diagnostics, "error", file, `duplicate in-memory profile key '${profile.key}'`);
      profiles.set(profile.key, profile);
    }
    if(id === "bbb.dmx.patch.v2") patches.push({ file, patch: data as PatchFile });
  }

  for(const { file, patch } of patches) lintPatchAgainstProfiles(patch, file, profiles, diagnostics);
  return { ok: collectExitCode(diagnostics, Boolean(options.strict)) === 0, diagnostics };
}

function printDiagnostics(diagnostics: Diagnostic[], json: boolean): void {
  if(json) {
    console.log(JSON.stringify({ ok: diagnostics.every((diag) => diag.severity !== "error"), diagnostics }, null, 2));
    return;
  }
  if(diagnostics.length === 0) {
    console.log("bbb-dmx-lint: ok");
    return;
  }
  for(const diag of diagnostics) {
    const out = `${diag.severity}: ${diag.file}: ${diag.message}`;
    if(diag.severity === "error") console.error(out);
    else console.warn(out);
  }
}

function collectExitCode(diagnostics: Diagnostic[], strict: boolean): number {
  if(diagnostics.some((diag) => diag.severity === "error")) return 1;
  if(strict && diagnostics.some((diag) => diag.severity === "warning")) return 1;
  return 0;
}

const program = new Command();
program
  .name("bbb-dmx-lint")
  .description("Validate bbb.dmx JSON files and semantic patch/profile references without launching Max.")
  .argument("<files...>", "bbb.dmx JSON files to lint")
  .option("--schema-dir <dir>", "schema directory", defaultSchemaDir())
  .option("--fixture-dir <dir...>", "additional fixture profile directories", [])
  .option("--strict", "treat warnings as errors", false)
  .option("--json", "emit machine-readable diagnostics", false)
  .action(async (files: string[], raw: Record<string, unknown>) => {
    const options: Options = {
      strict: Boolean(raw.strict),
      json: Boolean(raw.json),
      schemaDir: path.resolve(String(raw.schemaDir)),
      fixtureDir: Array.isArray(raw.fixtureDir) ? raw.fixtureDir.map((entry) => path.resolve(String(entry))) : [],
    };
    const diagnostics: Diagnostic[] = [];
    const ajv = await loadAjv(options.schemaDir);
    for(const file of files) await lintFile(file, ajv, options, diagnostics);
    printDiagnostics(diagnostics, options.json);
    process.exitCode = collectExitCode(diagnostics, options.strict);
  });

function isCliEntrypoint(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if(isCliEntrypoint()) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(`bbb-dmx-lint: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export type { Severity, Diagnostic, LintDocument, LintMemoryOptions };
export { defaultSchemaDir, lintDocumentsInMemory };
