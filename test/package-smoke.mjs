// Run manually after installing the packed artifact in an isolated directory.
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const packageDir = process.argv[2];
assert.ok(packageDir, 'Pass the installed package directory');
const { apply } = await import(pathToFileURL(join(packageDir, 'index.mjs')));
const tools = new Map();
const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-packed-smoke-')));
const cwd = join(base, 'project'); await mkdir(cwd);
const root = join(base, 'memory');
const agent = { id: 'smoke', session: { header: { cwd } }, ctx: { get: () => undefined } };
await apply({ agents: { get: () => agent, list: () => [agent] }, on: () => {},
  tools: { register: tool => tools.set(tool.name, tool) },
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }, { root });
const exec = { agent, signal: new AbortController().signal };
for (const scope of ['project', 'global']) {
  const saved = await tools.get('memory_write').execute({ scope, file: 'smoke.md', content: '# Smoke\n', summary: 'Installation check' }, exec);
  assert.equal(saved.saved, true);
  assert.ok(saved.directory.startsWith(root + '/'));
  assert.equal((await tools.get('memory_read').execute({ scope, file: 'smoke.md' }, exec)).content, '# Smoke\n');
  const index = await tools.get('memory_read').execute({ scope }, exec);
  assert.equal((await tools.get('memory_reindex').execute({ scope, expected_revision: index.revision, entries: [{ file: 'smoke.md', summary: 'Installation check' }], reason: 'Smoke canonical index reset' }, exec)).reindexed, true);
}
const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
assert.equal(pkg.version, '1.2.2');
assert.deepEqual(pkg.engines, { node: '>=22', dsh: '^0.2.0-rc.2' });
assert.deepEqual([...tools.keys()].sort(), ['memory_forget', 'memory_list', 'memory_projects', 'memory_read', 'memory_reindex', 'memory_restore', 'memory_write']);
for (const scope of ['project', 'global']) {
  const old = await tools.get('memory_read').execute({ scope, file: 'smoke.md' }, exec);
  const archived = await tools.get('memory_forget').execute({ scope, file: 'smoke.md', expected_revision: old.revision, reason: 'Smoke cleanup' }, exec);
  assert.equal((await tools.get('memory_read').execute({ scope, file: 'smoke.md' }, exec)).content, null);
  await tools.get('memory_restore').execute({ scope, file: 'smoke.md', expected_revision: archived.revision, archive_id: archived.archive_id, reason: 'Smoke restore' }, exec);
  assert.equal((await tools.get('memory_read').execute({ scope, file: 'smoke.md' }, exec)).content, '# Smoke\n');
}
console.log('Packed installation smoke passed in an explicit disposable root, both scopes and archival rollback');
