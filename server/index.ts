import express from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { customAlphabet } from 'nanoid';

const PORT = Number(process.env.PORT ?? 3940);
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const WHEELS = path.join(DATA, 'wheels');
const IMAGES = path.join(DATA, 'images');
for (const d of [WHEELS, IMAGES]) mkdirSync(d, { recursive: true });

// Unambiguous alphabet — codes get typed by hand on a tablet.
const newId = customAlphabet('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 8);

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
  let id: string = typeof wheel.id === 'string' && idOk(wheel.id) ? wheel.id.toUpperCase() : '';
  if (!id || !existsSync(wheelPath(id))) id = newId();
  wheel.id = id;
  wheel.savedAt = new Date().toISOString();
  await writeFile(wheelPath(id), JSON.stringify(wheel));
  res.json({ id });
});

app.get('/api/wheels/:id', async (req, res) => {
  const { id } = req.params;
  if (!idOk(id) || !existsSync(wheelPath(id))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.type('json').send(await readFile(wheelPath(id)));
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

app.listen(PORT, () => console.log(`LegendaryLots wheel on http://localhost:${PORT}`));
