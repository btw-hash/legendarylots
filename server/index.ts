import express from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { customAlphabet } from 'nanoid';

const PORT = Number(process.env.PORT ?? 3940);
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const WHEELS = path.join(DATA, 'wheels');
const IMAGES = path.join(DATA, 'images');
for (const d of [WHEELS, IMAGES]) mkdirSync(d, { recursive: true });

// Unambiguous alphabet — codes get typed by hand on a tablet. 4 chars.
const genId = customAlphabet('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 4);
function newId(): string {
  let id = genId();
  for (let i = 0; i < 8 && existsSync(wheelPath(id)); i++) id = genId(); // avoid collision
  return id;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const app = express();
app.use(express.json({ limit: '2mb' }));

const idOk = (id: string) => /^[A-Z0-9]{4,16}$/i.test(id);
const wheelPath = (id: string) => path.join(WHEELS, `${id.toUpperCase()}.json`);

app.post('/api/wheels', async (req, res) => {
  const wheel = req.body;
  if (
    !wheel ||
    typeof wheel !== 'object' ||
    !Array.isArray(wheel.texts) ||
    !Array.isArray(wheel.images)
  ) {
    res.status(400).json({ error: 'bad wheel payload' });
    return;
  }
  // Honor a valid client-provided code (the wheel gets its seed the moment it has
  // content, client-side); only mint one when none was supplied.
  let id: string = typeof wheel.id === 'string' && idOk(wheel.id) ? wheel.id.toUpperCase() : '';
  if (!id) id = newId();
  wheel.id = id;
  wheel.savedAt = new Date().toISOString();
  await writeFile(wheelPath(id), JSON.stringify(wheel));
  res.json({ id });
});

// List saved wheels (newest first) for the "my wheels" seed picker.
app.get('/api/wheels', async (_req, res) => {
  const files = await readdir(WHEELS).catch(() => [] as string[]);
  const out: { id: string; label: string; mode: string; count: number; savedAt: string }[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const w = JSON.parse(await readFile(path.join(WHEELS, f), 'utf8'));
      const count = (w.mode === 'image' ? w.images?.length : w.texts?.length) || 0;
      const label =
        w.name ||
        (w.mode === 'image'
          ? w.images?.[0]?.label || `${count} зображень`
          : w.texts?.[0] || 'Порожнє') ||
        w.id;
      out.push({ id: w.id, label, mode: w.mode ?? 'text', count, savedAt: w.savedAt ?? '' });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  res.json(out.slice(0, 60));
});

app.delete('/api/wheels/:id', async (req, res) => {
  const { id } = req.params;
  if (!idOk(id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  if (existsSync(wheelPath(id))) await unlink(wheelPath(id));
  res.json({ ok: true });
});

app.get('/api/wheels/:id', async (req, res) => {
  const { id } = req.params;
  if (!idOk(id) || !existsSync(wheelPath(id))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.type('json').send(await readFile(wheelPath(id)));
});

// Guest contribution: append ONE entry to a wheel (stream viewers). Never
// replaces the wheel — safe to expose to untrusted guests.
app.post('/api/wheels/:id/entry', async (req, res) => {
  const { id } = req.params;
  if (!idOk(id) || !existsSync(wheelPath(id))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
  if (!label) {
    res.status(400).json({ error: 'empty' });
    return;
  }
  const w = JSON.parse(await readFile(wheelPath(id), 'utf8'));
  const list: unknown[] = w.mode === 'image' ? (w.images ??= []) : (w.texts ??= []);
  if (list.length >= 100) {
    res.status(409).json({ error: 'full' });
    return;
  }
  if (w.mode === 'image') w.images.push({ label });
  else w.texts.push(label);
  w.savedAt = new Date().toISOString();
  await writeFile(wheelPath(id), JSON.stringify(w));
  res.json({ ok: true });
});

app.post('/api/images', express.raw({ type: 'image/*', limit: '8mb' }), async (req, res) => {
  const ext = EXT[req.headers['content-type'] ?? ''];
  if (!ext || !(req.body instanceof Buffer) || req.body.length === 0) {
    res.status(400).json({ error: 'bad image' });
    return;
  }
  const name = `${createHash('sha256').update(req.body).digest('hex').slice(0, 16)}.${ext}`;
  const file = path.join(IMAGES, name);
  if (!existsSync(file)) await writeFile(file, req.body);
  res.json({ url: `/i/${name}` });
});

app.use('/i', express.static(IMAGES, { immutable: true, maxAge: '365d' }));

const dist = path.join(ROOT, 'dist');
app.use(express.static(dist));
// SPA fallback: /w/:id (shared wheel URLs) and anything else → index.html
app.get(/^\/(w\/.*)?$/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

// Periodically delete image files no wheel references any more, so the disk
// doesn't fill with abandoned uploads. Keeps files younger than 1h (may be
// mid-creation, not yet saved into a wheel).
async function sweepOrphanImages(): Promise<void> {
  try {
    const referenced = new Set<string>();
    for (const f of await readdir(WHEELS)) {
      if (!f.endsWith('.json')) continue;
      let w: {
        images?: { url?: string }[];
        played?: { imageUrl?: string }[];
      };
      try {
        w = JSON.parse(await readFile(path.join(WHEELS, f), 'utf8'));
      } catch {
        // Safety: if ANY wheel is unreadable, abort — never risk deleting an
        // image that a temporarily-unreadable wheel actually references.
        console.log(`[cleanup] aborted: unreadable wheel ${f}`);
        return;
      }
      for (const e of w.images ?? []) {
        if (typeof e?.url === 'string' && e.url.startsWith('/i/')) referenced.add(e.url.slice(3));
      }
      // Images moved to the "played" window are still in use — must be kept.
      for (const p of w.played ?? []) {
        if (typeof p?.imageUrl === 'string' && p.imageUrl.startsWith('/i/')) {
          referenced.add(p.imageUrl.slice(3));
        }
      }
    }
    const now = Date.now();
    let removed = 0;
    for (const f of await readdir(IMAGES)) {
      if (referenced.has(f)) continue;
      const st = await stat(path.join(IMAGES, f)).catch(() => null);
      if (!st || now - st.mtimeMs < 7 * 24 * 3_600_000) continue; // 7-day grace
      await unlink(path.join(IMAGES, f)).catch(() => {});
      removed++;
    }
    if (removed) console.log(`[cleanup] removed ${removed} orphan image(s)`);
  } catch (e) {
    console.log('[cleanup] failed', e);
  }
}
setTimeout(() => void sweepOrphanImages(), 5 * 60_000);
setInterval(() => void sweepOrphanImages(), 12 * 3_600_000);

app.listen(PORT, () => console.log(`LegendaryLots wheel on http://localhost:${PORT}`));
