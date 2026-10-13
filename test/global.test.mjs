import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, canonical, parseScope } from '../store.mjs';
import { apply } from '../index.mjs';

async function fixture() {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-global-test-')));
  const cwd = join(base, 'repo'); await mkdir(join(cwd, '.git'), { recursive: true });
  const other = join(base, 'other'); await mkdir(join(other, '.git'), { recursive: true });
  return { base, cwd, other, store: new MemoryStore(join(base, 'memory')) };
}
const topic = (file = 'notes.md', content = '# Fact\n') => ({ file, content, summary: 'fact' });

test('scope parsing accepts only project and global', () => {
  assert.equal(parseScope(undefined), 'project');
  assert.equal(parseScope(''), 'project');
  assert.equal(parseScope('project'), 'project');
  assert.equal(parseScope('global'), 'global');
  assert.throws(() => parseScope('user'), /Scope must be/);
  assert.throws(() => parseScope('GLOBAL'), /Scope must be/);
});

test('global memory is shared across projects and never mixed with them', async () => {
  const { cwd, other, store } = await fixture();
  await store.write(null, topic('global-note.md', '# Global fact\n'), undefined, undefined, 'global');
  await store.write(cwd, topic('project-note.md', '# Project fact\n'));
  assert.deepEqual((await store.list(null, 'global')).files, ['MEMORY.md', 'global-note.md']);
  assert.deepEqual((await store.list(cwd)).files, ['MEMORY.md', 'project-note.md']);
  assert.equal((await store.read(other, 'global-note.md', 'global')).content, '# Global fact\n');
  assert.equal((await store.read(other, 'project-note.md')).content, null);
  assert.equal((await store.read(cwd, 'global-note.md')).content, null);
  assert.match((await store.read(null, 'MEMORY.md', 'global')).content, /global-note\.md/);
});

test('global memory lives in its own directory without a project identity', async () => {
  const { store } = await fixture();
  const result = await store.write(null, topic(), undefined, undefined, 'global');
  assert.equal(result.scope, 'global');
  assert.equal(result.cwd, null);
  assert.equal(result.directory, join(store.root, 'global'));
  assert.deepEqual(await readdir(result.directory), ['MEMORY.md', 'notes.md'].filter(Boolean).concat(['history']).sort());
  await assert.rejects(readFile(join(result.directory, 'project.json')), { code: 'ENOENT' });
});

test('revisions are scope-bound and project revisions cannot overwrite global topics', async () => {
  const { cwd, store } = await fixture();
  await store.write(cwd, topic('shared.md'));
  const projectRevision = (await store.read(cwd, 'shared.md')).revision;
  await store.write(null, topic('shared.md', '# Different global content\n'), undefined, undefined, 'global');
  const globalRevision = (await store.read(null, 'shared.md', 'global')).revision;
  assert.notEqual(projectRevision, globalRevision);
  await assert.rejects(
    store.write(null, { ...topic('shared.md', '# Overwrite\n'), expected_revision: projectRevision }, undefined, undefined, 'global'),
    /MEMORY_STALE_VERSION/
  );
  await assert.rejects(
    store.write(cwd, { ...topic('shared.md', '# Overwrite\n'), expected_revision: globalRevision }),
    /MEMORY_STALE_VERSION/
  );
  assert.equal((await store.read(null, 'shared.md', 'global')).content, '# Different global content\n');
});

test('project scope without a cwd fails closed; global scope needs none', async () => {
  const { store } = await fixture();
  await assert.rejects(store.read(null, 'MEMORY.md'), /requires a session cwd/);
  await assert.rejects(store.read(undefined, 'MEMORY.md', 'project'), /requires a session cwd/);
  assert.equal((await store.read(null, 'MEMORY.md', 'global')).content, null);
});

test('global index uses its own header and keeps the project index untouched', async () => {
  const { cwd, store } = await fixture();
  await store.write(cwd, topic());
  await store.write(null, topic('prefs.md', '# Prefers concise output\n'), undefined, undefined, 'global');
  assert.match((await store.read(cwd)).content, /^# Project memory/);
  assert.match((await store.read(null, 'MEMORY.md', 'global')).content, /^# Global memory/);
  assert.ok(!(await store.read(cwd)).content.includes('prefs.md'));
  assert.ok(!(await store.read(null, 'MEMORY.md', 'global')).content.includes('notes.md'));
});

test('context injects the project snapshot plus a bounded global snapshot', async () => {
  const { cwd, store } = await fixture();
  await store.write(cwd, topic('project-topic.md', '# Project fact\n'));
  for (let i = 0; i < 8; i++) await store.write(null, topic(`global-${i}.md`, `# Global ${i}\n`), undefined, undefined, 'global');
  const text = await store.context(cwd, { maxLines: 200, maxBytes: 20000 }, { maxLines: 3, maxBytes: 4096 });
  assert.match(text, /# Persistent project memory/);
  assert.match(text, /# Global memory \(shared across every project\)/);
  assert.match(text, /project-topic\.md/);
  assert.match(text, /Index truncated/);
  const globalPart = text.slice(text.indexOf('# Global memory'));
  // Index is clipped to 3 lines and unindexed topics are capped, so the block stays small.
  assert.ok(Buffer.byteLength(globalPart) < 2048, `global block too large: ${Buffer.byteLength(globalPart)}`);
  const listed = globalPart.match(/global-\d+\.md/g) ?? [];
  assert.ok(listed.length <= 12, `too many topic names in the global block: ${listed.length}`);
  assert.match(globalPart, /Index truncated/);
});

test('empty global memory adds no context block, project-only cwd still gets one', async () => {
  const { cwd, store } = await fixture();
  assert.match(await store.context(cwd), /# Persistent project memory/);
  assert.ok(!(await store.context(cwd)).includes('# Global memory'));
  await store.write(cwd, topic());
  assert.ok(!(await store.context(cwd)).includes('# Global memory'));
  await store.write(null, topic('prefs.md'), undefined, undefined, 'global');
  assert.match(await store.context(cwd), /# Global memory/);
  assert.match(await store.context(undefined, {}, {}), /# Global memory/);
});

test('global store rejects traversal, index aliases, symlinks and hardlinks', async () => {
  const { store, base } = await fixture();
  await assert.rejects(store.write(null, topic('../escape.md'), undefined, undefined, 'global'), /plain Markdown/);
  await assert.rejects(store.write(null, topic('memory.md'), undefined, undefined, 'global'), /maintained automatically/);
  const dir = store.global().dir; await mkdir(dir, { recursive: true });
  const outside = join(base, 'outside.md'); await writeFile(outside, 'private');
  await symlink(outside, join(dir, 'linked.md'));
  await assert.rejects(store.read(null, 'linked.md', 'global'), /Symlink/);
  const { link } = await import('node:fs/promises');
  await link(outside, join(dir, 'hard.md'));
  await assert.rejects(store.read(null, 'hard.md', 'global'), /Hard links/);
});

async function pluginFixture() {
  const { cwd, store } = await fixture(); const tools = new Map(); const handlers = new Map();
  let mode = 'workspace-write', planned = false;
  const agent = { id: 'a', session: { header: { cwd } }, ctx: { get: () => ({ get: () => ({ active: planned }) }) } };
  const ctx = { agents: { get: () => agent, list: () => [agent] },
    on: (name, handler) => handlers.set(name, handler), tools: { register: tool => tools.set(tool.name, tool) },
    sandboxPolicy: { resolve: () => ({ mode }) } };
  await apply(ctx, { root: store.root });
  const exec = { agent, signal: new AbortController().signal };
  return { cwd, store, tools, handlers, agent, exec, setPlan: value => planned = value };
}

test('tools expose scope and route writes to the right store', async () => {
  const { cwd, store, tools, exec } = await pluginFixture();
  assert.ok(tools.get('memory_write').parameters.properties.scope);
  assert.deepEqual(tools.get('memory_read').parameters.properties.scope.enum, ['project', 'global']);
  await tools.get('memory_write').execute({ ...topic('g.md', '# Global\n'), scope: 'global' }, exec);
  await tools.get('memory_write').execute({ ...topic('p.md', '# Project\n') }, exec);
  const globalList = await tools.get('memory_list').execute({ scope: 'global' }, exec);
  const projectList = await tools.get('memory_list').execute({}, exec);
  assert.deepEqual(globalList.files.filter(f => f.endsWith('.md')), ['MEMORY.md', 'g.md']);
  assert.deepEqual(projectList.files.filter(f => f.endsWith('.md')), ['MEMORY.md', 'p.md']);
  assert.equal((await tools.get('memory_read').execute({ file: 'g.md', scope: 'global' }, exec)).content, '# Global\n');
  assert.equal((await tools.get('memory_read').execute({ file: 'g.md' }, exec)).content, null);
  assert.equal((await store.read(cwd, 'p.md')).content, '# Project\n');
});

test('scope validation and plan mode reject global writes', async () => {
  const { tools, exec, setPlan } = await pluginFixture();
  await assert.rejects(tools.get('memory_write').execute({ ...topic(), scope: 'user' }, exec), /Scope must be/);
  await assert.rejects(tools.get('memory_read').execute({ scope: 'user' }, exec), /Scope must be/);
  setPlan(true);
  await assert.rejects(tools.get('memory_write').execute({ ...topic(), scope: 'global' }, exec), /plan mode/);
});

test('global tools work for an agent without a cwd while project tools refuse', async () => {
  const { store } = await fixture();
  const tools = new Map();
  const agent = { id: 'no-cwd', session: { header: {} }, ctx: { get: () => undefined } };
  const ctx = { agents: { get: () => agent, list: () => [agent] },
    on: () => {}, tools: { register: tool => tools.set(tool.name, tool) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } };
  await apply(ctx, { root: store.root });
  const exec = { agent, signal: new AbortController().signal };
  await assert.rejects(tools.get('memory_list').execute({}, exec), /requires a session cwd/);
  await assert.rejects(tools.get('memory_write').execute(topic(), exec), /requires a session cwd/);
  const listed = await tools.get('memory_list').execute({ scope: 'global' }, exec);
  assert.equal(listed.directory, store.global().dir);
  const written = await tools.get('memory_write').execute({ ...topic('no-cwd.md', '# Global\n'), scope: 'global' }, exec);
  assert.equal(written.saved, true);
  assert.equal((await store.read(null, 'no-cwd.md', 'global')).content, '# Global\n');
});
