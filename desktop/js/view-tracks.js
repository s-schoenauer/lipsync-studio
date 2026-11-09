// Ansicht „Spuren“ (optional): alle Videos als Spuren unter dem Song
import { S, $, esc, fmt, clamp, toast, changed, emit, activeTpl, videoById, effShift, setShift, filteredVideos, applyMarkerSync } from './state.js';
import { MultiPlayer } from './player.js';
import { Timeline } from './timeline.js';

let player, tl, sT = null, root;
const eyes = [];

export function renderTracks(r) {
  root = r;
  const T = activeTpl();
  if (sT == null && T) sT = T.markAbs ?? T.selStart;
  const vids = filteredVideos();
  // Augen: standardmäßig die ersten drei
  for (const id of [...eyes]) if (!videoById(id)) eyes.splice(eyes.indexOf(id), 1);
  if (!eyes.length) vids.slice(0, 3).forEach((v) => eyes.push(v.id));
  root.innerHTML = `
  <div class="sp-top">
    <div class="sp-prev" id="sp-prev"></div>
    <div style="flex:1 1 300px;display:flex;flex-direction:column;gap:10px;justify-content:center">
      <span class="h-card">Takes nebeneinander vergleichen</span>
      <span class="muted">Auge an der Spur = in der Vorschau zeigen (bis zu 3). Clips seitlich ziehen = Versatz, weiße Griffe = Start/Ende, Klick ins Lineal = Position.</span>
      <div class="row gap wrap">
        <button class="icon-btn play" id="sp-play" aria-label="Abspielen" title="Leertaste"><svg id="sp-play-ic" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
        <span class="mono" id="sp-time" style="font-size:15px">${fmt(sT ?? 0, 2)}</span>
        <label class="row gap small muted"><input type="checkbox" id="sp-snap" checked>Einrasten an Markern</label>
        <button class="btn-link" id="sp-fit">Einpassen</button>
      </div>
    </div>
  </div>
  <div style="padding:10px 14px 14px;background:var(--panel)">
    ${vids.length ? '<canvas class="tl-canvas" id="sp-tl"></canvas>' : '<div class="empty">Noch keine Videos.</div>'}
    <span class="small muted" style="display:block;margin-top:8px">Mausrad mit Strg zoomt · Umschalt+Mausrad scrollt · gestrichelt = noch nicht synchron · Hellblau = Marker</span>
  </div>`;
  player = player || new MultiPlayer();
  renderPreviews();
  player.onTime = (t) => { sT = t; $('sp-time') && ($('sp-time').textContent = fmt(t, 2)); tl && tl.draw(); };
  player.onEnd = () => setIcon(false);
  $('sp-play').onclick = togglePlay;
  $('sp-fit').onclick = () => tl && tl.fit();
  if (!vids.length) return;
  tl = new Timeline($('sp-tl'), {
    multi: true,
    rows: () => filteredVideos().map((v) => ({ v, eye: eyes.includes(v.id), active: v.id === S.selId })),
    playhead: () => sT,
    onSeek: (t) => { stop(); sT = t; $('sp-time').textContent = fmt(t, 2); player.seek(t); tl.draw(); },
    onShift: (v, ns, done) => { setShift(v, ns, v.syncMethod || 'manual'); if (done) { changed('video'); player.seek(sT); } },
    onInOut: (v, a, b, done) => { v.inV = a; v.outV = b; if (done) changed('video'); },
    onEye: (v) => { const i = eyes.indexOf(v.id); if (i >= 0) eyes.splice(i, 1); else { eyes.push(v.id); if (eyes.length > 3) eyes.shift(); } renderPreviews(); tl.draw(); },
    onSelect: (v) => { S.selId = v.id; tl.draw(); },
  });
  $('sp-snap').onchange = (e) => (tl.o.snap = e.target.checked);
  tl.fit();
}
function renderPreviews() {
  const box = $('sp-prev'); if (!box) return;
  const vs = eyes.map(videoById).filter(Boolean);
  box.innerHTML = vs.map((v) => `<div class="pv"><canvas data-pv="${v.id}" width="240" height="426"></canvas><span class="small muted mono">${esc(v.name)}</span></div>`).join('')
    || '<span class="muted small" style="align-self:center">Auge an einer Spur antippen</span>';
  stop();
  player && player.setItems(vs.map((v) => ({ v, canvas: box.querySelector(`[data-pv="${v.id}"]`) })));
  player && sT != null && player.seek(sT);
}
function setIcon(on) { const ic = $('sp-play-ic'); if (ic) ic.innerHTML = on ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'; }
function stop() { if (player?.playing) { player.stop(); setIcon(false); } }
function togglePlay() {
  if (player.playing) { stop(); return; }
  const T = activeTpl();
  const end = T ? T.selEnd + 1 : (sT ?? 0) + 20;
  if (sT == null || sT >= end - 0.1) sT = T ? T.selStart - 1 : 0;
  setIcon(true);
  player.play(sT, end);
}
export function tracksKey(e) { if (e.key === ' ') { togglePlay(); return true; } return false; }
export function leaveTracks() { stop(); }
