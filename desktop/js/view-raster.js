// Ansicht „Raster“: alle Videos als Kacheln, gemeinsam synchron abspielen, einzeln anpassen
import {
  S, $, esc, fmt, fmtMs, clamp, toast, changed, emit, tpl, activeTpl, videoById,
  effShift, inOut, defaultInOut, status, markerShift, setShift, applyMarkerSync, frameDur, filteredVideos, counts,
} from './state.js';
import { MultiPlayer, drawFrame } from './player.js';
import { runAudioSync } from './view-editor.js';
import { queueExport } from './view-export.js';

let player, rT = null, activeId = null, root, tileMin = 330;

function win() { const T = activeTpl(); return T ? [T.selStart - 1, T.selEnd + 1] : [0, 20]; }

export function renderRaster(r) {
  root = r;
  const T = activeTpl();
  if (rT == null || !T || rT < win()[0] || rT > win()[1]) rT = T ? (T.markAbs ?? T.selStart + 1) : 0;
  const c = counts();
  root.innerHTML = `
  <div class="toolbar">
    <button class="icon-btn play" id="ra-play" aria-label="Alle synchron abspielen" title="Leertaste"><svg id="ra-play-ic" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
    <div style="display:flex;flex-direction:column"><strong>Alle synchron abspielen</strong><span class="small muted mono" id="ra-time">Song ${fmt(rT)}</span></div>
    <input type="range" id="ra-pos" min="0" max="1000" value="0" aria-label="Song-Position für alle" style="flex:1 1 220px">
    <button class="btn btn-ghost btn-sm" id="ra-mark" ${T && T.markAbs != null ? '' : 'disabled'}>Zum Song-Marker</button>
    <div class="row gap wrap">${[['alle', 'Alle'], ['offen', 'Offen'], ['sync', 'Synchron'], ['done', 'Exportiert']].map(([k, l]) => `<button class="filter ${S.filter === k ? 'on' : ''}" data-f="${k}">${l} ${c[k]}</button>`).join('')}</div>
    <label class="row gap small muted">Kachelgröße<input type="range" id="ra-size" min="280" max="520" value="${tileMin}" style="width:90px"></label>
  </div>
  <div class="batchbar" id="ra-batch"></div>
  <div class="tiles" id="ra-tiles" style="grid-template-columns:repeat(auto-fill,minmax(${tileMin}px,1fr))"></div>
  ${S.project.videos.length ? '' : '<div class="empty"><span class="h-card">Noch keine Videos</span><span>Zieh Videos ins Fenster.</span></div>'}`;

  player = player || new MultiPlayer();
  player.onTime = (t, playing) => { rT = t; updateTime(); };
  player.onEnd = () => setIcon(false);
  $('ra-play').onclick = togglePlay;
  $('ra-pos').oninput = (e) => { stop(); const [a, b] = win(); rT = a + (Number(e.target.value) / 1000) * (b - a); updateTime(); seekAll(); };
  $('ra-mark').onclick = () => { stop(); rT = activeTpl().markAbs; updateTime(); seekAll(); };
  $('ra-size').oninput = (e) => { tileMin = Number(e.target.value); $('ra-tiles').style.gridTemplateColumns = `repeat(auto-fill,minmax(${tileMin}px,1fr))`; };
  root.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; renderRaster(root); }));
  renderTiles();
  renderBatch();
}

function setIcon(on) { const ic = $('ra-play-ic'); if (ic) ic.innerHTML = on ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'; }
function stop() { if (player?.playing) { player.stop(); setIcon(false); } }
function togglePlay() {
  if (player.playing) { stop(); return; }
  const [a, b] = win();
  if (rT >= b - 0.1) rT = a;
  player.setItems(items());
  setIcon(true);
  player.play(rT, b);
}
function items() {
  return filteredVideos().slice(0, 24).map((v) => ({ v, canvas: root.querySelector(`canvas[data-tile="${v.id}"]`) })).filter((x) => x.canvas);
}
function seekAll() { player.setItems(items()); player.seek(rT); }
function updateTime() {
  const [a, b] = win();
  const t = $('ra-time'), p = $('ra-pos');
  if (t) t.textContent = `Song ${fmt(rT)}`;
  if (p) p.value = String(Math.round(((rT - a) / (b - a)) * 1000));
  root.querySelectorAll('[data-tc]').forEach((el) => { const v = videoById(el.dataset.tc); if (v) el.textContent = fmt(rT + effShift(v), 2); });
}

function tileHtml(v) {
  const st = status(v), ms = markerShift(v), [a, b] = inOut(v), sh = effShift(v);
  const [w0, w1] = win(), span = w1 - w0;
  const pct = (t) => clamp(((t - w0) / span) * 100, 0, 100);
  const inL = pct(a - sh), outL = pct(b - sh);
  const T = tpl(v);
  const markL = T && T.markAbs != null ? pct(T.markAbs) : -5;
  const vL = v.markV != null ? pct(v.markV - sh) : -5;
  const offTxt = v.shift == null ? 'nicht synchron' : ms != null ? fmtMs((v.shift - ms) * 1000) : `${v.shift.toFixed(3)} s`;
  return `<article class="tile ${S.selection.has(v.id) ? 'sel' : ''} ${v.id === activeId ? 'active' : ''}" data-id="${v.id}" aria-label="${esc(v.name)}">
    <div class="tv"><canvas data-tile="${v.id}" width="240" height="426"></canvas><span class="tc" data-tc="${v.id}">${fmt(rT + sh, 2)}</span></div>
    <div class="tb">
      <div class="row gap"><input type="checkbox" data-chk="${v.id}" aria-label="${esc(v.name)} auswählen" ${S.selection.has(v.id) ? 'checked' : ''}>
        <strong class="grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(v.name)}</strong><span class="chip ${st.cls}">${st.label}</span></div>
      <div class="stepper"><button data-sh="-frame" aria-label="1 Frame früher" title="Komma · Umschalt = 10 ms">−Fr</button>
        <span class="mono" style="flex:1;min-width:0;text-align:center;white-space:nowrap;overflow:hidden;background:var(--bg-deep);border:1px solid var(--line);border-radius:6px;padding:6px 2px;font-size:12px">${offTxt}</span>
        <button data-sh="frame" aria-label="1 Frame später" title="Punkt · Umschalt = 10 ms">+Fr</button></div>
      <div class="trim" data-trim="${v.id}" title="Klick = alle an diese Song-Stelle">
        <div style="position:absolute;left:${inL}%;width:${Math.max(0, outL - inL)}%;top:4px;bottom:4px;background:var(--accent);opacity:.85;border-radius:4px"></div>
        <div style="position:absolute;left:${inL}%;top:0;bottom:0;width:4px;background:var(--text);border-radius:2px"></div>
        <div style="position:absolute;left:${outL}%;top:0;bottom:0;width:4px;margin-left:-4px;background:var(--text);border-radius:2px"></div>
        <div style="position:absolute;left:${markL}%;top:0;bottom:0;width:2px;background:var(--sec)"></div>
        ${v.markV != null && v.shift != null && Math.abs(vL - markL) > 0.3 ? `<div style="position:absolute;left:${vL}%;top:0;bottom:0;width:2px;background:var(--warn)"></div>` : ''}
      </div>
      <div class="row small muted mono" style="justify-content:space-between"><span>${fmt(a, 2)}</span><span>${(b - a).toFixed(1)} s</span><span>${fmt(b, 2)}</span></div>
      <div class="btn3"><button class="ice" data-act="m" title="M">Marker</button><button data-act="i" title="I">Start</button><button data-act="o" title="O">Ende</button></div>
    </div></article>`;
}
function renderTiles() {
  const box = $('ra-tiles'); if (!box) return;
  const vids = filteredVideos();
  box.innerHTML = vids.map(tileHtml).join('');
  box.querySelectorAll('.tile').forEach((el) => wireTile(el));
  seekAll();
}
function refreshTile(v) {
  const el = root.querySelector(`.tile[data-id="${v.id}"]`); if (!el) return;
  const tmp = document.createElement('div'); tmp.innerHTML = tileHtml(v);
  const n = tmp.firstElementChild;
  // Canvas behalten (kein Flackern)
  n.querySelector('.tv').replaceWith(el.querySelector('.tv'));
  el.replaceWith(n); wireTile(n);
  drawFrame(v, n.querySelector('canvas'), rT + effShift(v));
}
function wireTile(el) {
  const v = videoById(el.dataset.id);
  el.onclick = (e) => {
    if (e.target.closest('button,input,.trim')) return;
    if (e.ctrlKey || e.metaKey) { toggleSel(v.id); return; }
    setActive(v.id);
  };
  el.ondblclick = (e) => { if (!e.target.closest('button,input')) { S.selId = v.id; emit('go', 'editor'); } };
  el.querySelector('[data-chk]').onchange = () => toggleSel(v.id);
  el.querySelectorAll('[data-sh]').forEach((b) => (b.onclick = () => nudge(v, b.dataset.sh)));
  el.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(v, b.dataset.act)));
  el.querySelector('.trim').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect(), [a, b] = win();
    stop(); rT = a + ((e.clientX - r.left) / r.width) * (b - a); updateTime(); seekAll();
  };
}
function setActive(id) {
  activeId = id;
  root.querySelectorAll('.tile').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
}
function toggleSel(id) {
  S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id);
  const el = root.querySelector(`.tile[data-id="${id}"]`);
  if (el) { el.classList.toggle('sel', S.selection.has(id)); el.querySelector('[data-chk]').checked = S.selection.has(id); }
  renderBatch();
}
function nudge(v, kind) {
  const d = kind === 'frame' ? frameDur(v) : kind === '-frame' ? -frameDur(v) : Number(kind);
  setShift(v, effShift(v) + d, v.syncMethod || 'manual');
  changed('video'); refreshTile(v);
  if (player.playing) { const t = rT; stop(); rT = t; togglePlay(); }
}
async function act(v, a) {
  stop();
  setActive(v.id);
  const vt = player.frameTs.get(v.id) ?? clamp(rT + effShift(v), v.firstTs || 0, v.duration);
  if (a === 'm') {
    v.markV = vt;
    if (applyMarkerSync(v)) toast(`${v.name}: synchron per Marker`);
    else toast('Video-Marker gesetzt – im Projekt fehlt noch der Song-Marker', 3500);
  } else if (a === 'i') v.inV = clamp(vt, v.firstTs || 0, inOut(v)[1] - 0.2);
  else if (a === 'o') v.outV = clamp(vt, inOut(v)[0] + 0.2, v.duration);
  changed('video'); refreshTile(v); emit('counts');
}

function renderBatch() {
  const bar = $('ra-batch'); if (!bar) return;
  const ids = [...S.selection].filter((id) => videoById(id));
  if (!ids.length) {
    bar.innerHTML = `<span class="muted small">Tipp: Strg-Klick oder Häkchen wählt mehrere Kacheln für Sammelaktionen · Doppelklick öffnet im Editor</span>
      <button class="btn-link" id="ra-all" style="margin-left:auto">Alle auswählen</button>`;
    $('ra-all').onclick = () => { filteredVideos().forEach((v) => S.selection.add(v.id)); renderTiles(); renderBatch(); };
    return;
  }
  bar.innerHTML = `<strong>${ids.length} ausgewählt</strong>
    <button class="btn btn-ice btn-sm" id="ba-marker">Per Marker syncen</button>
    <button class="btn btn-dark btn-sm" id="ba-audio">Über Tonspur syncen</button>
    <button class="btn btn-dark btn-sm" id="ba-cut">Start/Ende = Song-Ausschnitt</button>
    <button class="btn btn-dark btn-sm" id="ba-export">In Export-Warteschlange</button>
    <button class="btn-link" id="ba-none" style="margin-left:auto">Auswahl aufheben</button>`;
  const vs = () => ids.map(videoById).filter(Boolean);
  $('ba-marker').onclick = () => {
    let ok = 0; for (const v of vs()) if (applyMarkerSync(v)) ok++;
    changed('video'); renderTiles();
    toast(ok ? `${ok} Videos per Marker synchron` : 'Keins der Videos hat einen Video-Marker – erst M drücken');
  };
  $('ba-audio').onclick = async () => { await runAudioSync(vs()); renderTiles(); };
  $('ba-cut').onclick = () => { for (const v of vs()) { const [a, b] = defaultInOut(v); v.inV = a; v.outV = b; } changed('video'); renderTiles(); };
  $('ba-export').onclick = () => { const n = queueExport(vs()); toast(`${n} Videos in der Export-Warteschlange`); };
  $('ba-none').onclick = () => { S.selection.clear(); renderTiles(); renderBatch(); };
}

export function rasterKey(e) {
  const k = e.key;
  if (k === ' ') { togglePlay(); return true; }
  const vids = filteredVideos();
  if (!vids.length) return false;
  const i = Math.max(0, vids.findIndex((v) => v.id === activeId));
  const v = videoById(activeId) || vids[0];
  if (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'ArrowDown' || k === 'ArrowUp') {
    const cols = Math.max(1, Math.round($('ra-tiles').clientWidth / (tileMin + 12)));
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[k];
    const n = vids[clamp(i + d, 0, vids.length - 1)];
    setActive(n.id);
    root.querySelector(`.tile[data-id="${n.id}"]`)?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (!activeId) setActive(v.id);
  if (k === 'm' || k === 'M') { act(v, 'm'); return true; }
  if (k === 'i' || k === 'I') { act(v, 'i'); return true; }
  if (k === 'o' || k === 'O') { act(v, 'o'); return true; }
  if (k === ',' || k === ';') { nudge(v, e.shiftKey ? '-0.01' : '-frame'); return true; }
  if (k === '.' || k === ':') { nudge(v, e.shiftKey ? '0.01' : 'frame'); return true; }
  if (k === 'Enter') { S.selId = v.id; emit('go', 'editor'); return true; }
  return false;
}
export function leaveRaster() { stop(); }
