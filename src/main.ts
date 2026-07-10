import '@fontsource/forum';
import '@fontsource/alegreya-sans/400.css';
import '@fontsource/alegreya-sans/700.css';
import './style.css';

import type { Sector, WheelData } from './types';
import { Wheel, PALETTE } from './wheel';
import {
  saveWheel,
  loadWheel,
  uploadImage,
  deleteWheel,
  submitPending,
  resolvePending,
} from './api';
import type { WheelSummary } from './api';
import type { PendingEntry } from './types';
import { winFanfare, toggleMute, isMuted } from './audio';
import { burstConfetti } from './confetti';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

// One unified list of sectors lives in `images`: an entry with a url is a photo,
// an entry with only a label is a text sector. `texts`/`mode` stay in the type for
// storage compat but are always empty/'image' now (legacy texts migrate on load).
const state: WheelData = { name: '', mode: 'image', texts: [], images: [], played: [] };
let winnerIdx = -1;
let dirty = false; // has unsaved changes
let savedToServer = false; // the current id exists on the server (Save pressed / loaded)
const isGuest = new URLSearchParams(location.search).get('guest') === '1';

/* ── Save state: there are no short codes. A wheel exists on the server only after
   Зберегти, and you keep it by its link (the pill copies it). The server mints a
   long, unguessable id on first save — nothing is typed or remembered by hand. ── */

function refreshSavePill(): void {
  const hasContent = state.images.length > 0;
  if (!state.id && !hasContent) {
    savePill.classList.add('hidden');
    return;
  }
  const unsaved = !savedToServer || dirty;
  savePill.querySelector('.save-pill-hint')!.textContent = unsaved
    ? 'не збережено'
    : '🔗 копіювати посилання';
  savePill.dataset.state = unsaved ? 'pending' : 'saved';
  savePill.classList.remove('hidden');
}

/* ── My wheels are tracked per-device (localStorage), not a global pool ── */

function myWheelIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem('ll-mine') || '[]') as string[];
  } catch {
    return [];
  }
}

function rememberWheel(id: string): void {
  const ids = [id, ...myWheelIds().filter((x) => x !== id)].slice(0, 60);
  localStorage.setItem('ll-mine', JSON.stringify(ids));
}

/* ── Snapshots: "Зберегти" saves a FROZEN copy here. Running/editing the live
   wheel afterwards never touches these — they're the entries shown in "Мої
   прокрути". Separate from the live/working record so sync keeps working. ── */

function snapshotIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem('ll-snapshots') || '[]') as string[];
  } catch {
    return [];
  }
}

function rememberSnapshot(id: string): void {
  localStorage.setItem(
    'll-snapshots',
    JSON.stringify([id, ...snapshotIds().filter((x) => x !== id)].slice(0, 60))
  );
}

function forgetSnapshot(id: string): void {
  localStorage.setItem('ll-snapshots', JSON.stringify(snapshotIds().filter((x) => x !== id)));
}

/* ── Edit tokens: the secret capability to modify a wheel (owner-only) ── */

function tokenFor(id?: string): string | undefined {
  return id ? localStorage.getItem(`ll-token-${id}`) || undefined : undefined;
}

function rememberToken(id: string, token: string): void {
  if (token) localStorage.setItem(`ll-token-${id}`, token);
}

let readOnly = false; // opened a wheel we don't own — view only, can't break it

const wheel = new Wheel($('#wheel') as unknown as HTMLCanvasElement);

/* ── Sectors from state ── */

function currentSectors(): Sector[] {
  return state.images.map((img, i) => ({
    label: img.label ?? '',
    imageUrl: img.url,
    color: PALETTE[i % PALETTE.length],
  }));
}

/** Full rebuild: wheel + entry list + hints + played. */
function rebuild(): void {
  applyWheel();
  renderThumbs();
  renderPlayed();
  $('#btn-clear-all').classList.toggle('hidden', state.images.length === 0);
}

/** Wheel + hints only — used while typing a caption so entry inputs keep focus. */
function applyWheel(): void {
  const sectors = currentSectors();
  wheel.setSectors(sectors);
  ($('#btn-spin') as HTMLButtonElement).disabled = sectors.length < 2;
  $('#entry-hint').textContent = plural(state.images.length, 'варіант', 'варіанти', 'варіантів');
  saveDraft(); // local draft (offline resilience); the server copy is kept via autosave
  refreshSavePill();
}

/* ── Autosave + cross-device sync ──
   Every user change marks the state dirty and schedules a save; the poll on the
   other device pulls it via the wheel's server `rev`. `dirty` also blocks the
   poll from overwriting local edits mid-change. ── */
let lastRev = 0; // highest server revision this device has seen/written
function markDirty(): void {
  dirty = true;
  scheduleSave();
}

/* ── Wheel name: editable, defaults to "Колесо N" (per-device counter) ── */
const nameInput = $('#wheel-name') as HTMLInputElement;
function nextWheelName(): string {
  const n = Number(localStorage.getItem('ll-wheel-seq') || '0') + 1;
  localStorage.setItem('ll-wheel-seq', String(n));
  return `Колесо ${n}`;
}
function ensureName(): void {
  if (!state.name) state.name = nextWheelName();
  nameInput.value = state.name;
}
nameInput.addEventListener('input', () => {
  state.name = nameInput.value;
  markDirty();
});

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const w =
    m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

/* ── Add a text variant: type + Enter (one), or paste a multi-line list (many) ── */

const entryInput = $('#entry-input') as HTMLInputElement;

function addTextEntries(lines: string[]): void {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  if (!clean.length) return;
  for (const label of clean) state.images.push({ label });
  ensureName();
  markDirty();
  rebuild();
}

entryInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addTextEntries(entryInput.value.split('\n'));
  entryInput.value = '';
});
// Pasting a newline-separated list adds every line at once.
entryInput.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text') ?? '';
  if (!text.includes('\n')) return; // single value → let it land in the field, add on Enter
  e.preventDefault();
  addTextEntries(text.split('\n'));
  entryInput.value = '';
});

/* ── Add a photo variant ── */

const dropzone = $('#dropzone');
const fileInput = $('#file-input') as HTMLInputElement;

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) void addFiles(fileInput.files);
  fileInput.value = '';
});

async function addFiles(files: FileList): Promise<void> {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  toast(`Завантажую ${plural(list.length, 'зображення', 'зображення', 'зображень')}…`);
  const results = await Promise.allSettled(list.map((f) => uploadImage(f)));
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') state.images.push({ url: r.value });
    else failed++;
  }
  if (state.images.length) ensureName();
  markDirty();
  toast(failed ? `⚠️ ${failed} не завантажилось` : 'Готово!');
  rebuild();
}

function renderThumbs(): void {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.images.forEach((entry, i) => {
    const cell = document.createElement('div');
    cell.className = 'thumb';

    if (entry.url) {
      const pic = document.createElement('img');
      pic.src = entry.url;
      pic.alt = entry.label ?? '';
      cell.appendChild(pic);
    } else {
      // Text-only sector living inside the image wheel — preview its sector color.
      cell.classList.add('text-thumb');
      cell.style.background = PALETTE[i % PALETTE.length];
    }

    const del = document.createElement('button');
    del.className = 'thumb-del';
    del.textContent = '✕';
    del.title = 'Прибрати';
    del.addEventListener('click', () => {
      state.images.splice(i, 1);
      markDirty();
      rebuild();
    });

    const cap = document.createElement('input');
    cap.className = 'thumb-caption';
    cap.value = entry.label ?? '';
    cap.placeholder = entry.url ? 'підпис…' : 'текст…';
    cap.maxLength = 40;
    let capDebounce = 0;
    cap.addEventListener('input', () => {
      state.images[i].label = cap.value.trim() || undefined;
      markDirty();
      clearTimeout(capDebounce);
      capDebounce = window.setTimeout(applyWheel, 220); // keep input focus (no thumb re-render)
    });

    cell.append(del, cap);
    box.appendChild(cell);
  });
}

// Two-step confirm — clearing wipes the live wheel, so require a second click.
const clearBtn = $('#btn-clear-all') as HTMLButtonElement;
let clearArmed = 0;
function disarmClear(): void {
  clearArmed = 0;
  clearBtn.textContent = 'Очистити все';
  clearBtn.classList.remove('danger');
}
clearBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = window.setTimeout(disarmClear, 3000);
    clearBtn.textContent = 'Точно? Очистити';
    clearBtn.classList.add('danger');
    return;
  }
  clearTimeout(clearArmed);
  disarmClear();
  state.images = [];
  markDirty();
  rebuild();
});

/* ── Played window — winners pulled off the wheel (kept, returnable) ── */

function renderPlayed(): void {
  $('#played-box').classList.toggle('hidden', state.played.length === 0);
  $('#played-count').textContent = `(${state.played.length})`;
  const list = $('#played-list');
  list.innerHTML = '';

  state.played.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'played-item';
    if (p.imageUrl) {
      const img = document.createElement('img');
      img.src = p.imageUrl;
      img.alt = p.label;
      row.appendChild(img);
    }
    const label = document.createElement('span');
    label.className = 'played-label';
    label.textContent = p.label || '—';
    row.appendChild(label);

    const back = document.createElement('button');
    back.className = 'btn ghost small';
    back.textContent = '↩';
    back.title = 'Повернути на колесо';
    back.addEventListener('click', () => returnPlayed(i));
    row.appendChild(back);

    list.appendChild(row);
  });
}

function restoreEntry(p: WheelData['played'][number]): void {
  state.images.push(
    p.imageUrl ? { url: p.imageUrl, label: p.label || undefined } : { label: p.label || undefined }
  );
}

function returnPlayed(i: number): void {
  const p = state.played[i];
  if (!p) return;
  state.played.splice(i, 1);
  restoreEntry(p);
  markDirty();
  rebuild();
}

$('#btn-return-all').addEventListener('click', () => {
  const returning = state.played;
  state.played = [];
  for (const p of returning) restoreEntry(p);
  markDirty();
  rebuild();
});

/* ── Spin ── */

async function doSpin(): Promise<void> {
  if (wheel.isSpinning || wheel.count < 2) return;
  hidePreview();
  ($('#btn-spin') as HTMLButtonElement).disabled = true;
  const idx = await wheel.spin();
  ($('#btn-spin') as HTMLButtonElement).disabled = wheel.count < 2;
  if (idx >= 0) showWinner(idx);
}

$('#btn-spin').addEventListener('click', () => void doSpin());
$('#wheel').addEventListener('click', () => void doSpin());
document.addEventListener('keydown', (e) => {
  if (
    e.code === 'Space' &&
    !(e.target instanceof HTMLTextAreaElement) &&
    !(e.target instanceof HTMLInputElement)
  ) {
    e.preventDefault();
    void doSpin();
  }
});

/* ── Winner ── */

function showWinner(idx: number): void {
  const sectors = currentSectors();
  const s = sectors[idx];
  if (!s) return;
  winnerIdx = idx;
  const box = $('#winner-content');
  box.innerHTML = '';
  if (s.imageUrl) {
    const img = document.createElement('img');
    img.src = s.imageUrl;
    img.alt = s.label;
    box.appendChild(img);
  }
  if (s.label || !s.imageUrl) {
    const div = document.createElement('div');
    div.className = 'winner-text';
    div.textContent = s.label || '🎉';
    box.appendChild(div);
  }
  $('#winner-modal').classList.remove('hidden');
  // Fanfare + confetti fire after the gavel's final slam (≈0.3s) lands.
  setTimeout(() => {
    winFanfare();
    burstConfetti();
  }, 120);
}

function closeWinner(): void {
  $('#winner-modal').classList.add('hidden');
}

$('#btn-close-winner').addEventListener('click', closeWinner);
document.querySelector('.modal-backdrop')!.addEventListener('click', closeWinner);
$('#btn-remove-winner').addEventListener('click', () => {
  if (winnerIdx < 0) return;
  const s = currentSectors()[winnerIdx];
  // Move to the played window — kept, not deleted.
  if (s) state.played.push({ label: s.label, imageUrl: s.imageUrl, mode: 'image' });
  state.images.splice(winnerIdx, 1);
  winnerIdx = -1;
  markDirty();
  closeWinner();
  rebuild();
});

/* ── Hover / tap preview ── */

const preview = $('#preview');
const previewImg = $('#preview-img') as HTMLImageElement;
let previewIdx = -1;

function showPreviewAt(idx: number, x: number, y: number): void {
  const s = currentSectors()[idx];
  if (!s?.imageUrl) {
    hidePreview();
    return;
  }
  if (idx !== previewIdx) {
    previewIdx = idx;
    previewImg.src = s.imageUrl;
    $('#preview-label').textContent = s.label;
    preview.classList.remove('hidden');
  }
  const pw = preview.offsetWidth;
  const ph = preview.offsetHeight;
  const px = Math.min(Math.max(12, x + 24), innerWidth - pw - 12);
  const py = Math.min(Math.max(12, y - ph / 2), innerHeight - ph - 12);
  preview.style.left = `${px}px`;
  preview.style.top = `${py}px`;
}

function hidePreview(): void {
  previewIdx = -1;
  preview.classList.add('hidden');
}

const wheelCanvas = $('#wheel');
wheelCanvas.addEventListener('mousemove', (e) => {
  if (wheel.isSpinning) return;
  const idx = wheel.hitTest(e.clientX, e.clientY);
  if (idx === null) hidePreview();
  else showPreviewAt(idx, e.clientX, e.clientY);
});
wheelCanvas.addEventListener('mouseleave', hidePreview);

// Tablet: long-press a sector to preview (tap = spin).
let pressTimer = 0;
wheelCanvas.addEventListener(
  'touchstart',
  (e) => {
    if (wheel.isSpinning) return;
    const t = e.touches[0];
    const idx = wheel.hitTest(t.clientX, t.clientY);
    if (idx === null) return;
    pressTimer = window.setTimeout(() => showPreviewAt(idx, t.clientX, t.clientY), 350);
  },
  { passive: true }
);
wheelCanvas.addEventListener('touchend', () => {
  clearTimeout(pressTimer);
  setTimeout(hidePreview, 1400);
});

/* ── Autosave: changes flush to the server ~1s after they stop; nothing is typed
   or pressed by hand. The other device pulls them via the poll. ── */

const savePill = $('#save-pill');
let saveTimer = 0;
let saving = false;

function scheduleSave(): void {
  if (readOnly) return; // can't save a wheel we don't own
  if (wheel.count < 1 && state.played.length === 0) return; // nothing worth saving yet
  clearTimeout(saveTimer);
  setSaveState('pending');
  saveTimer = window.setTimeout(doAutoSave, 900);
}

async function doAutoSave(): Promise<void> {
  if (saving) {
    scheduleSave();
    return;
  }
  saving = true;
  setSaveState('saving');
  const wasNew = !state.id; // a brand-new wheel is about to get its first id
  try {
    const { id, editToken, rev } = await saveWheel(state, tokenFor(state.id));
    state.id = id;
    lastRev = rev; // our own write — don't let the poll pull it back
    rememberToken(id, editToken); // this device now owns edit rights
    savedToServer = true;
    rememberWheel(id);
    if (!location.pathname.endsWith(`/w/${id}`)) history.replaceState(null, '', `/w/${id}`);
    dirty = false; // saved → no unsaved changes (also re-enables the poll pull)
    refreshSavePill();
    // Item: a freshly-created wheel should show up in an open "Мої прокрути" list
    // without needing to collapse/expand it.
    if (wasNew && !myWheelsBox.classList.contains('hidden')) {
      renderMyWheels(await loadMyWheels());
    }
  } catch (e) {
    setSaveState('error');
    if (e instanceof Error && e.message === 'forbidden') {
      toast('⛔ Немає прав на редагування цього колеса');
    }
  } finally {
    saving = false;
  }
}

function setSaveState(s: 'pending' | 'saving' | 'saved' | 'error'): void {
  savePill.dataset.state = s;
}

savePill.addEventListener('click', () => {
  if (!state.id) return;
  if (!savedToServer) {
    toast('Зачекай — колесо ще зберігається');
    return;
  }
  // The owner's link carries the secret edit token (open it on any of your devices).
  const tok = tokenFor(state.id);
  const link = tok
    ? `${location.origin}/w/${state.id}#e=${tok}`
    : `${location.origin}/w/${state.id}`;
  void navigator.clipboard
    .writeText(link)
    .then(() => toast('Посилання для редагування скопійовано (не показуй глядачам)'));
});

// Зберегти = save a FROZEN snapshot into "Мої прокрути". It's a separate record,
// so spinning/editing/clearing the live wheel afterwards never changes or removes
// it. (The live wheel keeps autosaving on its own id for cross-device sync.)
$('#btn-save').addEventListener('click', async () => {
  if (readOnly) return;
  if (state.images.length < 1) {
    toast('Колесо порожнє — додай варіанти');
    return;
  }
  const btn = $('#btn-save') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const snapshot: WheelData = { ...state, id: undefined }; // no id → server mints a fresh one
    const { id, editToken } = await saveWheel(snapshot, undefined);
    rememberToken(id, editToken);
    rememberSnapshot(id);
    if (!myWheelsBox.classList.contains('hidden')) renderMyWheels(await loadMyWheels());
    toast('Знімок збережено ✓');
  } catch {
    toast('⚠️ Не вдалося зберегти');
  } finally {
    btn.disabled = false;
  }
});

/* ── My wheels: the frozen snapshots saved via Зберегти ── */

const myWheelsBox = $('#my-wheels');

// Load summaries for this device's saved snapshots (tracked in localStorage).
// There is intentionally no server-side "list all wheels" endpoint — codes are
// secrets, so the server must not hand out everyone's.
async function loadMyWheels(): Promise<WheelSummary[]> {
  const ids = snapshotIds();
  const loaded = await Promise.all(
    ids.map(async (id) => {
      const d = await loadWheel(id).catch(() => null);
      if (!d) {
        forgetSnapshot(id); // gone from the server → drop it from the list
        return null;
      }
      const count = d.images?.length || 0;
      if (count < 1) return null; // skip empty
      const label = d.name || d.images?.[0]?.label || `${count} варіантів`;
      return { id, label, mode: 'image', count } as WheelSummary;
    })
  );
  return loaded.filter((w): w is WheelSummary => w !== null);
}

$('#btn-my-wheels').addEventListener('click', async () => {
  if (!myWheelsBox.classList.contains('hidden')) {
    myWheelsBox.classList.add('hidden');
    return;
  }
  myWheelsBox.innerHTML = '<div class="mw-empty">Завантаження…</div>';
  myWheelsBox.classList.remove('hidden');
  renderMyWheels(await loadMyWheels());
});

function renderMyWheels(wheels: WheelSummary[]): void {
  myWheelsBox.innerHTML = '';
  if (!wheels.length) {
    myWheelsBox.innerHTML = '<div class="mw-empty">Поки що немає збережених прокрутів</div>';
    return;
  }
  for (const w of wheels) {
    const row = document.createElement('div');
    row.className = 'mw-item';
    if (w.id === state.id) row.classList.add('current');

    const main = document.createElement('button');
    main.className = 'mw-open';
    main.innerHTML =
      `<span class="mw-label">${escapeHtml(w.label)}</span>` +
      `<span class="mw-meta">${w.mode === 'image' ? '🖼' : '📝'} ${w.count} · ${w.id}</span>`;
    main.addEventListener('click', async () => {
      const data = await loadWheel(w.id).catch(() => null);
      if (!data) {
        toast('⚠️ Не вдалося відкрити');
        return;
      }
      // Load the snapshot's CONTENT into the CURRENT live wheel, keeping its id +
      // link so a paired tablet stays paired. We only READ the snapshot, so it stays
      // frozen; autosave writes the restored content to the live record and syncs.
      const liveId = state.id;
      applyLoaded(data, false);
      state.id = liveId; // NOT the snapshot's id — never write back to the frozen copy
      savedToServer = !!liveId;
      markDirty(); // autosave the live wheel (mints a new id + link only if none yet)
      myWheelsBox.classList.add('hidden');
      toast('Знімок завантажено');
    });

    const del = document.createElement('button');
    del.className = 'mw-del';
    del.textContent = '✕';
    del.title = 'Видалити';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteWheel(w.id, tokenFor(w.id));
      forgetSnapshot(w.id);
      renderMyWheels(await loadMyWheels());
    });

    row.append(main, del);
    myWheelsBox.appendChild(row);
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
  );
}

function applyLoaded(data: WheelData, fromServer = true): void {
  state.id = data.id;
  state.name = data.name ?? '';
  nameInput.value = state.name;
  if (typeof data.rev === 'number') lastRev = data.rev;
  state.mode = 'image'; // unified list; the field is kept only for storage compat
  state.texts = [];
  const images = Array.isArray(data.images)
    ? data.images.filter((i) => i && (typeof i.url === 'string' || typeof i.label === 'string'))
    : [];
  // Migrate legacy text-mode wheels: their sectors live in texts[] → fold them in.
  const legacyTexts = Array.isArray(data.texts)
    ? data.texts.filter((t) => typeof t === 'string' && t.trim()).map((t) => ({ label: t }))
    : [];
  state.images = [...images, ...legacyTexts];
  state.played = Array.isArray(data.played)
    ? data.played.filter((p) => p && typeof p.label === 'string')
    : [];
  savedToServer = fromServer && !!state.id;
  // A protected wheel we don't hold the token for → view only (can't break it).
  // Decided purely by token possession, NOT by the ?guest URL param (which the
  // visitor controls) — so stripping/altering the param can't unlock editing.
  if (fromServer && state.id && data.protected && !tokenFor(state.id)) enterReadOnly();
  refreshSavePill();
  dirty = false;
  rebuild();
}

function enterReadOnly(): void {
  readOnly = true;
  document.body.classList.add('readonly');
}

/* ── Draft persistence (same device) ── */

function saveDraft(): void {
  localStorage.setItem('ll-draft', JSON.stringify(state));
}

function loadDraft(): WheelData | null {
  try {
    const raw = localStorage.getItem('ll-draft');
    return raw ? (JSON.parse(raw) as WheelData) : null;
  } catch {
    return null;
  }
}

/* ── Sound / panel toggles ── */

const soundBtn = $('#btn-sound');
soundBtn.textContent = isMuted() ? '🔇' : '🔊';
soundBtn.addEventListener('click', () => {
  soundBtn.textContent = toggleMute() ? '🔇' : '🔊';
});

$('#btn-panel-toggle').addEventListener('click', () => $('#panel').classList.toggle('open'));
document.addEventListener('click', (e) => {
  const panel = $('#panel');
  if (
    panel.classList.contains('open') &&
    !panel.contains(e.target as Node) &&
    !$('#btn-panel-toggle').contains(e.target as Node)
  ) {
    panel.classList.remove('open');
  }
});

/* ── New wheel ── */

$('#btn-new').addEventListener('click', () => {
  state.id = undefined;
  state.name = '';
  state.texts = [];
  state.images = [];
  state.played = [];
  state.mode = 'image';
  entryInput.value = '';
  lastRev = 0;
  readOnly = false;
  document.body.classList.remove('readonly');
  savedToServer = false;
  savePill.classList.add('hidden');
  localStorage.removeItem('ll-draft');
  history.replaceState(null, '', '/');
  dirty = false;
  ensureName(); // fresh "Колесо N"
  rebuild(); // stays local until the first content autosaves and mints the link
  toast('Нове колесо');
});

/* ── Guest link (for streamers to share) ── */

$('#btn-guest-link').addEventListener('click', async () => {
  if (!state.id || !savedToServer || dirty) {
    toast('Спершу збережи колесо (Зберегти)');
    return;
  }
  const link = `${location.origin}/w/${state.id}?guest=1`;
  await navigator.clipboard.writeText(link).catch(() => {});
  toast('Гостьове посилання скопійовано');
});

/* ── Guest mode: viewers add one variant, nothing else ── */

const GUEST_LIMIT = 3;

function enterGuestMode(): void {
  document.body.classList.add('guest');
  const addBtn = $('#btn-guest-add');
  const guestKey = state.id ? `ll-guest-${state.id}` : '';
  const guestCount = () => (guestKey ? Number(localStorage.getItem(guestKey) ?? '0') : 0);
  addBtn.classList.toggle('hidden', guestCount() >= GUEST_LIMIT);

  let pickedImageUrl = ''; // set once the guest's chosen image is uploaded
  const input = $('#guest-input') as HTMLInputElement;
  const fileInput = $('#guest-file') as HTMLInputElement;

  const openModal = () => {
    input.value = '';
    pickedImageUrl = '';
    $('#guest-preview').classList.add('hidden');
    $('#guest-msg').textContent = '';
    $('#guest-modal').classList.remove('hidden');
    input.focus();
  };
  const closeModal = () => $('#guest-modal').classList.add('hidden');

  addBtn.addEventListener('click', openModal);
  $('#btn-guest-cancel').addEventListener('click', closeModal);
  document.querySelector('#guest-modal .modal-backdrop')!.addEventListener('click', closeModal);

  $('#btn-guest-image').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    $('#guest-msg').textContent = 'Завантаження…';
    try {
      pickedImageUrl = await uploadImage(f);
      ($('#guest-preview-img') as HTMLImageElement).src = pickedImageUrl;
      $('#guest-preview').classList.remove('hidden');
      $('#guest-msg').textContent = '';
    } catch {
      $('#guest-msg').textContent = '⚠️ Не вдалося завантажити зображення';
    }
  });

  const submit = async () => {
    if (!state.id) return;
    const val = input.value.trim();
    if (!val && !pickedImageUrl) {
      $('#guest-msg').textContent = 'Напиши варіант або обери зображення';
      return;
    }
    const ok = await submitPending(state.id, {
      label: val || undefined,
      imageUrl: pickedImageUrl || undefined,
    });
    if (!ok) {
      $('#guest-msg').textContent = '⚠️ Не вдалося надіслати (можливо черга заповнена)';
      return;
    }
    const n = guestCount() + 1;
    localStorage.setItem(guestKey, String(n));
    closeModal();
    if (n >= GUEST_LIMIT) addBtn.classList.add('hidden');
    const left = GUEST_LIMIT - n;
    toast(
      left > 0
        ? `Дякуємо! Надіслано ведучому 🎉 (ще ${left})`
        : 'Дякуємо! Твій варіант надіслано ведучому 🎉'
    );
  };
  $('#btn-guest-submit').addEventListener('click', () => void submit());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
  });
}

/* ── Host moderation: guest submissions arrive as a popup to approve/reject ── */

function startOwnerPoll(): void {
  if (isGuest) return; // guests don't moderate or sync
  setInterval(() => {
    if (!state.id || !savedToServer) return;
    void loadWheel(state.id).then((data) => {
      if (!data) return;
      const winnerOpen = !$('#winner-modal').classList.contains('hidden');
      const modOpen = !$('#mod-modal').classList.contains('hidden');
      // 1. Pull a newer state made on the OTHER device — only while this device is
      //    idle. The moderation card is non-blocking, so it does NOT stop the pull
      //    (approval reads a captured item, not live state).
      if (
        typeof data.rev === 'number' &&
        data.rev > lastRev &&
        !dirty &&
        !saving &&
        !wheel.isSpinning &&
        !winnerOpen
      ) {
        const wasReadOnly = readOnly;
        applyLoaded(data); // sets lastRev, rebuilds the wheel + lists
        readOnly = wasReadOnly; // applyLoaded may re-enter read-only; keep our status
      }
      // 2. Show one moderation card at a time (don't stack over an open one).
      if (!readOnly && !modOpen && !winnerOpen && (data.pending?.length ?? 0)) {
        showModeration(data.pending![0], data.pending!.length);
      }
    });
  }, 2500);
}

function showModeration(item: PendingEntry, queueLen = 1): void {
  if (!item) return;
  const eyebrow = $('#mod-modal .modal-eyebrow');
  eyebrow.textContent =
    queueLen > 1 ? `Варіант від глядача · ще ${queueLen - 1} у черзі` : 'Варіант від глядача';
  const box = $('#mod-content');
  box.innerHTML = '';
  if (item.imageUrl) {
    const img = document.createElement('img');
    img.src = item.imageUrl;
    img.className = 'mod-image';
    box.appendChild(img);
  }
  if (item.label) {
    const div = document.createElement('div');
    div.className = 'mod-text';
    div.textContent = item.label;
    box.appendChild(div);
  }
  $('#mod-modal').classList.remove('hidden');

  const finish = async (approve: boolean) => {
    if (approve) {
      // Append to the host's unified list (photo if it has a url, else a text sector).
      state.images.push(
        item.imageUrl
          ? { url: item.imageUrl, label: item.label || undefined }
          : { label: item.label }
      );
      markDirty();
      rebuild();
    }
    if (state.id) await resolvePending(state.id, item.pid, tokenFor(state.id));
    $('#mod-modal').classList.add('hidden');
  };
  $('#btn-mod-approve').onclick = () => void finish(true);
  $('#btn-mod-reject').onclick = () => void finish(false);
}

/* ── Toast ── */

let toastTimer = 0;
function toast(msg: string): void {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ── Boot ── */

// The wheel labels are drawn to canvas in Alegreya Sans 700. Its Cyrillic subset
// loads lazily and canvas use doesn't trigger it, so a cold load can paint labels
// in a fallback (or as tofu). Force the subset in, then redraw once it's really ready.
async function ensureWheelFont(): Promise<void> {
  const spec = '700 20px "Alegreya Sans"';
  const sample = 'Приз Ы';
  try {
    await document.fonts.load(spec, sample);
  } catch {
    /* ignore — we still poll + redraw below */
  }
  for (let i = 0; i < 40; i++) {
    if (document.fonts.check(spec, sample)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  applyWheel();
}

// One-time: wheels saved before the snapshot model lived in `ll-mine` and no longer
// showed in "Мої прокрути". Fold them in once so they don't silently disappear.
function migrateOldWheelsToSnapshots(): void {
  if (localStorage.getItem('ll-snap-migrated')) return;
  const merged = [...snapshotIds(), ...myWheelIds().filter((id) => !snapshotIds().includes(id))];
  localStorage.setItem('ll-snapshots', JSON.stringify(merged.slice(0, 60)));
  localStorage.setItem('ll-snap-migrated', '1');
}

async function boot(): Promise<void> {
  migrateOldWheelsToSnapshots();
  const m = location.pathname.match(/^\/w\/([a-z0-9]{8,32})$/);
  if (m) {
    const code = m[1];
    // Owner's edit link carries the secret token in the URL fragment — capture it,
    // then scrub it from the address bar so it can't be shoulder-surfed on stream.
    const tok = new URLSearchParams(location.hash.slice(1)).get('e');
    if (tok) {
      rememberToken(code, tok);
      history.replaceState(null, '', `/w/${code}`);
    }
    const data = await loadWheel(code).catch(() => null);
    if (data) {
      applyLoaded(data);
      if (!isGuest && tokenFor(code)) rememberWheel(code); // only remember wheels we own
    } else {
      toast('⚠️ Колесо не знайдено');
      history.replaceState(null, '', '/');
    }
  } else if (!isGuest) {
    const draft = loadDraft();
    if (draft) {
      applyLoaded(draft, false); // draft is local; verify if its code is actually on the server
      if (state.id) {
        void loadWheel(state.id)
          .then((d) => {
            savedToServer = !!d;
            if (d && typeof d.rev === 'number') lastRev = d.rev;
            refreshSavePill();
          })
          .catch(() => {});
      }
    }
  }
  if (!isGuest && !readOnly) ensureName(); // every editable wheel gets a name (default "Колесо N")
  rebuild();
  void ensureWheelFont();

  if (isGuest) enterGuestMode();
  startOwnerPoll();
}

void boot();
