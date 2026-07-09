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
  listWheels,
  deleteWheel,
  submitPending,
  resolvePending,
} from './api';
import type { WheelSummary } from './api';
import type { PendingEntry } from './types';
import { winFanfare, toggleMute, isMuted } from './audio';
import { burstConfetti } from './confetti';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const state: WheelData = { name: '', mode: 'text', texts: [], images: [], played: [] };
let winnerIdx = -1;
let dirty = false; // has unsaved changes
let savedToServer = false; // the current id exists on the server (Save pressed / loaded)
const isGuest = new URLSearchParams(location.search).get('guest') === '1';

/* ── Seed: generated locally on first content, persisted only on Save ── */

const SEED_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function genSeed(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += SEED_ALPHABET[Math.floor(Math.random() * SEED_ALPHABET.length)];
  return s;
}

let seedInFlight = false;
async function ensureSeed(): Promise<void> {
  if (state.id || seedInFlight || isGuest) return;
  seedInFlight = true;
  try {
    let id = '';
    for (let i = 0; i < 6; i++) {
      const cand = genSeed();
      const exists = await loadWheel(cand).catch(() => null); // read-only availability check
      if (!exists) {
        id = cand;
        break;
      }
    }
    if (state.id) return; // set while we were checking
    state.id = id || genSeed();
    savedToServer = false;
    showSeedPill(); // shows the code as "не збережено" until the Зберегти button
  } finally {
    seedInFlight = false;
  }
}

function showSeedPill(): void {
  if (!state.id) {
    savePill.classList.add('hidden');
    return;
  }
  const unsaved = !savedToServer || dirty; // has a code, but current state not on server
  savePill.querySelector('.save-pill-code')!.textContent = state.id;
  savePill.querySelector('.save-pill-hint')!.textContent = unsaved ? 'не збережено' : 'копіювати';
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

function forgetWheel(id: string): void {
  localStorage.setItem('ll-mine', JSON.stringify(myWheelIds().filter((x) => x !== id)));
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
  if (state.mode === 'text') {
    return state.texts.map((t, i) => ({ label: t, color: PALETTE[i % PALETTE.length] }));
  }
  return state.images.map((img, i) => ({
    label: img.label ?? '',
    imageUrl: img.url,
    color: PALETTE[i % PALETTE.length],
  }));
}

/** Full rebuild: wheel + thumbs + hints + played + autosave. */
function rebuild(): void {
  applyWheel();
  renderThumbs();
  renderPlayed();
  $('#btn-clear-images').classList.toggle('hidden', state.images.length === 0);
}

/** Wheel + hints only — used while typing a caption so thumb inputs keep focus. */
function applyWheel(): void {
  const sectors = currentSectors();
  wheel.setSectors(sectors);
  ($('#btn-spin') as HTMLButtonElement).disabled = sectors.length < 2;
  $('#text-hint').textContent = plural(state.texts.length, 'варіант', 'варіанти', 'варіантів');
  $('#btn-clear-text').classList.toggle('hidden', state.texts.length === 0);
  $('#image-hint').textContent = plural(
    state.images.length,
    'зображення',
    'зображення',
    'зображень'
  );
  saveDraft(); // local draft only — server save is manual (the Зберегти button)
  // As soon as there's content, a fresh wheel gets its own code (local until Save).
  if (!state.id && sectors.length >= 1) void ensureSeed();
  else if (state.id) showSeedPill(); // reflect unsaved edits in the pill
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const w =
    m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

/* ── Mode tabs ── */

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode as WheelData['mode'];
    if (mode === state.mode) return;
    state.mode = mode;
    dirty = true;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#pane-text').classList.toggle('hidden', mode !== 'text');
    $('#pane-image').classList.toggle('hidden', mode !== 'image');
    rebuild();
  });
});

/* ── Text mode ── */

const textInput = $('#text-input') as HTMLTextAreaElement;
let textDebounce = 0;
textInput.addEventListener('input', () => {
  clearTimeout(textDebounce);
  textDebounce = window.setTimeout(() => {
    state.texts = textInput.value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    dirty = true;
    applyWheel();
  }, 180);
});

/* ── Image mode ── */

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
  dirty = true;
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
      dirty = true;
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
      dirty = true;
      clearTimeout(capDebounce);
      capDebounce = window.setTimeout(applyWheel, 220); // keep input focus (no thumb re-render)
    });

    cell.append(del, cap);
    box.appendChild(cell);
  });
}

$('#btn-clear-images').addEventListener('click', () => {
  state.images = [];
  dirty = true;
  rebuild();
});

$('#btn-clear-text').addEventListener('click', () => {
  state.texts = [];
  textInput.value = '';
  dirty = true;
  rebuild();
});

$('#btn-add-text-sector').addEventListener('click', () => {
  state.images.push({}); // empty text sector; user types its caption
  dirty = true;
  rebuild();
  const inputs = document.querySelectorAll<HTMLInputElement>('.thumb-caption');
  inputs[inputs.length - 1]?.focus();
});

/* ── Played window ── */

/** The tab a played entry belongs to (falls back to image presence for old data). */
function playedMode(p: WheelData['played'][number]): 'image' | 'text' {
  return p.mode ?? (p.imageUrl ? 'image' : 'text');
}

/** Played entries for the CURRENT tab only — winners keep the tab they were played on. */
function playedForMode(): { p: WheelData['played'][number]; i: number }[] {
  return state.played.map((p, i) => ({ p, i })).filter((x) => playedMode(x.p) === state.mode);
}

function renderPlayed(): void {
  const items = playedForMode();
  $('#played-box').classList.toggle('hidden', items.length === 0);
  $('#played-count').textContent = `(${items.length})`;
  const list = $('#played-list');
  list.innerHTML = '';

  items.forEach(({ p, i }) => {
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
  if (playedMode(p) === 'image') {
    state.images.push(
      p.imageUrl
        ? { url: p.imageUrl, label: p.label || undefined }
        : { label: p.label || undefined }
    );
  } else {
    state.texts.push(p.label);
  }
}

function returnPlayed(i: number): void {
  const p = state.played[i];
  if (!p) return;
  state.played.splice(i, 1);
  restoreEntry(p);
  if (state.mode === 'text') textInput.value = state.texts.join('\n');
  dirty = true;
  rebuild();
}

$('#btn-return-all').addEventListener('click', () => {
  // Return only the entries shown on the current tab.
  const returning = playedForMode().map((x) => x.p);
  state.played = state.played.filter((p) => !returning.includes(p));
  for (const p of returning) restoreEntry(p);
  if (state.mode === 'text') textInput.value = state.texts.join('\n');
  dirty = true;
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
  if (s) state.played.push({ label: s.label, imageUrl: s.imageUrl, mode: state.mode });
  if (state.mode === 'text') {
    state.texts.splice(winnerIdx, 1);
    textInput.value = state.texts.join('\n');
  } else {
    state.images.splice(winnerIdx, 1);
  }
  winnerIdx = -1;
  dirty = true;
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
  if (wheel.isSpinning || state.mode !== 'image') return;
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
    if (wheel.isSpinning || state.mode !== 'image') return;
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

/* ── Save (manual only — the Зберегти button; nothing hits the server until then) ── */

const savePill = $('#save-pill');
let saveTimer = 0;
let saving = false;

function scheduleSave(): void {
  if (wheel.count < 1 && state.played.length === 0) return; // nothing worth a code yet
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
  try {
    const { id, editToken } = await saveWheel(state, tokenFor(state.id));
    state.id = id;
    rememberToken(id, editToken); // this device now owns edit rights
    savedToServer = true;
    rememberWheel(id);
    if (!location.pathname.endsWith(`/w/${id}`)) history.replaceState(null, '', `/w/${id}`);
    dirty = false; // saved → no unsaved changes (also re-enables the guest poll)
    showSeedPill();
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
    toast('Спершу натисни «Зберегти»');
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

// Explicit Save — flush now, confirm, and its seed shows up in "Мої колеса".
$('#btn-save').addEventListener('click', async () => {
  if (wheel.count < 1) {
    toast('Колесо порожнє — додай варіанти');
    return;
  }
  clearTimeout(saveTimer);
  await doAutoSave();
  toast(state.id ? `Збережено ✓ (${state.id})` : 'Збережено ✓');
});

/* ── My wheels: pick a saved seed ── */

const myWheelsBox = $('#my-wheels');

$('#btn-my-wheels').addEventListener('click', async () => {
  if (!myWheelsBox.classList.contains('hidden')) {
    myWheelsBox.classList.add('hidden');
    return;
  }
  myWheelsBox.innerHTML = '<div class="mw-empty">Завантаження…</div>';
  myWheelsBox.classList.remove('hidden');
  const mine = new Set(myWheelIds());
  const wheels = (await listWheels().catch(() => [] as WheelSummary[]))
    .filter((w) => mine.has(w.id) && w.count > 0) // only my wheels, skip empty
    .sort((a, b) => myWheelIds().indexOf(a.id) - myWheelIds().indexOf(b.id));
  renderMyWheels(wheels);
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
      applyLoaded(data);
      history.replaceState(null, '', `/w/${data.id}`);
      myWheelsBox.classList.add('hidden');
      toast('Колесо відкрито');
    });

    const del = document.createElement('button');
    del.className = 'mw-del';
    del.textContent = '✕';
    del.title = 'Видалити';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteWheel(w.id, tokenFor(w.id));
      forgetWheel(w.id);
      const mine = new Set(myWheelIds());
      renderMyWheels(
        (await listWheels().catch(() => [])).filter((x) => mine.has(x.id) && x.count > 0)
      );
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

/* ── Open by code ── */

$('#btn-open').addEventListener('click', () => void openByCode());
($('#code-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void openByCode();
});

async function openByCode(): Promise<void> {
  const code = ($('#code-input') as HTMLInputElement).value.trim().toUpperCase();
  if (!code) return;
  const data = await loadWheel(code).catch(() => null);
  if (!data) {
    toast('⚠️ Колесо з таким кодом не знайдено');
    return;
  }
  applyLoaded(data);
  if (data.id) rememberWheel(data.id);
  history.replaceState(null, '', `/w/${data.id}`);
  toast('Колесо відкрито');
}

function applyLoaded(data: WheelData, fromServer = true): void {
  state.id = data.id;
  state.name = data.name ?? '';
  state.mode = data.mode === 'image' ? 'image' : 'text';
  state.texts = Array.isArray(data.texts) ? data.texts.filter((t) => typeof t === 'string') : [];
  state.images = Array.isArray(data.images)
    ? data.images.filter((i) => i && (typeof i.url === 'string' || typeof i.label === 'string'))
    : [];
  state.played = Array.isArray(data.played)
    ? data.played.filter((p) => p && typeof p.label === 'string')
    : [];
  textInput.value = state.texts.join('\n');
  document
    .querySelectorAll<HTMLButtonElement>('.tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.mode === state.mode));
  $('#pane-text').classList.toggle('hidden', state.mode !== 'text');
  $('#pane-image').classList.toggle('hidden', state.mode !== 'image');
  savedToServer = fromServer && !!state.id;
  // Loaded a wheel we don't hold the edit token for → view only (can't break it).
  if (fromServer && !isGuest && state.id && !tokenFor(state.id)) enterReadOnly();
  showSeedPill();
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
  state.mode = 'text';
  textInput.value = '';
  document
    .querySelectorAll<HTMLButtonElement>('.tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.mode === 'text'));
  $('#pane-text').classList.toggle('hidden', false);
  $('#pane-image').classList.toggle('hidden', true);
  savedToServer = false;
  savePill.classList.add('hidden');
  localStorage.removeItem('ll-draft');
  history.replaceState(null, '', '/');
  dirty = false;
  rebuild(); // next content typed will mint a fresh seed via ensureSeed()
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

function enterGuestMode(): void {
  document.body.classList.add('guest');
  const addBtn = $('#btn-guest-add');
  const already = state.id ? localStorage.getItem(`ll-guest-${state.id}`) === '1' : false;
  addBtn.classList.toggle('hidden', already);

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
    localStorage.setItem(`ll-guest-${state.id}`, '1');
    closeModal();
    addBtn.classList.add('hidden');
    toast('Дякуємо! Твій варіант надіслано ведучому 🎉');
  };
  $('#btn-guest-submit').addEventListener('click', () => void submit());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
  });
}

/* ── Host moderation: guest submissions arrive as a popup to approve/reject ── */

function startGuestPoll(): void {
  if (isGuest) return; // guests don't moderate
  setInterval(() => {
    if (readOnly || !state.id || !savedToServer || saving || wheel.isSpinning) return;
    if (!$('#mod-modal').classList.contains('hidden')) return; // a decision is already open
    if (!$('#winner-modal').classList.contains('hidden')) return;
    void loadWheel(state.id).then((data) => {
      const pending = data?.pending ?? [];
      if (pending.length) showModeration(pending[0]);
    });
  }, 4000);
}

function showModeration(item: PendingEntry): void {
  if (!item) return;
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
      // Append to the host's local wheel (persisted when the host next saves).
      if (item.imageUrl) {
        if (state.mode !== 'image') switchMode('image');
        state.images.push({ url: item.imageUrl, label: item.label || undefined });
      } else if (state.mode === 'image') {
        state.images.push({ label: item.label });
      } else {
        state.texts.push(item.label!);
        textInput.value = state.texts.join('\n');
      }
      dirty = true;
      rebuild();
    }
    if (state.id) await resolvePending(state.id, item.pid, tokenFor(state.id));
    $('#mod-modal').classList.add('hidden');
  };
  $('#btn-mod-approve').onclick = () => void finish(true);
  $('#btn-mod-reject').onclick = () => void finish(false);
}

function switchMode(mode: WheelData['mode']): void {
  state.mode = mode;
  document
    .querySelectorAll<HTMLButtonElement>('.tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('#pane-text').classList.toggle('hidden', mode !== 'text');
  $('#pane-image').classList.toggle('hidden', mode !== 'image');
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

async function boot(): Promise<void> {
  const m = location.pathname.match(/^\/w\/([A-Za-z0-9]{4,16})$/);
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
            showSeedPill();
          })
          .catch(() => {});
      }
    }
  }
  rebuild();
  void document.fonts.ready.then(() => applyWheel());

  if (isGuest) enterGuestMode();
  startGuestPoll();
}

void boot();
