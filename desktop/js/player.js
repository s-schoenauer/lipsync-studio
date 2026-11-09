// Synchrone Wiedergabe: Song ist die Uhr, beliebig viele Videos folgen.
import { Input, ALL_FORMATS, BlobSource, CanvasSink } from 'mediabunny';
import { S, effShift, clamp } from './state.js';
import { resumeAudio } from './media.js';

const tracks = new Map(); // videoId -> Promise<{input, vt}>
const sinks = new Map();
export function track(v) {
  if (!tracks.has(v.id)) {
    const file = S.files.get(v.id);
    tracks.set(v.id, (async () => {
      if (!file) throw new Error('Originaldatei fehlt');
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      return { input, vt };
    })());
  }
  return tracks.get(v.id);
}
export function forgetVideo(id) {
  tracks.delete(id);
  for (const k of [...sinks.keys()]) if (k.startsWith(id + '|')) sinks.delete(k);
}
export async function sinkFor(v, w, h, crop = null) {
  const key = `${v.id}|${w}x${h}|${v.mirror ? 1 : 0}|${crop ? crop.join(',') : ''}`;
  if (!sinks.has(key)) {
    sinks.set(key, (async () => {
      const { vt } = await track(v);
      const opts = { width: w, height: h, fit: 'cover', poolSize: 0 };
      if (v.mirror) opts.flip = true;
      if (crop) {
        const W = vt.displayWidth, H = vt.displayHeight;
        opts.crop = { left: Math.round(crop[0] * W), top: Math.round(crop[1] * H), width: Math.round(crop[2] * W), height: Math.round(crop[3] * H) };
      }
      return new CanvasSink(vt, opts);
    })());
  }
  return sinks.get(key);
}

function blank(canvas, text) {
  const g = canvas.getContext('2d');
  g.fillStyle = '#2C1832'; g.fillRect(0, 0, canvas.width, canvas.height);
  if (text) {
    g.fillStyle = '#C9B3D3'; g.font = `${Math.round(canvas.width / 14)}px DM Sans, sans-serif`; g.textAlign = 'center';
    g.fillText(text, canvas.width / 2, canvas.height / 2);
  }
}
export async function drawFrame(v, canvas, vtime) {
  try {
    if (vtime < (v.firstTs || 0) - 0.001 || vtime > v.duration + 0.001) { blank(canvas, vtime < 0 ? 'vor Videostart' : 'nach Videoende'); return null; }
    const sink = await sinkFor(v, canvas.width, canvas.height);
    const wc = await sink.getCanvas(clamp(vtime, v.firstTs || 0, v.duration));
    if (wc) canvas.getContext('2d').drawImage(wc.canvas, 0, 0, canvas.width, canvas.height);
    return wc ? wc.timestamp : null;
  } catch (e) {
    blank(canvas, 'nicht lesbar');
    return null;
  }
}

export class MultiPlayer {
  constructor({ onTime, onEnd } = {}) {
    this.items = []; this.t = 0; this.playing = false; this.token = 0; this.src = null;
    this.onTime = onTime; this.onEnd = onEnd;
    this.frameTs = new Map();
  }
  setItems(items) { this.stop(); this.items = items; }
  async seek(t) {
    this.t = t;
    const tok = ++this.seekTok || (this.seekTok = 1);
    await Promise.all(this.items.map(async (it) => {
      const ts = await drawFrame(it.v, it.canvas, t + effShift(it.v));
      if (tok === this.seekTok) this.frameTs.set(it.v.id, ts);
    }));
    this.onTime && this.onTime(this.t, false);
  }
  stop() {
    this.token++;
    this.playing = false;
    if (this.src) { try { this.src.stop(); } catch {} this.src = null; }
  }
  // Song von t0 bis t1 (Songzeit) abspielen; Videos folgen
  async play(t0, t1, { loop = false } = {}) {
    this.stop();
    const token = this.token;
    const c = await resumeAudio();
    if (token !== this.token) return;
    const buf = S.song?.buffer;
    if (!buf) return;
    this.playing = true;
    const T = c.currentTime + 0.15;
    const dur = Math.max(0.05, t1 - t0);
    const src = c.createBufferSource();
    src.buffer = buf; src.connect(c.destination);
    const off = Math.max(0, t0);
    const delay = Math.max(0, -t0);
    if (off < buf.duration) src.start(T + delay, off, Math.max(0.01, Math.min(dur - delay, buf.duration - off)));
    this.src = src;
    const outLat = (c.outputLatency || 0) + (c.baseLatency || 0);
    const iters = await Promise.all(this.items.map(async (it) => {
      try {
        const vt0 = t0 + effShift(it.v);
        const sink = await sinkFor(it.v, it.canvas.width, it.canvas.height);
        const start = clamp(vt0 - 0.05, it.v.firstTs || 0, it.v.duration);
        const iter = sink.canvases(start);
        const first = await iter.next();
        return { it, iter, next: first.done ? null : first.value, cur: null, g: it.canvas.getContext('2d') };
      } catch { return null; }
    }));
    if (token !== this.token) { iters.forEach((x) => x && x.iter.return()); return; }
    const loopFn = async () => {
      if (token !== this.token) { iters.forEach((x) => x && x.iter.return()); return; }
      const t = t0 + (c.currentTime - T) - outLat;
      this.t = clamp(t, t0, t1);
      if (t >= t1) {
        iters.forEach((x) => x && x.iter.return());
        this.playing = false;
        this.onTime && this.onTime(this.t, false);
        if (loop) { this.play(t0, t1, { loop }); return; }
        this.onEnd && this.onEnd();
        return;
      }
      for (const x of iters) {
        if (!x) continue;
        const vt = Math.max(t, t0) + effShift(x.it.v);
        while (x.next && x.next.timestamp <= vt) {
          x.cur = x.next;
          const r = await x.iter.next();
          if (token !== this.token) return;
          x.next = r.done ? null : r.value;
        }
        if (x.cur) { x.g.drawImage(x.cur.canvas, 0, 0, x.it.canvas.width, x.it.canvas.height); this.frameTs.set(x.it.v.id, x.cur.timestamp); }
      }
      this.onTime && this.onTime(this.t, true);
      requestAnimationFrame(loopFn);
    };
    requestAnimationFrame(loopFn);
  }
}
