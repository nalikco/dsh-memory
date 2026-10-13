// Run manually after installing the packed artifact in an isolated directory.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const packageDir = process.argv[2];
assert.ok(packageDir, 'Pass the installed package directory');
const { apply } = await import(pathToFileURL(join(packageDir, 'index.mjs')));
const tools = new Map();
const cwd = '/tmp/smoke-project'; await mkdir(cwd, { recursive: true });
const agent = { id: 'smoke', session: { header: { cwd } }, ctx: { get: () => undefined } };
await apply({ agents: { get: () => agent, list: () => [agent] }, on: () => {},
  tools: { register: tool => tools.set(tool.name, tool) },
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } });
const exec = { agent, signal: new AbortController().signal };
for (const scope of ['project', 'global']) {
  const saved = await tools.get('memory_write').execute({ scope, file: 'smoke.md', content: '# Smoke\n', summary: 'Installation check' }, exec);
  assert.equal(saved.saved, true);
  assert.ok(saved.directory.startsWith(join(homedir(), '.dsh', 'memory')));
  assert.equal((await tools.get('memory_read').execute({ scope, file: 'smoke.md' }, exec)).content, '# Smoke\n');
}
const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
assert.equal(pkg.version, '1.1.1');
console.log('Packed installation smoke passed with a fresh HOME and both scopes');
