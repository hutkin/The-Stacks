import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18787;
const base = `http://localhost:${PORT}/api`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-'));
const j = async (p, m = 'GET', b) => (await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) })).json();
let srv;

test.before(async () => {
  srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: data }, cwd: path.resolve('.') });
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/sessions'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
test.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });

test('talk -> clips -> re-edit -> export', async () => {
  const s = await j('/sessions', 'POST', {});
  assert.equal(s.mock, true);
  await j(`/sessions/${s.id}`, 'PATCH', { settings: { width: 320, height: 180 } });
  const a = await j(`/sessions/${s.id}/segments`, 'POST', { text: 'a red car on a beach' });
  const b = await j(`/sessions/${s.id}/segments`, 'POST', { text: 'camera pulls back' });
  let cur;
  for (let i = 0; i < 60; i++) {
    cur = await j(`/sessions/${s.id}`);
    if (cur.segments.every((x) => x.status === 'done')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.deepEqual(cur.segments.map((x) => x.status), ['done', 'done']);
  assert.equal(cur.segments[0].usedMode, 't2v');
  assert.equal(cur.segments[1].usedMode, 'i2v'); // continuity from clip 1's last frame

  await j(`/sessions/${s.id}/order`, 'PUT', { ids: [b.id, a.id] });
  await j(`/sessions/${s.id}/segments/${a.id}`, 'PATCH', { trimEnd: 1 });
  cur = await j(`/sessions/${s.id}`);
  assert.equal(cur.segments[0].id, b.id);

  const exp = await fetch(`${base}/sessions/${s.id}/export`);
  assert.equal(exp.status, 200);
  const buf = Buffer.from(await exp.arrayBuffer());
  assert.ok(buf.length > 1000);
  const up = await fetch(`${base}/sessions/${s.id}/upscale`);
  assert.equal(up.status, 501); // no Topaz configured -> clear message

  const tar = await fetch(`${base}/sessions/${s.id}/download`);
  assert.equal(tar.status, 200);
});
