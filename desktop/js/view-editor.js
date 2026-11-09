// Ansicht „Editor“: Videoliste, Vorschau, Timeline, Eigenschaften
import {
  S, $, esc, fmt, fmtMs, parseTime, clamp, toast, changed, emit, tpl, activeTpl, videoById, selVideo,
  effShift, inOut, defaultInOut, status, markerShift, setShift, applyMarkerSync, frameDur, filteredVideos, counts,
} from './state.js';
import { MultiPlayer, drawFrame, forgetVideo } from './player.js';
import { Timeline } from './timeline.js';
import { fillThumbs } from './thumbs.js';
import { audioSync } from './media.js';
import { openFramePicker } from './framepicker.js';

let player, tl, stage, vt = 0, loop = false, root;

export function renderEditor(r) {
  root = r;
  const vids = S.project.videos;
  if (!S.selId || !videoById(S.selId)) S.selId = vids[0]?.id || null;
  root.innerHTML = `
  <div class="ed-body">
    <aside class="ed-list" aria-label="Videos">
      <div class="ed-list-head">
        <div class="row" style="justify-content:space-between">
          <span class="h-small">Videos · ${vids.length}</span>
          <label class="row gap small muted"><input type="checkbox" id="ed-all">Alle</label>
        </div>
        <div class="row gap wrap" id="ed-filters"></div>
      </div>
      <ul class="vlist" id="ed-list"></ul>
      <div class="small muted" style="padding:9px 12px;border-top:1px solid var(--line)">Weitere Videos einfach ins Fenster ziehen · Strg/Umschalt-Klick wählt mehrere</div>
    </aside>
    <section class="ed-center">
      ${S.selId ? `
      <div class="stage">
        <div class="stage-video" id="ed-stage-box">
          <canvas id="ed-stage" width="540" height="960"></canvas>
          <div class="safe" id="ed-safe1" style="right:3%;top:55%;bottom:14%;width:15%"></div>
          <div class="safe" id="ed-safe2" style="left:4%;right:22%;bottom:5%;height:13%"></div>
        </div>
        <div class="transport">
          <span class="timecode" id="ed-tc">–</span>
          <button class="icon-btn" id="ed-prev" aria-label="1 Frame zurück" title="← 1 Frame"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
          <button class="icon-btn play" id="ed-play" aria-label="Abspielen" title="Leertaste"><svg id="ed-play-ic" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
          <button class="icon-btn" id="ed-next" aria-label="1 Frame vor" title="→ 1 Frame"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
          <button class="btn btn-ghost btn-sm" id="ed-loop">Loop Start–Ende</button>
          <button class="btn btn-ghost btn-sm" id="ed-at-mark">Um Marker abspielen</button>
          <label class="row gap small muted"><input type="checkbox" id="ed-safe" checked>TikTok-Bereiche</label>
        </div>
      </div>
      <div class="tl-wrap">
        <div class="row wrap gap" style="justify-content:space-between">
          <span class="h-small">Timeline</span>
          <div class="row gap wrap small muted">
            <label class="row gap"><input type="checkbox" id="ed-snap" checked>Einrasten an Markern</label>
            <button class="btn-link" id="ed-fit">Einpassen</button>
            <button class="btn-link" id="ed-zoom-in">Zoom +</button>
            <button class="btn-link" id="ed-zoom-out">Zoom −</button>
          </div>
        </div>
        <canvas class="tl-canvas" id="ed-tl"></canvas>
        <span class="small muted">Videospur ziehen = Versatz · weiße Griffe = Start/Ende · S und V übereinander = synchron · Mausrad zoomt, Umschalt+Mausrad scrollt</span>
      </div>` : `<div class="empty"><span class="h-card">Noch keine Videos</span><span>Zieh Videos ins Fenster oder importiere sie im Projekt.</span><button class="btn btn-pink" id="ed-import">Videos importieren</button></div>`}
    </section>
    ${S.selId ? `<aside class="ed-inspector" id="ed-insp" aria-label="Eigenschaften"></aside>` : ''}
  </div>`;
  renderList();
  const imp = $('ed-import'); if (imp) imp.onclick = () => $('file-videos').click();
  if (!S.selId) return;

  stage = $('ed-stage');
  player = player || new MultiPlayer();
  player.onTime = (t, playing) => { if (playing) { const v = selVideo(); if (v) vt = t + effShift(v); } updateTransport(); tl && tl.draw(); };
  player.onEnd = () => setPlayIcon(false);
  tl = new Timeline($('ed-tl'), {
    rows: () => (selVideo() ? [{ v: selVideo() }] : []),
    playhead: () => { const v = selVideo(); return v ? vt - effShift(v) : null; },
    onSeek: (songT) => { const v = selVideo(); stopPlay(); seekVideo(songT + effShift(v)); },
    onShift: (v, ns, done) => { setShift(v, ns, v.syncMethod || 'manual'); if (done) { changed('video'); renderInspector(); renderList(); } else { vt = vt; updateTransport(); } },
    onInOut: (v, a, b, done) => { v.inV = a; v.outV = b; if (done) { changed('video'); renderInspector(); } else updateInspectorTimes(); },
    onSelect: () => {},
  });
  $('ed-snap').onchange = (e) => (tl.o.snap = e.target.checked);
  $('ed-fit').onclick = () => tl.fit();
  $('ed-zoom-in').onclick = () => tl.zoomTo((tl.t1 - tl.t0) / 1.6);
  $('ed-zoom-out').onclick = () => tl.zoomTo((tl.t1 - tl.t0) * 1.6);
  $('ed-safe').onchange = (e) => { $('ed-safe1').hidden = $('ed-safe2').hidden = !e.target.checked; };
  $('ed-play').onclick = togglePlay;
  $('ed-prev').onclick = () => step(-1);
  $('ed-next').onclick = () => step(1);
  $('ed-loop').onclick = () => { loop = !loop; $('ed-loop').classList.toggle('btn-ice', loop); $('ed-loop').classList.toggle('btn-ghost', !loop); if (player.playing) playFromHere(); };
  $('ed-at-mark').onclick = () => {
    const v = selVideo(), T = tpl(v);
    if (!T || T.markAbs == null) { toast('Erst im Projekt einen Song-Marker setzen'); return; }
    stopPlay();
    const sh = effShift(v);
    player.setItems([{ v, canvas: stage }]);
    setPlayIcon(true);
    player.play(T.markAbs - 1.5, T.markAbs + 1);
  };
  selectVideo(S.selId, true);
}

function setPlayIcon(on) {
  const ic = $('ed-play-ic'); if (!ic) return;
  ic.innerHTML = on ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  $('ed-play').setAttribute('aria-label', on ? 'Pause' : 'Abspielen');
}
function stopPlay() {
  if (player && player.playing) {
    player.stop(); setPlayIcon(false);
    const ts = player.frameTs.get(S.selId);
    if (ts != null) { S.frameTs = ts; vt = ts; updateTransport(); tl && tl.draw(); }
  }
}
function togglePlay() { if (player.playing) stopPlay(); else playFromHere(); }
function playFromHere() {
  const v = selVideo(); if (!v) return;
  const sh = effShift(v);
  const [a, b] = inOut(v);
  let from = vt;
  if (loop || from >= b - 0.05) from = loop && (vt < a || vt >= b - 0.05) ? a : (from >= b - 0.05 ? a : from);
  player.setItems([{ v, canvas: stage }]);
  setPlayIcon(true);
  player.play(from - sh, b - sh, { loop });
}
async function seekVideo(t) {
  const v = selVideo(); if (!v) return;
  vt = clamp(t, v.firstTs || 0, v.duration);
  updateTransport(); tl && tl.draw();
  const ts = await drawFrame(v, stage, vt);
  if (ts != null) S.frameTs = ts;
}
function step(n) { const v = selVideo(); if (!v) return; stopPlay(); seekVideo(vt + n * frameDur(v) + 1e-4); }

export function selectVideo(id, initial = false) {
  stopPlay();
  S.selId = id;
  const v = selVideo(); if (!v) return;
  const [a] = inOut(v);
  const T = tpl(v);
  // Start: am Video-Marker, sonst am Start
  vt = v.markV != null ? v.markV : a;
  renderList(); renderInspector();
  if (tl) { tl.fit(); }
  seekVideo(vt);
}

// ---------------------------------------------------------------- Liste
function renderList() {
  const box = $('ed-list'); if (!box) return;
  const c = counts();
  $('ed-filters').innerHTML = [['alle', 'Alle'], ['offen', 'Offen'], ['sync', 'Synchron'], ['done', 'Exportiert']]
    .map(([k, l]) => `<button class="filter ${S.filter === k ? 'on' : ''}" data-f="${k}">${l} ${c[k]}</button>`).join('');
  $('ed-filters').querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; renderList(); }));
  const vids = filteredVideos();
  box.innerHTML = vids.map((v) => {
    const st = status(v), ms = markerShift(v);
    const meta = v.shift == null ? `${fmt(v.duration, 1)} · ${v.hasAudio ? 'mit Ton' : 'ohne Ton'}` : `${fmt(v.duration, 1)} · ${ms != null ? fmtMs((v.shift - ms) * 1000) + ' z. Marker' : 'Versatz ' + (v.shift).toFixed(3) + ' s'}`;
    return `<li class="vitem ${v.id === S.selId ? 'on' : ''}" data-id="${v.id}">
      <input type="checkbox" aria-label="${esc(v.name)} auswählen" data-chk="${v.id}" ${S.selection.has(v.id) ? 'checked' : ''}>
      <img class="thumb" data-thumb="${v.id}" alt="">
      <div class="meta"><span class="name">${esc(v.name)}</span><span class="small muted mono">${meta}</span></div>
      <span class="chip ${st.cls}">${st.label}</span></li>`;
  }).join('') || '<li class="muted small" style="padding:10px">Keine Videos in diesem Filter.</li>';
  fillThumbs(box, vids);
  box.querySelectorAll('.vitem').forEach((li) => {
    li.onclick = (e) => {
      if (e.target.matches('input')) return;
      const id = li.dataset.id;
      if (e.ctrlKey || e.metaKey) { S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id); renderList(); renderInspector(); return; }
      if (e.shiftKey && S.selId) {
        const ids = vids.map((x) => x.id), a = ids.indexOf(S.selId), b = ids.indexOf(id);
        ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => S.selection.add(x));
        renderList(); renderInspector(); return;
      }
      selectVideo(id);
    };
  });
  box.querySelectorAll('[data-chk]').forEach((cb) => (cb.onchange = () => { cb.checked ? S.selection.add(cb.dataset.chk) : S.selection.delete(cb.dataset.chk); renderInspector(); emit('selection'); }));
  const all = $('ed-all');
  if (all) { all.checked = vids.length > 0 && vids.every((v) => S.selection.has(v.id)); all.onchange = () => { vids.forEach((v) => (all.checked ? S.selection.add(v.id) : S.selection.delete(v.id))); renderList(); renderInspector(); }; }
}

// ---------------------------------------------------------------- Eigenschaften
function renderInspector() {
  const box = $('ed-insp'); const v = selVideo(); if (!box || !v) return;
  const T = tpl(v), p = S.project;
  const ms = markerShift(v);
  const [a, b] = inOut(v);
  const method = v.syncMethod || (T && T.markAbs != null ? 'marker' : 'manual');
  const others = [...S.selection].filter((id) => id !== v.id);
  box.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:4px">
      <span style="font:800 18px var(--display);word-break:break-all">${esc(v.name)}</span>
      <span class="muted small">${fmt(v.duration, 1)} · ${v.width}×${v.height} · ${v.fps} fps · ${v.hasAudio ? 'mit Ton' : 'ohne Ton'} · ${esc(v.codec || '')}</span>
      ${v.canDecode === false ? '<span class="chip bad" style="align-self:flex-start">Dieses Format kann der Browser nicht lesen (HEVC?). Am iPhone „Maximale Kompatibilität“ wählen.</span>' : ''}
    </div>
    ${p.templates.length > 1 ? `<label class="field-label">Vorlage<select id="in-tpl">${p.templates.map((t) => `<option value="${t.id}" ${t.id === T.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}

    <div style="display:flex;flex-direction:column;gap:9px">
      <span class="label">Sync</span>
      <div class="seg" role="radiogroup" aria-label="Sync-Methode">
        <button data-m="marker" class="${method === 'marker' ? 'on' : ''}">Marker</button>
        <button data-m="audio" class="${method === 'audio' ? 'on' : ''}" ${v.hasAudio ? '' : 'disabled title="Video hat keinen Ton"'}>Tonspur</button>
        <button data-m="manual" class="${method === 'manual' ? 'on' : ''}">Manuell</button>
      </div>
      <div class="kv"><span>Song-Marker</span>${T && T.markAbs != null ? `<span class="mono" style="color:var(--sec)">${fmt(T.markAbs, 3)}</span>` : '<button class="btn-link" id="in-goto-proj">im Projekt setzen</button>'}</div>
      <div class="kv"><span>Video-Marker</span><span class="mono" style="color:var(--sec)">${v.markV != null ? fmt(v.markV, 3) + ' ✓' : '–'}</span></div>
      <div class="grid2">
        <button class="btn btn-ghost btn-sm" id="in-mark">Marker hier (M)</button>
        <button class="btn btn-ghost btn-sm" id="in-frames">Frame-Streifen (F)</button>
      </div>
      <label class="field-label">Versatz (Videozeit − Songzeit)
        <div class="stepper">
          <button data-sh="-frame" title="Komma">−1 Fr</button><button data-sh="-0.01" title="Umschalt+Komma">−10</button>
          <input id="in-shift" class="field" value="${v.shift != null ? v.shift.toFixed(3) + ' s' : 'nicht synchron'}">
          <button data-sh="0.01" title="Umschalt+Punkt">+10</button><button data-sh="frame" title="Punkt">+1 Fr</button>
        </div>
      </label>
      <span class="small muted">${ms != null && v.shift != null ? `Feinkorrektur zum Marker: <b style="color:var(--text)">${fmtMs((v.shift - ms) * 1000)}</b> · ` : ''}Im Feld: Pfeiltasten ±1 ms, Umschalt ±10 ms</span>
      ${v.shift != null ? '<button class="btn-link" id="in-reset" style="align-self:flex-start;padding:0">Sync zurücksetzen</button>' : ''}
    </div>

    <div style="display:flex;flex-direction:column;gap:9px">
      <span class="label">Zuschnitt</span>
      <div class="grid2">
        <label class="field-label">Start (I)<input id="in-a" class="field mono" value="${fmt(a, 2)}"></label>
        <label class="field-label">Ende (O)<input id="in-b" class="field mono" value="${fmt(b, 2)}"></label>
      </div>
      <span class="small muted" id="in-len">Länge ${(b - a).toFixed(2)} s · Song ${fmt(a - effShift(v))} – ${fmt(b - effShift(v))}</span>
      <div class="row gap wrap">
        <button class="btn btn-dark btn-sm" id="in-tosel">Auf Song-Ausschnitt</button>
        <button class="btn btn-dark btn-sm" id="in-whole">Ganzes Video</button>
      </div>
      <label class="check"><input type="checkbox" id="in-mirror" ${v.mirror ? 'checked' : ''}><span>Spiegeln</span></label>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:auto">
      ${others.length ? `<button class="btn btn-ghost" id="in-apply">Feinkorrektur &amp; Schnitt auf ${others.length} ausgewählte</button>` : ''}
      <button class="btn btn-ice" id="in-next">Fertig · nächstes offenes Video (Tab)</button>
    </div>`;

  const sel = $('in-tpl'); if (sel) sel.onchange = () => { v.templateId = sel.value; if (v.markV != null) applyMarkerSync(v); changed('video'); renderInspector(); tl.fit(); };
  box.querySelectorAll('[data-m]').forEach((btn) => (btn.onclick = () => chooseMethod(v, btn.dataset.m)));
  const gp = $('in-goto-proj'); if (gp) gp.onclick = () => emit('go', 'projekt');
  $('in-mark').onclick = () => setMarkerHere();
  $('in-frames').onclick = () => openFrames();
  box.querySelectorAll('[data-sh]').forEach((btn) => (btn.onclick = () => nudge(btn.dataset.sh)));
  const sf = $('in-shift');
  sf.onkeydown = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(String((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.01 : 0.001))); }
    if (e.key === 'Enter') sf.blur();
  };
  sf.onchange = () => { const x = parseFloat(sf.value.replace(',', '.').replace('−', '-')); if (!isNaN(x)) { keepFrame(() => setShift(v, x, v.syncMethod || 'manual')); afterShift(); } else renderInspector(); };
  const rs = $('in-reset'); if (rs) rs.onclick = () => { v.shift = null; v.syncMethod = null; v.inV = v.outV = null; changed('video'); renderInspector(); renderList(); tl.fit(); };
  $('in-a').onchange = (e) => { const x = parseTime(e.target.value); if (!isNaN(x)) { v.inV = clamp(x, v.firstTs || 0, inOut(v)[1] - 0.2); changed('video'); } renderInspector(); tl.draw(); };
  $('in-b').onchange = (e) => { const x = parseTime(e.target.value); if (!isNaN(x)) { v.outV = clamp(x, inOut(v)[0] + 0.2, v.duration); changed('video'); } renderInspector(); tl.draw(); };
  $('in-tosel').onclick = () => { v.inV = v.outV = null; const [x, y] = defaultInOut(v); v.inV = x; v.outV = y; changed('video'); renderInspector(); tl.draw(); };
  $('in-whole').onclick = () => { v.inV = v.firstTs || 0; v.outV = v.duration; changed('video'); renderInspector(); tl.draw(); };
  $('in-mirror').onchange = (e) => { v.mirror = e.target.checked; forgetVideo(v.id); changed('video'); seekVideo(vt); };
  const ap = $('in-apply'); if (ap) ap.onclick = () => applyToSelection(v, others);
  $('in-next').onclick = () => nextOpen(1);
}
function updateInspectorTimes() {
  const v = selVideo(); const [a, b] = inOut(v);
  const ia = $('in-a'), ib = $('in-b'), il = $('in-len');
  if (ia) ia.value = fmt(a, 2); if (ib) ib.value = fmt(b, 2);
  if (il) il.textContent = `Länge ${(b - a).toFixed(2)} s · Song ${fmt(a - effShift(v))} – ${fmt(b - effShift(v))}`;
}
function updateTransport() {
  const v = selVideo(), tc = $('ed-tc'); if (!v || !tc) return;
  const [a, b] = inOut(v);
  tc.textContent = `${fmt(vt, 2)} / ${fmt(b - a, 2)} · Song ${fmt(vt - effShift(v), 2)}`;
}

// Bild bleibt stehen, Song rutscht darunter
function keepFrame(fn) { fn(); }
function afterShift() { changed('video'); renderInspector(); renderList(); tl.draw(); updateTransport(); if (player.playing) playFromHere(); }
function nudge(kind) {
  const v = selVideo(); if (!v) return;
  const d = kind === 'frame' ? frameDur(v) : kind === '-frame' ? -frameDur(v) : Number(kind);
  setShift(v, effShift(v) + d, v.syncMethod || 'manual');
  afterShift();
}
function chooseMethod(v, m) {
  if (m === 'audio') return runAudioSync([v]);
  if (m === 'marker') {
    v.syncMethod = 'marker';
    if (!applyMarkerSync(v)) toast(tpl(v)?.markAbs == null ? 'Erst im Projekt den Song-Marker setzen' : 'Jetzt im Video den Marker setzen (M oder Frame-Streifen)', 3500);
  }
  if (m === 'manual') { if (v.shift == null) setShift(v, effShift(v), 'manual'); else v.syncMethod = 'manual'; }
  afterShift();
}
export async function runAudioSync(list) {
  if (!S.song) { toast('Erst einen Song laden'); return; }
  const todo = list.filter((v) => v.hasAudio && S.files.get(v.id));
  if (!todo.length) { toast('Keins der Videos hat eine Tonspur'); return; }
  for (const v of todo) {
    v.syncing = true; emit('change', 'video'); renderList();
    try {
      const r = await audioSync(S.files.get(v.id), S.song.buffer);
      setShift(v, r.shift, 'audio');
      v.audioConfidence = r.confidence;
      if (r.confidence < 0.12) toast(`${v.name}: Tonspur-Sync unsicher – bitte kontrollieren`, 4500);
    } catch (e) { toast(`${v.name}: ${e.message}`, 4500); }
    v.syncing = false;
    changed('video');
    if (S.view === 'editor' && v.id === S.selId) { renderInspector(); tl && tl.fit(); seekVideo(vt); }
    renderList();
  }
  if (todo.length > 1) toast(`${todo.length} Videos über die Tonspur abgeglichen`);
}
function setMarkerHere() {
  const v = selVideo(); if (!v) return;
  stopPlay();
  v.markV = S.frameTs ?? vt;
  if (applyMarkerSync(v)) toast('Synchron per Marker');
  else toast('Video-Marker gesetzt – im Projekt fehlt noch der Song-Marker', 3500);
  afterShift();
}
function openFrames() {
  const v = selVideo(); if (!v) return;
  stopPlay();
  openFramePicker(v, vt, (t, next) => {
    v.markV = t;
    applyMarkerSync(v);
    afterShift();
    seekVideo(t);
    if (next) nextOpen(1);
  });
}
function applyToSelection(v, ids) {
  const msV = markerShift(v), [a, b] = inOut(v), sh = effShift(v);
  const fine = msV != null && v.shift != null ? v.shift - msV : null;
  let n = 0;
  for (const id of ids) {
    const o = videoById(id); if (!o) continue;
    const msO = markerShift(o);
    if (fine != null && msO != null) setShift(o, msO + fine, 'marker');
    if (o.shift != null) {
      const so = effShift(o);
      o.inV = clamp(a - sh + so, o.firstTs || 0, o.duration);
      o.outV = clamp(b - sh + so, o.inV + 0.2, o.duration);
    }
    n++;
  }
  changed('video'); renderList();
  toast(`${n} Videos angepasst${fine == null ? ' (nur Schnitt – Feinkorrektur braucht Marker)' : ''}`);
}
export function nextOpen(dir = 1) {
  const vids = S.project.videos;
  if (!vids.length) return;
  const i = vids.findIndex((x) => x.id === S.selId);
  for (let k = 1; k <= vids.length; k++) {
    const v = vids[(i + dir * k + vids.length * 2) % vids.length];
    if (status(v).key === 'open') { selectVideo(v.id); return; }
  }
  toast('Alle Videos sind synchron');
}

// ---------------------------------------------------------------- Tastenkürzel
export function editorKey(e) {
  const v = selVideo(); if (!v) return false;
  const k = e.key;
  if (k === ' ') { togglePlay(); return true; }
  if (k === 'ArrowLeft' || k === 'ArrowRight') { const d = k === 'ArrowLeft' ? -1 : 1; if (e.shiftKey) { stopPlay(); seekVideo(vt + d); } else step(d); return true; }
  if (k === 'j' || k === 'J') { stopPlay(); seekVideo(vt - 1); return true; }
  if (k === 'k' || k === 'K') { stopPlay(); return true; }
  if (k === 'l' || k === 'L') { if (!player.playing) playFromHere(); return true; }
  if (k === 'i' || k === 'I') { v.inV = clamp(vt, v.firstTs || 0, inOut(v)[1] - 0.2); changed('video'); renderInspector(); tl.draw(); return true; }
  if (k === 'o' || k === 'O') { v.outV = clamp(vt, inOut(v)[0] + 0.2, v.duration); changed('video'); renderInspector(); tl.draw(); return true; }
  if (k === 'm' || k === 'M') { setMarkerHere(); return true; }
  if (k === 'f' || k === 'F') { openFrames(); return true; }
  if (k === ',' || k === ';') { nudge(e.shiftKey ? '-0.01' : '-frame'); return true; }
  if (k === '.' || k === ':') { nudge(e.shiftKey ? '0.01' : 'frame'); return true; }
  if (k === 'Tab') { nextOpen(e.shiftKey ? -1 : 1); return true; }
  if (k === 'Home') { stopPlay(); seekVideo(inOut(v)[0]); return true; }
  if (k === 'End') { stopPlay(); seekVideo(inOut(v)[1]); return true; }
  return false;
}
export function leaveEditor() { stopPlay(); }
export function refreshEditorList() { renderList(); }
