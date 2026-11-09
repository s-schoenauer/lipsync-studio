// Lipsync Studio Desktop – Start, Projektverwaltung, Import, Navigation, Tastatur
import { S, $, esc, toast, on, emit, changed, save, newProject, uid, activeTpl, status, counts, videoById, fmt } from './state.js';
import { hasFolderAccess, pickProjectFolder, reopen, recentProjects, kvGet, internalProject, listInternalProjects, filesFromDrop, filesFromDirectory, VIDEO_RE } from './store.js';
import { decodeSong, probeVideo, resumeAudio } from './media.js';
import { renderProject, stopProjectAudio } from './view-project.js';
import { renderEditor, editorKey, leaveEditor, runAudioSync, refreshEditorList } from './view-editor.js';
import { renderRaster, rasterKey, leaveRaster } from './view-raster.js';
import { renderTracks, tracksKey, leaveTracks } from './view-tracks.js';
import { renderExport, queueExport, exportRunning } from './view-export.js';

const VIEWS = {
  projekt: { render: renderProject, leave: stopProjectAudio },
  editor: { render: renderEditor, key: editorKey, leave: leaveEditor },
  raster: { render: renderRaster, key: rasterKey, leave: leaveRaster },
  spuren: { render: renderTracks, key: tracksKey, leave: leaveTracks },
  export: { render: renderExport },
};

// ---------------------------------------------------------------- Start
async function boot() {
  $('start').hidden = false;
  if (!hasFolderAccess) {
    $('btn-open-folder').hidden = true;
    $('btn-intern').hidden = false;
    $('start-note').innerHTML = 'Dein Browser kann keine Ordner auf dem Rechner öffnen. Projekte werden deshalb im Browser gespeichert – Exporte lädst du einzeln herunter. <b>Empfehlung: Chrome oder Edge.</b>';
    const names = await listInternalProjects();
    showRecent(names.map((n) => ({ label: n, open: () => openStore(internalProject(n)) })));
  } else {
    const rec = await recentProjects();
    showRecent(rec.map((h) => ({ label: h.name, open: () => openStore(reopen(h)) })));
  }
  $('btn-open-folder').onclick = () => openStore(pickProjectFolder());
  $('btn-intern').onclick = () => { const n = prompt('Name des Projekts:', 'Mein Song'); if (n) openStore(internalProject(n.trim())); };
}
function showRecent(list) {
  $('recent-wrap').hidden = !list.length;
  $('recent').innerHTML = '';
  for (const it of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = it.label; b.onclick = it.open;
    li.append(b); $('recent').append(li);
  }
}

async function openStore(storePromise) {
  try {
    const store = await storePromise;
    S.store = store;
    let p = await store.loadProject();
    if (!p) { p = newProject(store.name); await store.saveProject(p); }
    S.project = p;
    S.files.clear(); S.song = null; S.selection.clear(); S.selId = null; S.exportQueue = [];
    $('start').hidden = true; $('app').hidden = false;
    $('project-label').textContent = `${p.name}`;
    toast('Projekt wird geladen …', 60000);
    // Song
    if (p.song) {
      try { const blob = await store.readFile(p.song.file); S.song = { blob, buffer: await decodeSong(blob) }; }
      catch (e) { toast('Song-Datei fehlt im Projektordner: ' + p.song.file, 6000); }
    }
    // Originale
    let missing = 0;
    for (const v of p.videos) {
      try { S.files.set(v.id, await store.readFile(v.file)); } catch { missing++; }
    }
    toast(missing ? `${missing} Originale fehlen im Ordner „Originale“` : 'Projekt geladen', missing ? 6000 : 1500);
    go(p.song ? (p.videos.length ? 'editor' : 'projekt') : 'projekt');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Projekt konnte nicht geöffnet werden: ' + e.message, 5000);
  }
}

// ---------------------------------------------------------------- Song
$('file-song').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  await resumeAudio();
  toast('Song wird kopiert und analysiert …', 60000);
  try {
    const buffer = await decodeSong(f);
    const name = await S.store.freeName('Song', f.name);
    await S.store.writeFile(`Song/${name}`, f);
    const p = S.project;
    p.song = { file: `Song/${name}`, name: f.name.replace(/\.[^.]+$/, ''), duration: buffer.duration };
    S.song = { blob: await S.store.readFile(`Song/${name}`), buffer };
    if (!p.templates.length) {
      const d = buffer.duration, s = Math.min(d * 0.25, Math.max(0, d - 20));
      const t = { id: uid('tpl'), name: 'Hook', selStart: s, selEnd: Math.min(d, s + 20), markAbs: null };
      p.templates.push(t); p.activeTemplateId = t.id;
    } else for (const t of p.templates) { t.selEnd = Math.min(t.selEnd, buffer.duration); t.selStart = Math.min(t.selStart, t.selEnd - 1); }
    changed('song'); rerender();
    toast('Song geladen – jetzt Ausschnitt wählen und Song-Marker setzen', 3500);
  } catch (err) { toast('Song konnte nicht gelesen werden: ' + err.message, 5000); }
};

// ---------------------------------------------------------------- Import
let importing = Promise.resolve();
export function importFiles(files) {
  const vids = [...files].filter((f) => VIDEO_RE.test(f.name) || f.type.startsWith('video/'));
  if (!vids.length) { toast('Keine Videodateien gefunden'); return; }
  importing = importing.then(() => doImport(vids));
  return importing;
}
async function doImport(files) {
  const p = S.project;
  const T = activeTpl();
  const added = [];
  let i = 0;
  for (const f of files) {
    i++;
    toast(`Importiere ${i} von ${files.length}: ${f.name}`, 60000);
    try {
      const info = await probeVideo(f);
      const name = await S.store.freeName('Originale', f.name);
      await S.store.writeFile(`Originale/${name}`, f);
      const stored = await S.store.readFile(`Originale/${name}`);
      const v = {
        id: uid('vid'), file: `Originale/${name}`, name, sourceName: f.name, importedAt: Date.now(),
        size: f.size, ...info, templateId: T?.id || null,
        shift: null, syncMethod: null, markV: null, inV: null, outV: null, mirror: false, exports: [],
      };
      p.videos.push(v);
      S.files.set(v.id, stored);
      added.push(v);
      if (S.watch) S.watch.seen.add(f.name + '|' + f.size);
    } catch (e) {
      toast(`${f.name}: ${e.message}`, 4000);
    }
  }
  save(true);
  emit('change', 'videos');
  rerender();
  toast(`${added.length} Videos importiert – Originale liegen in „Originale“`, 3000);
  const withAudio = added.filter((v) => v.hasAudio);
  if (p.settings.autoAudio && S.song && withAudio.length) await runAudioSync(withAudio);
  if (S.view === 'editor') refreshEditorList();
}
$('file-videos').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importFiles(f); };
on('import-folder', async () => {
  try { const d = await window.showDirectoryPicker({ id: 'lipsync-import' }); importFiles(await filesFromDirectory(d)); }
  catch (e) { if (e.name !== 'AbortError') toast(e.message); }
});
// Ordner beobachten
on('toggle-watch', async () => {
  if (S.watch) { clearInterval(S.watch.timer); S.watch = null; toast('Beobachtung beendet'); rerender(); return; }
  try {
    const d = await window.showDirectoryPicker({ id: 'lipsync-watch' });
    const seen = new Set();
    for (const f of await filesFromDirectory(d)) seen.add(f.name + '|' + f.size);
    for (const v of S.project.videos) seen.add((v.sourceName || v.name) + '|' + v.size);
    S.watch = { dir: d, name: d.name, seen, timer: null };
    S.watch.timer = setInterval(async () => {
      try {
        const files = await filesFromDirectory(d);
        // nur Dateien, deren Größe stabil ist (fertig kopiert)
        const fresh = files.filter((f) => !seen.has(f.name + '|' + f.size) && Date.now() - f.lastModified > 3000);
        if (fresh.length) { fresh.forEach((f) => seen.add(f.name + '|' + f.size)); importFiles(fresh); }
      } catch {}
    }, 5000);
    toast(`Beobachte „${d.name}“ – neue Videos werden automatisch übernommen`, 3500);
    rerender();
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
});

// Drag & Drop ins ganze Fenster
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (!S.project || !e.dataTransfer.types.includes('Files')) return; dragDepth++; $('drop-overlay').hidden = false; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
window.addEventListener('dragover', (e) => { if (S.project) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!S.project) return;
  e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
  const files = await filesFromDrop(e.dataTransfer);
  const audio = files.find((f) => /\.(mp3|wav|m4a|aac|aif|aiff|flac)$/i.test(f.name));
  if (audio && !S.project.song) { const dt = new DataTransfer(); dt.items.add(audio); $('file-song').files = dt.files; $('file-song').dispatchEvent(new Event('change')); }
  importFiles(files.filter((f) => f !== audio));
});

// ---------------------------------------------------------------- Navigation
export function go(view) {
  if (VIEWS[S.view]?.leave) VIEWS[S.view].leave();
  S.view = view;
  for (const k of Object.keys(VIEWS)) $('view-' + k).hidden = k !== view;
  document.querySelectorAll('.tabs [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (!S.song && view !== 'projekt') { S.view = 'projekt'; $('view-' + view).hidden = true; $('view-projekt').hidden = false; document.querySelectorAll('.tabs [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === 'projekt')); toast('Erst einen Song laden'); }
  rerender();
}
function rerender() {
  if (!S.project) return;
  VIEWS[S.view].render($('view-' + S.view));
  statusbar();
}
document.querySelectorAll('.tabs [data-view]').forEach((b) => (b.onclick = () => go(b.dataset.view)));
on('go', go);
on('rerender', rerender);
on('change', () => statusbar());
on('saved', () => { const el = $('save-state'); if (el) el.textContent = 'Gespeichert ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); });
on('queue', () => statusbar());
$('btn-import-top').onclick = () => $('file-videos').click();
$('btn-export-top').onclick = () => {
  const n = queueExport(S.project.videos.filter((v) => status(v).key === 'sync'));
  if (n) toast(`${n} synchrone Videos in die Warteschlange gelegt`);
  go('export');
};
$('btn-project-menu').onclick = async () => {
  if (exportRunning()) { toast('Erst den Export abwarten'); return; }
  if (!confirm('Anderes Projekt öffnen?')) return;
  await save(true);
  for (const k of Object.keys(VIEWS)) VIEWS[k].leave && VIEWS[k].leave();
  if (S.watch) { clearInterval(S.watch.timer); S.watch = null; }
  $('app').hidden = true; S.project = null;
  boot();
};

function statusbar() {
  const sb = $('statusbar'); if (!sb || !S.project) return;
  const c = counts();
  const keys = {
    projekt: '<span><b>Ziehen</b> Ausschnitt</span><span><b>Mausrad</b> Marker-Zoom</span>',
    editor: '<span><b>Leertaste</b> Play</span><span><b>← →</b> Frame</span><span><b>Umschalt ← →</b> 1 s</span><span><b>I / O</b> Start / Ende</span><span><b>M</b> Marker</span><span><b>F</b> Frame-Streifen</span><span><b>, .</b> Versatz ±1 Frame</span><span><b>Tab</b> nächstes</span>',
    raster: '<span><b>Leertaste</b> alle abspielen</span><span><b>Pfeile</b> Kachel</span><span><b>M / I / O</b> in aktiver Kachel</span><span><b>, .</b> ±1 Frame</span><span><b>Enter</b> Editor</span>',
    spuren: '<span><b>Leertaste</b> Play</span><span><b>Strg+Mausrad</b> Zoom</span><span><b>Auge</b> Vorschau</span>',
    export: '<span>Originale bleiben unverändert in „Originale“</span>',
  }[S.view] || '';
  sb.innerHTML = `${keys}<span class="right">${c.alle} Videos · ${c.offen} offen · ${c.sync} synchron · ${c.done} exportiert</span><span id="save-state">${S.store.kind === 'folder' ? 'Projektordner „' + esc(S.store.name) + '“' : 'Im Browser gespeichert'}</span>`;
}

// ---------------------------------------------------------------- Tastatur
document.addEventListener('keydown', (e) => {
  if (!S.project || document.querySelector('.modal-back')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if ((tag === 'input' && !['checkbox', 'range', 'button'].includes(e.target.type)) || tag === 'select' || tag === 'textarea') return;
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(true); toast('Gespeichert'); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const h = VIEWS[S.view]?.key;
  if (h && h(e)) e.preventDefault();
});
window.addEventListener('beforeunload', (e) => { if (exportRunning()) { e.preventDefault(); e.returnValue = ''; } });

// Für Tests
window.__lsd = { S, importFiles, go, openStore, internalProject };
boot();
