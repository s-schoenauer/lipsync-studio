// Frame-Streifen (optional): 9 Frames um die geschätzte Stelle, Klick = Video-Marker
import { S, $, esc, fmt, tpl, effShift, frameDur, clamp } from './state.js';
import { sinkFor, MultiPlayer } from './player.js';

const N = 9;
let zoom = true;
const ZOOM_CROP = [0.2, 0.3, 0.6, 0.38]; // Bildmitte, auf Höhe von Mund und Kinn

export function openFramePicker(v, currentVt, onPick) {
  const T = tpl(v);
  const fd = frameDur(v);
  // Startpunkt: vorhandener Marker → geschätzte Stelle → aktuelle Position
  let center = v.markV != null ? v.markV : (T && T.markAbs != null ? T.markAbs + effShift(v) : currentVt);
  center = clamp(center, (v.firstTs || 0) + 4 * fd, v.duration - 4 * fd);
  let pick = v.markV != null ? 4 : null;
  let frames = [];
  const player = new MultiPlayer();

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Frame-Streifen">
      <div class="row wrap gap" style="justify-content:space-between">
        <div style="display:flex;flex-direction:column;gap:4px">
          <span class="h-card">Klick auf den Frame, der zum Song-Marker passt</span>
          <span class="muted">${esc(v.name)} · ${T && T.markAbs != null ? `Song-Marker bei ${fmt(T.markAbs, 3)} – z. B. Lippen schließen sich beim „p“` : 'Im Projekt ist noch kein Song-Marker gesetzt'}</span>
        </div>
        <div class="row gap wrap">
          <label class="row gap small muted"><input type="checkbox" id="fp-zoom" ${zoom ? 'checked' : ''}>Zoom auf Mund</label>
          <button class="btn btn-ice btn-sm" id="fp-listen" ${T && T.markAbs != null ? '' : 'disabled'}>Song-Stelle anhören</button>
          <button class="icon-btn" id="fp-close" aria-label="Schließen">✕</button>
        </div>
      </div>
      <div class="row gap" style="align-items:stretch">
        <button class="icon-btn" id="fp-left" style="height:auto" aria-label="Frühere Frames"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="frames grow" id="fp-frames"></div>
        <button class="icon-btn" id="fp-right" style="height:auto" aria-label="Spätere Frames"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
      </div>
      <div class="row wrap gap" style="justify-content:space-between">
        <span class="muted small">← → Frame wählen · Umschalt+← → Streifen verschieben · Enter übernehmen · Esc schließen</span>
        <div class="row gap">
          <span class="mono" id="fp-sel">–</span>
          <button class="btn btn-ghost" id="fp-ok" disabled>Übernehmen</button>
          <button class="btn btn-pink" id="fp-ok-next" disabled>Übernehmen · nächstes Video</button>
        </div>
      </div>
    </div>`;
  $('modal-root').append(back);
  const close = () => { player.stop(); back.remove(); document.removeEventListener('keydown', key, true); };

  async function load() {
    const box = back.querySelector('#fp-frames');
    const times = Array.from({ length: N }, (_, i) => clamp(center + (i - 4) * fd, v.firstTs || 0, v.duration));
    box.innerHTML = times.map((t, i) => `<button class="frame" data-i="${i}"><canvas width="${zoom ? 240 : 180}" height="${zoom ? 160 : 320}"></canvas><span>${fmt(t, 3)}</span></button>`).join('');
    const w = zoom ? 240 : 180, h = zoom ? 160 : 320;
    const sink = await sinkFor(v, w, h, zoom ? ZOOM_CROP : null);
    frames = [];
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      const btn = box.querySelector(`[data-i="${i}"]`);
      if (wc && btn) {
        btn.querySelector('canvas').getContext('2d').drawImage(wc.canvas, 0, 0, w, h);
        btn.querySelector('span').textContent = fmt(wc.timestamp, 3);
      }
      frames[i] = wc ? wc.timestamp : times[i];
      i++;
    }
    box.querySelectorAll('.frame').forEach((b) => {
      b.onclick = () => { pick = Number(b.dataset.i); mark(); };
      b.ondblclick = () => { pick = Number(b.dataset.i); accept(false); };
    });
    mark();
  }
  function mark() {
    back.querySelectorAll('.frame').forEach((b) => {
      const i = Number(b.dataset.i);
      b.classList.toggle('pick', i === pick);
      b.classList.toggle('sugg', pick == null && i === 4);
    });
    back.querySelector('#fp-sel').textContent = pick != null && frames[pick] != null ? `Frame ${fmt(frames[pick], 3)}` : '–';
    back.querySelector('#fp-ok').disabled = back.querySelector('#fp-ok-next').disabled = pick == null;
  }
  function shiftStrip(n) { center = clamp(center + n * fd, (v.firstTs || 0) + 4 * fd, v.duration - 4 * fd); pick = null; load(); }
  function accept(next) { if (pick == null) return; const t = frames[pick]; close(); onPick(t, next); }
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) shiftStrip(d * 4);
      else {
        const p = (pick ?? 4) + d;
        if (p < 0) shiftStrip(-1); else if (p >= N) shiftStrip(1); else { pick = p; mark(); }
      }
    } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); accept(e.shiftKey || e.ctrlKey); }
  }
  document.addEventListener('keydown', key, true);
  back.querySelector('#fp-close').onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  back.querySelector('#fp-left').onclick = () => shiftStrip(-4);
  back.querySelector('#fp-right').onclick = () => shiftStrip(4);
  back.querySelector('#fp-zoom').onchange = (e) => { zoom = e.target.checked; load(); };
  back.querySelector('#fp-listen').onclick = () => player.play(T.markAbs - 1.2, T.markAbs + 0.4);
  back.querySelector('#fp-ok').onclick = () => accept(false);
  back.querySelector('#fp-ok-next').onclick = () => accept(true);
  load();
}
