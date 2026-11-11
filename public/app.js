const $ = (id) => document.getElementById(id);
const api = async (path, method = 'GET', body) => {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
let session = null, cut = [], cutIdx = -1, playing = false;
const cards = new Map();

/* ---------- sessions ---------- */
async function loadList(selectId) {
  const list = await api('/sessions');
  $('sessionPick').innerHTML = list.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.segments})</option>`).join('');
  if (selectId) $('sessionPick').value = selectId;
}
async function open(id) {
  localStorage.h3Session = id;
  session = await api(`/sessions/${id}`);
  cards.clear(); $('timeline').innerHTML = '';
  $('sessionName').value = session.name;
  $('continuity').checked = session.settings.continuity;
  $('style').value = session.settings.stylePrefix;
  $('w').value = session.settings.width; $('h').value = session.settings.height; $('frames').value = session.settings.frames;
  $('badge').textContent = session.mock ? 'MOCK mode (no config.json)' : 'ComfyUI connected';
  $('badge').className = session.mock ? 'mock' : '';
  $('upscaleBtn').title = session.topaz ? '' : 'Topaz not configured — see README';
  render();
}
$('newSession').onclick = async () => { const s = await api('/sessions', 'POST', {}); await loadList(s.id); open(s.id); };
$('sessionPick').onchange = (e) => open(e.target.value);
$('sessionName').onchange = (e) => api(`/sessions/${session.id}`, 'PATCH', { name: e.target.value }).then(() => loadList(session.id));
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async (e) => {
  const r = await fetch('/api/import', { method: 'POST', body: e.target.files[0] });
  const j = await r.json(); if (!r.ok) return flash(j.error);
  await loadList(j.id); open(j.id);
};
const saveSettings = () => api(`/sessions/${session.id}`, 'PATCH', { settings: {
  continuity: $('continuity').checked, stylePrefix: $('style').value,
  width: +$('w').value, height: +$('h').value, frames: +$('frames').value } });
['continuity', 'style', 'w', 'h', 'frames'].forEach((i) => ($(i).onchange = saveSettings));

/* ---------- director: speech -> segments ---------- */
async function send(text) {
  text = text.trim(); if (!text) return;
  try { await saveSettings(); await api(`/sessions/${session.id}/segments`, 'POST', { text }); poll(); }
  catch (e) { flash(e.message); }
}
$('sendNow').onclick = () => { flushBuffer(); };
$('typed').onkeydown = (e) => { if (e.key === 'Enter') { send($('typed').value); $('typed').value = ''; } };

let buffer = '', timer = null, rec = null, listening = false;
function flushBuffer() { clearTimeout(timer); const t = buffer; buffer = ''; $('final').textContent = ''; $('interim').textContent = ''; send(t); }

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) $('speechHint').textContent = 'Live speech needs Chrome/Edge/Safari. You can still type shots.';
else $('speechHint').textContent = 'Speak naturally; each pause sends a shot. (Browser speech recognition may stream audio to the browser vendor.)';

$('mic').onclick = () => {
  if (!SR) return;
  if (listening) { listening = false; rec.stop(); return; }
  rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) { buffer += ' ' + r[0].transcript; } else interim += r[0].transcript;
    }
    $('final').textContent = buffer; $('interim').textContent = interim;
    clearTimeout(timer);
    timer = setTimeout(flushBuffer, +$('pause').value * 1000);
  };
  rec.onend = () => { if (listening) rec.start(); else setMic(false); }; // Chrome stops after silence; keep going
  rec.onerror = (e) => { if (e.error !== 'no-speech') flash('Mic: ' + e.error); };
  listening = true; rec.start(); setMic(true);
};
function setMic(on) { $('mic').textContent = on ? '■ Stop (listening…)' : '🎙 Start talking'; $('mic').classList.toggle('on', on); if (!on) flushBuffer(); }

/* ---------- timeline / re-edit ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const seg$ = (id, path = '', m = 'PATCH', b) => api(`/sessions/${session.id}/segments/${id}${path}`, m, b);

function render() {
  const tl = $('timeline');
  const ids = session.segments.map((s) => s.id);
  for (const [id, c] of cards) if (!ids.includes(id)) { c.el.remove(); cards.delete(id); }
  session.segments.forEach((s, i) => {
    let c = cards.get(s.id);
    if (!c) { c = { el: document.createElement('div'), file: null }; c.el.className = 'card'; cards.set(s.id, c); buildCard(c, s); }
    const el = c.el;
    el.classList.toggle('disabled', !s.enabled);
    el.querySelector('.n').textContent = `#${i + 1} · ${s.usedMode || '…'}`;
    const st = el.querySelector('.st'); st.textContent = s.status; st.className = 'st st-' + s.status;
    el.querySelector('.err').textContent = s.error || '';
    const ta = el.querySelector('textarea'); if (document.activeElement !== ta && !ta.dataset.dirty) ta.value = s.prompt;
    el.querySelector('.en').textContent = s.enabled ? 'Mute' : 'Unmute';
    if (s.file && c.file !== s.file + s.seed) { c.file = s.file + s.seed; el.querySelector('.vid').innerHTML = `<video src="/api/sessions/${session.id}/clips/${s.file}?v=${s.seed}" muted loop playsinline></video>`; }
    if (!s.file) el.querySelector('.vid').innerHTML = `<div class="ph">${s.status === 'error' ? '⚠' : '⏳ ' + s.status}</div>`, c.file = null;
    el.querySelector('.ts').value = s.trimStart || 0; el.querySelector('.te').value = s.trimEnd || 0;
    el.querySelector('.dur').textContent = s.duration ? `${s.duration.toFixed(1)}s` : '';
    if (tl.children[i] !== el) tl.insertBefore(el, tl.children[i] || null);
  });
  const done = session.segments.filter((s) => s.enabled && s.file);
  const total = done.reduce((a, s) => a + ((s.trimEnd || s.duration) - (s.trimStart || 0)), 0);
  $('status').style.color = 'var(--mute)'; $('status').textContent = `${done.length} clips in cut · ${total.toFixed(1)}s`;
}

function buildCard(c, s) {
  c.el.innerHTML = `<div class="vid"></div>
    <div class="meta"><span class="n"></span><span class="dur"></span><span class="st"></span></div>
    <textarea></textarea><div class="err st-error"></div>
    <div class="trim">in <input class="ts" type="number" step="0.1" min="0"> out <input class="te" type="number" step="0.1" min="0"></div>
    <div class="actions"><button class="up">←</button><button class="dn">→</button><button class="en"></button><button class="re">↻ Redo</button><button class="del">✕</button></div>`;
  const q = (x) => c.el.querySelector(x);
  q('textarea').oninput = (e) => (e.target.dataset.dirty = 1);
  q('textarea').onchange = async (e) => { await seg$(s.id, '', 'PATCH', { prompt: e.target.value }); delete e.target.dataset.dirty; };
  q('.re').onclick = async () => { const ta = q('textarea'); await seg$(s.id, '/regenerate', 'POST', { prompt: ta.value }); delete ta.dataset.dirty; poll(); };
  q('.en').onclick = async () => { const cur = session.segments.find((x) => x.id === s.id); await seg$(s.id, '', 'PATCH', { enabled: !cur.enabled }); poll(); };
  q('.del').onclick = async () => { await seg$(s.id, '', 'DELETE'); poll(); };
  q('.ts').onchange = (e) => seg$(s.id, '', 'PATCH', { trimStart: +e.target.value });
  q('.te').onchange = (e) => seg$(s.id, '', 'PATCH', { trimEnd: +e.target.value });
  const move = (d) => async () => {
    const ids = session.segments.map((x) => x.id), i = ids.indexOf(s.id), j = i + d;
    if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]];
    session = await api(`/sessions/${session.id}/order`, 'PUT', { ids }); render();
  };
  q('.up').onclick = move(-1); q('.dn').onclick = move(1);
  c.el.onmouseenter = () => q('video')?.play().catch(() => {}); c.el.onmouseleave = () => q('video')?.pause();
}

/* ---------- cut player ---------- */
const P = $('player');
function playIdx(i) {
  cut = session.segments.filter((s) => s.enabled && s.file);
  if (i >= cut.length) { playing = false; cards.forEach((c) => c.el.classList.remove('playing')); return; }
  cutIdx = i; playing = true; const s = cut[i];
  P.src = `/api/sessions/${session.id}/clips/${s.file}?v=${s.seed}`;
  P.onloadedmetadata = () => { P.currentTime = s.trimStart || 0; P.play(); };
  cards.forEach((c, id) => c.el.classList.toggle('playing', id === s.id));
}
P.ontimeupdate = () => { const s = cut[cutIdx]; if (playing && s && s.trimEnd > 0 && P.currentTime >= s.trimEnd) playIdx(cutIdx + 1); };
P.onended = () => { if (playing) playIdx(cutIdx + 1); };
$('playCut').onclick = () => playIdx(0);

/* ---------- export ---------- */
$('exportBtn').onclick = () => { location.href = `/api/sessions/${session.id}/export`; };
$('archiveBtn').onclick = () => { location.href = `/api/sessions/${session.id}/download`; };
$('upscaleBtn').onclick = async () => {
  if (!session.topaz) return flash('Topaz Video AI not configured — download the cut and upscale it in Topaz manually (see README).');
  $('upscaleBtn').disabled = true; flash('Upscaling in Topaz… this can take a while.', true);
  try {
    const r = await fetch(`/api/sessions/${session.id}/upscale`);
    if (!r.ok) throw new Error((await r.json()).error);
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `${session.name}_topaz.mp4`; a.click(); flash('Upscale done.', true);
  } catch (e) { flash(e.message); } finally { $('upscaleBtn').disabled = false; }
};
function flash(msg, ok) { $('status').style.color = ok ? 'var(--ok)' : 'var(--err)'; $('status').textContent = msg; }

/* ---------- polling + live follow ---------- */
let prevDone = new Set();
async function poll() {
  if (!session) return;
  try {
    const fresh = await api(`/sessions/${session.id}`);
    const doneNow = new Set(fresh.segments.filter((s) => s.status === 'done').map((s) => s.id));
    const newly = [...doneNow].filter((id) => !prevDone.has(id));
    prevDone = doneNow; session = fresh; render();
    if (newly.length && $('follow').checked && (P.paused || P.ended || !playing)) {
      const idx = session.segments.filter((s) => s.enabled && s.file).findIndex((s) => s.id === newly[0]);
      if (idx >= 0) playIdx(idx);
    }
  } catch {}
}
setInterval(poll, 1500);

(async () => {
  let list = await api('/sessions');
  if (!list.length) { await api('/sessions', 'POST', {}); list = await api('/sessions'); }
  const id = list.find((s) => s.id === localStorage.h3Session)?.id || list[0].id;
  await loadList(id); await open(id);
  prevDone = new Set(session.segments.filter((s) => s.status === 'done').map((s) => s.id));
})();
