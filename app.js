// Lipsync Studio – perfekt synchrone Lipsync-Videos zu eigenen Songs.
// Prinzip: Song wird nur abgespielt, die Kamera nimmt NUR Video auf (kein Mikro).
// Im Export wird der Original-Song digital eingebettet und um die gemessene
// Kopfhörer-Latenz verschoben.

import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  QUALITY_HIGH, canEncodeVideo, canEncodeAudio,
} from 'mediabunny';

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
};
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

const FPS = 30;
const OUT_W = 1080;
const OUT_H = 1920;

// ------------------------------------------------------------------ storage
const DB_NAME = 'lipsync-studio';
let dbP;
function db() {
  if (!dbP) {
    dbP = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('takes')) {
          const t = d.createObjectStore('takes', { keyPath: 'id' });
          t.createIndex('songId', 'songId');
        }
        if (!d.objectStoreNames.contains('templates')) d.createObjectStore('templates', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbP;
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const putSong = (s) => idb('songs', 'readwrite', (st) => st.put(s));
const getSong = (id) => idb('songs', 'readonly', (st) => st.get(id));
const putTake = (t) => idb('takes', 'readwrite', (st) => st.put(t));
const delTake = (id) => idb('takes', 'readwrite', (st) => st.delete(id));
const delSong = (id) => idb('songs', 'readwrite', (st) => st.delete(id));
const takesFor = (songId) => idb('takes', 'readonly', (st) => st.index('songId').getAll(songId));
const putTemplate = (t) => idb('templates', 'readwrite', (st) => st.put(t));
const getTemplate = (id) => idb('templates', 'readonly', (st) => st.get(id));
const delTemplate = (id) => idb('templates', 'readwrite', (st) => st.delete(id));
const allTemplates = () => idb('templates', 'readonly', (st) => st.getAll());

const LS = {
  get(k, d) { try { const v = localStorage.getItem('ls_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ls_' + k, JSON.stringify(v)); } catch {} },
};

// ------------------------------------------------------------------ state
const DEFAULT_PROFILES = {
  bt: { name: 'AirPods / Bluetooth', short: 'AirPods', defaultMs: 180, latencyMs: null, measuredAt: null },
  wired: { name: 'Kabelkopfhörer', short: 'Kabel', defaultMs: 15, latencyMs: null, measuredAt: null },
  speaker: { name: 'Handy-Lautsprecher', short: 'Lautsprecher', defaultMs: 30, latencyMs: null, measuredAt: null },
};
const S = {
  ctx: null,
  song: null, // {id, name, blob, buffer, peaks, selStart, selEnd}
  templateId: null, // aktuell geladene Vorlage
  templatesCache: [],
  profiles: Object.assign(structuredClone(DEFAULT_PROFILES), LS.get('profiles', {})),
  profileId: LS.get('profileId', 'bt'),
  preroll: LS.get('preroll', 2),
  mirror: LS.get('mirror', true),
  stream: null,
  take: null, // aktueller Take (mit Laufzeit-Objekten)
  exportFile: null,
};
function profile() { return S.profiles[S.profileId] || S.profiles.bt; }
function profileLatency(p = profile()) { return p.latencyMs ?? p.defaultMs; }
function saveProfiles() {
  const out = {};
  for (const [k, p] of Object.entries(S.profiles)) out[k] = { latencyMs: p.latencyMs, measuredAt: p.measuredAt };
  LS.set('profiles', out);
  LS.set('profileId', S.profileId);
}

// ------------------------------------------------------------------ audio
function makeCtx() {
  if (!S.ctx) {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    S.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  }
  return S.ctx;
}
async function ensureCtx() {
  makeCtx();
  // resume() kann auf iOS ohne frische Nutzer-Geste ewig hängen -> mit Timeout
  if (S.ctx.state !== 'running') await Promise.race([S.ctx.resume().catch(() => {}), sleep(1500)]);
  // kurz warten, bis die Ausgabe-Uhr läuft (für getOutputTimestamp)
  for (let i = 0; i < 20 && S.ctx.currentTime < 0.05; i++) await sleep(20);
  return S.ctx;
}

// Rechnet eine AudioContext-Zeit in performance.now()-Zeit um.
// Immer dieselbe Methode für Kalibrierung und Aufnahme -> konstante Fehler kürzen sich weg.
function ctxToPerf(t) {
  const ctx = S.ctx;
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
      return ts.performanceTime + (t - ts.contextTime) * 1000;
    }
  }
  return performance.now() + (t - ctx.currentTime) * 1000;
}

function click(t, freq = 1500, gain = 0.7) {
  const ctx = S.ctx;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.08);
}

function computePeaks(buffer, n = 600) {
  const ch = buffer.getChannelData(0);
  const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const block = Math.floor(ch.length / n) || 1;
  const peaks = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const start = i * block;
    const end = Math.min(ch.length, start + block);
    for (let j = start; j < end; j += 16) {
      const v = Math.abs(ch[j]) + (ch2 ? Math.abs(ch2[j]) : 0);
      if (v > m) m = v;
    }
    peaks[i] = m;
    if (m > max) max = m;
  }
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max;
  return peaks;
}

// ------------------------------------------------------------------ screens
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => { stopCalibration(); show('screen-home'); }));

// ------------------------------------------------------------------ song
$('song-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  toast('Song wird geladen …', 60000);
  try {
    // Datei sofort komplett in den Speicher holen (iOS-Dateien können sonst später unlesbar werden)
    const data = await file.arrayBuffer();
    e.target.value = '';
    const blob = new Blob([data], { type: file.type || guessType(file.name) });
    makeCtx(); // NICHT auf resume() warten: nach dem Datei-Dialog erlaubt iOS das nicht und es hängt
    S.templateId = null; LS.set('templateId', null);
    await loadSong({ id: 'song-' + Date.now(), name: file.name.replace(/\.[^.]+$/, ''), blob, selStart: null, selEnd: null }, true);
    toast('Geladen! Startpunkt wählen und als Vorlage speichern', 3500);
  } catch (err) {
    console.error(err);
    e.target.value = '';
    toast(`Datei konnte nicht gelesen werden (${(err && (err.name || err.message)) || 'Fehler'}). Unterstützt: MP3, WAV, M4A, AIFF, FLAC.`, 6000);
  }
});
function guessType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac' }[ext] || '';
}

async function decode(blob) {
  const ctx = makeCtx();
  try {
    const ab = await blob.arrayBuffer();
    return await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  } catch (err) {
    // Fallback: z. B. 32-Bit-Float-WAV oder Formate, die Safari nicht selbst dekodiert
    console.warn('decodeAudioData fehlgeschlagen, nutze Fallback-Decoder', err);
    return await decodeFallback(blob);
  }
}

async function decodeFallback(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('Keine Audiospur gefunden');
  const sink = new AudioBufferSink(track);
  const parts = [];
  let sr = track.sampleRate, ch = track.numberOfChannels, total = 0;
  const first = await track.getFirstTimestamp();
  for await (const { buffer, timestamp } of sink.buffers()) {
    sr = buffer.sampleRate; ch = buffer.numberOfChannels;
    const offset = Math.max(0, Math.round((timestamp - first) * sr));
    parts.push({ buffer, offset });
    total = Math.max(total, offset + buffer.length);
  }
  if (!total) throw new Error('Leere Audiodatei');
  const out = new AudioBuffer({ length: total, numberOfChannels: ch, sampleRate: sr });
  for (let c = 0; c < ch; c++) {
    const dst = out.getChannelData(c);
    for (const { buffer, offset } of parts) dst.set(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).subarray(0, total - offset), offset);
  }
  return out;
}

async function loadSong(rec, isNew) {
  const buffer = await decode(rec.blob);
  const dur = buffer.duration;
  if (rec.selStart == null) {
    rec.selStart = Math.min(dur * 0.25, Math.max(0, dur - 20));
    rec.selEnd = Math.min(dur, rec.selStart + 20);
  }
  S.song = { ...rec, buffer, peaks: computePeaks(buffer) };
  LS.set('songId', rec.id);
  if (isNew) {
    try { await putSong({ id: rec.id, name: rec.name, blob: rec.blob, selStart: rec.selStart, selEnd: rec.selEnd }); }
    catch (err) { console.warn(err); toast('Song geladen, aber nicht dauerhaft gespeichert (Speicher voll / privater Modus?).', 5000); }
  }
  renderHome();
  drawWave();
  await renderTakes();
  await renderTemplates();
}

let saveSelTimer;
function persistSel() {
  clearTimeout(saveSelTimer);
  saveSelTimer = setTimeout(() => {
    const s = S.song;
    if (s) putSong({ id: s.id, name: s.name, blob: s.blob, selStart: s.selStart, selEnd: s.selEnd });
  }, 400);
}

function renderHome() {
  const has = !!S.song;
  $('empty-song').hidden = has;
  $('song-area').hidden = !has;
  if (has) {
    const s = S.song;
    const tpl = S.templateId && S.templatesCache.find((t) => t.id === S.templateId);
    $('hero-eyebrow').textContent = tpl ? `Vorlage · ${s.name}` : 'Heute performst du';
    $('song-title').textContent = tpl ? tpl.name : s.name;
    $('btn-save-template').textContent = tpl ? (tpl.selStart === s.selStart && tpl.selEnd === s.selEnd ? 'Vorlage gespeichert ✓' : 'Vorlage aktualisieren') : 'Als Vorlage speichern';
    $('btn-save-as-new').hidden = !tpl;
    $('song-sel-label').textContent = `Ausschnitt ${fmt(s.selStart)} – ${fmt(s.selEnd)}`;
    $('sel-start').textContent = fmt(s.selStart);
    $('sel-end').textContent = fmt(s.selEnd);
    $('sel-len').textContent = `${(s.selEnd - s.selStart).toFixed(1).replace('.', ',')} Sekunden`;
  }
  const p = profile();
  $('profile-name').textContent = p.short;
  $('latency-value').textContent = p.latencyMs != null ? `${Math.round(p.latencyMs)} ms ✓` : 'messen';
  $('chip-preroll').textContent = `Vorlauf ${S.preroll} s`;
  $('chip-mirror').textContent = S.mirror ? 'Spiegeln an' : 'Spiegeln aus';
  $('chip-mirror').classList.toggle('on', S.mirror);
}

// ------------------------------------------------------------------ waveform + selection
const wave = $('wave');
function drawWave() {
  if (!S.song) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wave.clientWidth, h = wave.clientHeight;
  if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
  const g = wave.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim();
  const line = css.getPropertyValue('--line').trim();
  const ter = css.getPropertyValue('--ter').trim();
  const dur = S.song.buffer.duration;
  const bars = Math.floor(w / 5);
  const peaks = S.song.peaks;
  for (let i = 0; i < bars; i++) {
    const t = (i + 0.5) / bars * dur;
    const p = peaks[Math.floor((i / bars) * peaks.length)];
    const bh = Math.max(3, p * (h - 8));
    g.fillStyle = t >= S.song.selStart && t <= S.song.selEnd ? accent : line;
    roundRect(g, i * 5, h - bh, 3, bh, 1.5);
  }
  // Griffe
  g.fillStyle = ter;
  for (const t of [S.song.selStart, S.song.selEnd]) {
    const x = (t / dur) * w;
    roundRect(g, clamp(x - 2, 0, w - 4), 0, 4, h, 2);
  }
  // Wiedergabe-Position
  if (listen.playing) {
    const x = (listen.pos() / dur) * w;
    g.fillStyle = css.getPropertyValue('--text').trim();
    g.fillRect(x - 1, 0, 2, h);
  }
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
  g.fill();
}
window.addEventListener('resize', drawWave);

let drag = null;
wave.addEventListener('pointerdown', (e) => {
  if (!S.song) return;
  wave.setPointerCapture(e.pointerId);
  const dur = S.song.buffer.duration;
  const t = (e.offsetX / wave.clientWidth) * dur;
  const dS = Math.abs(t - S.song.selStart), dE = Math.abs(t - S.song.selEnd);
  const tol = dur * 0.04;
  if (Math.min(dS, dE) < tol) drag = { kind: dS < dE ? 'start' : 'end' };
  else if (t > S.song.selStart && t < S.song.selEnd) drag = { kind: 'move', off: t - S.song.selStart };
  else drag = { kind: t < S.song.selStart ? 'start' : 'end' };
  onDrag(e);
});
wave.addEventListener('pointermove', (e) => drag && onDrag(e));
wave.addEventListener('pointerup', () => { drag = null; persistSel(); });
wave.addEventListener('pointercancel', () => { drag = null; });
function onDrag(e) {
  const s = S.song, dur = s.buffer.duration;
  const t = clamp((e.offsetX / wave.clientWidth) * dur, 0, dur);
  const MIN = 3;
  if (drag.kind === 'start') s.selStart = clamp(t, 0, s.selEnd - MIN);
  else if (drag.kind === 'end') s.selEnd = clamp(t, s.selStart + MIN, dur);
  else {
    const len = s.selEnd - s.selStart;
    s.selStart = clamp(t - drag.off, 0, dur - len);
    s.selEnd = s.selStart + len;
  }
  renderHome();
  drawWave();
}
document.querySelectorAll('[data-len]').forEach((b) => b.addEventListener('click', () => {
  const s = S.song; if (!s) return;
  const len = Number(b.dataset.len), dur = s.buffer.duration;
  s.selEnd = Math.min(dur, s.selStart + len);
  if (s.selEnd - s.selStart < len) s.selStart = Math.max(0, s.selEnd - len);
  renderHome(); drawWave(); persistSel();
}));

// Ausschnitt anhören
const listen = {
  playing: false, src: null, t0: 0, from: 0,
  pos() { return this.from + (S.ctx.currentTime - this.t0); },
  stop() {
    if (this.src) { try { this.src.stop(); } catch {} }
    this.src = null; this.playing = false;
    $('btn-listen').textContent = 'Anhören';
    $('btn-listen').classList.remove('on');
    $('btn-set-start').hidden = true;
    drawWave();
  },
};
$('btn-listen').addEventListener('click', () => (listen.playing ? listen.stop() : startListen(S.song.selStart, S.song.selEnd)));
$('btn-listen-before').addEventListener('click', () => {
  if (listen.playing) listen.stop();
  const s = S.song;
  startListen(Math.max(0, s.selStart - 5), s.buffer.duration);
});
$('btn-set-start').addEventListener('click', () => {
  if (!listen.playing) return;
  const s = S.song;
  const len = s.selEnd - s.selStart;
  // Wahrgenommene Position: Ausgabe-Latenz des Kopfhörers abziehen
  const heard = listen.pos() - profileLatency() / 1000;
  s.selStart = clamp(heard, 0, Math.max(0, s.buffer.duration - 3));
  s.selEnd = Math.min(s.buffer.duration, s.selStart + len);
  listen.stop();
  renderHome(); drawWave(); persistSel();
  toast(`Start auf ${fmt(s.selStart)} gesetzt`);
});
document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
  const s = S.song; if (!s) return;
  const d = Number(b.dataset.nudge);
  const len = s.selEnd - s.selStart;
  s.selStart = clamp(Math.round((s.selStart + d) * 10) / 10, 0, Math.max(0, s.buffer.duration - 3));
  s.selEnd = Math.min(s.buffer.duration, s.selStart + len);
  renderHome(); drawWave(); persistSel();
}));
async function startListen(from, to) {
  const ctx = await ensureCtx();
  const s = S.song;
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.connect(ctx.destination);
  listen.t0 = ctx.currentTime + 0.05;
  listen.from = from;
  src.start(listen.t0, from, to - from);
  src.onended = () => { if (listen.src === src) listen.stop(); };
  listen.src = src; listen.playing = true;
  $('btn-listen').textContent = 'Stopp';
  $('btn-listen').classList.add('on');
  $('btn-set-start').hidden = false;
  const tick = () => { if (!listen.playing) return; drawWave(); requestAnimationFrame(tick); };
  tick();
}

// Optionen
$('chip-preroll').addEventListener('click', () => {
  const opts = [0, 1, 2, 4];
  S.preroll = opts[(opts.indexOf(S.preroll) + 1) % opts.length];
  LS.set('preroll', S.preroll); renderHome();
});
$('chip-mirror').addEventListener('click', () => { S.mirror = !S.mirror; LS.set('mirror', S.mirror); renderHome(); });

// Profil-Auswahl
$('tile-profile').addEventListener('click', () => {
  const box = $('profile-options');
  box.innerHTML = '';
  for (const [id, p] of Object.entries(S.profiles)) {
    const b = document.createElement('button');
    b.className = 'profile-opt' + (id === S.profileId ? ' on' : '');
    const name = document.createElement('span'); name.textContent = p.name;
    const val = document.createElement('span'); val.className = 'muted';
    val.textContent = p.latencyMs != null ? `${Math.round(p.latencyMs)} ms` : 'nicht gemessen';
    b.append(name, val);
    b.addEventListener('click', () => {
      S.profileId = id; saveProfiles(); renderHome();
      box.querySelectorAll('.profile-opt').forEach((x) => x.classList.toggle('on', x === b));
    });
    box.append(b);
  }
  $('sheet-profile').hidden = false;
});
$('sheet-profile').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.hasAttribute('data-close')) $('sheet-profile').hidden = true;
});

// ------------------------------------------------------------------ Vorlagen
async function renderTemplates() {
  let list = [];
  try { list = (await allTemplates()) || []; } catch {}
  list.sort((a, b) => (b.usedAt || b.createdAt) - (a.usedAt || a.createdAt));
  S.templatesCache = list;
  $('templates-section').hidden = list.length === 0 && !S.song;
  const ul = $('templates-list');
  ul.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'Noch keine Vorlagen – Song laden, Start wählen, speichern.';
    ul.append(li);
  }
  for (const t of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'tpl' + (t.id === S.templateId ? ' on' : '');
    const n = document.createElement('span'); n.className = 'tpl-name'; n.textContent = t.name;
    const sub = document.createElement('span'); sub.className = 'tpl-sub';
    sub.textContent = `${t.songName} · ab ${fmt(t.selStart)} · ${Math.round(t.selEnd - t.selStart)} s`;
    b.append(n, sub);
    b.addEventListener('click', () => openTemplate(t.id));
    const del = document.createElement('button');
    del.className = 'tpl-del';
    del.setAttribute('aria-label', `Vorlage ${t.name} löschen`);
    del.textContent = '✕';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Vorlage „${t.name}“ löschen?`)) return;
      await delTemplate(t.id);
      if (S.templateId === t.id) { S.templateId = null; LS.set('templateId', null); }
      await renderTemplates(); renderHome();
    });
    li.append(b, del);
    ul.append(li);
  }
  renderHome();
}

async function openTemplate(id) {
  if (listen.playing) listen.stop();
  const t = await getTemplate(id);
  if (!t) return;
  const song = await getSong(t.songId);
  if (!song) { toast('Die Song-Datei dieser Vorlage fehlt.'); return; }
  t.usedAt = Date.now(); putTemplate(t);
  S.templateId = id; LS.set('templateId', id);
  if (S.song && S.song.id === song.id) {
    S.song.selStart = t.selStart; S.song.selEnd = t.selEnd;
    persistSel(); renderHome(); drawWave(); await renderTemplates();
  } else {
    await loadSong({ ...song, selStart: t.selStart, selEnd: t.selEnd }, false);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function saveTemplate(asNew) {
  const s = S.song; if (!s) return;
  const existing = !asNew && S.templateId && (await getTemplate(S.templateId));
  if (existing) {
    existing.selStart = s.selStart; existing.selEnd = s.selEnd; existing.usedAt = Date.now();
    await putTemplate(existing);
    toast('Vorlage aktualisiert');
  } else {
    const def = `${s.name} · ab ${fmt(s.selStart)}`;
    const name = (prompt('Name der Vorlage (z. B. „Hook“, „Strophe 2“):', def) || '').trim();
    if (!name) return;
    const t = { id: 'tpl-' + Date.now(), name, songId: s.id, songName: s.name, selStart: s.selStart, selEnd: s.selEnd, createdAt: Date.now(), usedAt: Date.now() };
    await putSong({ id: s.id, name: s.name, blob: s.blob, selStart: s.selStart, selEnd: s.selEnd });
    await putTemplate(t);
    S.templateId = t.id; LS.set('templateId', t.id);
    toast(`Vorlage „${name}“ gespeichert`);
  }
  await renderTemplates();
}
$('btn-save-template').addEventListener('click', () => saveTemplate(false));
$('btn-save-as-new').addEventListener('click', () => saveTemplate(true));

// ------------------------------------------------------------------ calibration (Tap-Test)
const CAL = { lead: 4, count: 16, interval: 0.75 };
const cal = { running: false, taps: [], clicks: [], timer: null, result: null };

$('tile-latency').addEventListener('click', openCalibration);
function openCalibration() {
  stopCalibration();
  $('calib-profile').textContent = profile().name;
  $('tap-count').textContent = 'Start';
  $('tap-sub').textContent = 'tippen zum Starten';
  $('calib-result').hidden = true;
  $('calib-actions').hidden = true;
  show('screen-calib');
}
function stopCalibration() {
  cal.running = false;
  clearTimeout(cal.timer);
}
function perfStamp(e) {
  const now = performance.now();
  return e && e.timeStamp && Math.abs(e.timeStamp - now) < 1000 ? e.timeStamp : now;
}
$('tap-pad').addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  if (cal.running) {
    cal.taps.push(perfStamp(e));
    const pad = $('tap-pad');
    pad.classList.add('flash'); setTimeout(() => pad.classList.remove('flash'), 80);
    $('tap-count').textContent = String(cal.taps.length);
    return;
  }
  if (!$('calib-actions').hidden) return;
  await startCalibration();
});
async function startCalibration() {
  const ctx = await ensureCtx();
  cal.taps = []; cal.clicks = []; cal.running = true;
  const T0 = ctx.currentTime + 0.8;
  const base = ctxToPerf(T0);
  const n = CAL.lead + CAL.count;
  for (let i = 0; i < n; i++) {
    const t = T0 + i * CAL.interval;
    click(t, i < CAL.lead ? 900 : 1500);
    if (i >= CAL.lead) cal.clicks.push(base + i * CAL.interval * 1000);
  }
  $('tap-count').textContent = '0';
  $('tap-sub').textContent = 'im Takt tippen …';
  cal.timer = setTimeout(finishCalibration, (0.8 + n * CAL.interval + 0.7) * 1000);
}
function evaluateTaps(taps, clicks) {
  // Jedem Klick höchstens einen Tap zuordnen (Fenster −250 … +550 ms)
  const used = new Set();
  const diffs = [];
  for (const tp of taps) {
    let best = -1, bestD = 0;
    clicks.forEach((c, i) => {
      const d = tp - c;
      if (d > -250 && d < 550 && !used.has(i) && (best < 0 || Math.abs(d - 150) < Math.abs(bestD - 150))) { best = i; bestD = d; }
    });
    if (best >= 0) { used.add(best); diffs.push(bestD); }
  }
  if (diffs.length < 8) return null;
  const m = median(diffs);
  const mad = median(diffs.map((d) => Math.abs(d - m)));
  // Ausreißer raus, dann neu
  const clean = diffs.filter((d) => Math.abs(d - m) <= Math.max(40, 3 * mad));
  const m2 = median(clean);
  const mad2 = median(clean.map((d) => Math.abs(d - m2)));
  return { latencyMs: m2, spreadMs: mad2, n: clean.length };
}
function finishCalibration() {
  if (!cal.running) return;
  cal.running = false;
  const r = evaluateTaps(cal.taps, cal.clicks);
  $('calib-result').hidden = false;
  $('calib-actions').hidden = false;
  if (!r) {
    cal.result = null;
    $('calib-result-text').textContent = 'Zu wenige Taps';
    $('calib-result-sub').textContent = 'Tippe bei jedem Klick mit';
    $('calib-accept').disabled = true;
    $('tap-count').textContent = '–';
    $('tap-sub').textContent = '';
    return;
  }
  cal.result = r;
  $('calib-accept').disabled = false;
  $('tap-count').textContent = String(Math.round(r.latencyMs));
  $('tap-sub').textContent = 'ms Versatz';
  $('calib-result-text').textContent = `${Math.round(r.latencyMs)} ms`;
  $('calib-result-sub').textContent = r.spreadMs <= 15 ? `sehr stabil (±${Math.round(r.spreadMs)} ms)` : r.spreadMs <= 30 ? `okay (±${Math.round(r.spreadMs)} ms)` : `wackelig (±${Math.round(r.spreadMs)} ms) – nochmal?`;
}
$('calib-retry').addEventListener('click', async () => {
  $('calib-result').hidden = true; $('calib-actions').hidden = true;
  await startCalibration();
});
$('calib-accept').addEventListener('click', () => {
  if (!cal.result) return;
  const p = profile();
  p.latencyMs = Math.round(cal.result.latencyMs);
  p.measuredAt = Date.now();
  saveProfiles(); renderHome();
  toast(`${p.short}: ${p.latencyMs} ms gespeichert`);
  show('screen-home');
});

// ------------------------------------------------------------------ camera + recording
async function ensureCamera() {
  if (S.stream && S.stream.getVideoTracks().some((t) => t.readyState === 'live')) return S.stream;
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: false, // bewusst: kein Mikro -> AirPods bleiben im Musik-Modus
    video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  });
  const v = $('cam');
  v.srcObject = S.stream;
  try { await v.play(); } catch {}
  return S.stream;
}
function stopCamera() {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  $('cam').srcObject = null;
}
function pickMime() {
  const c = [
    'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
  ];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

const rec = { active: false, recorder: null, src: null, wakeLock: null, timers: [], raf: 0, cancel: false };

$('btn-go').addEventListener('click', async () => {
  if (!S.song) return;
  if (listen.playing) listen.stop();
  await ensureCtx();
  if (profile().latencyMs == null) toast(`Noch nicht gemessen – ich nehme ~${profile().defaultMs} ms. Feinjustieren geht danach.`, 3500);
  $('cam').classList.toggle('mirror', S.mirror);
  $('rec-status').textContent = 'Bereit';
  $('rec-time').textContent = `${Math.round(S.song.selEnd - S.song.selStart)} s`;
  $('rec-mode').textContent = `${profile().short} · ohne Mikro`;
  $('rec-bar').style.width = '0';
  $('rec-btn').classList.remove('recording');
  $('countdown').hidden = true;
  show('screen-record');
  try {
    await ensureCamera();
  } catch (err) {
    console.error(err);
    toast('Kein Kamerazugriff. Bitte in den Einstellungen erlauben.', 4000);
    show('screen-home');
  }
});
$('rec-cancel').addEventListener('click', () => { abortRecording(); stopCamera(); show('screen-home'); });
$('rec-btn').addEventListener('click', () => { if (rec.active) stopRecording(); else startRecording(); });

async function startRecording() {
  const ctx = await ensureCtx();
  const stream = await ensureCamera();
  const s = S.song;
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.cancel = false;
  rec.active = true;
  rec.recorder = recorder;
  $('rec-btn').classList.add('recording');
  $('rec-btn').setAttribute('aria-label', 'Aufnahme stoppen');
  try { rec.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  const started = new Promise((r) => { recorder.onstart = (e) => r(perfStamp(e)); });
  const stopped = new Promise((r) => { recorder.onstop = r; });
  recorder.start(1000);
  const recStartPerf = await started;

  // Countdown: 3 Klicks, dann Song (mit Vorlauf)
  const beat = 0.6;
  const T0 = ctx.currentTime + 0.6;
  const playFrom = Math.max(0, s.selStart - S.preroll);
  const prerollActual = s.selStart - playFrom;
  const dur = s.selEnd - s.selStart;
  const songAt = T0 + 3 * beat;
  for (let i = 0; i < 3; i++) click(T0 + i * beat, 1200, 0.5);
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.connect(ctx.destination);
  src.start(songAt, playFrom, prerollActual + dur + 0.3);
  rec.src = src;
  const songPerf = ctxToPerf(songAt);
  const clickPerf = ctxToPerf(T0);

  // Countdown-Anzeige
  const cd = $('countdown');
  ['3', '2', '1'].forEach((n, i) => {
    rec.timers.push(setTimeout(() => { cd.hidden = false; cd.textContent = n; }, clickPerf + i * beat * 1000 - performance.now()));
  });
  rec.timers.push(setTimeout(() => { cd.hidden = true; $('rec-status').textContent = prerollActual > 0 ? 'Vorlauf …' : 'Performe!'; }, songPerf - performance.now()));
  rec.timers.push(setTimeout(() => { $('rec-status').textContent = 'Performe!'; }, songPerf + prerollActual * 1000 - performance.now()));
  const endPerf = songPerf + (prerollActual + dur + 0.4) * 1000;
  rec.timers.push(setTimeout(stopRecording, endPerf - performance.now()));
  const tick = () => {
    if (!rec.active) return;
    const u = (performance.now() - songPerf) / 1000 - prerollActual;
    $('rec-bar').style.width = `${clamp(u / dur, 0, 1) * 100}%`;
    $('rec-time').textContent = u < 0 ? `${Math.round(dur)} s` : `${Math.max(0, Math.ceil(dur - u))} s`;
    rec.raf = requestAnimationFrame(tick);
  };
  tick();

  await stopped;
  const cancelled = rec.cancel;
  cleanupRecording();
  if (cancelled) return;
  const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'video/mp4' });
  const p = profile();
  const take = {
    id: 'take-' + Date.now(),
    songId: s.id,
    createdAt: Date.now(),
    blob,
    mime: blob.type,
    songStartInRec: (songPerf - recStartPerf) / 1000, // Sekunden ab Aufnahmestart, an denen playFrom erklang
    prerollActual,
    selStart: s.selStart,
    selEnd: s.selEnd,
    mirror: S.mirror,
    profileId: S.profileId,
    latencyMs: profileLatency(p),
    fineMs: 0,
  };
  await putTake(take);
  stopCamera();
  await renderTakes();
  await openTake(take);
}
function cleanupRecording() {
  rec.active = false;
  rec.timers.forEach(clearTimeout); rec.timers = [];
  cancelAnimationFrame(rec.raf);
  if (rec.src) { try { rec.src.stop(); } catch {} rec.src = null; }
  try { rec.wakeLock?.release(); } catch {}
  rec.wakeLock = null;
  $('countdown').hidden = true;
  $('rec-btn').classList.remove('recording');
  $('rec-btn').setAttribute('aria-label', 'Aufnahme starten');
}
function stopRecording() {
  if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
}
function abortRecording() {
  rec.cancel = true;
  if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  else cleanupRecording();
}

// ------------------------------------------------------------------ takes list
async function renderTakes() {
  const list = $('takes-list');
  list.innerHTML = '';
  if (!S.song) return;
  let takes = [];
  try { takes = (await takesFor(S.song.id)) || []; } catch {}
  takes.sort((a, b) => b.createdAt - a.createdAt);
  $('takes-section').hidden = takes.length === 0;
  takes.forEach((t, i) => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'take-open';
    const a = document.createElement('span');
    a.textContent = `Take ${takes.length - i}`;
    const b = document.createElement('span');
    b.className = 'muted small';
    b.textContent = `${new Date(t.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} · ${Math.round(t.latencyMs + t.fineMs)} ms`;
    open.append(a, b);
    open.addEventListener('click', () => openTake(t, takes.length - i));
    const del = document.createElement('button');
    del.className = 'take-del';
    del.setAttribute('aria-label', `Take ${takes.length - i} löschen`);
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      if (!confirm('Diesen Take löschen?')) return;
      await delTake(t.id); renderTakes();
    });
    li.append(open, del);
    list.append(li);
  });
}

// ------------------------------------------------------------------ take / sync
// Zeit im Aufnahme-File, an der die Lippen zur Song-Position (selStart + u) passen.
function fileTimeFor(take, u) {
  const L = (take.latencyMs + take.fineMs) / 1000;
  return take.firstTs + take.songStartInRec + take.prerollActual + u + L;
}

async function openTake(take, num) {
  preview.stop();
  S.exportFile = null;
  $('btn-share').hidden = true;
  $('btn-download').hidden = true;
  $('export-status').hidden = true;
  $('btn-export').disabled = false;
  const input = new Input({ source: new BlobSource(take.blob), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) { toast('Die Aufnahme enthält kein Video.'); return; }
  const firstTs = await vt.getFirstTimestamp();
  const end = await input.computeDuration();
  S.take = Object.assign(take, { input, vt, firstTs, fileEnd: end, num });
  S.take.previewSink = new CanvasSink(vt, { width: 360, height: 640, fit: 'cover', flip: take.mirror, poolSize: 0 });
  $('sync-take-name').textContent = num ? `Take ${num}` : 'Neuer Take';
  $('off-save-profile').textContent = (S.profiles[take.profileId] || profile()).short;
  renderOffset();
  show('screen-sync');
  await preview.drawAt(0);
}

function renderOffset() {
  const t = S.take; if (!t) return;
  $('offset-value').textContent = String(Math.round(t.latencyMs + t.fineMs));
}
async function changeOffset(delta) {
  const t = S.take; if (!t) return;
  t.fineMs = clamp(t.fineMs + delta, -600, 600);
  renderOffset();
  S.exportFile = null; $('btn-share').hidden = true; $('btn-download').hidden = true;
  persistTake();
  if (preview.playing) await preview.play(Math.max(0, preview.u - 1.5));
  else await preview.drawAt(preview.u || 0);
}
let persistTimer;
function persistTake() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { input, vt, previewSink, firstTs, fileEnd, num, ...plain } = S.take;
    putTake(plain);
  }, 400);
}
$('off-minus').addEventListener('click', () => changeOffset(-10));
$('off-plus').addEventListener('click', () => changeOffset(10));
$('off-frame-minus').addEventListener('click', () => changeOffset(-1000 / FPS));
$('off-frame-plus').addEventListener('click', () => changeOffset(1000 / FPS));
$('off-reset').addEventListener('click', () => { if (S.take) changeOffset(-S.take.fineMs); });
$('off-save').addEventListener('click', () => {
  const t = S.take; if (!t) return;
  const p = S.profiles[t.profileId] || profile();
  p.latencyMs = Math.round(t.latencyMs + t.fineMs);
  p.measuredAt = Date.now();
  saveProfiles(); renderHome();
  toast(`${p.short}: ${p.latencyMs} ms gemerkt`);
});
$('btn-retake').addEventListener('click', () => { preview.stop(); renderTakes(); $('btn-go').click(); });
$('sync-back').addEventListener('click', () => { preview.stop(); renderTakes(); show('screen-home'); });

// Vorschau: Audio-Uhr ist der Taktgeber, Video-Frames folgen.
const preview = {
  playing: false, token: 0, src: null, u: 0,
  canvas: $('preview'),
  async drawAt(u) {
    const t = S.take; if (!t) return;
    const wc = await t.previewSink.getCanvas(Math.max(t.firstTs, fileTimeFor(t, u)));
    if (wc) this.canvas.getContext('2d').drawImage(wc.canvas, 0, 0, this.canvas.width, this.canvas.height);
  },
  stop() {
    this.token++;
    this.playing = false;
    if (this.src) { try { this.src.stop(); } catch {} this.src = null; }
    $('preview-play').classList.remove('playing');
  },
  async play(u0 = 0) {
    this.stop();
    const token = this.token;
    const t = S.take; const ctx = await ensureCtx();
    const dur = t.selEnd - t.selStart;
    if (u0 >= dur - 0.2) u0 = 0;
    this.playing = true;
    $('preview-play').classList.add('playing');
    const outLat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const src = ctx.createBufferSource();
    src.buffer = S.song && S.song.id === t.songId ? S.song.buffer : null;
    if (!src.buffer) { toast('Song nicht geladen'); this.stop(); return; }
    src.connect(ctx.destination);
    const T = ctx.currentTime + 0.25;
    src.start(T, t.selStart + u0, dur - u0);
    this.src = src;
    const it = t.previewSink.canvases(Math.max(t.firstTs, fileTimeFor(t, u0) - 0.1));
    let next = (await it.next()).value || null;
    let cur = null;
    const g = this.canvas.getContext('2d');
    const loop = async () => {
      if (token !== this.token) { it.return(); return; }
      const u = u0 + (ctx.currentTime - T) - outLat;
      this.u = clamp(u, 0, dur);
      if (u >= dur) { this.stop(); this.u = 0; it.return(); return; }
      const ft = fileTimeFor(t, Math.max(u, u0));
      while (next && next.timestamp <= ft) {
        cur = next;
        const r = await it.next();
        if (token !== this.token) return;
        next = r.done ? null : r.value;
      }
      if (cur) g.drawImage(cur.canvas, 0, 0, this.canvas.width, this.canvas.height);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },
};
$('preview-play').addEventListener('click', () => (preview.playing ? preview.stop() : preview.play(preview.u)));
$('preview').addEventListener('click', () => { if (preview.playing) preview.stop(); });

// ------------------------------------------------------------------ export
$('btn-export').addEventListener('click', exportTake);
async function exportTake() {
  const t = S.take; if (!t) return;
  if (!S.song || S.song.id !== t.songId) { toast('Bitte zuerst den passenden Song laden.'); return; }
  preview.stop();
  const btn = $('btn-export');
  btn.disabled = true;
  $('export-status').hidden = false;
  const bar = $('export-bar'), txt = $('export-text');
  bar.style.width = '0';
  txt.textContent = 'Export wird vorbereitet …';
  try {
    if (!(await canEncodeVideo('avc', { width: OUT_W, height: OUT_H }))) throw new Error('NO_AVC');
    if (!(await canEncodeAudio('aac'))) {
      // Browser ohne eingebauten AAC-Encoder (z. B. iOS < 26, Firefox, Linux): WASM-Encoder nachladen
      txt.textContent = 'Lade Audio-Encoder …';
      const { registerAacEncoder } = await import('./vendor/mediabunny-aac-encoder.min.mjs');
      registerAacEncoder();
      if (!(await canEncodeAudio('aac'))) throw new Error('NO_AAC');
    }

    const dur = t.selEnd - t.selStart;
    const nFrames = Math.round(dur * FPS);
    const canvas = document.createElement('canvas');
    canvas.width = OUT_W; canvas.height = OUT_H;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, OUT_W, OUT_H);

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const vSrc = new CanvasSource(canvas, { codec: 'avc', quality: QUALITY_HIGH, keyFrameInterval: 1 });
    const aSrc = new AudioBufferSource({ codec: 'aac', quality: QUALITY_HIGH });
    output.addVideoTrack(vSrc, { frameRate: FPS });
    output.addAudioTrack(aSrc);
    await output.start();

    const sink = new CanvasSink(t.vt, { width: OUT_W, height: OUT_H, fit: 'cover', flip: t.mirror, poolSize: 2 });
    const times = Array.from({ length: nFrames }, (_, i) => Math.max(t.firstTs, fileTimeFor(t, i / FPS)));

    const sr = S.song.buffer.sampleRate;
    const ch = S.song.buffer.numberOfChannels;
    const startSample = Math.round(t.selStart * sr);
    const audioChunk = (fromSec, toSec) => {
      const a = startSample + Math.round(fromSec * sr);
      const b = Math.min(S.song.buffer.length, startSample + Math.round(toSec * sr));
      const len = Math.max(0, b - a);
      if (!len) return null;
      const buf = new AudioBuffer({ length: len, numberOfChannels: ch, sampleRate: sr });
      for (let c = 0; c < ch; c++) buf.copyToChannel(S.song.buffer.getChannelData(c).subarray(a, b), c);
      return buf;
    };

    let audioDone = 0; // Sekunden
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      if (wc) g.drawImage(wc.canvas, 0, 0, OUT_W, OUT_H);
      await vSrc.add(i / FPS, 1 / FPS);
      i++;
      // Audio in 1-s-Stücken mitlaufen lassen
      const target = Math.min(dur, i / FPS + 1);
      if (target - audioDone >= 1 || i === nFrames) {
        const end = i === nFrames ? dur : target;
        const chunk = audioChunk(audioDone, end);
        if (chunk) await aSrc.add(chunk);
        audioDone = end;
      }
      if (i % 5 === 0) {
        bar.style.width = `${(i / nFrames) * 100}%`;
        txt.textContent = `Export läuft … ${Math.round((i / nFrames) * 100)} %`;
      }
    }
    if (audioDone < dur) { const chunk = audioChunk(audioDone, dur); if (chunk) await aSrc.add(chunk); }
    txt.textContent = 'Datei wird fertiggestellt …';
    await output.finalize();
    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    const safe = (S.song.name || 'song').replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'song';
    S.exportFile = new File([blob], `lipsync-${safe}.mp4`, { type: 'video/mp4' });
    bar.style.width = '100%';
    txt.textContent = `Fertig · ${(blob.size / 1e6).toFixed(1).replace('.', ',')} MB · 1080×1920`;
    const canShare = navigator.canShare && navigator.canShare({ files: [S.exportFile] });
    $('btn-share').hidden = !canShare;
    const dl = $('btn-download');
    if (dl.href) URL.revokeObjectURL(dl.href);
    dl.href = URL.createObjectURL(S.exportFile);
    dl.download = S.exportFile.name;
    dl.hidden = false;
    window.__lastExport = S.exportFile;
  } catch (err) {
    console.error(err);
    const m = String(err && err.message);
    txt.textContent = m === 'NO_AAC'
      ? 'Dein Browser kann noch kein AAC-Audio erzeugen. Bitte iOS 26 / aktuelles Chrome nutzen.'
      : m === 'NO_AVC' ? 'Dein Browser kann kein H.264-Video erzeugen.' : `Export fehlgeschlagen: ${m}`;
  } finally {
    btn.disabled = false;
  }
}
$('btn-share').addEventListener('click', async () => {
  if (!S.exportFile) return;
  try { await navigator.share({ files: [S.exportFile] }); }
  catch (err) { if (err && err.name !== 'AbortError') toast('Teilen nicht möglich – nutze „Datei herunterladen“.'); }
});

// ------------------------------------------------------------------ start
(async function init() {
  renderHome();
  await renderTemplates();
  const tplId = LS.get('templateId', null);
  if (tplId && (await getTemplate(tplId).catch(() => null))) {
    try { await openTemplate(tplId); } catch (err) { console.warn(err); }
    return registerSW();
  }
  const id = LS.get('songId', null);
  if (id) {
    try {
      const rec = await getSong(id);
      if (rec) await loadSong(rec, false);
    } catch (err) { console.warn('Song konnte nicht geladen werden', err); }
  }
  registerSW();
})();
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Für Tests
window.__ls = { S, decodeFallback, saveTemplate, openTemplate, allTemplates, evaluateTaps, fileTimeFor, exportTake, openTake, loadSong, putSong };
