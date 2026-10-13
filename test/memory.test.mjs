import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, canonical, projectKey } from '../store.mjs';
import { migrate } from '../migrate.mjs';
import { apply } from '../index.mjs';

async function fixture() {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-memory-test-')));
  const cwd = join(base, 'repo'); await mkdir(join(cwd, '.git'), { recursive: true });
  return { base, cwd: canonical(cwd), store: new MemoryStore(join(base, 'memory')) };
}
const topic = (file = 'notes.md', content = '# Durable fact\n') => ({ file, content, summary: 'Durable fact' });

test('new project reads without creating directories; topic writes update index', async () => {
  const { cwd, store } = await fixture();
  const first = await store.read(cwd);
  assert.equal(first.content, null);
  await store.write(cwd, topic());
  const index = await store.read(cwd);
  assert.match(index.content, /\[notes.md\]/);
  assert.deepEqual((await store.list(cwd)).files, ['MEMORY.md', 'notes.md']);
  assert.equal((await store.read(cwd, 'notes.md')).content, '# Durable fact\n');
});

test('read-before-write and revision guard include topic and index changes', async () => {
  const { cwd, store } = await fixture();
  await store.write(cwd, topic());
  await assert.rejects(store.write(cwd, topic()), /MEMORY_READ_REQUIRED/);
  const old = await store.read(cwd, 'notes.md');
  await store.write(cwd, topic('other.md'));
  await assert.rejects(store.write(cwd, { ...topic(), expected_revision: old.revision }), /MEMORY_STALE_VERSION/);
  const current = await store.read(cwd, 'notes.md');
  await store.write(cwd, { ...topic('notes.md', '# Updated\n'), expected_revision: current.revision });
  const list = await readdir(join(current.directory, 'history')); assert.equal(list.length, 3);
  const histories = await Promise.all(list.map(f => readFile(join(current.directory, 'history', f), 'utf8')));
  assert.ok(histories.some(text => JSON.parse(text).previousContent === '# Durable fact\n'));
});

test('subdirectories share project memory, longest imported root wins', async () => {
  const { cwd, store } = await fixture();
  const nested = join(cwd, 'src'); await mkdir(nested);
  await store.write(cwd, topic());
  assert.equal((await store.read(nested, 'notes.md')).content, '# Durable fact\n');
  const inner = join(cwd, 'separate'); await mkdir(inner);
  const metaDir = join(store.root, 'projects', projectKey(inner)); await mkdir(metaDir, { recursive: true });
  await writeFile(join(metaDir, 'project.json'), JSON.stringify({ version: 1, cwd: inner }));
  assert.equal((await store.locate(join(inner, 'child'))).cwd, inner);
  assert.notEqual(projectKey('/a/b.c'), projectKey('/a/b-c'));
});

test('path traversal, index writes, oversized files and symlinks are rejected', async () => {
  const { cwd, store, base } = await fixture();
  for (const file of ['../escape.md', '/tmp/escape.md', 'MEMORY.md', 'nested/file.md', 'x\\y.md'])
    await assert.rejects(store.write(cwd, topic(file)));
  await assert.rejects(store.write(cwd, topic('large.md', 'x'.repeat(262145))));
  await store.write(cwd, topic());
  const project = await store.locate(cwd);
  const outside = join(base, 'outside.md'); await writeFile(outside, 'private');
  await symlink(outside, join(project.dir, 'linked.md'));
  await assert.rejects(store.read(cwd, 'linked.md'), /Symlink/);
  await assert.rejects(store.write(cwd, topic('linked.md')), /Symlink/);
  const alternate = new MemoryStore(join(base, 'alias')); await symlink(store.root, alternate.root);
  await assert.rejects(alternate.read(cwd), /Symlink/);
});

test('cross-session locking prevents simultaneous lost updates', async () => {
  const { cwd, store } = await fixture();
  const results = await Promise.allSettled([store.write(cwd, topic('one.md')), store.write(cwd, topic('two.md'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /MEMORY_BUSY/);
});

test('index is bounded and unindexed topics remain discoverable', async () => {
  const { cwd, store } = await fixture();
  await store.write(cwd, topic());
  const ctx = await store.context(cwd, { maxLines: 1, maxBytes: 100 });
  assert.match(ctx, /Index truncated/);
  assert.match(ctx, /Additional topic files/);
  assert.match(ctx, /notes.md/);
});

test('migration dry-run, byte fidelity, rerun and conflicts', async () => {
  const { cwd, store, base } = await fixture();
  const source = join(base, 'claude'); const dir = join(source, 'slug', 'memory'); await mkdir(dir, { recursive: true });
  const bytes = Buffer.from('# Original\r\nФакт\r\n');
  await writeFile(join(dir, 'MEMORY.md'), bytes);
  await writeFile(join(dir, 'notes.md'), '# Topic');
  const options = { source, destination: store.root, mapping: { slug: cwd } };
  assert.equal((await migrate(options)).files, 2);
  assert.equal((await store.read(cwd)).content, null);
  const result = await migrate({ ...options, apply: true }); assert.equal(result.projects, 1);
  assert.deepEqual(await readFile(join(result.entries[0].directory, 'MEMORY.md')), bytes);
  assert.deepEqual(await readFile(join(dir, 'MEMORY.md')), bytes);
  assert.equal((await migrate({ ...options, apply: true })).files, 2);
  await writeFile(join(result.entries[0].directory, 'notes.md'), '# Changed');
  await assert.rejects(migrate({ ...options, apply: true }), /Import conflict/);
});

test('migration refuses ambiguous mapping and source symlinks', async () => {
  const { cwd, store, base } = await fixture();
  const source = join(base, 'claude'); const dir = join(source, 'slug', 'memory'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'MEMORY.md'), '# Original');
  await assert.rejects(migrate({ source, destination: store.root, mapping: {} }), /No unambiguous/);
  await symlink(join(dir, 'MEMORY.md'), join(dir, 'alias.md'));
  await assert.rejects(migrate({ source, destination: store.root, mapping: { slug: cwd } }), /symlink/);
});

async function pluginFixture() {
  const { cwd, store } = await fixture(); const tools = new Map(); const handlers = new Map();
  let mode = 'workspace-write', planned = false;
  const agent = { id: 'a', session: { header: { cwd } }, ctx: { get: () => ({ get: () => ({ active: planned }) }) } };
  const ctx = { agents: { get: id => id === 'a' ? agent : undefined, list: () => [agent] },
    on: (name, handler) => handlers.set(name, handler), tools: { register: tool => tools.set(tool.name, tool) },
    sandboxPolicy: { resolve: () => ({ mode }) } };
  await apply(ctx, { root: store.root });
  const exec = { agent, signal: new AbortController().signal };
  return { cwd, store, tools, handlers, agent, exec, setMode: value => mode = value, setPlan: value => planned = value };
}

test('plugin supplies current scoped snapshot and does not leak into other scopes', async () => {
  const { handlers, agent, tools, exec } = await pluginFixture();
  const handler = handlers.get('system-prompt/assemble'); const assembly = { contexts: [], sections: [], tools: [], variables: {} };
  const result = await handler(assembly, { scope: agent }, async () => assembly);
  assert.match(result.contexts[0].text, /Persistent project memory/);
  await tools.get('memory_write').execute(topic(), exec);
  const latest = await handler(assembly, { scope: agent }, async () => assembly);
  assert.match(latest.contexts[0].text, /Durable fact/);
  const unrelated = await handler(assembly, { scope: {} }, async () => assembly);
  assert.equal(unrelated.contexts.length, 0);
});

test('plugin blocks writes in read-only and plan mode; allows bounded workspace memory', async () => {
  const f = await pluginFixture(); const write = () => f.tools.get('memory_write').execute(topic(), f.exec);
  f.setMode('read-only'); await assert.rejects(write(), /read-only/);
  f.setMode('workspace-write'); f.setPlan(true); await assert.rejects(write(), /plan mode/);
  f.setPlan(false); assert.equal((await write()).saved, true);
  await assert.rejects(f.tools.get('memory_list').execute({}, { ...f.exec, agent: undefined }), /live agent/);
});

test('case-insensitive index aliases and topic spelling are rejected', async () => {
  const { cwd, store } = await fixture();
  for (const file of ['memory.md', 'Memory.md', 'mEmOrY.md']) await assert.rejects(store.write(cwd, topic(file)), /maintained automatically/);
  await store.write(cwd, topic('Fact.md'));
  await assert.rejects(store.write(cwd, topic('fact.md')), /exact stored topic/);
});

test('index and metadata symlinks cannot leak or partially modify a topic', async () => {
  const { cwd, store, base } = await fixture();
  const project = await store.locate(cwd); await mkdir(project.dir, { recursive: true });
  const outside = join(base, 'outside.md'); await writeFile(outside, 'private');
  await symlink(outside, join(project.dir, 'MEMORY.md'));
  await assert.rejects(store.read(cwd, 'notes.md'), /Symlink/);
  await assert.rejects(store.write(cwd, topic()), /Symlink/);
  await assert.rejects(readFile(join(project.dir, 'notes.md')), { code: 'ENOENT' });
  await symlink(outside, join(project.dir, 'project.json'));
  await assert.rejects(store.locate(cwd), /Symlink/);
});

test('migration forbids source and destination overlap before any write', async () => {
  const { cwd, base } = await fixture();
  const source = join(base, 'claude'); await mkdir(source);
  for (const destination of [source, join(source, 'slug', 'memory'), base])
    await assert.rejects(migrate({ source, destination, mapping: { slug: cwd }, apply: true }), /must not overlap/);
  assert.deepEqual(await readdir(source), []);
});

test('revision cannot authorize a different topic with identical contents', async () => {
  const { cwd, store } = await fixture();
  await store.write(cwd, topic('one.md'));
  await store.write(cwd, topic('two.md'));
  const one = await store.read(cwd, 'one.md');
  const two = await store.read(cwd, 'two.md');
  assert.notEqual(one.revision, two.revision);
  await assert.rejects(store.write(cwd, { ...topic('two.md', '# Replacement'), expected_revision: one.revision }), /MEMORY_STALE_VERSION/);
});

test('migration rejects inaccessible topic names before copying', async () => {
  const { cwd, store, base } = await fixture();
  const source = join(base, 'claude'), dir = join(source, 'slug', 'memory');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'file with spaces.md'), '# Fact');
  await assert.rejects(migrate({ source, destination: store.root, mapping: { slug: cwd }, apply: true }), /Unsupported imported topic/);
  assert.equal((await store.read(cwd)).content, null);
});

test('migration recognizes case aliases of existing source on macOS', async t => {
  const { cwd, base } = await fixture();
  const source = join(base, 'ClaudeCase'); await mkdir(source);
  const alias = join(base, 'claudecase');
  const { realpath } = await import('node:fs/promises');
  try { if (await realpath(alias) !== await realpath(source)) return t.skip('Case-sensitive filesystem'); }
  catch (e) { if (e.code === 'ENOENT') return t.skip('Case-sensitive filesystem'); throw e; }
  await assert.rejects(migrate({ source, destination: alias, mapping: { slug: cwd }, apply: true }), /must not overlap/);
  await assert.rejects(migrate({ source, destination: join(alias, 'new', 'memory'), mapping: { slug: cwd }, apply: true }), /must not overlap/);
});

test('aborted operations never write', async () => {
  const { cwd, store } = await fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(store.write(cwd, topic(), controller.signal));
  assert.equal((await store.read(cwd, 'notes.md')).content, null);
});
