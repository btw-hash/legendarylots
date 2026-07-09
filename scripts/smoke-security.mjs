// Security smoke: exercises the capability model + hardening end-to-end against a
// freshly spawned server on an isolated data dir. Run: node scripts/smoke-security.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3971;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'll-smoke-'));
mkdirSync(path.join(DATA, 'wheels'), { recursive: true });
mkdirSync(path.join(DATA, 'images'), { recursive: true });

const results = [];
const check = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(32).fill(0)]);

const srv = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), LL_DATA_DIR: DATA },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

const waitUp = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/wheels/ZZZZ`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
};

try {
  if (!(await waitUp())) throw new Error('server did not start');

  // 1. Create a fresh wheel WITHOUT an id → server mints a long id + editToken.
  let r = await fetch(`${BASE}/api/wheels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', mode: 'text', texts: ['one'], images: [], played: [] }),
  });
  let j = await r.json();
  const id = j.id;
  const token = j.editToken;
  check(
    'create mints long unguessable id + token',
    r.status === 200 && !!token && /^[a-z0-9]{8,32}$/.test(id || ''),
    `id=${id}`
  );

  // 2. Overwrite WITHOUT the token → 403.
  r = await fetch(`${BASE}/api/wheels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: 'hijack', mode: 'text', texts: ['evil'], images: [], played: [] }),
  });
  check('overwrite without token → 403', r.status === 403);

  // 3. Overwrite WITH the token → 200.
  r = await fetch(`${BASE}/api/wheels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-edit-token': token },
    body: JSON.stringify({ id, name: 'ok', mode: 'text', texts: ['two'], images: [], played: [] }),
  });
  check('overwrite with token → 200', r.status === 200);

  // 4. Old-style short/uppercase code no longer routes (idOk rejects it) → 404.
  r = await fetch(`${BASE}/api/wheels/VIS1`);
  check('legacy short code rejected → 404', r.status === 404, `got ${r.status}`);

  // 5. GET never exposes editToken, only protected flag.
  r = await fetch(`${BASE}/api/wheels/${id}`);
  j = await r.json();
  check('GET hides editToken', !('editToken' in j) && j.protected === true);

  // 6. Global list endpoint is gone.
  r = await fetch(`${BASE}/api/wheels`);
  check('GET /api/wheels (list all) removed → not 200', r.status !== 200, `got ${r.status}`);

  // 7. DELETE without token → 403.
  r = await fetch(`${BASE}/api/wheels/${id}`, { method: 'DELETE' });
  check('delete without token → 403', r.status === 403);

  // 8. Content caps: an oversized label is truncated on save.
  const bigLabel = 'Z'.repeat(5000);
  r = await fetch(`${BASE}/api/wheels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: bigLabel, mode: 'text', texts: [bigLabel], images: [], played: [] }),
  });
  const big = await r.json();
  r = await fetch(`${BASE}/api/wheels/${big.id}`);
  j = await r.json();
  check('oversized content clamped on save', j.name.length <= 200 && j.texts[0].length <= 200);

  // 9. Image upload: spoofed bytes (plain text) as image/png → 400.
  r = await fetch(`${BASE}/api/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from('this is not an image'),
  });
  check('spoofed non-image bytes rejected → 400', r.status === 400);

  // 10. Image upload: real PNG signature → 200.
  r = await fetch(`${BASE}/api/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: png,
  });
  check('valid PNG accepted → 200', r.status === 200);

  // 11. Security headers present.
  r = await fetch(`${BASE}/api/wheels/${id}`);
  check(
    'nosniff + frame protection headers',
    r.headers.get('x-content-type-options') === 'nosniff' &&
      (r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'")
  );

  // 12. Pending contribution still works (guest path).
  r = await fetch(`${BASE}/api/wheels/${id}/pending`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'guest pick' }),
  });
  check('guest pending submission → 200', r.status === 200);
} catch (e) {
  check('smoke run', false, String(e));
} finally {
  srv.kill();
  rmSync(DATA, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
