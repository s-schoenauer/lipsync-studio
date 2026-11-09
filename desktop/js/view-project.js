// Ansicht „Projekt“: Song, Ausschnitt, Song-Marker, Vorlagen, Import
import { S, $, esc, fmt, parseTime, clamp, toast, changed, activeTpl, uid, css, emit } from './state.js';
import { peaks, songMax } from './media.js';
import { MultiPlayer } from './player.js';
import { hasFolderAccess } from './store.js';

let player, overviewC, detailC, ph = null, detailSpan = 3;

export function renderProject(root) {
  const p = S.project, T = activeTpl();
  root.innerHTML = `
  <div class="page">
    <div class="main-col">
      ${S.song ? `
      <div class="card">
        <div class="row wrap gap" style="justify-content:space-between;align-items:flex-start">
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="label">Song</span>
            <span style="font:800 26px var(--display)">${esc(p.song.name)}</span>
            <span class="muted">${fmt(S.song.buffer.duration, 1)} · ${Math.round(S.song.buffer.sampleRate / 100) / 10} kHz · ${S.song.buffer.numberOfChannels === 2 ? 'Stereo' : 'Mono'}</span>
          </div>
          <div class="row gap">
            <button class="btn btn-ghost" id="pj-play-sel">Ausschnitt anhören</button>
            <button class="btn btn-ghost" id="pj-song">Song ersetzen …</button>
          </div>
        </div>
        <span class="muted small">Gesamter Song – Ausschnitt ziehen, Griffe an den Rändern verschieben. Klick außerhalb setzt den nächsten Rand.</span>
        <canvas id="pj-overview" class="wave" style="height:90px" aria-label="Wellenform des ganzen Songs mit Ausschnitt"></canvas>
        <div class="row wrap gap">
          <label class="field-label">Start<input id="pj-start" class="field mono" style="width:120px" value="${fmt(T.selStart, 2)}"></label>
          <label class="field-label">Ende<input id="pj-end" class="field mono" style="width:120px" value="${fmt(T.selEnd, 2)}"></label>
          <label class="field-label">Länge<input id="pj-len" class="field mono" style="width:110px" value="${(T.selEnd - T.selStart).toFixed(2)} s"></label>
          <div class="row gap" style="align-self:flex-end">
            <button class="filter" data-len="15">15 s</button><button class="filter" data-len="20">20 s</button>
            <button class="filter" data-len="30">30 s</button><button class="filter" data-len="60">60 s</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="row wrap gap" style="justify-content:space-between">
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="h-card">Song-Marker</span>
            <span class="muted">Einmal setzen – gilt für alle Videos dieser Vorlage. Am besten auf einen harten Laut (p, b, m) oder die Snare.</span>
          </div>
          <span class="mono" style="font-size:22px;color:var(--sec)">${T.markAbs != null ? fmt(T.markAbs, 3) : '–'}</span>
        </div>
        ${T.markAbs != null ? `
        <canvas id="pj-detail" class="wave" style="height:150px" aria-label="Vergrößerte Wellenform um den Marker. Ziehen verschiebt, Klick setzt, Mausrad zoomt."></canvas>
        <div class="row wrap gap">
          <button class="btn btn-ghost" data-nudge="-0.01">−10 ms</button>
          <button class="btn btn-ghost" data-nudge="-0.001">−1 ms</button>
          <button class="btn btn-ice" id="pj-listen">Um Marker anhören</button>
          <button class="btn btn-ghost" data-nudge="0.001">+1 ms</button>
          <button class="btn btn-ghost" data-nudge="0.01">+10 ms</button>
          <button class="btn-link" id="pj-mark-clear">Marker entfernen</button>
          <span class="muted small" style="margin-left:auto">Welle ziehen · Klick setzt · Mausrad zoomt</span>
        </div>` : `
        <button class="btn btn-ice" id="pj-mark-set" style="align-self:flex-start">Marker im Ausschnitt setzen</button>`}
      </div>` : `
      <div class="card">
        <span class="h-card">Song laden</span>
        <div class="dropzone">
          <strong>Deinen Song wählen</strong>
          <span class="muted small">MP3, WAV, M4A, AIFF oder FLAC – wird in den Projektordner kopiert</span>
          <button class="btn btn-pink" id="pj-song">Song wählen …</button>
        </div>
      </div>`}
    </div>

    <aside class="side-col">
      ${S.song ? `
      <div class="card">
        <span class="h-card">Vorlagen</span>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${p.templates.map((t) => `
          <div class="tpl ${t.id === p.activeTemplateId ? 'on' : ''}">
            <button class="btn-link" style="color:var(--text);text-align:left;flex:1;padding:0" data-tpl="${t.id}">
              <strong>${esc(t.name)}</strong><br><span class="muted small mono">${fmt(t.selStart)} – ${fmt(t.selEnd)} · ${Math.round(t.selEnd - t.selStart)} s</span>
            </button>
            <span class="chip ${t.markAbs != null ? 'ok' : 'done'}">${t.markAbs != null ? 'Marker ✓' : 'kein Marker'}</span>
            <button class="btn-link" data-tpl-rename="${t.id}" title="Umbenennen">✎</button>
            ${p.templates.length > 1 ? `<button class="btn-link" data-tpl-del="${t.id}" title="Löschen" aria-label="Vorlage löschen">✕</button>` : ''}
          </div>`).join('')}
          <button class="btn btn-dark" id="pj-tpl-new">+ Neue Vorlage aus Ausschnitt</button>
        </div>
      </div>` : ''}

      <div class="card">
        <span class="h-card">Videos hinzufügen</span>
        <div class="dropzone" id="pj-drop">
          <strong>Videos oder Ordner hierher ziehen</strong>
          <span class="muted small">MOV, MP4 – beliebig viele. Sie werden nach „Originale“ kopiert und dort nie verändert.</span>
          <div class="row gap wrap" style="justify-content:center">
            <button class="btn btn-pink" id="pj-files">Dateien wählen …</button>
            ${hasFolderAccess ? '<button class="btn btn-ghost" id="pj-folder">Ordner wählen …</button>' : ''}
          </div>
        </div>
        <label class="check"><input type="checkbox" id="pj-auto" ${p.settings.autoAudio ? 'checked' : ''}><span>Videos mit Ton automatisch über die Tonspur syncen<br><span class="muted small">wenn beim Dreh der Song hörbar mitlief</span></span></label>
        ${hasFolderAccess ? `<div class="row gap wrap"><button class="btn btn-ghost btn-sm" id="pj-watch">${S.watch ? 'Beobachtung beenden' : 'Ordner beobachten …'}</button><span class="muted small">${S.watch ? 'Neue Videos aus „' + esc(S.watch.name) + '“ werden automatisch übernommen' : 'z. B. AirDrop- oder iCloud-Ordner'}</span></div>` : ''}
        <span class="muted small">${p.videos.length} Videos im Projekt · gespeichert in ${S.store.kind === 'folder' ? '„' + esc(S.store.name) + '“' : 'deinem Browser'}</span>
      </div>
    </aside>
  </div>`;
  wire(root);
}

function wire(root) {
  const p = S.project, T = activeTpl();
  root.querySelectorAll('#pj-song').forEach((b) => (b.onclick = () => $('file-song').click()));
  if (!player) player = new MultiPlayer({ onTime: (t, playing) => { ph = playing ? t : null; drawAll(); } });
  if (!S.song) return;

  overviewC = $('pj-overview'); detailC = $('pj-detail');
  wireOverview(overviewC);
  if (detailC) wireDetail(detailC);
  requestAnimationFrame(drawAll);

  const setSel = (a, b) => {
    const d = S.song.buffer.duration;
    T.selStart = clamp(a, 0, d - 1); T.selEnd = clamp(b, T.selStart + 1, d);
    if (T.markAbs != null) T.markAbs = clamp(T.markAbs, T.selStart, T.selEnd);
    updateFields(); drawAll(); changed('template');
  };
  $('pj-start').onchange = (e) => { const v = parseTime(e.target.value); if (!isNaN(v)) setSel(v, Math.max(v + 1, T.selEnd)); else updateFields(); };
  $('pj-end').onchange = (e) => { const v = parseTime(e.target.value); if (!isNaN(v)) setSel(T.selStart, v); else updateFields(); };
  $('pj-len').onchange = (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (v > 0) setSel(T.selStart, T.selStart + v); else updateFields(); };
  root.querySelectorAll('[data-len]').forEach((b) => (b.onclick = () => setSel(T.selStart, T.selStart + Number(b.dataset.len))));
  $('pj-play-sel').onclick = () => (player.playing ? player.stop() : player.play(T.selStart, T.selEnd));

  root.querySelectorAll('[data-nudge]').forEach((b) => (b.onclick = () => { T.markAbs = clamp(T.markAbs + Number(b.dataset.nudge), T.selStart, T.selEnd); markChanged(); }));
  const listen = $('pj-listen'); if (listen) listen.onclick = () => player.play(T.markAbs - 1.2, T.markAbs + 0.4);
  const clear = $('pj-mark-clear'); if (clear) clear.onclick = () => { T.markAbs = null; changed('template'); emit('rerender'); };
  const set = $('pj-mark-set'); if (set) set.onclick = () => { T.markAbs = T.selStart + Math.min(2, (T.selEnd - T.selStart) / 2); changed('template'); emit('rerender'); };

  root.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = () => { p.activeTemplateId = b.dataset.tpl; changed('template'); emit('rerender'); }));
  root.querySelectorAll('[data-tpl-rename]').forEach((b) => (b.onclick = () => {
    const t = p.templates.find((x) => x.id === b.dataset.tplRename);
    const n = prompt('Name der Vorlage:', t.name); if (n && n.trim()) { t.name = n.trim(); changed('template'); emit('rerender'); }
  }));
  root.querySelectorAll('[data-tpl-del]').forEach((b) => (b.onclick = () => {
    const t = p.templates.find((x) => x.id === b.dataset.tplDel);
    const used = p.videos.filter((v) => v.templateId === t.id).length;
    if (!confirm(`Vorlage „${t.name}“ löschen?${used ? ` ${used} Videos wechseln zur ersten Vorlage.` : ''}`)) return;
    p.templates = p.templates.filter((x) => x !== t);
    for (const v of p.videos) if (v.templateId === t.id) v.templateId = p.templates[0].id;
    if (p.activeTemplateId === t.id) p.activeTemplateId = p.templates[0].id;
    changed('template'); emit('rerender');
  }));
  $('pj-tpl-new').onclick = () => {
    const n = prompt('Name der neuen Vorlage (z. B. „Strophe 2“):', 'Vorlage ' + (p.templates.length + 1));
    if (!n) return;
    const t = { id: uid('tpl'), name: n.trim(), selStart: T.selStart, selEnd: T.selEnd, markAbs: null };
    p.templates.push(t); p.activeTemplateId = t.id; changed('template'); emit('rerender');
    toast('Neue Vorlage: Ausschnitt anpassen und Marker setzen');
  };

  $('pj-files').onclick = () => $('file-videos').click();
  const fb = $('pj-folder'); if (fb) fb.onclick = () => emit('import-folder');
  $('pj-auto').onchange = (e) => { p.settings.autoAudio = e.target.checked; changed('settings'); };
  const wb = $('pj-watch'); if (wb) wb.onclick = () => emit('toggle-watch');
}

function updateFields() {
  const T = activeTpl();
  const s = $('pj-start'), e = $('pj-end'), l = $('pj-len');
  if (s) s.value = fmt(T.selStart, 2);
  if (e) e.value = fmt(T.selEnd, 2);
  if (l) l.value = `${(T.selEnd - T.selStart).toFixed(2)} s`;
}
function markChanged() {
  const T = activeTpl();
  const lbl = document.querySelector('.card .mono[style*="22px"]');
  if (lbl) lbl.textContent = fmt(T.markAbs, 3);
  drawAll(); changed('template');
}

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  return { g, w, h };
}
function drawAll() {
  if (S.view !== 'projekt' || !S.song) return;
  if (overviewC && overviewC.isConnected) drawOverview();
  if (detailC && detailC.isConnected) drawDetail();
}
function drawOverview() {
  const { g, w, h } = sizeCanvas(overviewC);
  const buf = S.song.buffer, T = activeTpl(), d = buf.duration;
  const n = Math.floor(w / 3), p = peaks(buf, 0, d, n), mx = songMax(buf);
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * d, bh = Math.max(2, (p[i] / mx) * (h - 12));
    g.fillStyle = t >= T.selStart && t <= T.selEnd ? css('--accent') : css('--line');
    g.fillRect(i * 3 + 1, (h - bh) / 2, 2, bh);
  }
  const xa = (T.selStart / d) * w, xb = (T.selEnd / d) * w;
  g.strokeStyle = css('--text'); g.lineWidth = 2; g.strokeRect(xa, 1, xb - xa, h - 2);
  g.fillStyle = css('--text'); g.fillRect(xa - 3, 0, 6, h); g.fillRect(xb - 3, 0, 6, h);
  if (T.markAbs != null) { g.fillStyle = css('--sec'); g.fillRect((T.markAbs / d) * w - 1, 0, 2, h); }
  if (ph != null) { g.fillStyle = css('--sec'); g.fillRect((ph / d) * w - 1, 0, 2, h); }
}
function wireOverview(c) {
  let drag = null;
  c.onpointerdown = (e) => {
    c.setPointerCapture(e.pointerId);
    const T = activeTpl(), d = S.song.buffer.duration, t = (e.offsetX / c.clientWidth) * d;
    const xa = (T.selStart / d) * c.clientWidth, xb = (T.selEnd / d) * c.clientWidth;
    if (Math.abs(e.offsetX - xa) < 8) drag = { k: 'a' };
    else if (Math.abs(e.offsetX - xb) < 8) drag = { k: 'b' };
    else if (t > T.selStart && t < T.selEnd) drag = { k: 'm', off: t - T.selStart, mo: T.markAbs != null ? T.markAbs - T.selStart : null };
    else drag = { k: t < T.selStart ? 'a' : 'b' };
    move(e);
  };
  const move = (e) => {
    if (!drag) { const T = activeTpl(), d = S.song.buffer.duration; const xa = (T.selStart / d) * c.clientWidth, xb = (T.selEnd / d) * c.clientWidth; c.style.cursor = Math.abs(e.offsetX - xa) < 8 || Math.abs(e.offsetX - xb) < 8 ? 'ew-resize' : 'pointer'; return; }
    const T = activeTpl(), d = S.song.buffer.duration, t = clamp((e.offsetX / c.clientWidth) * d, 0, d);
    if (drag.k === 'a') T.selStart = clamp(t, 0, T.selEnd - 1);
    else if (drag.k === 'b') T.selEnd = clamp(t, T.selStart + 1, d);
    else { const len = T.selEnd - T.selStart; T.selStart = clamp(t - drag.off, 0, d - len); T.selEnd = T.selStart + len; if (drag.mo != null) T.markAbs = T.selStart + drag.mo; }
    if (T.markAbs != null) T.markAbs = clamp(T.markAbs, T.selStart, T.selEnd);
    updateFields(); drawAll();
  };
  c.onpointermove = move;
  c.onpointerup = () => { if (drag) { drag = null; changed('template'); } };
  new ResizeObserver(drawAll).observe(c);
}
function drawDetail() {
  const { g, w, h } = sizeCanvas(detailC);
  const T = activeTpl(), buf = S.song.buffer, m = T.markAbs;
  const t0 = m - detailSpan / 2, t1 = m + detailSpan / 2, n = Math.floor(w / 3);
  const p = peaks(buf, Math.max(0, t0), Math.min(buf.duration, t1), n);
  let mx = 1e-6; for (const v of p) if (v > mx) mx = v;
  const xa = t0 < 0 ? (-t0 / detailSpan) * w : 0;
  const n2 = Math.floor((w - xa) / 3);
  for (let i = 0; i < n2 && i < n; i++) {
    const t = Math.max(0, t0) + ((i + 0.5) / n) * (Math.min(buf.duration, t1) - Math.max(0, t0));
    const bh = Math.max(2, (p[i] / mx) * (h - 26));
    g.fillStyle = t >= T.selStart && t <= T.selEnd ? css('--accent') : css('--line');
    g.fillRect(xa + i * 3, (h - 14 - bh) / 2, 2, bh);
  }
  g.font = '500 11px JetBrains Mono, monospace'; g.fillStyle = css('--muted'); g.textBaseline = 'bottom';
  const step = detailSpan <= 2 ? 0.25 : detailSpan <= 5 ? 0.5 : 1;
  for (let k = Math.ceil(t0 / step) * step; k <= t1; k += step) { const x = ((k - t0) / detailSpan) * w; g.fillRect(x, h - 18, 1, 5); g.fillText(fmt(k, 2), x + 3, h - 2); }
  if (ph != null) { g.fillStyle = css('--text'); g.fillRect(((ph - t0) / detailSpan) * w - 1, 0, 2, h - 14); }
  g.fillStyle = css('--sec'); g.fillRect(w / 2 - 1.5, 0, 3, h - 14);
  g.beginPath(); g.moveTo(w / 2 - 7, 0); g.lineTo(w / 2 + 7, 0); g.lineTo(w / 2, 9); g.fill();
}
function wireDetail(c) {
  let drag = null;
  c.onpointerdown = (e) => { c.setPointerCapture(e.pointerId); drag = { x: e.offsetX, m: activeTpl().markAbs, moved: false }; c.style.cursor = 'grabbing'; };
  c.onpointermove = (e) => {
    if (!drag) { c.style.cursor = 'grab'; return; }
    const dx = e.offsetX - drag.x; if (Math.abs(dx) > 3) drag.moved = true;
    if (drag.moved) { const T = activeTpl(); T.markAbs = clamp(drag.m - (dx / c.clientWidth) * detailSpan, T.selStart, T.selEnd); markChanged(); }
  };
  c.onpointerup = (e) => {
    if (drag && !drag.moved) { const T = activeTpl(); T.markAbs = clamp(drag.m - detailSpan / 2 + (e.offsetX / c.clientWidth) * detailSpan, T.selStart, T.selEnd); markChanged(); }
    drag = null; c.style.cursor = 'grab';
  };
  c.onwheel = (e) => { e.preventDefault(); detailSpan = clamp(detailSpan * Math.exp(e.deltaY * 0.0015), 0.4, 12); drawDetail(); };
  new ResizeObserver(drawAll).observe(c);
}
export function stopProjectAudio() { if (player) player.stop(); }
