// Projektspeicher: ein Ordner auf dem Rechner (Chrome/Edge: File System Access API).
// Fallback (andere Browser): browser-interner Speicher (OPFS) mit derselben Struktur.
//
// Projektordner/
//   projekt.json      – alle Einstellungen, Marker, Versätze, Start/Ende
//   Song/             – Kopie des Songs
//   Originale/        – Kopien der Videos, werden nie verändert oder gelöscht
//   Exporte/          – fertige TikTok-Videos

const IDB = 'lipsync-desktop';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function kvGet(k) {
  const d = await idb();
  return new Promise((res) => {
    const q = d.transaction('kv').objectStore('kv').get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(undefined);
  });
}
export async function kvSet(k, v) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export const hasFolderAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export class ProjectStore {
  constructor(root, kind) { this.root = root; this.kind = kind; } // kind: 'folder' | 'intern'
  get name() { return this.root.name; }

  async dir(path, create = true) {
    let d = this.root;
    for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
    return d;
  }
  async fileHandle(path, create = false) {
    const parts = path.split('/');
    const name = parts.pop();
    const d = await this.dir(parts.join('/'), create);
    return d.getFileHandle(name, { create });
  }
  async readFile(path) { return (await this.fileHandle(path)).getFile(); }
  async exists(path) { try { await this.fileHandle(path); return true; } catch { return false; } }
  async writeFile(path, data) {
    const h = await this.fileHandle(path, true);
    const w = await h.createWritable();
    if (data instanceof Blob) await data.stream().pipeTo(w);
    else { await w.write(data); await w.close(); }
  }
  // Freien Dateinamen finden: name.mp4, name_2.mp4, …
  async freeName(dirPath, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const n = i === 1 ? name : `${base}_${i}${ext}`;
      if (!(await this.exists(`${dirPath}/${n}`))) return n;
    }
    return `${base}_${Date.now()}${ext}`;
  }
  async listFiles(dirPath) {
    const out = [];
    try {
      const d = await this.dir(dirPath, false);
      for await (const [n, h] of d.entries()) if (h.kind === 'file') out.push(n);
    } catch {}
    return out;
  }
  async loadProject() {
    try { return JSON.parse(await (await this.readFile('projekt.json')).text()); } catch { return null; }
  }
  async saveProject(p) {
    p.savedAt = Date.now();
    await this.writeFile('projekt.json', JSON.stringify(p, null, 2));
  }
}

async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission?.(opts)) === 'granted') return true;
  return (await handle.requestPermission?.(opts)) === 'granted';
}

// Projektordner wählen (neu oder bestehend)
export async function pickProjectFolder() {
  const root = await window.showDirectoryPicker({ id: 'lipsync-projekt', mode: 'readwrite', startIn: 'videos' });
  if (!(await ensurePermission(root))) throw new Error('Kein Schreibzugriff auf den Ordner');
  await kvSet('lastProject', root);
  await addRecent(root);
  return new ProjectStore(root, 'folder');
}

// Interner Browser-Speicher (Fallback)
export async function internalProject(name) {
  const opfs = await navigator.storage.getDirectory();
  const projects = await opfs.getDirectoryHandle('projekte', { create: true });
  const root = await projects.getDirectoryHandle(name, { create: true });
  try { await navigator.storage.persist?.(); } catch {}
  return new ProjectStore(root, 'intern');
}
export async function listInternalProjects() {
  try {
    const opfs = await navigator.storage.getDirectory();
    const projects = await opfs.getDirectoryHandle('projekte', { create: true });
    const out = [];
    for await (const [n, h] of projects.entries()) if (h.kind === 'directory') out.push(n);
    return out;
  } catch { return []; }
}

async function addRecent(handle) {
  const list = (await kvGet('recent')) || [];
  const next = [handle];
  for (const h of list) {
    try { if (!(await h.isSameEntry(handle))) next.push(h); } catch {}
  }
  await kvSet('recent', next.slice(0, 6));
}
export async function recentProjects() { return (await kvGet('recent')) || []; }

export async function reopen(handle) {
  if (!(await ensurePermission(handle))) throw new Error('Zugriff verweigert');
  await kvSet('lastProject', handle);
  await addRecent(handle);
  return new ProjectStore(handle, 'folder');
}

// Dateien aus Drag & Drop / Ordner-Auswahl einsammeln (rekursiv)
export const VIDEO_RE = /\.(mov|mp4|m4v|webm|mkv)$/i;
export async function filesFromDirectory(dirHandle, out = []) {
  for await (const [, h] of dirHandle.entries()) {
    if (h.kind === 'file' && VIDEO_RE.test(h.name)) out.push(await h.getFile());
    else if (h.kind === 'directory') await filesFromDirectory(h, out);
  }
  return out;
}
export async function filesFromDrop(dataTransfer) {
  // Alles synchron abholen – die Einträge sind nach dem ersten await ungültig
  const items = [...(dataTransfer.items || [])].filter((it) => it.kind === 'file');
  const entries = items.map((it) => ({
    handle: it.getAsFileSystemHandle ? it.getAsFileSystemHandle() : Promise.resolve(null),
    file: it.getAsFile(),
  }));
  const out = [];
  for (const e of entries) {
    const h = await e.handle.catch(() => null);
    if (h && h.kind === 'directory') await filesFromDirectory(h, out);
    else if (e.file) out.push(e.file);
  }
  return out;
}
