import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, canonical } from '../store.mjs';

async function fixture() {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-fault-test-')));
  const cwd = join(base, 'repo'); await mkdir(join(cwd, '.git'), { recursive: true });
  return { base, cwd, store: new MemoryStore(join(base, 'memory')) };
}
const topic = { file: 'notes.md', content: '# Fact\n', summary: 'fact' };
const child = script => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const storeURL = JSON.stringify(new URL('../store.mjs', import.meta.url).href);
const migrateURL = JSON.stringify(new URL('../migrate.mjs', import.meta.url).href);
const recoverURL = JSON.stringify(new URL('../recover-lock.mjs', import.meta.url).href);

test('failed index replacement leaves a journal with exact recovery bytes and unlocks the store', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic);
  const before = await store.read(cwd, topic.file); const dir = before.directory;
  const previousIndex = await readFile(join(dir, 'MEMORY.md'), 'utf8');
  child(`import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const original = fs.rename; fs.rename = async (from,to) => {
      if (to === ${JSON.stringify(join(dir, 'MEMORY.md'))}) throw Object.assign(new Error('Injected'),{code:'EIO'});
      return original(from,to);
    }; syncBuiltinESMExports();
    const {MemoryStore} = await import(${storeURL});
    try { await new MemoryStore(${JSON.stringify(store.root)}).write(${JSON.stringify(cwd)},${JSON.stringify({ ...topic, content: '# Changed\n', summary: 'changed', expected_revision: before.revision })}); process.exit(9); }
    catch(e) { if(e.code!=='EIO') throw e; }`);
  assert.equal(await readFile(join(dir, topic.file), 'utf8'), '# Changed\n');
  assert.equal(await readFile(join(dir, 'MEMORY.md'), 'utf8'), previousIndex);
  await assert.rejects(lstat(join(dir, '.write-lock')), { code: 'ENOENT' });
  const journals = await Promise.all((await readdir(join(dir, 'history'))).map(async file => JSON.parse(await readFile(join(dir, 'history', file), 'utf8'))));
  const journal = journals.find(j => j.nextContent === '# Changed\n');
  assert.equal(journal.previousContent, '# Fact\n'); assert.equal(journal.previousIndex, previousIndex);
  assert.match(journal.nextIndex, /changed/);
});

test('cancellation and policy revocation after commit admission do not interrupt index completion', async () => {
  const { cwd, store } = await fixture();
  const dir = (await store.locate(cwd)).dir;
  child(`import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const controller = new AbortController(); let allowed = true; const original = fs.rename;
    fs.rename = async (from,to) => { const result = await original(from,to);
      if(to === ${JSON.stringify(join(dir, topic.file))}) {allowed=false;controller.abort();} return result;
    }; syncBuiltinESMExports(); const {MemoryStore} = await import(${storeURL});
    const saved = await new MemoryStore(${JSON.stringify(store.root)}).write(${JSON.stringify(cwd)},${JSON.stringify(topic)},controller.signal,()=>{if(!allowed)throw new Error('revoked');});
    if(!saved.saved || !controller.signal.aborted) process.exit(9);`);
  assert.equal((await store.read(cwd, topic.file)).content, '# Fact\n');
  assert.match((await store.read(cwd)).content, /notes.md/);
});

test('migration rechecks destination case aliases created after preflight under the lock', async () => {
  const { base, cwd, store } = await fixture(); const dir = (await store.locate(cwd)).dir;
  const source = join(base, 'source'); const src = join(source, 'slug', 'memory');
  await mkdir(src, { recursive: true }); await writeFile(join(src, 'notes.md'), '# Fact\n');
  child(`import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const original = fs.open; fs.open = async (...args) => { const handle = await original(...args);
      if(args[0]===${JSON.stringify(join(dir, '.write-lock'))}) await fs.writeFile(${JSON.stringify(join(dir, 'Notes.md'))},'# Other\\n'); return handle;
    }; syncBuiltinESMExports(); const {migrate} = await import(${migrateURL});
    try {await migrate(${JSON.stringify({ source, destination: store.root, mapping: { slug: cwd }, apply: true })}); process.exit(9);}
    catch(e) {if(!e.message.includes('Case-colliding destination'))throw e;}`);
  const names = await readdir(dir);
  assert.ok(names.includes('Notes.md') && !names.includes('notes.md') && !names.includes('import.json'));
});

test('recovery refuses a lock replaced after dead-owner inspection', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic);
  const dir = (await store.locate(cwd)).dir; const lock = join(dir, '.write-lock');
  await writeFile(lock, JSON.stringify({ pid: 2147483647, generation: 1 }));
  child(`import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const original = fs.open; fs.open = async (...args) => { const handle = await original(...args);
      if(args[0]===${JSON.stringify(join(dir, '.lock-recovery'))}) await fs.writeFile(${JSON.stringify(lock)},JSON.stringify({pid:2147483647,generation:2})); return handle;
    }; syncBuiltinESMExports(); const {recoverLock} = await import(${recoverURL});
    try {await recoverLock(${JSON.stringify({ cwd, root: store.root, confirm: true })}); process.exit(9);}
    catch(e) {if(!e.message.includes('Lock identity changed'))throw e;}`);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).generation, 2);
  await assert.rejects(lstat(join(dir, '.lock-recovery')), { code: 'ENOENT' });
});

test('journals and history directories have private permissions', async () => {
  const { cwd, store } = await fixture(); const { directory } = await store.write(cwd, topic);
  const history = join(directory, 'history');
  assert.equal((await lstat(history)).mode & 0o777, 0o700);
  for (const file of await readdir(history)) assert.equal((await lstat(join(history, file))).mode & 0o777, 0o600);
});
