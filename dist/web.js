#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { convertInput } from "./index.js";
import { defaultSchemaDir, lintDocumentsInMemory } from "./lint.js";
function safeFileName(name) {
    const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
    return base.length > 0 ? base : "upload.dat";
}
function contentTypeForPath(urlPath) {
    if (urlPath.endsWith(".js"))
        return "text/javascript; charset=utf-8";
    if (urlPath.endsWith(".css"))
        return "text/css; charset=utf-8";
    if (urlPath.endsWith(".json"))
        return "application/json; charset=utf-8";
    return "text/html; charset=utf-8";
}
function send(res, status, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(status, {
        "content-type": contentType,
        "cache-control": "no-store",
    });
    res.end(body);
}
function sendJson(res, status, value) {
    send(res, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}
async function readBody(req, limitBytes = 50 * 1024 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > limitBytes)
            throw new Error(`request body exceeds ${limitBytes} bytes`);
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
async function readJsonBody(req) {
    const text = (await readBody(req)).toString("utf8");
    return JSON.parse(text);
}
async function convertUploadedFile(payload) {
    if (typeof payload.name !== "string" || typeof payload.contentBase64 !== "string") {
        throw new Error("expected { name, contentBase64 } upload payload");
    }
    const workDir = path.join(tmpdir(), `bbb-dmx-fixture-editor-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
    const file = path.join(workDir, safeFileName(payload.name));
    try {
        await writeFile(file, Buffer.from(payload.contentBase64, "base64"));
        const options = {
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
    }
    finally {
        await rm(workDir, { recursive: true, force: true });
    }
}
async function validateDocuments(payload) {
    if (!Array.isArray(payload.documents))
        throw new Error("expected { documents: [...] }");
    return await lintDocumentsInMemory(payload.documents, { schemaDir: defaultSchemaDir(), strict: Boolean(payload.strict) });
}
const editorHtml = String.raw `<!doctype html>
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
    <input id="file" type="file" accept=".gdtf,.mvr,.xml">
    <label for="format">Format</label>
    <select id="format"><option value="auto">auto</option><option value="gdtf">gdtf</option><option value="gdtf-xml">gdtf-xml</option><option value="mvr">mvr</option><option value="ma3">ma3</option></select>
    <label for="prefix">Profile prefix</label>
    <input id="prefix" placeholder="optional.prefix">
    <button id="convert">Convert import</button>
    <div class="actions"><button id="validate" disabled>Validate</button><button id="downloadAll" disabled>Download all</button><button id="reset">Reset</button></div>
    <label>Status</label><div id="status" class="status">No file loaded.</div>
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
  </section>
</main>
<script>
const state = { profiles: [], patch: null, selected: 0, warnings: [] };
const $ = (id) => document.getElementById(id);
function status(text, cls='') { const el=$('status'); el.className='status '+cls; el.textContent=text; }
function pretty(value) { return JSON.stringify(value, null, 2); }
function parseJson(id) { return JSON.parse($(id).value); }
function download(name, data) { const blob = new Blob([typeof data === 'string' ? data : pretty(data)+'\n'], {type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); URL.revokeObjectURL(a.href); }
async function copyText(text) { await navigator.clipboard.writeText(text); status('Copied JSON.', 'ok'); }
async function fileToBase64(file) { const buf = await file.arrayBuffer(); let binary=''; const bytes=new Uint8Array(buf); for(let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]); return btoa(binary); }
function selectedProfile() { return state.profiles[state.selected]?.profile ?? null; }
function selectedEntry() { return state.profiles[state.selected] ?? null; }
function clear(el) { el.replaceChildren(); }
function addOption(select, text) { const option=document.createElement('option'); option.textContent=text; option.value=text; select.appendChild(option); }
function labeledInput(labelText, attrs = {}) { const outer=document.createElement('div'); const label=document.createElement('label'); const input=document.createElement('input'); label.textContent=labelText; for(const [key,value] of Object.entries(attrs)) { if(value === undefined || value === null) continue; if(key === 'dataset') { for(const [dataKey,dataValue] of Object.entries(value)) input.dataset[dataKey] = String(dataValue); } else { input.setAttribute(key, String(value)); } } outer.append(label, input); return { outer, input }; }
function selectedModeKey() { return $('modeSelect').value || Object.keys(selectedProfile()?.modes ?? {})[0] || ''; }
function selectedMode() { const p=selectedProfile(); const key=selectedModeKey(); return key ? p?.modes?.[key] ?? null : null; }
function refreshProfileJson() { const p=selectedProfile(); $('profileJson').value = p ? pretty(p) : ''; }
function syncProfileFormFromState() { const p=selectedProfile(); const modeSelect=$('modeSelect'); clear(modeSelect); if(!p) { $('manufacturer').value=''; $('model').value=''; $('profileKey').value=''; $('profileJson').value=''; renderModeEditor(); return; } $('manufacturer').value=p.manufacturer ?? ''; $('model').value=p.model ?? ''; $('profileKey').value=p.key ?? ''; for(const key of Object.keys(p.modes ?? {})) addOption(modeSelect, key); refreshProfileJson(); renderModeEditor(); }
function syncProfileStateFromForm() { const p=selectedProfile(); if(!p) return; p.manufacturer=$('manufacturer').value; p.model=$('model').value; p.key=$('profileKey').value; refreshProfileJson(); renderProfiles(); renderPatch(); }
function renderProfiles() { const root=$('profiles'); if(state.profiles.length===0) { root.textContent='No profiles.'; return; } clear(root); state.profiles.forEach((entry,i)=>{ const b=document.createElement('button'); b.className='item'; b.textContent=(i===state.selected?'● ':'○ ')+entry.profile.key+' — '+(entry.profile.manufacturer ?? '')+' '+(entry.profile.model ?? ''); b.onclick=()=>{ state.selected=i; renderAll(); }; root.appendChild(b); }); }
function renderPatch() { $('patchSummary').textContent = state.patch ? ((state.patch.fixtures?.length ?? 0) + ' fixture(s), coordinates=' + (state.patch.coordinates ?? 'unset')) : 'No patch loaded. MVR imports usually produce patch fixtures.'; $('patchJson').value = state.patch ? pretty(state.patch) : ''; const root=$('fixtures'); clear(root); for(const [i,f] of (state.patch?.fixtures ?? []).entries()) { const row=document.createElement('div'); row.className='row'; const fields=[labeledInput('ID', {dataset:{k:'id'}, value:f.id ?? ''}), labeledInput('Profile', {dataset:{k:'profile'}, value:f.profile ?? ''}), labeledInput('Mode', {dataset:{k:'mode'}, value:f.mode ?? ''}), labeledInput('Universe', {dataset:{k:'universe'}, type:'number', min:'1', value:f.universe ?? 1}), labeledInput('Address', {dataset:{k:'address'}, type:'number', min:'1', max:'512', value:f.address ?? 1}), labeledInput('Position x/y/z', {dataset:{k:'position'}, value:(f.position ?? [0,0,0]).join(', ')}), labeledInput('Rotation x/y/z', {dataset:{k:'rotation'}, value:(f.rotation ?? [0,0,0]).join(', ')})]; const action=document.createElement('div'); const del=document.createElement('button'); del.textContent='Delete'; action.appendChild(del); for(const field of fields) { field.input.addEventListener('change', ()=>updateFixture(i,row)); row.appendChild(field.outer); } del.onclick=()=>{ state.patch.fixtures.splice(i,1); renderPatch(); }; row.appendChild(action); root.appendChild(row); } }
function renderModeEditor() { renderChannels(); renderParameters(); }
function renderChannels() { const root=$('channels'); clear(root); const mode=selectedMode(); if(!mode) { root.textContent='No mode selected.'; return; } mode.channels ??= []; for(const [i,c] of mode.channels.entries()) { const row=document.createElement('div'); row.className='row'; const fields=[labeledInput('Offset', {dataset:{k:'offset'}, type:'number', min:'1', max:'512', value:c.offset ?? 1}), labeledInput('Key', {dataset:{k:'key'}, value:c.key ?? ''}), labeledInput('Label', {dataset:{k:'label'}, value:c.label ?? ''}), labeledInput('Default', {dataset:{k:'default'}, type:'number', min:'0', max:'255', value:c.default ?? ''})]; const spacer=document.createElement('div'); spacer.className='readonly'; spacer.textContent=c.hold ? 'hold' : ''; const action=document.createElement('div'); const del=document.createElement('button'); del.textContent='Delete'; action.appendChild(del); for(const field of fields) { field.input.addEventListener('change', ()=>updateChannel(i,row)); row.appendChild(field.outer); } row.append(spacer, action); del.onclick=()=>{ mode.channels.splice(i,1); refreshProfileJson(); renderChannels(); }; root.appendChild(row); } }
function renderParameters() { const root=$('parameters'); clear(root); const mode=selectedMode(); if(!mode) { root.textContent='No mode selected.'; return; } mode.parameters ??= {}; const entries=Object.entries(mode.parameters); if(entries.length===0) { root.textContent='No parameters.'; return; } for(const [key,param] of entries) { const row=document.createElement('div'); row.className='row'; const channelText=param.channel ?? (param.channels ?? []).join(', '); const fields=[labeledInput('Key', {dataset:{k:'paramKey'}, value:key}), labeledInput('Type', {dataset:{k:'type'}, value:param.type ?? 'u8'}), labeledInput('Channel(s)', {dataset:{k:'channels'}, value:channelText}), labeledInput('Byte order', {dataset:{k:'byte_order'}, value:param.byte_order ?? ''}), labeledInput('Range deg', {dataset:{k:'range_degrees'}, type:'number', value:param.range_degrees ?? ''})]; const rangeInfo=document.createElement('div'); rangeInfo.className='readonly'; rangeInfo.textContent=((param.ranges ?? []).length)+' range(s)'; const action=document.createElement('div'); const del=document.createElement('button'); del.textContent='Delete'; action.appendChild(del); for(const field of fields) { field.input.addEventListener('change', ()=>updateParameter(key,row)); row.appendChild(field.outer); } row.append(rangeInfo, action); del.onclick=()=>{ delete mode.parameters[key]; refreshProfileJson(); renderParameters(); }; root.appendChild(row); } }
function parseTriple(text) { const values=text.split(',').map(v=>Number(v.trim())); if(values.length!==3 || values.some(v=>!Number.isFinite(v))) throw new Error('expected x, y, z numeric triple'); return values; }
function updateFixture(i,row) { const f=state.patch.fixtures[i]; for(const input of row.querySelectorAll('input')) { const k=input.dataset.k; if(k==='id'||k==='profile'||k==='mode') f[k]=input.value; if(k==='universe'||k==='address') f[k]=Number(input.value); if(k==='position'||k==='rotation') f[k]=parseTriple(input.value); } $('patchJson').value=pretty(state.patch); }
function updateChannel(i,row) { const mode=selectedMode(); if(!mode) return; const c=mode.channels[i]; for(const input of row.querySelectorAll('input')) { const k=input.dataset.k; if(k==='offset') c.offset=Number(input.value); if(k==='key') c.key=input.value; if(k==='label') { if(input.value) c.label=input.value; else delete c.label; } if(k==='default') { if(input.value === '') delete c.default; else c.default=Number(input.value); } } refreshProfileJson(); }
function updateParameter(oldKey,row) { const mode=selectedMode(); if(!mode) return; mode.parameters ??= {}; const current=mode.parameters[oldKey] ?? {type:'u8'}; const fields=Object.fromEntries([...row.querySelectorAll('input')].map(input=>[input.dataset.k,input.value])); const newKey=(fields.paramKey ?? oldKey).trim(); if(!newKey) { status('Parameter key cannot be empty.', 'err'); renderParameters(); return; } const next={...current}; next.type=(fields.type ?? next.type ?? 'u8').trim() || 'u8'; const channels=(fields.channels ?? '').split(',').map(v=>v.trim()).filter(Boolean); delete next.channel; delete next.channels; if(channels.length===1) next.channel=channels[0]; else if(channels.length>1) next.channels=channels; if(fields.byte_order) next.byte_order=fields.byte_order.trim(); else delete next.byte_order; if(fields.range_degrees) next.range_degrees=Number(fields.range_degrees); else delete next.range_degrees; if(newKey !== oldKey) delete mode.parameters[oldKey]; mode.parameters[newKey]=next; refreshProfileJson(); renderParameters(); }
function renderAll() { renderProfiles(); syncProfileFormFromState(); renderPatch(); const has=state.profiles.length>0 || state.patch; $('validate').disabled=!has; $('downloadAll').disabled=!has; $('downloadProfile').disabled=!selectedProfile(); $('downloadPatch').disabled=!state.patch; }
async function convert() { const file=$('file').files[0]; if(!file) { status('Choose a GDTF/MVR/XML file first.', 'err'); return; } $('convert').disabled=true; status('Converting...'); try { const result=await fetch('/api/convert',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,format:$('format').value,profilePrefix:$('prefix').value,contentBase64:await fileToBase64(file)})}); const json=await result.json(); if(!result.ok) throw new Error(json.error ?? 'convert failed'); state.profiles=json.profiles ?? []; state.patch=json.patch ?? null; state.warnings=json.warnings ?? []; state.selected=0; renderAll(); status('Converted '+state.profiles.length+' profile(s), '+(state.patch?.fixtures?.length ?? 0)+' patch fixture(s).'+(state.warnings.length?'\nWarnings:\n'+state.warnings.map(w=>'- '+w.source+': '+w.message).join('\n'):''), state.warnings.length?'warn':'ok'); } catch(e) { status(e.message ?? String(e), 'err'); } finally { $('convert').disabled=false; } }
async function validate() { const docs=[]; for(const entry of state.profiles) docs.push({name:entry.suggestedFile ?? entry.profile.key+'.json', data:entry.profile}); if(state.patch) docs.push({name:'patch.json', data:state.patch}); status('Validating and linting...'); const res=await fetch('/api/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documents:docs})}); const json=await res.json(); if(!res.ok) { status(json.error ?? 'validate failed', 'err'); return; } status(json.ok ? 'Schema and semantic lint passed.' : json.diagnostics.map(d=>d.severity+': '+d.file+': '+d.message).join('\n'), json.ok?'ok':'err'); }
$('convert').onclick=convert; $('validate').onclick=validate; $('reset').onclick=()=>{ state.profiles=[]; state.patch=null; state.warnings=[]; state.selected=0; renderAll(); status('Reset.'); };
$('manufacturer').onchange=syncProfileStateFromForm; $('model').onchange=syncProfileStateFromForm; $('profileKey').onchange=syncProfileStateFromForm;
$('modeSelect').onchange=renderModeEditor; $('applyProfile').onclick=()=>{ const p=parseJson('profileJson'); if(!state.profiles[state.selected]) state.profiles.push({profile:p,suggestedFile:(p.key??'profile')+'.json',source:'editor'}); else state.profiles[state.selected].profile=p; renderAll(); status('Applied profile JSON.', 'ok'); };
$('refreshProfileJson').onclick=()=>{ refreshProfileJson(); status('Refreshed profile JSON from form state.', 'ok'); };
$('addChannel').onclick=()=>{ const mode=selectedMode(); if(!mode) return; mode.channels ??= []; mode.channels.push({offset:mode.channels.length+1,key:'channel_'+(mode.channels.length+1)}); refreshProfileJson(); renderChannels(); };
$('addParameter').onclick=()=>{ const mode=selectedMode(); if(!mode) return; mode.parameters ??= {}; let i=Object.keys(mode.parameters).length+1; while(mode.parameters['parameter_'+i]) i++; mode.parameters['parameter_'+i]={type:'u8',channel:mode.channels?.[0]?.key ?? 'channel_1'}; refreshProfileJson(); renderParameters(); };
$('applyPatch').onclick=()=>{ state.patch=parseJson('patchJson'); renderPatch(); status('Applied patch JSON.', 'ok'); };
$('downloadProfile').onclick=()=>{ const e=selectedEntry(); if(e) download(e.suggestedFile ?? e.profile.key+'.json', e.profile); };
$('downloadPatch').onclick=()=>{ if(state.patch) download('patch.json', state.patch); };
$('downloadAll').onclick=()=>{ for(const e of state.profiles) download(e.suggestedFile ?? e.profile.key+'.json', e.profile); if(state.patch) download('patch.json', state.patch); };
$('copyProfile').onclick=()=>copyText($('profileJson').value); $('copyPatch').onclick=()=>copyText($('patchJson').value);
renderAll();
</script>
</body>
</html>`;
async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
        if (req.method === "GET" && url.pathname === "/api/health") {
            sendJson(res, 200, { ok: true, app: "bbb-dmx-fixture-editor" });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/convert") {
            const payload = await readJsonBody(req);
            sendJson(res, 200, await convertUploadedFile(payload));
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/validate") {
            const payload = await readJsonBody(req);
            sendJson(res, 200, await validateDocuments(payload));
            return;
        }
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
            send(res, 200, editorHtml, contentTypeForPath(url.pathname));
            return;
        }
        sendJson(res, 404, { error: "not found" });
    }
    catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
}
function createFixtureEditorServer() {
    return createServer((req, res) => {
        handle(req, res).catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }));
    });
}
function argValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function isCliEntrypoint() {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
if (isCliEntrypoint()) {
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
