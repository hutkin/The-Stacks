import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve('config.json'), 'utf8'));
  } catch {
    return null; // -> mock mode
  }
}

/** Fill a ComfyUI API-format workflow using the config's {param: [nodeId, inputName]} map. */
export function renderWorkflow(wfCfg, params) {
  const wf = JSON.parse(fs.readFileSync(path.resolve(wfCfg.file), 'utf8'));
  for (const [key, target] of Object.entries(wfCfg.map)) {
    if (params[key] === undefined) continue;
    const [nodeId, input] = target;
    if (!wf[nodeId]) throw new Error(`workflow ${wfCfg.file}: node ${nodeId} (for "${key}") not found`);
    wf[nodeId].inputs[input] = params[key];
  }
  return wf;
}

export class ComfyClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, '');
    this.clientId = crypto.randomUUID();
  }

  async uploadImage(pngPath) {
    const form = new FormData();
    const name = `director_${Date.now()}.png`;
    form.append('image', new Blob([fs.readFileSync(pngPath)]), name);
    form.append('overwrite', 'true');
    const r = await fetch(`${this.base}/upload/image`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`ComfyUI upload failed: ${r.status}`);
    return (await r.json()).name;
  }

  async generate(workflow, outFile, { timeoutMs = 20 * 60_000 } = {}) {
    const r = await fetch(`${this.base}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (!r.ok) throw new Error(`ComfyUI rejected workflow: ${r.status} ${(await r.text()).slice(0, 500)}`);
    const { prompt_id: id } = await r.json();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1500);
      const h = await (await fetch(`${this.base}/history/${id}`)).json();
      const entry = h[id];
      if (!entry) continue;
      if (entry.status?.status_str === 'error') throw new Error('ComfyUI execution error (see ComfyUI console)');
      if (!entry.outputs || !Object.keys(entry.outputs).length) continue;
      const f = findVideo(entry.outputs);
      if (!f) throw new Error('Workflow finished but produced no video output (use a Save/Video Combine node)');
      const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
      const v = await fetch(`${this.base}/view?${q}`);
      if (!v.ok) throw new Error(`Could not fetch output: ${v.status}`);
      fs.writeFileSync(outFile, Buffer.from(await v.arrayBuffer()));
      return;
    }
    throw new Error('Timed out waiting for ComfyUI');
  }
}

function findVideo(outputs) {
  for (const o of Object.values(outputs)) {
    for (const key of ['videos', 'gifs', 'images']) {
      const hit = (o[key] || []).find((f) => /\.(mp4|webm|mov|mkv)$/i.test(f.filename));
      if (hit) return hit;
    }
  }
  return null;
}
