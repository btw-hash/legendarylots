// Sync smoke: proves the server's rev contract that cross-device pull relies on.
// Device A writes, device B (GET) sees the new rev + content, and vice versa.
// Run: node scripts/smoke-sync.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3973;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'll-sync-'));
mkdirSync(path.join(DATA, 'wheels'), { recursive: true });
mkdirSync(path.join(DATA, 'images'), { recursive: true });

const results = [];
const check = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const srv = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), LL_DATA_DIR: DATA },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
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

const save = (body, token) =>
  fetch(`${BASE}/api/wheels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-edit-token': token } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const get = (id) => fetch(`${BASE}/api/wheels/${id}`).then((r) => r.json());

try {
  if (!(await waitUp())) throw new Error('server did not start');

  // Device A creates a wheel → rev 1.
  const a1 = await save({ name: 'Sync', mode: 'text', texts: ['Один', 'Два'], images: [], played: [] });
  check('create → rev 1', a1.rev === 1, `rev=${a1.rev}`);
  const { id, editToken } = a1;

  // Device A adds an entry → rev 2.
  const a2 = await save(
    { id, name: 'Sync', mode: 'text', texts: ['Один', 'Два', 'Три'], images: [], played: [] },
    editToken
  );
  check('device A edit bumps rev → 2', a2.rev === 2, `rev=${a2.rev}`);

  // Device B (poll) sees the newer rev + the added entry.
  const b = await get(id);
  check('device B sees rev 2 + new content', b.rev === 2 && b.texts.length === 3 && b.texts[2] === 'Три');

  // Device B (holds the same edit token) spins one off into "played" → rev 3.
  const b3 = await save(
    {
      id,
      name: 'Sync',
      mode: 'text',
      texts: ['Один', 'Два'],
      images: [],
      played: [{ label: 'Три', mode: 'text' }],
    },
    editToken
  );
  check('device B edit bumps rev → 3', b3.rev === 3, `rev=${b3.rev}`);

  // Device A (poll) sees the played entry reflected.
  const a = await get(id);
  check(
    'device A sees played entry (rev 3)',
    a.rev === 3 && a.played.length === 1 && a.texts.length === 2
  );
} catch (e) {
  check('sync run', false, String(e));
} finally {
  srv.kill();
  rmSync(DATA, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
