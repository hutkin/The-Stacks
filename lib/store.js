import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data/sessions');
fs.mkdirSync(DATA_DIR, { recursive: true });

const cache = new Map();
const uid = () => crypto.randomBytes(5).toString('hex');

export const sessionDir = (id) => path.join(DATA_DIR, path.basename(id));
export const clipsDir = (id) => path.join(sessionDir(id), 'clips');
const file = (id) => path.join(sessionDir(id), 'session.json');

export function createSession(name) {
  const id = uid();
  fs.mkdirSync(clipsDir(id), { recursive: true });
  const s = {
    id, name: name || `Session ${new Date().toLocaleString()}`,
    createdAt: Date.now(), updatedAt: Date.now(),
    settings: { stylePrefix: '', continuity: true, width: 768, height: 432, frames: 121, fps: 24 },
    segments: [],
  };
  cache.set(id, s); save(s);
  return s;
}

export function getSession(id) {
  if (cache.has(id)) return cache.get(id);
  try {
    const s = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    cache.set(id, s);
    return s;
  } catch { return null; }
}

export function save(s) {
  s.updatedAt = Date.now();
  const tmp = file(s.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file(s.id));
}

export function listSessions() {
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => getSession(d.name))
    .filter(Boolean)
    .map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt, segments: s.segments.length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function newSegment(session, text, overrides = {}) {
  const seg = {
    id: uid(), text, prompt: text, seed: Math.floor(Math.random() * 2 ** 31),
    status: 'queued', error: null, file: null, usedMode: null,
    enabled: true, trimStart: 0, trimEnd: 0, // trimEnd 0 = full length
    duration: 0, createdAt: Date.now(), ...overrides,
  };
  session.segments.push(seg);
  return seg;
}
