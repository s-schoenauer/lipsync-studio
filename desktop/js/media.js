// Medien: Song dekodieren, Wellenformen, Video-Infos, Auto-Sync über die Tonspur.
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from 'mediabunny';

let ctx = null;
export function audioCtx() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}
export async function resumeAudio() {
  const c = audioCtx();
  if (c.state !== 'running') await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  return c;
}

export async function decodeSong(blob) {
  const c = audioCtx();
  try {
    return await c.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return await decodeWithMediabunny(blob);
  }
}
async function decodeWithMediabunny(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('Keine Audiospur');
  return collectAudio(track);
}
async function collectAudio(track, maxSeconds = Infinity) {
  const sink = new AudioBufferSink(track);
  const first = await track.getFirstTimestamp();
  const parts = [];
  let sr = track.sampleRate, ch = track.numberOfChannels, total = 0;
  for await (const { buffer, timestamp } of sink.buffers()) {
    sr = buffer.sampleRate; ch = buffer.numberOfChannels;
    const off = Math.max(0, Math.round((timestamp - first) * sr));
    parts.push({ buffer, off });
    total = Math.max(total, off + buffer.length);
    if (timestamp - first > maxSeconds) break;
  }
  if (!total) throw new Error('Leere Audiospur');
  const out = new AudioBuffer({ length: total, numberOfChannels: ch, sampleRate: sr });
  for (let c = 0; c < ch; c++) {
    const dst = out.getChannelData(c);
    for (const { buffer, off } of parts) dst.set(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).subarray(0, total - off), off);
  }
  return { buffer: out, firstTs: first };
}

// Spitzenwerte für Wellenformen (normiert 0..1), n Säulen über [t0, t1]
export function peaks(buffer, t0, t1, n) {
  const sr = buffer.sampleRate;
  const c0 = buffer.getChannelData(0);
  const c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const out = new Float32Array(n);
  const a0 = t0 * sr, span = (t1 - t0) * sr;
  const step = Math.max(1, Math.floor(span / n / 64));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, Math.floor(a0 + (i / n) * span));
    const b = Math.min(c0.length, Math.floor(a0 + ((i + 1) / n) * span));
    let m = 0;
    for (let j = a; j < b; j += step) {
      const v = Math.abs(c0[j]) + (c1 ? Math.abs(c1[j]) : 0);
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}
let globalPeak = new WeakMap();
export function songMax(buffer) {
  if (globalPeak.has(buffer)) return globalPeak.get(buffer);
  const p = peaks(buffer, 0, buffer.duration, 2000);
  let m = 1e-6; for (const v of p) if (v > m) m = v;
  globalPeak.set(buffer, m);
  return m;
}

// Video untersuchen
export async function probeVideo(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('Keine Videospur');
  const at = await input.getPrimaryAudioTrack();
  const [duration, canDecode, firstTs] = await Promise.all([input.computeDuration(), vt.canDecode(), vt.getFirstTimestamp()]);
  let fps = 30;
  try { const st = await vt.computePacketStats(60); if (st.averagePacketRate > 1) fps = Math.round(st.averagePacketRate); } catch {}
  return {
    duration, firstTs, fps,
    width: vt.displayWidth, height: vt.displayHeight, rotation: vt.rotation,
    codec: vt.codec, canDecode, hasAudio: !!at,
  };
}

// ---------------------------------------------------------------- Auto-Sync über die Tonspur
// Ergebnis: shift (Sekunden) mit Videozeit = Songzeit + shift, plus Zuverlässigkeit 0..1
const SR = 8000;
function mono8k(buffer, from = 0, to = buffer.duration) {
  const sr = buffer.sampleRate, ratio = sr / SR;
  const c0 = buffer.getChannelData(0), c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = Math.max(0, Math.floor((to - from) * SR));
  const out = new Float32Array(n);
  const start = from * sr;
  const w = Math.max(1, Math.floor(ratio));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(start + i * ratio);
    let s = 0;
    for (let k = 0; k < w; k++) { const j = a + k; if (j < c0.length) s += c0[j] + (c1 ? c1[j] : 0); }
    out[i] = s / w;
  }
  return out;
}
function onsetEnvelope(x, hop = 80) { // 10 ms Raster
  const n = Math.floor(x.length / hop);
  const e = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop, k = j + hop; j < k; j++) s += x[j] * x[j];
    const l = Math.log(1e-7 + s / hop);
    e[i] = Math.max(0, l - prev);
    prev = l;
  }
  // Mittelwert abziehen
  let m = 0; for (const v of e) m += v; m /= n || 1;
  for (let i = 0; i < n; i++) e[i] -= m;
  return e;
}
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// corr[k] = Σ v[i]·s[i+k]  für k = 0..S-1 (Video beginnt bei Song-Index k)
function xcorr(s, v) {
  let n = 1; while (n < s.length + v.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(s); br.set(v);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { // A · conj(B)
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  return ar.subarray(0, s.length);
}

export async function audioSync(videoBlob, songBuffer, videoFirstTs = 0) {
  const input = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
  const at = await input.getPrimaryAudioTrack();
  if (!at) throw new Error('Das Video hat keine Tonspur');
  const { buffer: vbuf, firstTs } = await collectAudio(at, 120);
  const vs = mono8k(vbuf), ss = mono8k(songBuffer);
  const ve = onsetEnvelope(vs), se = onsetEnvelope(ss);
  const c = xcorr(se, ve);
  let best = 0, bi = 0;
  for (let i = 0; i < c.length; i++) if (c[i] > best) { best = c[i]; bi = i; }
  // Zweitbester Peak außerhalb ±150 ms → Zuverlässigkeit
  let second = 0;
  for (let i = 0; i < c.length; i++) if (Math.abs(i - bi) > 15 && c[i] > second) second = c[i];
  const confidence = best > 0 ? Math.max(0, Math.min(1, 1 - second / best)) : 0;
  // Feinabgleich auf Samplebasis (±15 ms um den Grobwert), auf einem lauten Stück des Videos
  let coarse = bi * 80; // Song-Sample, an dem Video-Sample 0 liegt
  const segLen = Math.min(vs.length, 6 * SR);
  let segStart = 0, bestE = -1;
  for (let a = 0; a + segLen <= vs.length; a += SR / 2) {
    let e = 0; for (let j = a; j < a + segLen; j += 8) e += vs[j] * vs[j];
    if (e > bestE) { bestE = e; segStart = a; }
  }
  let fine = coarse, fineBest = -Infinity;
  for (let lag = coarse - 120; lag <= coarse + 120; lag++) {
    let s = 0;
    for (let j = segStart; j < segStart + segLen; j += 2) {
      const k = j + lag;
      if (k >= 0 && k < ss.length) s += vs[j] * ss[k];
    }
    if (s > fineBest) { fineBest = s; fine = lag; }
  }
  const songAtVideoAudioStart = fine / SR;
  // Videozeit (Container) = Audio-Start + t; Songzeit = songAtVideoAudioStart + t
  const shift = (firstTs) - songAtVideoAudioStart;
  return { shift, confidence };
}
