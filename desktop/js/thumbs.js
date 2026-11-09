// Kleine Vorschaubilder für Listen (im Speicher zwischengespeichert)
import { sinkFor } from './player.js';

const cache = new Map();
export function thumb(v) {
  if (!cache.has(v.id)) {
    cache.set(v.id, (async () => {
      try {
        const sink = await sinkFor(v, 72, 128);
        const t = Math.min(v.duration, (v.firstTs || 0) + Math.min(3, v.duration / 3));
        const wc = await sink.getCanvas(t);
        if (!wc) return null;
        const c = document.createElement('canvas'); c.width = 72; c.height = 128;
        c.getContext('2d').drawImage(wc.canvas, 0, 0);
        return c.toDataURL('image/jpeg', 0.7);
      } catch { return null; }
    })());
  }
  return cache.get(v.id);
}
export function forgetThumb(id) { cache.delete(id); }
// <img data-thumb="id"> füllen
export function fillThumbs(root, videos) {
  root.querySelectorAll('img[data-thumb]').forEach(async (img) => {
    const v = videos.find((x) => x.id === img.dataset.thumb);
    if (!v) return;
    const url = await thumb(v);
    if (url && img.isConnected) img.src = url;
  });
}
