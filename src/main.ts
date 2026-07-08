import '@fontsource/forum';
import '@fontsource/alegreya-sans/400.css';
import '@fontsource/alegreya-sans/700.css';
import './style.css';

import type { Sector, WheelData } from './types';
import { Wheel, PALETTE } from './wheel';
import { saveWheel, loadWheel, uploadImage } from './api';
import { winFanfare, toggleMute, isMuted } from './audio';
import { burstConfetti } from './confetti';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const state: WheelData = { name: '', mode: 'text', texts: [], images: [] };
let winnerIdx = -1;

const wheel = new Wheel($('#wheel') as unknown as HTMLCanvasElement);

/* ── Sectors from state ── */

function currentSectors(): Sector[] {
  if (state.mode === 'text') {
    return state.texts.map((t, i) => ({ label: t, color: PALETTE[i % PALETTE.length] }));
  }
  return state.images.map((img, i) => ({
    label: img.label ?? `Лот ${i + 1}`,
    imageUrl: img.url,
    color: PALETTE[i % PALETTE.length],
  }));
}

function rebuild(): void {
  const sectors = currentSectors();
  wheel.setSectors(sectors);
  ($('#btn-spin') as HTMLButtonElement).disabled = sectors.length < 2;
  $('#text-hint').textContent = plural(state.texts.length, 'варіант', 'варіанти', 'варіантів');
  $('#image-hint').textContent = plural(
    state.images.length,
    'зображення',
    'зображення',
    'зображень'
  );
  $('#btn-clear-images').classList.toggle('hidden', state.images.length === 0);
  renderThumbs();
  saveDraft();
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
    rebuild();
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
  toast(failed ? `⚠️ ${failed} не завантажилось` : 'Готово!');
  rebuild();
}

function renderThumbs(): void {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.images.forEach((img, i) => {
    const cell = document.createElement('div');
    cell.className = 'thumb';
    const pic = document.createElement('img');
    pic.src = img.url;
    pic.alt = img.label ?? '';
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Прибрати';
    del.addEventListener('click', () => {
      state.images.splice(i, 1);
      rebuild();
    });
    cell.append(pic, del);
    box.appendChild(cell);
  });
}

$('#btn-clear-images').addEventListener('click', () => {
  state.images = [];
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
  } else {
    const div = document.createElement('div');
    div.className = 'winner-text';
    div.textContent = s.label;
    box.appendChild(div);
  }
  $('#winner-modal').classList.remove('hidden');
  winFanfare();
  burstConfetti();
}

function closeWinner(): void {
  $('#winner-modal').classList.add('hidden');
}

$('#btn-close-winner').addEventListener('click', closeWinner);
document.querySelector('.modal-backdrop')!.addEventListener('click', closeWinner);
$('#btn-remove-winner').addEventListener('click', () => {
  if (winnerIdx < 0) return;
  if (state.mode === 'text') {
    state.texts.splice(winnerIdx, 1);
    textInput.value = state.texts.join('\n');
  } else {
    state.images.splice(winnerIdx, 1);
  }
  winnerIdx = -1;
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

/* ── Save / load / share ── */

const savePill = $('#save-pill');

async function doSave(): Promise<void> {
  if (wheel.count === 0) {
    toast('Колесо порожнє — додай варіанти');
    return;
  }
  const btn = $('#btn-save') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const id = await saveWheel(state);
    state.id = id;
    history.replaceState(null, '', `/w/${id}`);
    savePill.querySelector('.save-pill-code')!.textContent = id;
    savePill.classList.remove('hidden');
    toast('Збережено! Відкрий це посилання на планшеті');
    saveDraft();
  } catch {
    toast('⚠️ Не вдалося зберегти');
  } finally {
    btn.disabled = false;
  }
}

$('#btn-save').addEventListener('click', () => void doSave());

savePill.addEventListener('click', () => {
  void navigator.clipboard.writeText(location.href).then(() => toast('Посилання скопійовано'));
});

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
  history.replaceState(null, '', `/w/${data.id}`);
  toast('Колесо відкрито');
}

function applyLoaded(data: WheelData): void {
  state.id = data.id;
  state.name = data.name ?? '';
  state.mode = data.mode === 'image' ? 'image' : 'text';
  state.texts = Array.isArray(data.texts) ? data.texts.filter((t) => typeof t === 'string') : [];
  state.images = Array.isArray(data.images)
    ? data.images.filter((i) => i && typeof i.url === 'string')
    : [];
  textInput.value = state.texts.join('\n');
  document
    .querySelectorAll<HTMLButtonElement>('.tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.mode === state.mode));
  $('#pane-text').classList.toggle('hidden', state.mode !== 'text');
  $('#pane-image').classList.toggle('hidden', state.mode !== 'image');
  if (state.id) {
    savePill.querySelector('.save-pill-code')!.textContent = state.id;
    savePill.classList.remove('hidden');
  }
  rebuild();
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
    const data = await loadWheel(m[1]).catch(() => null);
    if (data) {
      applyLoaded(data);
    } else {
      toast('⚠️ Колесо не знайдено');
      history.replaceState(null, '', '/');
    }
  } else {
    const draft = loadDraft();
    if (draft) applyLoaded(draft);
  }
  rebuild();
  // Canvas text uses a webfont — rebake once fonts are actually ready (Cyrillic subset included).
  void document.fonts.ready.then(() => rebuild());
}

void boot();
