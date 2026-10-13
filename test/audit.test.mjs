import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, link, symlink, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { MemoryStore, canonical, projectKey, MAX_READ_BYTES } from '../store.mjs';
import { migrate } from '../migrate.mjs';
import { recoverLock } from '../recover-lock.mjs';
import { apply } from '../index.mjs';

async function fixture() {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-audit-test-')));
  const cwd = join(base, 'repo'); await mkdir(join(cwd, '.git'), { recursive: true });
  return { base, cwd, store: new MemoryStore(join(base, 'memory')) };
}
const topic = (file = 'notes.md') => ({ file, content: '# Fact\n', summary: 'fact' });

test('independent nested Git repositories never read parent memory', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic());
  const child = join(cwd, 'child'); await mkdir(join(child, '.git'), { recursive: true });
  assert.equal((await store.locate(child)).cwd, child);
  assert.equal((await store.read(child, 'notes.md')).content, null);
  await store.write(child, topic('child.md'));
  assert.equal((await store.read(cwd, 'child.md')).content, null);
  assert.equal((await store.read(join(child, 'src'), 'child.md')).content, '# Fact\n');
});

test('Git worktree marker files are project boundaries', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic());
  const child = join(cwd, 'worktree'); await mkdir(child); await writeFile(join(child, '.git'), 'gitdir: /other/repo\n');
  assert.equal((await store.locate(child)).cwd, child);
});

test('unrelated malformed project metadata cannot disable healthy memory', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic());
  const other = join(store.root, 'projects', 'broken'); await mkdir(other); await writeFile(join(other, 'project.json'), '{invalid');
  assert.equal((await store.read(cwd, 'notes.md')).content, '# Fact\n');
  assert.match(await store.context(cwd), /fact/);
});

test('hardlinks to topics, index and metadata are refused', async () => {
  for (const file of ['notes.md', 'MEMORY.md', 'project.json']) {
    const { cwd, store, base } = await fixture(); const project = await store.locate(cwd);
    await mkdir(project.dir, { recursive: true }); const outside = join(base, 'outside');
    await writeFile(outside, 'private'); await link(outside, join(project.dir, file));
    await assert.rejects(store.read(cwd, 'notes.md'), /Hard links/);
    await assert.rejects(store.write(cwd, topic()), /Hard links/);
    assert.equal(await readFile(outside, 'utf8'), 'private');
  }
});

test('directories, FIFOs and oversized topics are rejected without hanging', async () => {
  const { cwd, store } = await fixture(); const p = await store.locate(cwd); await mkdir(p.dir, { recursive: true });
  await mkdir(join(p.dir, 'directory.md'));
  await assert.rejects(store.read(cwd, 'directory.md'), /regular file/);
  await writeFile(join(p.dir, 'huge.md'), Buffer.alloc(MAX_READ_BYTES + 1));
  await assert.rejects(store.read(cwd, 'huge.md'), /exceeds/);
  if (process.platform !== 'win32') {
    const result = spawnSync('mkfifo', [join(p.dir, 'pipe.md')]); assert.equal(result.status, 0);
    await assert.rejects(store.read(cwd, 'pipe.md'), /regular file/);
  }
});

test('canonical missing descendants use nearest existing physical ancestor', async () => {
  const { base } = await fixture(); const physical = join(base, 'physical'); await mkdir(physical);
  const alias = join(base, 'alias'); await symlink(physical, alias);
  assert.equal(canonical(join(alias, 'missing', 'child')), canonical(join(physical, 'missing', 'child')));
});

test('imported index prose, multi-link lines and other entries are preserved', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic()); const p = await store.locate(cwd);
  const lines = ['# Index', 'Important [notes](notes.md) and [other](other.md)', '- [notes.md](notes.md): critical [other](other.md) details', '- [Else](other.md): other topic'];
  await writeFile(join(p.dir, 'MEMORY.md'), lines.join('\n') + '\n');
  const old = await store.read(cwd, 'notes.md'); await store.write(cwd, { ...topic(), expected_revision: old.revision });
  let index = (await store.read(cwd)).content; for (const line of lines) assert.ok(index.includes(line));
  const next = await store.read(cwd, 'notes.md'); await store.write(cwd, { ...topic(), summary: 'updated', expected_revision: next.revision });
  index = (await store.read(cwd)).content;
  assert.equal(index.split('\n').filter(l => l === '- [notes.md](<notes.md>): updated').length, 1);
  assert.ok(!index.includes('- [notes.md](<notes.md>): fact'));
  for (const line of lines) assert.ok(index.includes(line));
});

test('history records normalized exact committed bytes', async () => {
  const { cwd, store } = await fixture(); const result = await store.write(cwd, { ...topic(), content: '# No final newline' });
  const files = await readdir(join(result.directory, 'history')); const data = JSON.parse(await readFile(join(result.directory, 'history', files[0]), 'utf8'));
  assert.equal(data.nextContent, await readFile(join(result.directory, 'notes.md'), 'utf8'));
  assert.equal(data.nextIndex, await readFile(join(result.directory, 'MEMORY.md'), 'utf8'));
});

test('private permissions apply to new topics, metadata, index and journals', async () => {
  const { cwd, store } = await fixture(); const result = await store.write(cwd, topic());
  for (const file of ['notes.md', 'MEMORY.md', 'project.json']) assert.equal((await lstat(join(result.directory, file))).mode & 0o777, 0o600);
  assert.equal((await lstat(result.directory)).mode & 0o777, 0o700);
});

test('policy revoked before asynchronous mutation prevents saved topics', async () => {
  const { cwd, store } = await fixture(); const tools = new Map(); let mode = 'workspace-write', planned = false;
  const agent = { id: 'a', session: { header: { cwd } }, ctx: { get: () => ({ get: () => ({ active: planned }) }) } };
  await apply({ agents: { get: () => agent, list: () => [agent] }, tools: { register: t => tools.set(t.name, t) }, on: () => {}, sandboxPolicy: { resolve: () => ({ mode }) } }, { root: store.root });
  const writing = tools.get('memory_write').execute(topic(), { agent, signal: new AbortController().signal });
  mode = 'read-only'; planned = true;
  await assert.rejects(writing, /read-only|plan mode/);
  assert.equal((await store.read(cwd, 'notes.md')).content, null);
});

test('read-only unknown mode and pending plan fail closed', async () => {
  const { cwd, store } = await fixture(); const tools = new Map(); let mode = 'unknown', active = false, pending = false;
  const agent = { id: 'a', session: { header: { cwd } }, ctx: { get: () => ({ get: () => ({ active, pending }) }) } };
  await apply({ agents: { get: () => agent, list: () => [agent] }, tools: { register: t => tools.set(t.name, t) }, on: () => {}, sandboxPolicy: { resolve: () => ({ mode }) } }, { root: store.root });
  const exec = { agent, signal: new AbortController().signal };
  await assert.rejects(tools.get('memory_write').execute(topic(), exec), /Unknown/);
  mode = 'workspace-write'; pending = true; await assert.rejects(tools.get('memory_write').execute(topic(), exec), /plan mode/);
  active = true; pending = false; await assert.rejects(tools.get('memory_write').execute(topic(), exec), /plan mode/);
});

test('lock recovery inspects by default, refuses live owner, and explicitly recovers dead owner', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic()); const p = await store.locate(cwd), path = join(p.dir, '.write-lock');
  await writeFile(path, JSON.stringify({ pid: process.pid }));
  await assert.rejects(recoverLock({ cwd, root: store.root, confirm: true }), /still alive/);
  await writeFile(path, JSON.stringify({ pid: 2147483647 }));
  const dry = await recoverLock({ cwd, root: store.root }); assert.equal(dry.removed, false); assert.ok(await lstat(path));
  const recovered = await recoverLock({ cwd, root: store.root, confirm: true }); assert.equal(recovered.removed, true);
  await store.write(cwd, topic('new.md'));
});

test('explicit migration map imports parent and nested projects separately', async () => {
  const { cwd, store, base } = await fixture(); const child = join(cwd, 'child'); await mkdir(child);
  const source = join(base, 'claude');
  for (const slug of ['parent', 'child']) { const dir = join(source, slug, 'memory'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'MEMORY.md'), `# ${slug}`); }
  const opts = { source, destination: store.root, mapping: { parent: cwd, child }, apply: true };
  assert.equal((await migrate(opts)).projects, 2);
  assert.equal((await store.read(cwd)).content, '# parent'); assert.equal((await store.read(child)).content, '# child');
});

test('migration rejects oversized and hardlinked bytes during preflight', async () => {
  for (const kind of ['huge', 'hardlink']) {
    const { cwd, store, base } = await fixture(), source = join(base, 'claude'), dir = join(source, 'slug', 'memory');
    await mkdir(dir, { recursive: true });
    if (kind === 'huge') await writeFile(join(dir, 'notes.md'), Buffer.alloc(MAX_READ_BYTES + 1));
    else { const outside = join(base, 'outside.md'); await writeFile(outside, 'private'); await link(outside, join(dir, 'notes.md')); }
    await assert.rejects(migrate({ source, destination: store.root, mapping: { slug: cwd }, apply: true }), /exceeds|Hard links/);
    assert.equal((await store.read(cwd, 'notes.md')).content, null);
  }
});

test('migration rerun retains original evidence and normalizes existing modes', async () => {
  const { cwd, store, base } = await fixture(), source = join(base, 'claude'), dir = join(source, 'slug', 'memory');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'notes.md'), '# Fact');
  const opts = { source, destination: store.root, mapping: { slug: cwd }, apply: true };
  const result = await migrate(opts), target = result.entries[0].directory;
  const before = await readFile(join(target, 'import.json')); await migrate(opts);
  assert.deepEqual(await readFile(join(target, 'import.json')), before);
  assert.equal((await lstat(join(target, 'notes.md'))).mode & 0o777, 0o600);
});

test('migration staging failure never publishes partial final topic and permits rerun', async () => {
  const { cwd, store, base } = await fixture(), source = join(base, 'claude'), dir = join(source, 'slug', 'memory');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'notes.md'), '# Complete bytes');
  const opts = { source, destination: store.root, mapping: { slug: cwd }, apply: true };
  const script = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.open; fs.open=async(...args)=>{const h=await original(...args);if(String(args[0]).includes('/.import-')){h.writeFile=async bytes=>{await h.write(bytes.subarray(0,5));throw Object.assign(new Error('Injected'),{code:'EIO'});};}return h;};syncBuiltinESMExports();
    const {migrate}=await import(${JSON.stringify(new URL('../migrate.mjs', import.meta.url).href)});try{await migrate(${JSON.stringify(opts)});process.exit(9);}catch(e){if(e.code!=='EIO')throw e;}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const target = join(store.root, 'projects', projectKey(cwd), 'notes.md'); await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.equal((await migrate(opts)).files, 1);
  assert.equal((await store.read(cwd, 'notes.md')).content, '# Complete bytes');
});

test('multibyte index truncation never leaves replacement characters', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic()); const p = await store.locate(cwd);
  await writeFile(join(p.dir, 'MEMORY.md'), 'Ж'.repeat(1000));
  const context = await store.context(cwd, { maxLines: 200, maxBytes: 101 });
  assert.match(context, /Index truncated/); assert.ok(!context.includes('\uFFFD'));
});
