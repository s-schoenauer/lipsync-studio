// Ansicht „Export“: Warteschlange + Export-Engine (1080×1920 MP4, H.264 + AAC)
import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  QUALITY_HIGH, canEncodeVideo, canEncodeAudio,
} from 'mediabunny';
import { S, $, esc, fmt, fmtMs, toast, changed, emit, tpl, videoById, inOut, markerShift, status, exportSignature } from './state.js';

const OUT_W = 1080, OUT_H = 1920;
let running = false, stopRequested = false, root;

export function queueExport(videos) {
  let n = 0;
  for (const v of videos) {
    if (v.shift == null) continue;
    const q = S.exportQueue.find((x) => x.id === v.id);
    if (q && (q.state === 'wait' || q.state === 'run')) continue;
    if (q) Object.assign(q, { state: 'wait', pct: 0, error: null, file: null });
    else S.exportQueue.push({ id: v.id, state: 'wait', pct: 0 });
    n++;
  }
  emit('queue');
  return n;
}

export function renderExport(r) {
  root = r;
  const p = S.project, st = p.settings;
  const q = S.exportQueue.filter((x) => videoById(x.id));
  const done = q.filter((x) => x.state === 'done').length;
  const total = q.length;
  const pctAll = total ? Math.round(q.reduce((s, x) => s + (x.state === 'done' ? 100 : x.pct || 0), 0) / total) : 0;
  const openSync = p.videos.filter((v) => status(v).key === 'sync' && !q.some((x) => x.id === v.id && x.state !== 'done')).length;
  const notSync = p.videos.filter((v) => v.shift == null).length;
  root.innerHTML = `
  <div class="page">
    <section class="card main-col" aria-label="Warteschlange">
      <div class="row wrap gap" style="justify-content:space-between">
        <span class="h-card" style="font-size:22px">Export-Warteschlange</span>
        <span class="muted">${total ? `${done} von ${total} fertig` : 'leer'}</span>
      </div>
      <div class="bar ok" style="height:8px"><div style="width:${pctAll}%"></div></div>
      <div class="row gap wrap">
        <button class="btn btn-ghost btn-sm" id="ex-add" ${openSync ? '' : 'disabled'}>Alle synchronen hinzufügen (${openSync})</button>
        ${notSync ? `<span class="small muted">${notSync} Videos sind noch nicht synchron und werden nicht exportiert.</span>` : ''}
      </div>
      ${total ? `
      <div style="overflow-x:auto">
        <table class="q">
          <thead><tr><th>Video</th><th>Versatz</th><th>Start – Ende</th><th>Länge</th><th style="width:30%">Status</th><th><span class="small" style="position:absolute;left:-9999px">Aktion</span></th></tr></thead>
          <tbody>${q.map(rowHtml).join('')}</tbody>
        </table>
      </div>` : '<div class="empty">Noch nichts in der Warteschlange. Füg alle synchronen Videos hinzu oder wähle im Raster einzelne aus.</div>'}
      <div class="row gap wrap" style="margin-top:auto">
        <button class="btn btn-pink" id="ex-start" ${q.some((x) => x.state === 'wait') && !running ? '' : 'disabled'}>${running ? 'Export läuft …' : 'Export starten'}</button>
        <button class="btn btn-ghost" id="ex-stop" ${running ? '' : 'disabled'}>Nach aktuellem anhalten</button>
        <button class="btn btn-ghost" id="ex-clear" ${done ? '' : 'disabled'}>Fertige aus Liste entfernen</button>
      </div>
    </section>

    <aside class="card side-col" aria-label="Export-Einstellungen">
      <span class="h-card">Einstellungen</span>
      <div class="kv"><span>Ausgabe</span><span class="small">${S.store.kind === 'folder' ? `„${esc(S.store.name)}“ / Exporte` : 'im Browser (über „Laden“ speichern)'}</span></div>
      <span class="small muted">Die Originale bleiben unverändert in „Originale“. Neue Exporte überschreiben nichts – bei gleichem Namen wird _2, _3 … angehängt.</span>
      <label class="field-label">Dateiname
        <input id="ex-pattern" class="field mono" value="${esc(st.pattern)}">
        <span class="muted">Platzhalter: {song} {vorlage} {take} {datum} – Beispiel: ${esc(fileName(p.videos[0]))}</span>
      </label>
      <div class="grid2">
        <label class="field-label">Format<select disabled><option>1080×1920 · 9:16</option></select></label>
        <label class="field-label">Bildrate<select id="ex-fps"><option value="30" ${st.fps == 30 ? 'selected' : ''}>30 fps</option><option value="60" ${st.fps == 60 ? 'selected' : ''}>60 fps</option></select></label>
      </div>
      <label class="field-label">Qualität: <span id="ex-br">${st.bitrate} Mbit/s</span>
        <input type="range" id="ex-bitrate" min="6" max="24" step="1" value="${st.bitrate}">
      </label>
      <label class="check"><input type="checkbox" checked disabled><span>Original-Song als Ton (kein Kameraton)</span></label>
      <label class="check"><input type="checkbox" id="ex-fade" ${st.fade ? 'checked' : ''}><span>Ton kurz ein- und ausblenden (0,15 s)</span></label>
      <label class="field-label">Gleichzeitig exportieren
        <select id="ex-par"><option value="1" ${st.parallel == 1 ? 'selected' : ''}>1</option><option value="2" ${st.parallel == 2 ? 'selected' : ''}>2</option><option value="3" ${st.parallel == 3 ? 'selected' : ''}>3</option></select>
      </label>
    </aside>
  </div>`;
  $('ex-add').onclick = () => { const n = queueExport(p.videos.filter((v) => status(v).key === 'sync')); toast(`${n} Videos hinzugefügt`); renderExport(root); };
  $('ex-start').onclick = () => startExport();
  $('ex-stop').onclick = () => { stopRequested = true; toast('Hält nach dem aktuellen Video an'); };
  $('ex-clear').onclick = () => { S.exportQueue = S.exportQueue.filter((x) => x.state !== 'done'); renderExport(root); };
  $('ex-pattern').onchange = (e) => { st.pattern = e.target.value.trim() || '{song}_{vorlage}_{take}'; changed('settings'); renderExport(root); };
  $('ex-fps').onchange = (e) => { st.fps = Number(e.target.value); changed('settings'); };
  $('ex-bitrate').oninput = (e) => { st.bitrate = Number(e.target.value); $('ex-br').textContent = `${st.bitrate} Mbit/s`; };
  $('ex-bitrate').onchange = () => changed('settings');
  $('ex-fade').onchange = (e) => { st.fade = e.target.checked; changed('settings'); };
  $('ex-par').onchange = (e) => { st.parallel = Number(e.target.value); changed('settings'); };
  root.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => rowAction(b.dataset.q, b.dataset.act)));
}

function rowHtml(x) {
  const v = videoById(x.id);
  const [a, b] = inOut(v), ms = markerShift(v);
  const off = v.shift == null ? '–' : ms != null ? fmtMs((v.shift - ms) * 1000) : `${v.shift.toFixed(3)} s`;
  const stTxt = { wait: 'Wartet', run: `${Math.round(x.pct || 0)} %`, done: 'Fertig', error: 'Fehler: ' + (x.error || '') }[x.state];
  const action = x.state === 'done' ? ['dl', 'Laden'] : x.state === 'error' ? ['retry', 'Nochmal'] : x.state === 'wait' ? ['rm', 'Entfernen'] : null;
  return `<tr>
    <td><strong>${esc(v.name)}</strong>${x.file ? `<br><span class="small muted mono">${esc(x.file)}</span>` : ''}</td>
    <td class="mono">${off}</td>
    <td class="mono">${fmt(a, 2)} – ${fmt(b, 2)}</td>
    <td class="mono">${(b - a).toFixed(1)} s</td>
    <td><div class="row gap"><div class="bar ${x.state === 'done' ? 'ok' : ''}"><div style="width:${x.state === 'done' ? 100 : x.pct || 0}%"></div></div>
      <span class="small" data-st="${x.id}" style="min-width:90px;color:${x.state === 'error' ? 'var(--warn)' : x.state === 'done' ? 'var(--sec)' : 'var(--text)'}">${esc(stTxt)}</span></div></td>
    <td style="text-align:right">${action ? `<button class="btn-link" data-q="${x.id}" data-act="${action[0]}">${action[1]}</button>` : ''}</td>
  </tr>`;
}
async function rowAction(id, act) {
  const x = S.exportQueue.find((q) => q.id === id); if (!x) return;
  if (act === 'rm') S.exportQueue = S.exportQueue.filter((q) => q !== x);
  if (act === 'retry') Object.assign(x, { state: 'wait', pct: 0, error: null });
  if (act === 'dl') {
    try {
      const f = await S.store.readFile(x.path);
      const url = URL.createObjectURL(f);
      const a = document.createElement('a'); a.href = url; a.download = x.file; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { toast('Datei nicht gefunden: ' + e.message); }
  }
  renderIfVisible();
}
function renderIfVisible() { if (S.view === 'export' && root) renderExport(root); emit('queue'); }

function fileName(v) {
  if (!v) return 'song_hook_take01.mp4';
  const p = S.project, T = tpl(v);
  const clean = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 40);
  const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const base = (p.settings.pattern || '{song}_{vorlage}_{take}')
    .replace(/\{song\}/g, clean(p.song?.name || 'song'))
    .replace(/\{vorlage\}/g, clean(T?.name || 'vorlage'))
    .replace(/\{take\}/g, clean(v.name.replace(/\.[^.]+$/, '')))
    .replace(/\{datum\}/g, date);
  return (base || 'export') + '.mp4';
}

async function startExport() {
  if (running) return;
  if (!(await canEncodeVideo('avc', { width: OUT_W, height: OUT_H }))) { toast('Dieser Browser kann kein H.264 erzeugen. Bitte Chrome oder Edge nutzen.', 5000); return; }
  if (!(await canEncodeAudio('aac'))) {
    const { registerAacEncoder } = await import('../../vendor/mediabunny-aac-encoder.min.mjs');
    registerAacEncoder();
  }
  running = true; stopRequested = false;
  renderIfVisible();
  const par = Math.max(1, S.project.settings.parallel || 1);
  const worker = async () => {
    while (!stopRequested) {
      const x = S.exportQueue.find((q) => q.state === 'wait' && videoById(q.id));
      if (!x) break;
      x.state = 'run'; x.pct = 0; renderIfVisible();
      try { await exportOne(videoById(x.id), x); x.state = 'done'; x.pct = 100; }
      catch (e) { console.error(e); x.state = 'error'; x.error = e.message; }
      renderIfVisible();
    }
  };
  await Promise.all(Array.from({ length: par }, worker));
  running = false;
  renderIfVisible();
  const done = S.exportQueue.filter((q) => q.state === 'done').length;
  toast(`${done} Videos exportiert${S.store.kind === 'folder' ? ' – im Ordner „Exporte“' : ''}`, 4000);
}

async function exportOne(v, job) {
  const file = S.files.get(v.id);
  if (!file) throw new Error('Original fehlt');
  if (!S.song) throw new Error('Kein Song geladen');
  const st = S.project.settings, fps = st.fps || 30;
  const [a, b] = inOut(v);
  const sh = v.shift, dur = b - a, n = Math.max(1, Math.round(dur * fps));
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  const canvas = new OffscreenCanvas(OUT_W, OUT_H);
  const g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, OUT_W, OUT_H);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vSrc = new CanvasSource(canvas, { codec: 'avc', bitrate: (st.bitrate || 10) * 1e6, keyFrameInterval: 2 });
  const aSrc = new AudioBufferSource({ codec: 'aac', quality: QUALITY_HIGH });
  output.addVideoTrack(vSrc, { frameRate: fps });
  output.addAudioTrack(aSrc);
  await output.start();

  const sinkOpts = { width: OUT_W, height: OUT_H, fit: 'cover', poolSize: 2 };
  if (v.mirror) sinkOpts.flip = true;
  const sink = new CanvasSink(vt, sinkOpts);
  const times = Array.from({ length: n }, (_, i) => Math.min(b, a + i / fps));

  // Song-Audio ab Songzeit (a − shift); außerhalb des Songs Stille
  const song = S.song.buffer, sr = song.sampleRate, ch = song.numberOfChannels;
  const s0 = (a - sh) * sr;
  const fadeN = st.fade ? Math.round(0.15 * sr) : 0;
  const totalN = Math.round(dur * sr);
  const chunk = (from, to) => {
    const len = to - from; if (len <= 0) return null;
    const buf = new AudioBuffer({ length: len, numberOfChannels: ch, sampleRate: sr });
    for (let c = 0; c < ch; c++) {
      const src = song.getChannelData(c), dst = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const k = Math.round(s0) + from + i;
        let val = k >= 0 && k < src.length ? src[k] : 0;
        if (fadeN) { const pos = from + i; if (pos < fadeN) val *= pos / fadeN; else if (pos > totalN - fadeN) val *= Math.max(0, (totalN - pos) / fadeN); }
        dst[i] = val;
      }
    }
    return buf;
  };
  let aDone = 0, i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    if (wc) g.drawImage(wc.canvas, 0, 0, OUT_W, OUT_H);
    await vSrc.add(i / fps, 1 / fps);
    i++;
    const target = Math.min(totalN, Math.round((i / fps + 1) * sr));
    if (target - aDone >= sr || i === n) {
      const end = i === n ? totalN : target;
      const c = chunk(aDone, end); if (c) await aSrc.add(c);
      aDone = end;
    }
    if (i % 6 === 0) { job.pct = (i / n) * 96; const el = document.querySelector(`[data-st="${v.id}"]`); if (el) el.textContent = `${Math.round(job.pct)} %`; }
  }
  if (aDone < totalN) { const c = chunk(aDone, totalN); if (c) await aSrc.add(c); }
  await output.finalize();
  const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
  const name = await S.store.freeName('Exporte', fileName(v));
  await S.store.writeFile(`Exporte/${name}`, blob);
  job.file = name; job.path = `Exporte/${name}`;
  v.exports = v.exports || [];
  v.exports.push({ file: `Exporte/${name}`, at: Date.now(), sig: exportSignature(v), size: blob.size });
  changed('video');
}
export function exportRunning() { return running; }
