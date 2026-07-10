// Snapshot smoke: proves the core promise — a saved snapshot is a SEPARATE frozen
// record, so editing the live/working wheel afterwards never changes it.
// Run: node scripts/smoke-snapshot.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3976;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'll-snap-'));
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

  // Live/working wheel with 3 prizes.
  const work = await save({
    name: 'Колесо 1',
    mode: 'image',
    texts: [],
    images: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    played: [],
  });

  // Зберегти → a snapshot is a POST with NO id, so the server mints a fresh one.
  const snap = await save({
    name: 'Колесо 1',
    mode: 'image',
    texts: [],
    images: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    played: [],
  });
  check('snapshot is a distinct record', !!snap.id && snap.id !== work.id, `work=${work.id} snap=${snap.id}`);

  const snapBefore = await get(snap.id);
  check('snapshot has the 3 prizes', snapBefore.images.length === 3);

  // Run the giveaway on the LIVE wheel: remove two winners, then clear it entirely.
  await save(
    { id: work.id, name: 'Колесо 1', mode: 'image', texts: [], images: [{ label: 'C' }], played: [{ label: 'A', mode: 'image' }, { label: 'B', mode: 'image' }] },
    work.editToken
  );
  await save(
    { id: work.id, name: 'Колесо 1', mode: 'image', texts: [], images: [], played: [] },
    work.editToken
  );

  // The snapshot must be untouched by all of that.
  const snapAfter = await get(snap.id);
  check('snapshot unchanged after live edits + clear', snapAfter.images.length === 3 && snapAfter.rev === snapBefore.rev);

  // The live wheel did change.
  const workAfter = await get(work.id);
  check('live wheel reflects the edits', workAfter.images.length === 0);

  // Cleanup
  await fetch(`${BASE}/api/wheels/${work.id}`, { method: 'DELETE', headers: { 'x-edit-token': work.editToken } });
  await fetch(`${BASE}/api/wheels/${snap.id}`, { method: 'DELETE', headers: { 'x-edit-token': snap.editToken } });
} catch (e) {
  check('snapshot run', false, String(e));
} finally {
  srv.kill();
  rmSync(DATA, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
