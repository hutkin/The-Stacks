import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import { ComfyClient, loadConfig, renderWorkflow } from './lib/comfy.js';
import { lastFrame, mockClip, probe, stitch } from './lib/media.js';
import { topazAvailable, topazUpscale } from './lib/topaz.js';

const PORT = process.env.PORT || 8787;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const cfg = loadConfig();
const MOCK = !cfg;
const comfy = cfg ? new ComfyClient(cfg.comfyUrl) : null;
const jobs = [];
let working = false;

/* ---------- generation queue (one clip at a time; the GPU is the bottleneck) ---------- */
function enqueue(sessionId, segId) { jobs.push({ sessionId, segId }); pump(); }

async function pump() {
  if (working) return;
  working = true;
  while (jobs.length) {
    const { sessionId, segId } = jobs.shift();
    const s = store.getSession(sessionId);
    const seg = s?.segments.find((x) => x.id === segId);
    if (!seg) continue;
    seg.status = 'generating'; seg.error = null; store.save(s);
    try { await generate(s, seg); seg.status = 'done'; }
    catch (e) { seg.status = 'error'; seg.error = e.message; console.error(e); }
    store.save(s);
  }
  working = false;
}

async function generate(s, seg) {
  const set = s.settings;
  const out = path.join(store.clipsDir(s.id), `${seg.id}.mp4`);
  const prompt = [set.stylePrefix, seg.prompt].filter(Boolean).join(', ');

  // Continuity: start from the last frame of the previous enabled, finished clip.
  let prevFrame = null;
  if (set.continuity) {
    const i = s.segments.indexOf(seg);
    const prev = s.segments.slice(0, i).reverse().find((x) => x.enabled && x.status === 'done' && x.file);
    if (prev) {
      prevFrame = path.join(store.clipsDir(s.id), `${prev.id}_last.png`);
      if (!fs.existsSync(prevFrame)) await lastFrame(path.join(store.clipsDir(s.id), prev.file), prevFrame);
    }
  }
  seg.usedMode = prevFrame ? 'i2v' : 't2v';

  if (MOCK) {
    await new Promise((r) => setTimeout(r, 1200));
    await mockClip(out, { width: set.width, height: set.height, seed: seg.seed });
  } else {
    const wfCfg = cfg.workflows[seg.usedMode];
    if (!wfCfg) throw new Error(`No "${seg.usedMode}" workflow in config.json`);
    const params = { prompt, seed: seg.seed, width: set.width, height: set.height, frames: set.frames };
    if (prevFrame) params.image = await comfy.uploadImage(prevFrame);
    await comfy.generate(renderWorkflow(wfCfg, params), out);
  }
  seg.file = `${seg.id}.mp4`;
  seg.duration = (await probe(out)).duration;
  seg.trimStart = Math.min(seg.trimStart, seg.duration);
  if (seg.trimEnd > seg.duration) seg.trimEnd = 0;
  // Re-rendered clip invalidates its cached last frame.
  fs.rmSync(path.join(store.clipsDir(s.id), `${seg.id}_last.png`), { force: true });
}

// Resume anything interrupted by a restart.
for (const meta of store.listSessions()) {
  const s = store.getSession(meta.id);
  for (const seg of s.segments) if (['queued', 'generating'].includes(seg.status)) enqueue(s.id, seg.id);
}

/* ---------- http helpers ---------- */
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.png': 'image/png' };

function serveFile(req, res, file, download) {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size;
  const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'accept-ranges': 'bytes' };
  if (download) headers['content-disposition'] = `attachment; filename="${download}"`;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
    fs.createReadStream(file).pipe(res);
  }
}

const view = (s) => ({ ...s, mock: MOCK, topaz: topazAvailable(cfg) });
const clean = (n) => (n || 'session').replace(/[^\w-]+/g, '_');

/* ---------- routes ---------- */
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/sessions' && req.method === 'GET') return json(res, 200, store.listSessions());
    if (p === '/api/sessions' && req.method === 'POST') {
      const b = await readBody(req);
      const s = store.createSession(b.name);
      Object.assign(s.settings, cfg?.defaults);
      store.save(s);
      return json(res, 200, view(s));
    }

    let m = p.match(/^\/api\/sessions\/(\w+)(?:\/(.*))?$/);
    if (m) {
      const s = store.getSession(m[1]);
      if (!s) return json(res, 404, { error: 'no such session' });
      const rest = m[2] || '';

      if (rest === '' && req.method === 'GET') return json(res, 200, view(s));
      if (rest === '' && req.method === 'PATCH') {
        const b = await readBody(req);
        if (typeof b.name === 'string') s.name = b.name;
        if (b.settings) Object.assign(s.settings, b.settings);
        store.save(s); return json(res, 200, view(s));
      }

      if (rest === 'segments' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.text?.trim()) return json(res, 400, { error: 'empty text' });
        const seg = store.newSegment(s, b.text.trim());
        store.save(s); enqueue(s.id, seg.id);
        return json(res, 200, seg);
      }

      if (rest === 'order' && req.method === 'PUT') { // re-arrange the cut
        const { ids } = await readBody(req);
        const by = new Map(s.segments.map((x) => [x.id, x]));
        s.segments = [...ids.map((i) => by.get(i)).filter(Boolean), ...s.segments.filter((x) => !ids.includes(x.id))];
        store.save(s); return json(res, 200, view(s));
      }

      m = rest.match(/^segments\/(\w+)(?:\/(regenerate))?$/);
      if (m) {
        const seg = s.segments.find((x) => x.id === m[1]);
        if (!seg) return json(res, 404, { error: 'no such segment' });
        if (m[2] === 'regenerate' && req.method === 'POST') {
          const b = await readBody(req);
          if (b.prompt) seg.prompt = b.prompt;
          if (b.keepSeed !== true) seg.seed = Math.floor(Math.random() * 2 ** 31);
          seg.status = 'queued'; store.save(s); enqueue(s.id, seg.id);
          return json(res, 200, seg);
        }
        if (req.method === 'PATCH') {
          const b = await readBody(req);
          for (const k of ['prompt', 'enabled', 'trimStart', 'trimEnd']) if (b[k] !== undefined) seg[k] = b[k];
          store.save(s); return json(res, 200, seg);
        }
        if (req.method === 'DELETE') {
          s.segments = s.segments.filter((x) => x !== seg);
          if (seg.file) fs.rmSync(path.join(store.clipsDir(s.id), seg.file), { force: true });
          store.save(s); return json(res, 200, { ok: true });
        }
      }

      if (rest.startsWith('clips/')) return serveFile(req, res, path.join(store.clipsDir(s.id), path.basename(rest)));

      if (rest === 'export' || rest === 'upscale') {
        const clips = s.segments.filter((x) => x.enabled && x.status === 'done' && x.file)
          .map((x) => ({ path: path.join(store.clipsDir(s.id), x.file), trimStart: x.trimStart, trimEnd: x.trimEnd }));
        if (!clips.length) return json(res, 400, { error: 'no finished clips to export' });
        const dir = store.sessionDir(s.id);
        const cut = path.join(dir, 'export_cut.mp4');
        await stitch(clips, cut, { width: s.settings.width, height: s.settings.height, fps: s.settings.fps }, path.join(dir, 'tmp'));
        if (rest === 'export') return serveFile(req, res, cut, `${clean(s.name)}.mp4`);
        if (!topazAvailable(cfg)) return json(res, 501, { error: 'Topaz Video AI not configured (see README). Download the cut and upscale it in Topaz manually.' });
        const up = path.join(dir, 'export_topaz.mp4');
        await topazUpscale(cfg, cut, up, { filter: url.searchParams.get('filter') || undefined });
        return serveFile(req, res, up, `${clean(s.name)}_topaz.mp4`);
      }

      if (rest === 'download' && req.method === 'GET') { // whole session (clips + session.json) for archiving / re-opening
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${clean(s.name)}.tar.gz"` });
        const tar = spawn('tar', ['-czf', '-', '-C', store.DATA_DIR, '--exclude=tmp', '--exclude=export_*', s.id]);
        tar.stdout.pipe(res); return;
      }
    }

    if (p === '/api/import' && req.method === 'POST') { // restore a downloaded session archive
      const tmp = path.join(store.DATA_DIR, `.import_${Date.now()}`);
      fs.mkdirSync(tmp);
      await new Promise((ok, bad) => {
        const tar = spawn('tar', ['-xzf', '-', '-C', tmp]);
        tar.on('close', (c) => (c === 0 ? ok() : bad(new Error('bad archive'))));
        req.pipe(tar.stdin);
      });
      const [id] = fs.readdirSync(tmp);
      if (!id || !/^\w+$/.test(id) || fs.existsSync(store.sessionDir(id))) { fs.rmSync(tmp, { recursive: true }); return json(res, 400, { error: 'invalid or already-present session' }); }
      fs.renameSync(path.join(tmp, id), store.sessionDir(id)); fs.rmSync(tmp, { recursive: true });
      return json(res, 200, view(store.getSession(id)));
    }

    // static
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return json(res, 403, {});
    return serveFile(req, res, file);
  } catch (e) {
    console.error(e); json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`H3 Live Director on http://localhost:${PORT}  (${MOCK ? 'MOCK mode — no config.json' : 'ComfyUI ' + cfg.comfyUrl})`));
