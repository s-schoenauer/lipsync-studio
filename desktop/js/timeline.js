// Timeline auf Canvas: Songspur + eine oder mehrere Videospuren (Achse = Songzeit)
import { S, effShift, inOut, status, tpl, activeTpl, clamp, css, fmt, fmtMs, markerShift } from './state.js';
import { peaks, songMax } from './media.js';

const NICE = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];

export class Timeline {
  constructor(canvas, opts) {
    this.c = canvas; this.o = Object.assign({ multi: false, snap: true }, opts);
    this.t0 = 0; this.t1 = 20; this.drag = null; this.hover = null;
    this.LW = this.o.multi ? 200 : 64;
    this.RULER = 22; this.SONG = this.o.multi ? 48 : 60; this.ROW = this.o.multi ? 40 : 58; this.GAP = 6;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', () => (this.drag = null));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.c.style.cursor = ''; });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  rows() { return this.o.rows(); }
  height() { const n = this.rows().length; return this.RULER + this.SONG + this.GAP + n * (this.ROW + this.GAP); }
  fit() {
    const t = activeTpl();
    const rows = this.rows();
    let a = t ? t.selStart - 2 : 0, b = t ? t.selEnd + 2 : 20;
    if (!this.o.multi && rows[0]) {
      const v = rows[0].v, sh = effShift(v);
      a = Math.min(a, (v.firstTs || 0) - sh - 0.5); b = Math.max(b, v.duration - sh + 0.5);
    }
    if (S.song) { a = Math.max(a, -5); b = Math.min(b, S.song.buffer.duration + 5); }
    this.t0 = a; this.t1 = Math.max(a + 1, b);
    this.draw();
  }
  x(t) { const W = this.c.clientWidth; return this.LW + ((t - this.t0) / (this.t1 - this.t0)) * (W - this.LW); }
  t(x) { const W = this.c.clientWidth; return this.t0 + ((x - this.LW) / (W - this.LW)) * (this.t1 - this.t0); }
  rowTop(i) { return this.RULER + this.SONG + this.GAP + i * (this.ROW + this.GAP); }

  draw() {
    const c = this.c, dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = this.height();
    if (!W) return;
    c.style.height = H + 'px';
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const C = { accent: css('--accent'), sec: css('--sec'), line: css('--line'), text: css('--text'), muted: css('--muted'), deep: css('--bg-deep'), thumb: css('--thumb'), warn: css('--warn'), card: css('--card') };
    const span = this.t1 - this.t0;
    const T = activeTpl();

    // Lineal
    const step = NICE.find((s) => ((W - this.LW) / span) * s >= 70) || 60;
    g.font = '500 11px JetBrains Mono, monospace'; g.fillStyle = C.muted; g.textBaseline = 'top';
    for (let k = Math.ceil(this.t0 / step) * step; k <= this.t1; k += step) {
      const x = this.x(k);
      g.fillRect(x, 14, 1, 6);
      g.fillText(fmt(k, step < 1 ? (step < 0.1 ? 2 : 1) : 0), x + 3, 2);
    }

    // Songspur
    const sy = this.RULER, sh = this.SONG;
    g.fillStyle = C.deep; this.rr(g, this.LW, sy, W - this.LW, sh, 8); g.fill();
    g.fillStyle = C.muted; g.font = '700 11px DM Sans, sans-serif'; g.textBaseline = 'middle';
    g.fillText('SONG', 6, sy + sh / 2);
    if (S.song) {
      const buf = S.song.buffer, cols = Math.max(10, Math.floor((W - this.LW) / 3));
      const a = Math.max(0, this.t0), b = Math.min(buf.duration, this.t1);
      if (b > a) {
        const xa = this.x(a), xb = this.x(b);
        const n = Math.max(2, Math.floor((xb - xa) / 3));
        const p = peaks(buf, a, b, n), mx = songMax(buf);
        for (let i = 0; i < n; i++) {
          const t = a + ((i + 0.5) / n) * (b - a);
          const h = Math.max(2, Math.min(1, p[i] / mx) * (sh - 10));
          g.fillStyle = T && t >= T.selStart && t <= T.selEnd ? C.accent : C.line;
          g.fillRect(xa + i * 3, sy + (sh - h) / 2, 2, h);
        }
      }
      if (T) {
        g.strokeStyle = C.text; g.lineWidth = 2;
        for (const tt of [T.selStart, T.selEnd]) { const x = this.x(tt); g.beginPath(); g.moveTo(x, sy); g.lineTo(x, sy + sh); g.stroke(); }
        if (T.markAbs != null) this.flag(g, this.x(T.markAbs), sy, sh, 'S', C, true);
      }
    }

    // Videospuren
    const rows = this.rows();
    rows.forEach((r, i) => {
      const v = r.v, y = this.rowTop(i), h = this.ROW;
      const shv = effShift(v);
      const a = (v.firstTs || 0) - shv, b = v.duration - shv;
      const [inA, outB] = inOut(v);
      const st = status(v);
      // Label
      if (this.o.multi) {
        if (r.active) { g.fillStyle = C.card; this.rr(g, 0, y, this.LW - 8, h, 8); g.fill(); }
        // Auge
        g.fillStyle = r.eye ? C.sec : C.card; this.rr(g, 6, y + h / 2 - 12, 24, 24, 6); g.fill();
        g.strokeStyle = r.eye ? C.deep : C.muted; g.lineWidth = 1.6;
        g.beginPath(); g.ellipse(18, y + h / 2, 7, 4.5, 0, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(18, y + h / 2, 1.8, 0, Math.PI * 2); g.stroke();
        g.fillStyle = C.text; g.font = '700 13px DM Sans, sans-serif'; g.textBaseline = 'alphabetic';
        g.fillText(this.ellipsis(g, v.name, this.LW - 50), 38, y + h / 2 - 2);
        g.font = '500 11px JetBrains Mono, monospace'; g.fillStyle = st.cls === 'warn' || st.cls === 'bad' ? C.warn : C.sec;
        const ms = markerShift(v);
        g.fillText(v.shift == null ? st.label : (ms != null ? fmtMs((v.shift - ms) * 1000) + ' zum Marker' : st.label), 38, y + h / 2 + 13);
      } else {
        g.fillStyle = C.muted; g.font = '700 11px DM Sans, sans-serif'; g.textBaseline = 'middle';
        g.fillText('VIDEO', 6, y + h / 2);
      }
      g.fillStyle = C.deep; this.rr(g, this.LW, y, W - this.LW, h, 8); g.fill();
      g.save(); g.beginPath(); g.rect(this.LW, y, W - this.LW, h); g.clip();
      const xa = this.x(a), xb = this.x(b);
      g.fillStyle = C.thumb; this.rr(g, xa, y + 3, xb - xa, h - 6, 6); g.fill();
      g.lineWidth = 2; g.strokeStyle = v.shift == null ? C.warn : C.accent;
      g.setLineDash(v.shift == null ? [6, 4] : []); this.rr(g, xa, y + 3, xb - xa, h - 6, 6); g.stroke(); g.setLineDash([]);
      // Bereiche außerhalb Start/Ende abdunkeln
      const xi = this.x(inA - shv), xo = this.x(outB - shv);
      g.fillStyle = 'rgba(16,7,15,0.7)';
      g.fillRect(xa, y + 3, Math.max(0, xi - xa), h - 6);
      g.fillRect(xo, y + 3, Math.max(0, xb - xo), h - 6);
      g.fillStyle = 'rgba(240,42,150,0.18)'; g.fillRect(xi, y + 5, Math.max(0, xo - xi), h - 10);
      // Griffe
      g.fillStyle = C.text;
      this.rr(g, xi - 1, y, 6, h, 3); g.fill();
      this.rr(g, xo - 5, y, 6, h, 3); g.fill();
      if (v.markV != null) this.flag(g, this.x(v.markV - shv), y, h, 'V', C, false);
      g.restore();
    });

    // Abspielkopf
    const ph = this.o.playhead();
    if (ph != null) {
      const x = this.x(ph);
      if (x >= this.LW) { g.fillStyle = C.text; g.fillRect(x - 1, 0, 2, H); g.beginPath(); g.moveTo(x - 6, 0); g.lineTo(x + 6, 0); g.lineTo(x, 8); g.fill(); }
    }
  }
  flag(g, x, y, h, label, C, top) {
    g.fillStyle = C.sec; g.fillRect(x - 1, y, 2, h);
    g.font = '800 11px DM Sans, sans-serif'; g.textBaseline = 'middle';
    const ty = top ? y + 9 : y + h - 9;
    this.rr(g, x + 3, ty - 8, 16, 16, 4); g.fill();
    g.fillStyle = C.deep; g.fillText(label, x + 7, ty + 1);
  }
  rr(g, x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, Math.max(0, w), h, r); else g.rect(x, y, Math.max(0, w), h); }
  ellipsis(g, s, w) { if (g.measureText(s).width <= w) return s; while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; }

  hit(e) {
    const r = this.c.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < this.RULER + this.SONG + this.GAP / 2) return { kind: 'seek', x, y };
    const i = Math.floor((y - this.RULER - this.SONG - this.GAP) / (this.ROW + this.GAP));
    const rows = this.rows();
    if (i < 0 || i >= rows.length) return { kind: 'none', x, y };
    const v = rows[i].v;
    if (x < this.LW) {
      if (this.o.multi && x < 34) return { kind: 'eye', v, x, y };
      return { kind: 'label', v, x, y };
    }
    const sh = effShift(v);
    const [a, b] = inOut(v);
    const xi = this.x(a - sh), xo = this.x(b - sh);
    if (Math.abs(x - xi) < 7) return { kind: 'in', v, x, y };
    if (Math.abs(x - xo) < 7) return { kind: 'out', v, x, y };
    const xa = this.x((v.firstTs || 0) - sh), xb = this.x(v.duration - sh);
    if (x >= xa && x <= xb) return { kind: 'clip', v, x, y };
    return { kind: 'seek', x, y };
  }
  down(e) {
    const h = this.hit(e);
    this.c.setPointerCapture(e.pointerId);
    if (h.kind === 'eye') { this.o.onEye && this.o.onEye(h.v); return; }
    if (h.kind === 'label') { this.o.onSelect && this.o.onSelect(h.v); return; }
    if (h.kind === 'none') return;
    if (h.v) this.o.onSelect && this.o.onSelect(h.v, true);
    this.drag = { ...h, startX: h.x, shift0: h.v ? effShift(h.v) : 0, io0: h.v ? inOut(h.v) : null, moved: false };
    if (h.kind === 'seek') this.o.onSeek(this.t(h.x));
  }
  move(e) {
    const r = this.c.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (!this.drag) {
      const h = this.hit(e);
      this.c.style.cursor = h.kind === 'in' || h.kind === 'out' ? 'ew-resize' : h.kind === 'clip' ? 'grab' : h.kind === 'seek' ? 'text' : 'default';
      return;
    }
    const d = this.drag, dt = this.t(x) - this.t(d.startX);
    if (Math.abs(x - d.startX) > 2) d.moved = true;
    if (d.kind === 'seek') this.o.onSeek(this.t(x));
    else if (d.kind === 'clip' && d.moved) {
      let ns = d.shift0 - dt;
      const T = tpl(d.v);
      if (this.o.snap && !e.altKey && T && T.markAbs != null && d.v.markV != null) {
        const target = d.v.markV - T.markAbs;
        if (Math.abs(this.x(d.v.markV - ns) - this.x(T.markAbs)) < 8) ns = target;
      }
      this.o.onShift(d.v, ns, false);
    } else if (d.kind === 'in' || d.kind === 'out') {
      const sh = effShift(d.v);
      const vt = clamp(this.t(x) + sh, d.v.firstTs || 0, d.v.duration);
      const [a, b] = inOut(d.v);
      if (d.kind === 'in') this.o.onInOut(d.v, Math.min(vt, b - 0.2), b, false);
      else this.o.onInOut(d.v, a, Math.max(vt, a + 0.2), false);
    }
    this.draw();
  }
  up() {
    const d = this.drag; this.drag = null;
    if (!d) return;
    if (d.kind === 'clip') { if (d.moved) this.o.onShift(d.v, effShift(d.v), true); else this.o.onSeek(this.t(d.startX)); }
    if (d.kind === 'in' || d.kind === 'out') { const [a, b] = inOut(d.v); this.o.onInOut(d.v, a, b, true); }
  }
  wheel(e) {
    const zoom = !this.o.multi || e.ctrlKey || e.metaKey || e.altKey;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / this.c.clientWidth) * (this.t1 - this.t0);
      this.t0 += d; this.t1 += d; this.draw(); return;
    }
    if (!zoom) return;
    e.preventDefault();
    const r = this.c.getBoundingClientRect();
    const tm = this.t(e.clientX - r.left);
    const f = Math.exp(e.deltaY * 0.0015);
    const span = clamp((this.t1 - this.t0) * f, 0.3, 600);
    const k = (tm - this.t0) / (this.t1 - this.t0);
    this.t0 = tm - k * span; this.t1 = this.t0 + span;
    this.draw();
  }
  zoomTo(span) {
    const ph = this.o.playhead() ?? (this.t0 + this.t1) / 2;
    this.t0 = ph - span / 2; this.t1 = ph + span / 2; this.draw();
  }
}
