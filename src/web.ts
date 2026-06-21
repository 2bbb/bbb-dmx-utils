#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { convertInput, type ConvertOptions, type ConvertResult } from "./index.js";
import { defaultSchemaDir, lintDocumentsInMemory, type Diagnostic } from "./lint.js";

type UploadedFile = {
  name: string;
  contentBase64: string;
  format?: string;
  profilePrefix?: string;
};

type ValidateDocument = {
  name: string;
  data: unknown;
};

type ValidateRequest = {
  documents: ValidateDocument[];
  strict?: boolean;
};

type ValidationResponse = {
  ok: boolean;
  diagnostics: Diagnostic[];
};

function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base.length > 0 ? base : "upload.dat";
}

function contentTypeForPath(urlPath: string): string {
  if(urlPath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if(urlPath.endsWith(".css")) return "text/css; charset=utf-8";
  if(urlPath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}

function send(res: ServerResponse, status: number, body: string | Buffer, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

async function readBody(req: IncomingMessage, limitBytes = 50 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if(total > limitBytes) throw new Error(`request body exceeds ${limitBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const text = (await readBody(req)).toString("utf8");
  return JSON.parse(text) as T;
}

async function convertUploadedFile(payload: UploadedFile): Promise<ConvertResult> {
  if(typeof payload.name !== "string" || typeof payload.contentBase64 !== "string") {
    throw new Error("expected { name, contentBase64 } upload payload");
  }
  const workDir = path.join(tmpdir(), `bbb-dmx-fixture-editor-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  const file = path.join(workDir, safeFileName(payload.name));
  try {
    await writeFile(file, Buffer.from(payload.contentBase64, "base64"));
    const options: ConvertOptions = {
      format: payload.format ?? "auto",
      outDir: workDir,
      fixtureDir: "fixtures",
      patch: undefined,
      overwrite: true,
      pretty: true,
      strict: false,
      profilePrefix: payload.profilePrefix ?? "",
    };
    return await convertInput(file, options);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function validateDocuments(payload: ValidateRequest): Promise<ValidationResponse> {
  if(!Array.isArray(payload.documents)) throw new Error("expected { documents: [...] }");
  return await lintDocumentsInMemory(payload.documents, { schemaDir: defaultSchemaDir(), strict: Boolean(payload.strict) });
}

const editorHtml = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bbb.dmx fixture editor</title>
<style>
:root { color-scheme: dark; --bg:#101318; --panel:#171c23; --muted:#9aa4b2; --line:#2b3440; --text:#eef3f8; --accent:#74b8ff; --ok:#63d471; --warn:#ffbf47; --err:#ff6b6b; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
header { padding:16px 20px; border-bottom:1px solid var(--line); background:#0d1015; }
h1 { margin:0 0 4px; font-size:20px; }
p { color:var(--muted); margin:0; }
main { display:grid; grid-template-columns: 360px 1fr; gap:12px; padding:12px; }
section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; min-width:0; }
h2 { margin:0 0 10px; font-size:15px; }
label { display:block; margin:10px 0 4px; color:var(--muted); font-size:12px; }
input, select, textarea, button { width:100%; border:1px solid var(--line); border-radius:8px; background:#0d1117; color:var(--text); padding:8px; }
button { cursor:pointer; background:#182638; border-color:#294766; }
button:hover { border-color:var(--accent); }
button:disabled { opacity:.45; cursor:not-allowed; }
textarea { min-height:360px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; line-height:1.45; resize:vertical; }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
.row { display:grid; grid-template-columns: repeat(8, minmax(70px, 1fr)); gap:6px; align-items:end; padding:8px 0; border-bottom:1px solid var(--line); }
.row input { font-family: ui-monospace, monospace; }
.subhead { margin:14px 0 4px; color:var(--muted); font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
.readonly { border:1px solid var(--line); border-radius:8px; padding:8px; background:#111821; min-height:34px; }
.small { font-size:12px; color:var(--muted); }
.list { display:flex; flex-direction:column; gap:6px; }
.item { text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.status { white-space:pre-wrap; font-family: ui-monospace, monospace; font-size:12px; border:1px solid var(--line); border-radius:8px; padding:8px; min-height:56px; color:var(--muted); }
.ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); }
.actions { display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; margin-top:8px; }
.wide-actions { display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; margin-top:8px; }
.semantic-row { display:grid; grid-template-columns: minmax(120px, 1fr) minmax(160px, 1.4fr) 82px; gap:6px; align-items:end; padding:8px 0; border-bottom:1px solid var(--line); }
.color-row { display:grid; grid-template-columns: repeat(6, minmax(88px, 1fr)); gap:6px; align-items:end; padding:8px 0; border-bottom:1px solid var(--line); }
.checklist { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:6px; margin:8px 0; }
.checkitem { display:flex; gap:6px; align-items:center; color:var(--text); background:#0d1117; border:1px solid var(--line); border-radius:8px; padding:6px; }
.checkitem input { width:auto; }
@media (max-width: 980px) { main { grid-template-columns:1fr; } .grid { grid-template-columns:1fr; } .row { grid-template-columns:1fr 1fr; } }
</style>
</head>
<body>
<header>
  <h1>bbb.dmx fixture / coordinate editor</h1>
  <p>Local editor for importing GDTF/MVR/MA3-like files, customizing profiles and fixture coordinates, validating against bbb-dmx schemas, and exporting JSON.</p>
</header>
<main>
  <section>
    <h2>Import</h2>
    <input id="file" type="file" accept=".gdtf,.mvr,.xml,.json" multiple>
    <label for="format">Format</label>
    <select id="format"><option value="auto">auto</option><option value="gdtf">gdtf</option><option value="gdtf-xml">gdtf-xml</option><option value="mvr">mvr</option><option value="ma3">ma3</option></select>
    <label for="prefix">Profile prefix</label>
    <input id="prefix" placeholder="optional.prefix">
    <button id="convert">Import / convert</button>
    <div class="actions"><button id="validate" disabled>Validate</button><button id="downloadAll" disabled>Download all</button><button id="reset">Reset</button></div>
    <label>Status</label><div id="status" class="status">No file loaded. Select GDTF/MVR/XML to convert, or one or more bbb.dmx JSON files to reopen.</div>
    <h2 style="margin-top:16px">Profiles</h2>
    <div id="profiles" class="list small">No profiles.</div>
  </section>
  <section>
    <div class="grid">
      <section>
        <h2>Selected profile</h2>
        <div class="grid">
          <div><label>Manufacturer</label><input id="manufacturer"></div>
          <div><label>Model</label><input id="model"></div>
          <div><label>Key</label><input id="profileKey"></div>
          <div><label>Mode</label><select id="modeSelect"></select></div>
        </div>
        <div class="actions"><button id="addChannel">Add channel</button><button id="addParameter">Add parameter</button><button id="refreshProfileJson">Refresh JSON</button></div>
        <div class="subhead">Mode channels</div>
        <div id="channels" class="small">No mode selected.</div>
        <div class="subhead">Parameters / functions</div>
        <div id="parameters" class="small">No mode selected.</div>
        <label>Profile JSON</label>
        <textarea id="profileJson" spellcheck="false"></textarea>
        <div class="actions"><button id="applyProfile">Apply profile JSON</button><button id="downloadProfile">Download profile</button><button id="copyProfile">Copy JSON</button></div>
      </section>
      <section>
        <h2>Patch / fixture coordinates</h2>
        <div id="patchSummary" class="small">No patch loaded. MVR imports usually produce patch fixtures.</div>
        <div id="fixtures"></div>
        <label>Patch JSON</label>
        <textarea id="patchJson" spellcheck="false"></textarea>
        <div class="actions"><button id="applyPatch">Apply patch JSON</button><button id="downloadPatch">Download patch</button><button id="copyPatch">Copy JSON</button></div>
      </section>
    </div>
    <section style="margin-top:12px">
      <h2>Semantic overrides</h2>
      <p class="small">Build <code>bbb.dmx.semantic_overrides.v1</code> with profile/mode-aware selects. Raw JSON is still visible, but aliases and RGB/CMY targets should not be hand-typed unless the profile is missing.</p>
      <div class="grid">
        <div><label for="semanticProfile">Profile</label><select id="semanticProfile"></select></div>
        <div><label for="semanticMode">Mode</label><select id="semanticMode"></select></div>
      </div>
      <div id="semanticSummary" class="small" style="margin-top:8px">No semantic overrides loaded.</div>
      <div class="wide-actions"><button id="newSemantic">New semantic_overrides</button><button id="addAlias">Add alias</button><button id="addRgbBlock">Add RGB block</button><button id="addCmyBlock">Add CMY block</button></div>
      <div class="subhead">Aliases</div>
      <datalist id="aliasOptions">
        <option value="dimmer"><option value="intensity"><option value="master"><option value="red"><option value="green"><option value="blue"><option value="white"><option value="cyan"><option value="magenta"><option value="yellow"><option value="color"><option value="colorwheel"><option value="shutter"><option value="strobe"><option value="pan"><option value="tilt">
      </datalist>
      <div id="semanticAliases" class="small">No semantic overrides loaded.</div>
      <div class="subhead">Intensity</div>
      <div id="semanticIntensity" class="small">No semantic overrides loaded.</div>
      <div class="subhead">RGB blocks</div>
      <div id="semanticRgb" class="small">No semantic overrides loaded.</div>
      <div class="subhead">CMY blocks</div>
      <div id="semanticCmy" class="small">No semantic overrides loaded.</div>
      <label>Semantic overrides JSON</label>
      <textarea id="semanticJson" spellcheck="false"></textarea>
      <div class="actions"><button id="applySemantic">Apply semantic JSON</button><button id="downloadSemantic">Download semantic_overrides</button><button id="copySemantic">Copy JSON</button></div>
    </section>
  </section>
</main>
<script>
const state = { profiles: [], patch: null, semanticOverrides: null, semanticProfile: '', semanticMode: '', selected: 0, warnings: [] };
const $ = (id) => document.getElementById(id);
function status(text, cls='') { const el=$('status'); el.className='status '+cls; el.textContent=text; }
function pretty(value) { return JSON.stringify(value, null, 2); }
function parseJson(id) { return JSON.parse($(id).value); }
function download(name, data) { const blob = new Blob([typeof data === 'string' ? data : pretty(data)+'\n'], {type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); URL.revokeObjectURL(a.href); }
async function copyText(text) { await navigator.clipboard.writeText(text); status('Copied JSON.', 'ok'); }
async function fileToBase64(file) { const buf = await file.arrayBuffer(); let binary=''; const bytes=new Uint8Array(buf); for(let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]); return btoa(binary); }
async function fileToText(file) { return await file.text(); }
function isJsonFile(file) { return file.name.toLowerCase().endsWith('.json'); }
function profileEntry(profile, name, source='json') { return { profile, source, suggestedFile: name || ((profile?.key ?? 'profile') + '.json') }; }
function looksLikeProfile(value) { return value && typeof value === 'object' && !Array.isArray(value) && (value.schema === 'bbb.dmx.fixture.profile.v1' || (typeof value.key === 'string' && value.modes && typeof value.modes === 'object')); }
function looksLikePatch(value) { return value && typeof value === 'object' && !Array.isArray(value) && (value.schema === 'bbb.dmx.patch.v2' || Array.isArray(value.fixtures)); }
function looksLikeSemanticOverrides(value) { return value && typeof value === 'object' && !Array.isArray(value) && value.schema === 'bbb.dmx.semantic_overrides.v1' && value.profiles && typeof value.profiles === 'object'; }
function collectJsonDocument(value, name, out) {
  if(looksLikeProfile(value)) { out.profiles.push(profileEntry(value, name)); return; }
  if(value && typeof value === 'object' && looksLikeProfile(value.profile)) { out.profiles.push(profileEntry(value.profile, value.suggestedFile ?? name, value.source ?? 'json')); return; }
  if(looksLikePatch(value)) { out.patches.push(value); return; }
  if(looksLikeSemanticOverrides(value)) { out.semanticOverrides.push(value); return; }
  if(Array.isArray(value)) { for(const [index, entry] of value.entries()) collectJsonDocument(entry, name.replace(/\.json$/i, '') + '-' + (index + 1) + '.json', out); return; }
  if(value && typeof value === 'object' && Array.isArray(value.profiles)) {
    for(const [index, entry] of value.profiles.entries()) collectJsonDocument(entry, entry?.suggestedFile ?? name.replace(/\.json$/i, '') + '-profile-' + (index + 1) + '.json', out);
    if(value.patch) collectJsonDocument(value.patch, name.replace(/\.json$/i, '') + '-patch.json', out);
    return;
  }
  out.unknown.push(name);
}
async function importJsonFiles(files) {
  const out = { profiles: [], patches: [], semanticOverrides: [], unknown: [] };
  for(const file of files) {
    const parsed = JSON.parse(await fileToText(file));
    collectJsonDocument(parsed, file.name, out);
  }
  if(out.patches.length > 1) throw new Error('Multiple patch JSON files selected. Load one patch at a time.');
  if(out.semanticOverrides.length > 1) throw new Error('Multiple semantic_overrides JSON files selected. Load one semantic_overrides file at a time.');
  if(out.profiles.length === 0 && out.patches.length === 0 && out.semanticOverrides.length === 0) throw new Error('No bbb.dmx fixture profile, patch, or semantic_overrides JSON found. Unknown: ' + out.unknown.join(', '));
  state.profiles = out.profiles;
  state.patch = out.patches[0] ?? null;
  state.semanticOverrides = out.semanticOverrides[0] ?? null;
  state.semanticProfile = '';
  state.semanticMode = '';
  state.warnings = out.unknown.map((name)=>({source:name, message:'ignored unknown JSON document'}));
  state.selected = 0;
  renderAll();
  status('Loaded JSON: '+state.profiles.length+' profile(s), '+(state.patch?.fixtures?.length ?? 0)+' patch fixture(s), '+(state.semanticOverrides ? '1' : '0')+' semantic_overrides file(s).'+(state.warnings.length?'\nWarnings:\n'+state.warnings.map(w=>'- '+w.source+': '+w.message).join('\n'):''), state.warnings.length?'warn':'ok');
}
function selectedProfile() { return state.profiles[state.selected]?.profile ?? null; }
function selectedEntry() { return state.profiles[state.selected] ?? null; }
function clear(el) { el.replaceChildren(); }
function addOption(select, text) { const option=document.createElement('option'); option.textContent=text; option.value=text; select.appendChild(option); }
function labeledInput(labelText, attrs = {}) { const outer=document.createElement('div'); const label=document.createElement('label'); const input=document.createElement('input'); label.textContent=labelText; for(const [key,value] of Object.entries(attrs)) { if(value === undefined || value === null) continue; if(key === 'dataset') { for(const [dataKey,dataValue] of Object.entries(value)) input.dataset[dataKey] = String(dataValue); } else { input.setAttribute(key, String(value)); } } outer.append(label, input); return { outer, input }; }
function unique(values) { return Array.from(new Set(values.filter((value)=>typeof value === 'string' && value.length > 0))); }
function emptySemanticOverrides() { return { schema:'bbb.dmx.semantic_overrides.v1', profiles:{} }; }
function ensureSemanticOverrides() { if(!state.semanticOverrides) state.semanticOverrides = emptySemanticOverrides(); return state.semanticOverrides; }
function profileKeys() { return state.profiles.map((entry)=>entry.profile?.key).filter(Boolean); }
function profileByKey(key) { return state.profiles.find((entry)=>entry.profile?.key === key)?.profile ?? null; }
function modeKeysForProfile(profileKey) { return Object.keys(profileByKey(profileKey)?.modes ?? {}); }
function semanticProfileKeys() { return unique([...profileKeys(), ...Object.keys(state.semanticOverrides?.profiles ?? {})]); }
function semanticModeKeys(profileKey) { return unique([...modeKeysForProfile(profileKey), ...Object.keys(state.semanticOverrides?.profiles?.[profileKey]?.modes ?? {})]); }
function selectedSemanticProfileKey() { const keys=semanticProfileKeys(); if(state.semanticProfile && keys.includes(state.semanticProfile)) return state.semanticProfile; const selected=selectedProfile()?.key ?? ''; if(selected && keys.includes(selected)) return selected; return keys[0] ?? ''; }
function selectedSemanticModeKey() { const profileKey=selectedSemanticProfileKey(); const keys=semanticModeKeys(profileKey); if(state.semanticMode && keys.includes(state.semanticMode)) return state.semanticMode; const current=selectedModeKey(); if(current && keys.includes(current)) return current; return keys[0] ?? ''; }
function selectedSemanticParameterKeys() { const profileKey=selectedSemanticProfileKey(); const modeKey=selectedSemanticModeKey(); return Object.keys(profileByKey(profileKey)?.modes?.[modeKey]?.parameters ?? {}); }
function ensureSemanticModeOverride(profileKey=selectedSemanticProfileKey(), modeKey=selectedSemanticModeKey()) { if(!profileKey || !modeKey) throw new Error('Load/select a profile and mode before editing semantic_overrides.'); const doc=ensureSemanticOverrides(); doc.profiles[profileKey] ??= { modes:{} }; doc.profiles[profileKey].modes ??= {}; doc.profiles[profileKey].modes[modeKey] ??= {}; return doc.profiles[profileKey].modes[modeKey]; }
function selectedSemanticModeOverride() { const profileKey=selectedSemanticProfileKey(); const modeKey=selectedSemanticModeKey(); return profileKey && modeKey ? state.semanticOverrides?.profiles?.[profileKey]?.modes?.[modeKey] ?? null : null; }
function syncSemanticJson() { $('semanticJson').value = state.semanticOverrides ? pretty(state.semanticOverrides) : ''; }
function selectBox(labelText, values, value, onChange, options = {}) { const outer=document.createElement('div'); const label=document.createElement('label'); const select=document.createElement('select'); label.textContent=labelText; if(options.blank !== false) { const blank=document.createElement('option'); blank.value=''; blank.textContent=options.blankLabel ?? '(none)'; select.appendChild(blank); } for(const item of unique([...(value ? [value] : []), ...values])) addOption(select, item); select.value=value ?? ''; select.onchange=()=>onChange(select.value); outer.append(label, select); return { outer, select }; }
function defaultParam(names) { const keys=selectedSemanticParameterKeys(); const lowerNames=names.map((name)=>name.toLowerCase()); return keys.find((key)=>lowerNames.includes(key.toLowerCase())) ?? keys.find((key)=>lowerNames.some((name)=>key.toLowerCase().includes(name))) ?? keys[0] ?? ''; }
function semanticColorBlocks(override, kind, create=false) { if(!override) return []; if(Array.isArray(override[kind]) && !override.color?.[kind]) { override.color ??= {}; override.color[kind]=override[kind]; delete override[kind]; } if(create) { override.color ??= {}; override.color[kind] ??= []; } return override.color?.[kind] ?? []; }
function selectedModeKey() { return $('modeSelect').value || Object.keys(selectedProfile()?.modes ?? {})[0] || ''; }
function selectedMode() { const p=selectedProfile(); const key=selectedModeKey(); return key ? p?.modes?.[key] ?? null : null; }
function refreshProfileJson() { const p=selectedProfile(); $('profileJson').value = p ? pretty(p) : ''; }
function syncProfileFormFromState() { const p=selectedProfile(); const modeSelect=$('modeSelect'); clear(modeSelect); if(!p) { $('manufacturer').value=''; $('model').value=''; $('profileKey').value=''; $('profileJson').value=''; renderModeEditor(); return; } $('manufacturer').value=p.manufacturer ?? ''; $('model').value=p.model ?? ''; $('profileKey').value=p.key ?? ''; for(const key of Object.keys(p.modes ?? {})) addOption(modeSelect, key); refreshProfileJson(); renderModeEditor(); }
function syncProfileStateFromForm() { const p=selectedProfile(); if(!p) return; p.manufacturer=$('manufacturer').value; p.model=$('model').value; p.key=$('profileKey').value; refreshProfileJson(); renderProfiles(); renderPatch(); renderSemanticOverrides(); }
function renderProfiles() { const root=$('profiles'); if(state.profiles.length===0) { root.textContent='No profiles.'; return; } clear(root); state.profiles.forEach((entry,i)=>{ const b=document.createElement('button'); b.className='item'; b.textContent=(i===state.selected?'● ':'○ ')+entry.profile.key+' — '+(entry.profile.manufacturer ?? '')+' '+(entry.profile.model ?? ''); b.onclick=()=>{ state.selected=i; renderAll(); }; root.appendChild(b); }); }
function renderPatch() { $('patchSummary').textContent = state.patch ? ((state.patch.fixtures?.length ?? 0) + ' fixture(s), coordinates=' + (state.patch.coordinates ?? 'unset')) : 'No patch loaded. MVR imports usually produce patch fixtures.'; $('patchJson').value = state.patch ? pretty(state.patch) : ''; const root=$('fixtures'); clear(root); for(const [i,f] of (state.patch?.fixtures ?? []).entries()) { const row=document.createElement('div'); row.className='row'; const fields=[labeledInput('ID', {dataset:{k:'id'}, value:f.id ?? ''}), labeledInput('Profile', {dataset:{k:'profile'}, value:f.profile ?? ''}), labeledInput('Mode', {dataset:{k:'mode'}, value:f.mode ?? ''}), labeledInput('Universe', {dataset:{k:'universe'}, type:'number', min:'1', value:f.universe ?? 1}), labeledInput('Address', {dataset:{k:'address'}, type:'number', min:'1', max:'512', value:f.address ?? 1}), labeledInput('Position x/y/z', {dataset:{k:'position'}, value:(f.position ?? [0,0,0]).join(', ')}), labeledInput('Rotation x/y/z', {dataset:{k:'rotation'}, value:(f.rotation ?? [0,0,0]).join(', ')})]; const action=document.createElement('div'); const del=document.createElement('button'); del.textContent='Delete'; action.appendChild(del); for(const field of fields) { field.input.addEventListener('change', ()=>updateFixture(i,row)); row.appendChild(field.outer); } del.onclick=()=>{ state.patch.fixtures.splice(i,1); renderPatch(); }; row.appendChild(action); root.appendChild(row); } }
function renderSemanticProfileModeSelects() { const profileSelect=$('semanticProfile'); const modeSelect=$('semanticMode'); clear(profileSelect); clear(modeSelect); const profiles=semanticProfileKeys(); for(const key of profiles) addOption(profileSelect, key); state.semanticProfile=selectedSemanticProfileKey(); profileSelect.value=state.semanticProfile; const modes=semanticModeKeys(state.semanticProfile); for(const key of modes) addOption(modeSelect, key); state.semanticMode=selectedSemanticModeKey(); modeSelect.value=state.semanticMode; profileSelect.onchange=()=>{ state.semanticProfile=profileSelect.value; state.semanticMode=''; renderSemanticOverrides(); }; modeSelect.onchange=()=>{ state.semanticMode=modeSelect.value; renderSemanticOverrides(); }; }
function renderSemanticAliases(override) { const root=$('semanticAliases'); clear(root); if(!state.semanticOverrides) { root.textContent='No semantic_overrides document. Click New semantic_overrides.'; return; } const aliases=override?.aliases ?? {}; const entries=Object.entries(aliases); if(entries.length===0) { root.textContent='No aliases for this profile/mode.'; return; } for(const [alias,target] of entries) { const row=document.createElement('div'); row.className='semantic-row'; const aliasField=labeledInput('Alias', {value:alias, list:'aliasOptions'}); const targetSelect=selectBox('Target parameter', selectedSemanticParameterKeys(), target, (value)=>{ const ov=ensureSemanticModeOverride(); ov.aliases ??= {}; if(value) ov.aliases[alias]=value; else delete ov.aliases[alias]; syncSemanticJson(); }, {blankLabel:'(select target)'}); const action=document.createElement('div'); const del=document.createElement('button'); del.textContent='Delete'; aliasField.input.onchange=()=>{ const next=aliasField.input.value.trim(); const ov=ensureSemanticModeOverride(); ov.aliases ??= {}; const oldValue=ov.aliases[alias]; delete ov.aliases[alias]; if(next) ov.aliases[next]=oldValue || target || selectedSemanticParameterKeys()[0] || ''; renderSemanticOverrides(); }; del.onclick=()=>{ const ov=ensureSemanticModeOverride(); if(ov.aliases) delete ov.aliases[alias]; renderSemanticOverrides(); }; action.appendChild(del); row.append(aliasField.outer, targetSelect.outer, action); root.appendChild(row); } }
function renderSemanticIntensity(override) { const root=$('semanticIntensity'); clear(root); if(!state.semanticOverrides) { root.textContent='No semantic_overrides document. Click New semantic_overrides.'; return; } const raw=override?.intensity; const selected=Array.isArray(raw) ? raw : (raw?.parameters ?? []); const primary=Array.isArray(raw) ? '' : (raw?.primary ?? ''); const params=unique([...selectedSemanticParameterKeys(), ...selected]); if(params.length===0) { root.textContent='No parameter options. Load the matching fixture profile to use structured intensity mapping.'; return; } const checklist=document.createElement('div'); checklist.className='checklist'; const update=()=>{ const chosen=[...checklist.querySelectorAll('input[type=checkbox]')].filter((input)=>input.checked).map((input)=>input.value); const ov=ensureSemanticModeOverride(); if(chosen.length===0) { delete ov.intensity; syncSemanticJson(); return; } ov.intensity={parameters:chosen}; const primaryValue=primarySelect.select.value; if(primaryValue) ov.intensity.primary=primaryValue; syncSemanticJson(); }; for(const key of params) { const label=document.createElement('label'); label.className='checkitem'; const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.value=key; checkbox.checked=selected.includes(key); checkbox.onchange=update; const span=document.createElement('span'); span.textContent=key; label.append(checkbox, span); checklist.appendChild(label); } const primarySelect=selectBox('Primary intensity parameter', params, primary, ()=>update(), {blankLabel:'(none)'}); root.append(checklist, primarySelect.outer); }
function renderSemanticColorBlocks(override, kind, rootId, fields) { const root=$(rootId); clear(root); if(!state.semanticOverrides) { root.textContent='No semantic_overrides document. Click New semantic_overrides.'; return; } const blocks=semanticColorBlocks(override, kind, false); if(blocks.length===0) { root.textContent='No '+kind.toUpperCase()+' blocks for this profile/mode.'; return; } for(const [index,block] of blocks.entries()) { const row=document.createElement('div'); row.className='color-row'; for(const field of fields) { const select=selectBox(field.toUpperCase(), selectedSemanticParameterKeys(), block[field] ?? '', (value)=>{ const ov=ensureSemanticModeOverride(); const editable=semanticColorBlocks(ov, kind, true); editable[index] ??= {}; if(value) editable[index][field]=value; else delete editable[index][field]; syncSemanticJson(); }, {blankLabel:'(none)'}); row.appendChild(select.outer); } const action=document.createElement('div'); const del=document.createElement('button'); del.textContent='Delete block'; del.onclick=()=>{ const ov=ensureSemanticModeOverride(); const editable=semanticColorBlocks(ov, kind, true); editable.splice(index,1); renderSemanticOverrides(); }; action.appendChild(del); row.appendChild(action); root.appendChild(row); } }
function renderSemanticOverrides() { renderSemanticProfileModeSelects(); const profileCount=Object.keys(state.semanticOverrides?.profiles ?? {}).length; const profileKey=selectedSemanticProfileKey(); const modeKey=selectedSemanticModeKey(); $('semanticSummary').textContent = state.semanticOverrides ? ('Editing '+(profileKey || '(no profile)')+' / '+(modeKey || '(no mode)')+'. '+profileCount+' override profile(s).') : 'No semantic_overrides loaded. Create one or import semantic_overrides.json.'; const override=selectedSemanticModeOverride(); renderSemanticAliases(override); renderSemanticIntensity(override); renderSemanticColorBlocks(override, 'rgb', 'semanticRgb', ['red','green','blue','white','dimmer']); renderSemanticColorBlocks(override, 'cmy', 'semanticCmy', ['cyan','magenta','yellow','dimmer']); syncSemanticJson(); $('downloadSemantic').disabled=!state.semanticOverrides; }
function renderModeEditor() { renderChannels(); renderParameters(); }
function renderChannels() { const root=$('channels'); clear(root); const mode=selectedMode(); if(!mode) { root.textContent='No mode selected.'; return; } mode.channels ??= []; for(const [i,c] of mode.channels.entries()) { const row=document.createElement('div'); row.className='row'; const fields=[labeledInput('Offset', {dataset:{k:'offset'}, type:'number', min:'1', max:'512', value:c.offset ?? 1}), labeledInput('Key', {dataset:{k:'key'}, value:c.key ?? ''}), labeledInput('Label', {dataset:{k:'label'}, value:c.label ?? ''}), labeledInput('Default', {dataset:{k:'default'}, type:'number', min:'0', max:'255', value:c.default ?? ''})]; const spacer=document.createElement('div'); spacer.className='readonly'; spacer.textContent=c.hold ? 'hold' : ''; const action=document.createElement('div'); const del=document.createElement('button'); del.textContent='Delete'; action.appendChild(del); for(const field of fields) { field.input.addEventListener('change', ()=>updateChannel(i,row)); row.appendChild(field.outer); } row.append(spacer, action); del.onclick=()=>{ mode.channels.splice(i,1); refreshProfileJson(); renderChannels(); }; root.appendChild(row); } }
function renderParameters() { const root=$('parameters'); clear(root); const mode=selectedMode(); if(!mode) { root.textContent='No mode selected.'; return; } mode.parameters ??= {}; const entries=Object.entries(mode.parameters); if(entries.length===0) { root.textContent='No parameters.'; return; } for(const [key,param] of entries) { const row=document.createElement('div'); row.className='row'; const channelText=param.channel ?? (param.channels ?? []).join(', '); const fields=[labeledInput('Key', {dataset:{k:'paramKey'}, value:key}), labeledInput('Type', {dataset:{k:'type'}, value:param.type ?? 'u8'}), labeledInput('Channel(s)', {dataset:{k:'channels'}, value:channelText}), labeledInput('Byte order', {dataset:{k:'byte_order'}, value:param.byte_order ?? ''}), labeledInput('Range deg', {dataset:{k:'range_degrees'}, type:'number', value:param.range_degrees ?? ''})]; const rangeInfo=document.createElement('div'); rangeInfo.className='readonly'; rangeInfo.textContent=((param.ranges ?? []).length)+' range(s)'; const action=document.createElement('div'); const del=document.createElement('button'); del.textContent='Delete'; action.appendChild(del); for(const field of fields) { field.input.addEventListener('change', ()=>updateParameter(key,row)); row.appendChild(field.outer); } row.append(rangeInfo, action); del.onclick=()=>{ delete mode.parameters[key]; refreshProfileJson(); renderParameters(); }; root.appendChild(row); } }
function parseTriple(text) { const values=text.split(',').map(v=>Number(v.trim())); if(values.length!==3 || values.some(v=>!Number.isFinite(v))) throw new Error('expected x, y, z numeric triple'); return values; }
function updateFixture(i,row) { const f=state.patch.fixtures[i]; for(const input of row.querySelectorAll('input')) { const k=input.dataset.k; if(k==='id'||k==='profile'||k==='mode') f[k]=input.value; if(k==='universe'||k==='address') f[k]=Number(input.value); if(k==='position'||k==='rotation') f[k]=parseTriple(input.value); } $('patchJson').value=pretty(state.patch); }
function updateChannel(i,row) { const mode=selectedMode(); if(!mode) return; const c=mode.channels[i]; for(const input of row.querySelectorAll('input')) { const k=input.dataset.k; if(k==='offset') c.offset=Number(input.value); if(k==='key') c.key=input.value; if(k==='label') { if(input.value) c.label=input.value; else delete c.label; } if(k==='default') { if(input.value === '') delete c.default; else c.default=Number(input.value); } } refreshProfileJson(); }
function updateParameter(oldKey,row) { const mode=selectedMode(); if(!mode) return; mode.parameters ??= {}; const current=mode.parameters[oldKey] ?? {type:'u8'}; const fields=Object.fromEntries([...row.querySelectorAll('input')].map(input=>[input.dataset.k,input.value])); const newKey=(fields.paramKey ?? oldKey).trim(); if(!newKey) { status('Parameter key cannot be empty.', 'err'); renderParameters(); return; } const next={...current}; next.type=(fields.type ?? next.type ?? 'u8').trim() || 'u8'; const channels=(fields.channels ?? '').split(',').map(v=>v.trim()).filter(Boolean); delete next.channel; delete next.channels; if(channels.length===1) next.channel=channels[0]; else if(channels.length>1) next.channels=channels; if(fields.byte_order) next.byte_order=fields.byte_order.trim(); else delete next.byte_order; if(fields.range_degrees) next.range_degrees=Number(fields.range_degrees); else delete next.range_degrees; if(newKey !== oldKey) delete mode.parameters[oldKey]; mode.parameters[newKey]=next; refreshProfileJson(); renderParameters(); }
function addSemanticAlias() { try { const ov=ensureSemanticModeOverride(); ov.aliases ??= {}; const options=['dimmer','intensity','red','green','blue','white','cyan','magenta','yellow','shutter','pan','tilt']; let alias=options.find((candidate)=>!Object.prototype.hasOwnProperty.call(ov.aliases, candidate)) ?? ('alias_'+(Object.keys(ov.aliases).length+1)); ov.aliases[alias]=selectedSemanticParameterKeys()[0] ?? ''; renderSemanticOverrides(); } catch(e) { status(e.message ?? String(e), 'err'); } }
function addSemanticColorBlock(kind) { try { const ov=ensureSemanticModeOverride(); const blocks=semanticColorBlocks(ov, kind, true); if(kind==='rgb') blocks.push({red:defaultParam(['red','r']), green:defaultParam(['green','g']), blue:defaultParam(['blue','b'])}); else blocks.push({cyan:defaultParam(['cyan','c']), magenta:defaultParam(['magenta','m']), yellow:defaultParam(['yellow','y'])}); renderSemanticOverrides(); } catch(e) { status(e.message ?? String(e), 'err'); } }
function renderAll() { renderProfiles(); syncProfileFormFromState(); renderPatch(); renderSemanticOverrides(); const has=state.profiles.length>0 || state.patch || state.semanticOverrides; $('validate').disabled=!has; $('downloadAll').disabled=!has; $('downloadProfile').disabled=!selectedProfile(); $('downloadPatch').disabled=!state.patch; $('downloadSemantic').disabled=!state.semanticOverrides; }
async function convert() { const files=Array.from($('file').files ?? []); if(files.length===0) { status('Choose GDTF/MVR/XML to convert or bbb.dmx JSON to reopen.', 'err'); return; } $('convert').disabled=true; try { if(files.every(isJsonFile)) { status('Loading JSON...'); await importJsonFiles(files); return; } if(files.some(isJsonFile)) throw new Error('Do not mix JSON with GDTF/MVR/XML imports. Load converted JSON separately.'); if(files.length !== 1) throw new Error('Converter input must be a single GDTF/MVR/XML file. JSON import supports multiple files.'); const file=files[0]; status('Converting...'); const result=await fetch('/api/convert',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,format:$('format').value,profilePrefix:$('prefix').value,contentBase64:await fileToBase64(file)})}); const json=await result.json(); if(!result.ok) throw new Error(json.error ?? 'convert failed'); state.profiles=json.profiles ?? []; state.patch=json.patch ?? null; state.semanticOverrides=null; state.semanticProfile=''; state.semanticMode=''; state.warnings=json.warnings ?? []; state.selected=0; renderAll(); status('Converted '+state.profiles.length+' profile(s), '+(state.patch?.fixtures?.length ?? 0)+' patch fixture(s).'+(state.warnings.length?'\nWarnings:\n'+state.warnings.map(w=>'- '+w.source+': '+w.message).join('\n'):''), state.warnings.length?'warn':'ok'); } catch(e) { status(e.message ?? String(e), 'err'); } finally { $('convert').disabled=false; } }
async function validate() { const docs=[]; for(const entry of state.profiles) docs.push({name:entry.suggestedFile ?? entry.profile.key+'.json', data:entry.profile}); if(state.patch) docs.push({name:'patch.json', data:state.patch}); if(state.semanticOverrides) docs.push({name:'semantic_overrides.json', data:state.semanticOverrides}); status('Validating and linting...'); const res=await fetch('/api/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documents:docs})}); const json=await res.json(); if(!res.ok) { status(json.error ?? 'validate failed', 'err'); return; } status(json.ok ? 'Schema and semantic lint passed.' : json.diagnostics.map(d=>d.severity+': '+d.file+': '+d.message).join('\n'), json.ok?'ok':'err'); }
$('convert').onclick=convert; $('validate').onclick=validate; $('reset').onclick=()=>{ state.profiles=[]; state.patch=null; state.semanticOverrides=null; state.semanticProfile=''; state.semanticMode=''; state.warnings=[]; state.selected=0; renderAll(); status('Reset.'); };
$('manufacturer').onchange=syncProfileStateFromForm; $('model').onchange=syncProfileStateFromForm; $('profileKey').onchange=syncProfileStateFromForm;
$('modeSelect').onchange=()=>{ renderModeEditor(); renderSemanticOverrides(); }; $('applyProfile').onclick=()=>{ const p=parseJson('profileJson'); if(!state.profiles[state.selected]) state.profiles.push({profile:p,suggestedFile:(p.key??'profile')+'.json',source:'editor'}); else state.profiles[state.selected].profile=p; renderAll(); status('Applied profile JSON.', 'ok'); };
$('refreshProfileJson').onclick=()=>{ refreshProfileJson(); status('Refreshed profile JSON from form state.', 'ok'); };
$('addChannel').onclick=()=>{ const mode=selectedMode(); if(!mode) return; mode.channels ??= []; mode.channels.push({offset:mode.channels.length+1,key:'channel_'+(mode.channels.length+1)}); refreshProfileJson(); renderChannels(); };
$('addParameter').onclick=()=>{ const mode=selectedMode(); if(!mode) return; mode.parameters ??= {}; let i=Object.keys(mode.parameters).length+1; while(mode.parameters['parameter_'+i]) i++; mode.parameters['parameter_'+i]={type:'u8',channel:mode.channels?.[0]?.key ?? 'channel_1'}; refreshProfileJson(); renderParameters(); };
$('applyPatch').onclick=()=>{ state.patch=parseJson('patchJson'); renderPatch(); status('Applied patch JSON.', 'ok'); };
$('newSemantic').onclick=()=>{ ensureSemanticOverrides(); try { const profileKey=selectedSemanticProfileKey(); const modeKey=selectedSemanticModeKey(); if(profileKey && modeKey) ensureSemanticModeOverride(profileKey, modeKey); } catch(e) {} renderAll(); status('Created semantic_overrides document.', 'ok'); };
$('addAlias').onclick=addSemanticAlias; $('addRgbBlock').onclick=()=>addSemanticColorBlock('rgb'); $('addCmyBlock').onclick=()=>addSemanticColorBlock('cmy');
$('applySemantic').onclick=()=>{ state.semanticOverrides=parseJson('semanticJson'); state.semanticProfile=''; state.semanticMode=''; renderAll(); status('Applied semantic_overrides JSON.', 'ok'); };
$('downloadProfile').onclick=()=>{ const e=selectedEntry(); if(e) download(e.suggestedFile ?? e.profile.key+'.json', e.profile); };
$('downloadPatch').onclick=()=>{ if(state.patch) download('patch.json', state.patch); };
$('downloadSemantic').onclick=()=>{ if(state.semanticOverrides) download('semantic_overrides.json', state.semanticOverrides); };
$('downloadAll').onclick=()=>{ for(const e of state.profiles) download(e.suggestedFile ?? e.profile.key+'.json', e.profile); if(state.patch) download('patch.json', state.patch); if(state.semanticOverrides) download('semantic_overrides.json', state.semanticOverrides); };
$('copyProfile').onclick=()=>copyText($('profileJson').value); $('copyPatch').onclick=()=>copyText($('patchJson').value); $('copySemantic').onclick=()=>copyText($('semanticJson').value);
renderAll();
</script>
</body>
</html>`;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if(req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, app: "bbb-dmx-fixture-editor" });
      return;
    }
    if(req.method === "POST" && url.pathname === "/api/convert") {
      const payload = await readJsonBody<UploadedFile>(req);
      sendJson(res, 200, await convertUploadedFile(payload));
      return;
    }
    if(req.method === "POST" && url.pathname === "/api/validate") {
      const payload = await readJsonBody<ValidateRequest>(req);
      sendJson(res, 200, await validateDocuments(payload));
      return;
    }
    if(req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      send(res, 200, editorHtml, contentTypeForPath(url.pathname));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch(error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function createFixtureEditorServer(): Server {
  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function isCliEntrypoint(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if(isCliEntrypoint()) {
  const port = Number(argValue("--port", process.env.PORT ?? "4173"));
  const host = argValue("--host", process.env.HOST ?? "127.0.0.1");
  const server = createFixtureEditorServer();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`bbb-dmx-fixture-editor: http://${host}:${actualPort}`);
  });
}

export { createFixtureEditorServer };
