// Zentraler Zustand + Hilfsfunktionen
export const S = {
  store: null,       // ProjectStore
  project: null,     // Inhalt von projekt.json
  song: null,        // { buffer, blob }
  files: new Map(),  // videoId -> File (Original im Projektordner)
  view: 'projekt',
  selId: null,       // aktives Video
  selection: new Set(),
  filter: 'alle',
  exportQueue: [],   // [{ id, state, pct, error }]
};

export const $ = (id) => document.getElementById(id);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function fmt(t, digits = 2) { // m:ss.xx
  if (t == null || !isFinite(t)) return '–';
  const neg = t < 0; t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${neg ? '−' : ''}${m}:${s.toFixed(digits).padStart(digits ? digits + 3 : 2, '0')}`;
}
export function fmtMs(ms) {
  const r = Math.round(ms);
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r)} ms`;
}
export function parseTime(str) { // "1:02.5" | "62.5" | "0:44.183"
  const s = String(str).trim().replace(',', '.').replace('−', '-');
  if (!s) return NaN;
  const neg = s.startsWith('-');
  const parts = s.replace('-', '').split(':').map(Number);
  if (parts.some((x) => isNaN(x))) return NaN;
  const v = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
  return neg ? -v : v;
}

let toastTimer;
export function toast(msg, ms = 2800) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------- Ereignisse
const listeners = new Map();
export function on(evt, fn) { (listeners.get(evt) || listeners.set(evt, new Set()).get(evt)).add(fn); }
export function emit(evt, data) { for (const fn of listeners.get(evt) || []) fn(data); }

// ---------------------------------------------------------------- Projekt
export function newProject(name) {
  return {
    v: 1, name, createdAt: Date.now(),
    song: null,           // { file, name, duration }
    templates: [],        // { id, name, selStart, selEnd, markAbs }
    activeTemplateId: null,
    videos: [],
    settings: { autoAudio: true, pattern: '{song}_{vorlage}_{take}', fps: 30, bitrate: 10, fade: false, parallel: 2, zoom: 1 },
  };
}

let saveTimer = null;
export function save(immediate = false) {
  clearTimeout(saveTimer);
  const run = () => S.store && S.project && S.store.saveProject(S.project).then(() => emit('saved')).catch((e) => toast('Speichern fehlgeschlagen: ' + e.message, 5000));
  if (immediate) return run();
  saveTimer = setTimeout(run, 400);
}
export function changed(what = 'all') { save(); emit('change', what); }

export function tpl(v) {
  const p = S.project; if (!p) return null;
  const id = (v && v.templateId) || p.activeTemplateId;
  return p.templates.find((t) => t.id === id) || p.templates[0] || null;
}
export function activeTpl() { return tpl(null); }
export const videoById = (id) => S.project?.videos.find((v) => v.id === id) || null;
export const selVideo = () => videoById(S.selId);

// Videozeit = Songzeit + shift
export function provisionalShift(v) {
  const t = tpl(v);
  const songStart = t ? t.selStart : 0;
  return (v.firstTs || 0) + Math.min(2, (v.duration || 10) * 0.1) - songStart;
}
export function effShift(v) { return v.shift != null ? v.shift : provisionalShift(v); }
export function frameDur(v) { return 1 / (v.fps || 30); }

// Start/Ende (Videozeit); Standard: Song-Ausschnitt der Vorlage, auf das Video begrenzt
export function defaultInOut(v) {
  const t = tpl(v), sh = effShift(v);
  const lo = v.firstTs || 0, hi = v.duration;
  if (!t || v.shift == null) return [lo, hi];
  let a = clamp(t.selStart + sh, lo, hi), b = clamp(t.selEnd + sh, lo, hi);
  if (b - a < 0.5) { a = lo; b = hi; }
  return [a, b];
}
export function inOut(v) {
  const [da, db] = defaultInOut(v);
  return [v.inV ?? da, v.outV ?? db];
}

export function markerShift(v) {
  const t = tpl(v);
  if (!t || t.markAbs == null || v.markV == null) return null;
  return v.markV - t.markAbs;
}

export function exportSignature(v) {
  const [a, b] = inOut(v);
  return [v.shift?.toFixed(4), a.toFixed(3), b.toFixed(3), v.mirror ? 1 : 0, tpl(v)?.id].join('|');
}
export function status(v) {
  if (v.canDecode === false) return { key: 'bad', label: 'Format?', cls: 'bad' };
  if (v.syncing) return { key: 'open', label: 'Analysiere …', cls: 'warn' };
  if (v.shift == null) {
    const t = tpl(v);
    return { key: 'open', label: t && t.markAbs != null ? 'Marker fehlt' : 'Nicht synchron', cls: 'warn' };
  }
  const last = v.exports?.[v.exports.length - 1];
  if (last && last.sig === exportSignature(v)) return { key: 'done', label: 'Exportiert', cls: 'done' };
  const m = { marker: 'Synchron', audio: 'Auto ✓', manual: 'Manuell' }[v.syncMethod] || 'Synchron';
  return { key: 'sync', label: m, cls: 'ok' };
}

// Neuer Versatz → Start/Ende ggf. mitführen
export function setShift(v, shift, method) {
  const first = v.shift == null;
  v.shift = shift;
  if (method) v.syncMethod = method;
  if (first) { v.inV = null; v.outV = null; } // Standard aus Vorlage
}
export function applyMarkerSync(v) {
  const ms = markerShift(v);
  if (ms == null) return false;
  setShift(v, ms, 'marker');
  return true;
}

export function filteredVideos() {
  const vs = S.project?.videos || [];
  if (S.filter === 'alle') return vs;
  return vs.filter((v) => {
    const k = status(v).key;
    return S.filter === 'offen' ? (k === 'open' || k === 'bad') : S.filter === 'sync' ? k === 'sync' : k === 'done';
  });
}
export function counts() {
  const c = { alle: 0, offen: 0, sync: 0, done: 0 };
  for (const v of S.project?.videos || []) {
    c.alle++;
    const k = status(v).key;
    if (k === 'open' || k === 'bad') c.offen++; else if (k === 'sync') c.sync++; else c.done++;
  }
  return c;
}
export function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
