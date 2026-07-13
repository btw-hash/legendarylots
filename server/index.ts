import express from 'express';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { customAlphabet } from 'nanoid';

const PORT = Number(process.env.PORT ?? 3940);
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.LL_DATA_DIR
  ? path.resolve(process.env.LL_DATA_DIR)
  : path.join(ROOT, 'data');
const WHEELS = path.join(DATA, 'wheels');
const IMAGES = path.join(DATA, 'images');
for (const d of [WHEELS, IMAGES]) mkdirSync(d, { recursive: true });

// Long, unguessable id — there are no short codes any more; a wheel is reached only
// by its link, so the id doubles as an unguessable capability (~80 bits). Lowercase
// + digits only: single-case keeps it safe on case-insensitive filesystems.
const genId = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 16);
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

// Baseline security headers. Notably nosniff — user-uploaded blobs are served from
// /i, so browsers must not content-sniff them into something executable — and
// frame-ancestors 'none' to prevent clickjacking the host's edit/delete buttons.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Lightweight per-IP fixed-window throttle for the unauthenticated WRITE paths
// (create/upload/contribute). The whole surface is anonymous, so without this a
// single client can fill the disk or flood queues at line speed. Read paths are
// left unthrottled (cheap, and codes are already unguessable-ish).
const rlHits = new Map<string, { n: number; reset: number }>();
function rateLimit(max: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const key = `${req.path}\0${ip}`;
    const now = Date.now();
    const cur = rlHits.get(key);
    if (!cur || now > cur.reset) {
      rlHits.set(key, { n: 1, reset: now + windowMs });
    } else if (cur.n >= max) {
      res.status(429).json({ error: 'too many requests' });
      return;
    } else {
      cur.n++;
    }
    if (rlHits.size > 5000) for (const [k, v] of rlHits) if (now > v.reset) rlHits.delete(k);
    next();
  };
}

app.use(express.json({ limit: '2mb' }));

const idOk = (id: string) => /^[a-z0-9]{8,32}$/.test(id);
const wheelPath = (id: string) => path.join(WHEELS, `${id}.json`);

// Cap persisted content so a stored wheel can't become a resource-exhaustion
// payload for every viewer who later opens that code.
const MAX_LABEL = 200;
const MAX_ENTRIES = 200;
const clampStr = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : '';
function sanitizeWheel(w: {
  texts?: unknown[];
  images?: { url?: unknown; label?: unknown }[];
  played?: { label?: unknown; imageUrl?: unknown; mode?: unknown }[];
  name?: unknown;
}): void {
  w.name = clampStr(w.name, MAX_LABEL);
  w.texts = (Array.isArray(w.texts) ? w.texts : [])
    .slice(0, MAX_ENTRIES)
    .map((t) => clampStr(t, MAX_LABEL));
  w.images = (Array.isArray(w.images) ? w.images : []).slice(0, MAX_ENTRIES).map((i) => ({
    url: typeof i?.url === 'string' && i.url.startsWith('/i/') ? i.url : undefined,
    label: i?.label !== undefined ? clampStr(i.label, MAX_LABEL) : undefined,
  }));
  w.played = (Array.isArray(w.played) ? w.played : []).slice(0, MAX_ENTRIES).map((p) => ({
    label: clampStr(p?.label, MAX_LABEL),
    imageUrl:
      typeof p?.imageUrl === 'string' && p.imageUrl.startsWith('/i/') ? p.imageUrl : undefined,
    mode: p?.mode === 'image' ? 'image' : 'text',
  }));
}

app.post('/api/wheels', rateLimit(120, 60_000), async (req, res) => {
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
  sanitizeWheel(wheel);
  // Reuse the id the client already holds (an update); mint a fresh long id for a
  // brand-new wheel. Clients never invent ids — the first save gets one from here.
  let id: string = typeof wheel.id === 'string' && idOk(wheel.id) ? wheel.id : '';
  if (!id) id = newId();

  // Capability security: the link lets anyone VIEW + contribute (moderated), but
  // overwriting an EXISTING wheel needs its secret editToken, held only by the
  // owner. A brand-new id (no file yet) is free to create and mints its own token.
  const fileExists = existsSync(wheelPath(id));
  let existing: { editToken?: string; pending?: unknown; rev?: number } | null = null;
  if (fileExists) {
    try {
      existing = JSON.parse(await readFile(wheelPath(id), 'utf8'));
    } catch {
      existing = null;
    }
  }
  // Any existing wheel is protected: unreadable or token-mismatch → refuse. This
  // closes the "know the code → overwrite/claim it" hole (legacy wheels get a
  // token at startup, see migrateLegacyTokens).
  if (fileExists && (!existing?.editToken || req.header('x-edit-token') !== existing.editToken)) {
    res.status(403).json({ error: 'no edit rights' });
    return;
  }
  wheel.editToken = existing?.editToken ?? randomUUID().replace(/-/g, '');
  wheel.id = id;
  wheel.savedAt = new Date().toISOString();
  // Monotonic revision — the other device polls this to know when to pull changes.
  wheel.rev = (typeof existing?.rev === 'number' ? existing.rev : 0) + 1;
  // A host full-save must not wipe the guest pending queue (managed separately).
  if (wheel.pending === undefined) wheel.pending = existing?.pending ?? [];
  await writeFile(wheelPath(id), JSON.stringify(wheel));
  res.json({ id, editToken: wheel.editToken, rev: wheel.rev });
});

// NOTE: there is deliberately NO "list all wheels" endpoint. Codes are secrets
// (they grant view + contribute); enumerating them all to any caller would defeat
// that. The "my wheels" picker is per-device — the client tracks its own ids in
// localStorage and loads each by code.

// Require the wheel's editToken for a mutation; returns true if allowed.
async function assertEditRights(
  id: string,
  req: express.Request,
  res: express.Response
): Promise<boolean> {
  let w: { editToken?: string };
  try {
    w = JSON.parse(await readFile(wheelPath(id), 'utf8'));
  } catch {
    // Unreadable → refuse rather than grant edit rights to an unauthenticated caller.
    res.status(500).json({ error: 'wheel unreadable' });
    return false;
  }
  if (!w.editToken || req.header('x-edit-token') !== w.editToken) {
    res.status(403).json({ error: 'no edit rights' });
    return false;
  }
  return true;
}

app.delete('/api/wheels/:id', async (req, res) => {
  const { id } = req.params;
  if (!idOk(id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  if (!existsSync(wheelPath(id))) {
    res.json({ ok: true });
    return;
  }
  if (!(await assertEditRights(id, req, res))) return;
  await unlink(wheelPath(id));
  res.json({ ok: true });
});

app.get('/api/wheels/:id', async (req, res) => {
  const { id } = req.params;
  if (!idOk(id) || !existsSync(wheelPath(id))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const w = JSON.parse(await readFile(wheelPath(id), 'utf8'));
  const isProtected = !!w.editToken; // has an owner — others get read-only
  delete w.editToken; // never expose the secret
  res.json({ ...w, protected: isProtected });
});

// Guest contribution (stream viewers): text or image goes into a PENDING queue
// for the host to approve/reject — never straight onto the wheel. Safe to expose.
app.post('/api/wheels/:id/pending', rateLimit(20, 60_000), async (req, res) => {
  const { id } = req.params;
  if (!idOk(id) || !existsSync(wheelPath(id))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
  const imageUrl =
    typeof req.body?.imageUrl === 'string' && req.body.imageUrl.startsWith('/i/')
      ? req.body.imageUrl
      : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 40) : '';
  if (!label && !imageUrl) {
    res.status(400).json({ error: 'empty' });
    return;
  }
  const w = JSON.parse(await readFile(wheelPath(id), 'utf8'));
  w.pending ??= [];
  if (w.pending.length >= 50) {
    res.status(409).json({ error: 'queue full' });
    return;
  }
  const pid = randomUUID().slice(0, 8);
  w.pending.push({
    pid,
    label: label || undefined,
    imageUrl: imageUrl || undefined,
    name: name || undefined,
    at: new Date().toISOString(),
  });
  await writeFile(wheelPath(id), JSON.stringify(w));
  res.json({ pid });
});

// Host resolves a pending item (approve OR reject both just drop it from the
// queue; the host adds approved items to its own wheel locally, saved manually).
app.post('/api/wheels/:id/pending/:pid/resolve', async (req, res) => {
  const { id, pid } = req.params;
  if (!idOk(id) || !existsSync(wheelPath(id))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!(await assertEditRights(id, req, res))) return; // only the host moderates
  const w = JSON.parse(await readFile(wheelPath(id), 'utf8'));
  w.pending = (w.pending ?? []).filter((p: { pid?: string }) => p?.pid !== pid);
  await writeFile(wheelPath(id), JSON.stringify(w));
  res.json({ ok: true });
});

// Verify the actual file signature, not the client-supplied Content-Type — this
// endpoint is anonymous and world-writable, so we must not become a host for
// arbitrary (spoofed-as-image) binaries. Returns the true extension or null.
function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 && // "RIFF"
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50 // "WEBP"
  )
    return 'webp';
  return null;
}

app.post(
  '/api/images',
  rateLimit(40, 60_000),
  express.raw({ type: 'image/*', limit: '8mb' }),
  async (req, res) => {
    if (!(req.body instanceof Buffer) || req.body.length === 0) {
      res.status(400).json({ error: 'bad image' });
      return;
    }
    const ext = sniffImage(req.body); // trust the bytes, not the header
    if (!ext || !EXT[req.headers['content-type'] ?? '']) {
      res.status(400).json({ error: 'unsupported image type' });
      return;
    }
    const name = `${createHash('sha256').update(req.body).digest('hex').slice(0, 16)}.${ext}`;
    const file = path.join(IMAGES, name);
    if (!existsSync(file)) await writeFile(file, req.body);
    res.json({ url: `/i/${name}` });
  }
);

/* ── Provably-fair spin (commit → reveal) ─────────────────────────────────
   The server commits to a secret seed BEFORE it learns the client's entropy, so it
   cannot grind an outcome toward any sector; the client adds its seed AFTER the
   commit, so it cannot pick one either. Anyone can re-verify a spin:
     sha256(serverSeed) == hash (published before the client seed existed)
     winner = first 4 bytes of HMAC-SHA256(key=serverSeed, `${clientSeed}:${count}`) mod count
   (The 2^32 mod count bias is < 5e-8 for count ≤ 200 — irrelevant for a prize wheel.)
   Commits are wheel-agnostic and single-use; unclaimed ones expire quickly. */
const spinCommits = new Map<string, { seed: string; at: number }>();
const SPIN_COMMIT_TTL = 2 * 60_000;
const SPIN_COMMIT_CAP = 500;

app.post('/api/spin/commit', rateLimit(60, 60_000), (_req, res) => {
  const now = Date.now();
  for (const [k, v] of spinCommits) if (now - v.at > SPIN_COMMIT_TTL) spinCommits.delete(k);
  if (spinCommits.size >= SPIN_COMMIT_CAP) {
    res.status(429).json({ error: 'too many open commits' });
    return;
  }
  const seed = randomBytes(32).toString('hex');
  const nonce = randomUUID();
  spinCommits.set(nonce, { seed, at: now });
  res.json({ nonce, hash: createHash('sha256').update(seed).digest('hex') });
});

app.post('/api/spin/reveal', rateLimit(60, 60_000), (req, res) => {
  const { nonce, clientSeed, count } = (req.body ?? {}) as Record<string, unknown>;
  const commit = typeof nonce === 'string' ? spinCommits.get(nonce) : undefined;
  if (!commit) {
    res.status(404).json({ error: 'unknown or expired nonce' });
    return;
  }
  spinCommits.delete(nonce as string); // single-use, even on a bad payload below
  const n = Number(count);
  if (
    !Number.isInteger(n) ||
    n < 2 ||
    n > MAX_ENTRIES ||
    typeof clientSeed !== 'string' ||
    !clientSeed ||
    clientSeed.length > 64
  ) {
    res.status(400).json({ error: 'bad reveal payload' });
    return;
  }
  const mac = createHmac('sha256', commit.seed).update(`${clientSeed}:${n}`).digest();
  const winner = mac.readUInt32BE(0) % n;
  // Visual landing point inside the winning sector — also seed-derived (bytes 4..7),
  // kept off the sector edges so float rounding can never flip the outcome.
  const offsetFrac = 0.15 + (mac.readUInt32BE(4) / 0xffffffff) * 0.7;
  res.json({ serverSeed: commit.seed, winner, offsetFrac });
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
        pending?: { imageUrl?: string }[];
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
      // Images moved to the "played" window or awaiting moderation are still in use.
      for (const p of w.played ?? []) {
        if (typeof p?.imageUrl === 'string' && p.imageUrl.startsWith('/i/')) {
          referenced.add(p.imageUrl.slice(3));
        }
      }
      for (const p of w.pending ?? []) {
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
