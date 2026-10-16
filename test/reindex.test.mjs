import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, symlink, link, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { MemoryStore, canonical, digest, MAX_READ_BYTES } from '../store.mjs';
import { apply } from '../plugin.mjs';

const entry = { file: 'notes.md', summary: 'Reviewed fact' };
async function fixture() {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-reindex-')));
  const cwd = join(base, 'repo'), other = join(base, 'other');
  await mkdir(join(cwd, '.git'), { recursive: true }); await mkdir(join(other, '.git'), { recursive: true });
  const store = new MemoryStore(join(base, 'memory'));
  return { base, cwd, other, store };
}
async function argsFor(store, cwd, scope = 'project', extra = {}) {
  return { entries: [entry], reason: 'Explicit reviewed index reset', expected_revision: (await store.read(cwd, 'MEMORY.md', scope, extra.project)).revision, ...extra };
}
async function populated() {
  const f = await fixture();
  const saved = await f.store.write(f.cwd, { ...entry, content: '# Secret-free topic\r\n' });
  return { ...f, dir: saved.directory };
}

for (const scope of ['project', 'global']) test('reindex resets imported prose, exact journal and unchanged topics: ' + scope, async () => {
  const { store, cwd } = await fixture();
  const saved = await store.write(cwd, { ...entry, content: '# Body\r\n' }, undefined, undefined, scope);
  const before = '# Imported\r\nobsolete prose and [gone](gone.md)\r\n';
  await writeFile(join(saved.directory, 'MEMORY.md'), before);
  await writeFile(join(saved.directory, 'unindexed.md'), '# Unindexed\n');
  const topicStat = await lstat(join(saved.directory, entry.file));
  const args = await argsFor(store, cwd, scope, { entries: [{ file: 'unindexed.md', summary: 'Other' }, entry] });
  const result = await store.reindex(cwd, args, undefined, undefined, scope);
  assert.equal(result.reindexed, true); assert.equal(result.entries, 2);
  const next = '# ' + (scope === 'global' ? 'Global' : 'Project') + ' memory\n- [notes.md](<notes.md>): Reviewed fact\n- [unindexed.md](<unindexed.md>): Other\n';
  assert.equal((await store.read(cwd, 'MEMORY.md', scope)).content, next);
  assert.equal((await store.read(cwd, entry.file, scope)).content, '# Body\r\n');
  assert.equal((await lstat(join(saved.directory, entry.file))).ino, topicStat.ino);
  const [id, hash] = result.journal_id.split(':');
  const bytes = await readFile(join(saved.directory, 'history', id)); assert.equal(digest(bytes), hash);
  const journal = JSON.parse(bytes);
  assert.equal(journal.operation, 'reindex'); assert.equal(journal.file, 'MEMORY.md');
  assert.equal(journal.previousIndex, before); assert.equal(journal.nextIndex, next);
  assert.equal(journal.previousRevision, args.expected_revision); assert.equal(journal.nextRevision, result.revision);
  assert.equal(journal.scope, scope); assert.equal(journal.cwd, scope === 'global' ? null : cwd);
  assert.equal(journal.reason, args.reason); assert.equal(journal.catalog.length, 2);
  assert.ok(!('previousContent' in journal)); assert.ok(!('nextContent' in journal));
  assert.match(journal.commit, /intent only/); assert.match(journal.rollback, /previousIndex/);
  assert.equal((await lstat(join(saved.directory, 'history', id))).mode & 0o777, 0o600);
  await assert.rejects(store.reindex(cwd, args, undefined, undefined, scope), /STALE_VERSION/);
});

test('reindex handles missing index, empty catalog, and omitted unindexed topics', async () => {
  const { store, cwd, dir } = await populated();
  await unlink(join(dir, 'MEMORY.md'));
  const args = await argsFor(store, cwd);
  await assert.rejects(store.reindex(cwd, { ...args, entries: [] }), /exact current topic catalog/);
  const result = await store.reindex(cwd, args);
  const journal = JSON.parse(await readFile(join(dir, 'history', result.journal_id.split(':')[0])));
  assert.equal(journal.previousIndex, null);
  await unlink(join(dir, entry.file));
  await store.reindex(cwd, await argsFor(store, cwd, 'project', { entries: [] }));
  assert.equal((await store.read(cwd)).content, '# Project memory\n');
  const fresh = await fixture();
  await fresh.store.reindex(fresh.cwd, await argsFor(fresh.store, fresh.cwd, 'project', { entries: [] }));
  assert.equal((await fresh.store.read(fresh.cwd)).content, '# Project memory\n');
});

test('reindex rejects missing/extra/duplicate entries, aliases, unsafe summaries and arbitrary content', async () => {
  const { store, cwd, dir } = await populated();
  const args = await argsFor(store, cwd), before = await readFile(join(dir, 'MEMORY.md'), 'utf8');
  const badEntries = [undefined, null, {}, [], [entry, entry], [entry, { ...entry, file: 'NOTES.md' }], [{ ...entry, file: 'NOTES.md' }], [entry, { ...entry, file: 'missing.md' }], [{ ...entry, file: './notes.md' }], [{ ...entry, file: '../notes.md' }], [{ ...entry, file: 'MEMORY.md' }], [{ ...entry, content: 'raw' }], [null]];
  for (const entries of badEntries) await assert.rejects(store.reindex(cwd, { ...args, entries }));
  for (const summary of ['', ' ', 3, '\n', 'x\t', 'x\0', '\u007f', '\u2028', '\ud800', 'x'.repeat(301)])
    await assert.rejects(store.reindex(cwd, { ...args, entries: [{ ...entry, summary }] }), /Summary/);
  for (const reason of ['', undefined, '\n', '\0']) await assert.rejects(store.reindex(cwd, { ...args, reason }), /Reason/);
  for (const expected_revision of [undefined, null, '', 1]) await assert.rejects(store.reindex(cwd, { ...args, expected_revision }), /READ_REQUIRED/);
  for (const key of ['content', 'file', 'nextIndex']) await assert.rejects(store.reindex(cwd, { ...args, [key]: 'raw' }), /not arbitrary/);
  assert.equal(await readFile(join(dir, 'MEMORY.md'), 'utf8'), before);
  assert.equal((await readdir(join(dir, 'history'))).length, 1);
});

test('reindex revisions bind index, scope, project and filename; unknown scopes fail closed', async () => {
  const { store, cwd, other, dir } = await populated();
  await store.write(other, { ...entry, content: '# Other' });
  await store.write(null, { ...entry, content: '# Global' }, undefined, undefined, 'global');
  const args = await argsFor(store, cwd);
  await assert.rejects(store.reindex(other, args), /STALE_VERSION/);
  await assert.rejects(store.reindex(null, args, undefined, undefined, 'global'), /STALE_VERSION/);
  await assert.rejects(store.reindex(cwd, { ...args, expected_revision: (await store.read(cwd, entry.file)).revision }), /STALE_VERSION/);
  for (const scope of ['typo', {}, 1]) await assert.rejects(store.reindex(cwd, args, undefined, undefined, scope), /Scope/);
  await assert.rejects(store.reindex(cwd, { ...args, project: other }, undefined, undefined, 'global'), /global scope/);
  await writeFile(join(dir, 'MEMORY.md'), '# changed\n');
  await assert.rejects(store.reindex(cwd, args), /STALE_VERSION/);
});

for (const kind of ['symlink', 'hardlink', 'directory', 'oversize', 'invalidUtf8', 'caseAlias', 'unsupported']) test('reindex refuses unsafe catalog ' + kind, async () => {
  const { store, cwd, dir, base } = await populated(); const args = await argsFor(store, cwd);
  const path = join(dir, entry.file);
  if (kind === 'symlink' || kind === 'hardlink') {
    const outside = join(base, 'outside'); await writeFile(outside, '# outside'); await unlink(path);
    await (kind === 'symlink' ? symlink : link)(outside, path);
  } else if (kind === 'directory') { await unlink(path); await mkdir(path); }
  else if (kind === 'oversize') await writeFile(path, Buffer.alloc(MAX_READ_BYTES + 1));
  else if (kind === 'invalidUtf8') await writeFile(path, Buffer.from([255]));
  else await writeFile(join(dir, kind === 'caseAlias' ? 'NOTES.md' : 'bad name.md'), '# Bad');
  await assert.rejects(store.reindex(cwd, args), /Symlink|Hard links|regular file|exceeds|UTF-8|aliases|filename/);
});

test('reindex escapes summary Markdown, refuses linked index and respects exclusive lock', async () => {
  const { store, cwd, dir, base } = await populated();
  await store.reindex(cwd, await argsFor(store, cwd, 'project', { entries: [{ ...entry, summary: '[bad](missing.md) <x> \u0060code\u0060' }] }));
  const next = (await store.read(cwd)).content;
  assert.ok(next.includes('&#91;bad&#93;&#40;missing.md&#41;')); assert.ok(!next.includes('[bad](missing.md)'));
  await writeFile(join(dir, '.write-lock'), '{}');
  await assert.rejects(store.reindex(cwd, await argsFor(store, cwd)), /MEMORY_BUSY/);
  await unlink(join(dir, '.write-lock'));
  const args = await argsFor(store, cwd), outside = join(base, 'index');
  await writeFile(outside, next); await unlink(join(dir, 'MEMORY.md')); await symlink(outside, join(dir, 'MEMORY.md'));
  await assert.rejects(store.reindex(cwd, args), /Symlink/);
});

async function pluginFixture() {
  const f = await populated(), tools = new Map(); let mode = 'workspace-write', active = false, pending = false;
  const agent = { id: 'a', session: { header: { cwd: f.cwd } }, ctx: { get: () => ({ get: () => ({ active, pending }) }) } };
  const controller = new AbortController();
  apply({ agents: { get: () => agent, list: () => [agent] }, on: () => {}, tools: { register: t => tools.set(t.name, t) }, sandboxPolicy: { resolve: () => ({ mode }) } }, { root: f.store.root }, { MemoryStore });
  return { ...f, tools, agent, controller, exec: { agent, signal: controller.signal }, policy: (m, a = false, p = false) => { mode = m; active = a; pending = p; } };
}

test('reindex shares sandbox, plan, cancellation and exact cross-project authority', async () => {
  const f = await pluginFixture(), tool = f.tools.get('memory_reindex');
  assert.deepEqual(tool.parameters.required, ['entries', 'expected_revision', 'reason']);
  assert.equal(tool.parameters.additionalProperties, false);
  const args = await argsFor(f.store, f.cwd);
  for (const [mode, active, pending, error] of [['read-only', false, false, /read-only/], ['unknown', false, false, /Unknown/], ['workspace-write', true, false, /plan mode/], ['danger-full-access', false, true, /plan mode/]]) {
    f.policy(mode, active, pending); await assert.rejects(tool.execute(args, f.exec), error);
  }
  f.policy('workspace-write'); await tool.execute({ ...args, project: f.cwd }, f.exec);
  await f.store.write(f.other, { ...entry, content: '# Other' });
  const cross = await argsFor(f.store, f.cwd, 'project', { project: f.other });
  await assert.rejects(tool.execute(cross, f.exec), /danger-full-access/);
  f.agent.session.header.cwd = undefined;
  await assert.rejects(tool.execute(cross, f.exec), /danger-full-access/);
  f.policy('danger-full-access'); await tool.execute(cross, f.exec);
  f.policy('workspace-write');
  await f.store.write(null, { ...entry, content: '# Global' }, undefined, undefined, 'global');
  await tool.execute({ ...await argsFor(f.store, null, 'global'), scope: 'global' }, f.exec);
  f.controller.abort(); await assert.rejects(tool.execute(await argsFor(f.store, f.other), f.exec), /abort/i);
});

const storeURL = JSON.stringify(new URL('../store.mjs', import.meta.url).href);
const pluginURL = JSON.stringify(new URL('../plugin.mjs', import.meta.url).href);
for (const race of ['topic', 'add', 'remove', 'index', 'policy', 'plan', 'pending', 'cancel', 'session', 'cwd']) test('reindex rechecks after journal before commit: ' + race, async () => {
  const { store, cwd, dir } = await populated(); const args = await argsFor(store, cwd);
  const before = await readFile(join(dir, 'MEMORY.md'), 'utf8');
  const script =
    "import fs from 'node:fs/promises'; import assert from 'node:assert/strict'; import {syncBuiltinESMExports} from 'node:module';" +
    "let mode='workspace-write',active=false,pending=false;const controller=new AbortController();" +
    'const agent={id:"a",session:{header:{cwd:' + JSON.stringify(cwd) + '}},ctx:{get:()=>({get:()=>({active,pending})})}};' +
    'const original=fs.rename;fs.rename=async(a,b)=>{await original(a,b);if(b.includes("/history/")){' +
    ({ topic: 'await fs.writeFile(' + JSON.stringify(join(dir, entry.file)) + ',"changed");', add: 'await fs.writeFile(' + JSON.stringify(join(dir, 'new.md')) + ',"new");', remove: 'await fs.unlink(' + JSON.stringify(join(dir, entry.file)) + ');', index: 'await fs.writeFile(' + JSON.stringify(join(dir, 'MEMORY.md')) + ',"external index");', policy: 'mode="read-only";', plan: 'active=true;', pending: 'pending=true;', cancel: 'controller.abort();', session: 'agent.session={header:{cwd:' + JSON.stringify(cwd) + '}};', cwd: 'agent.session.header.cwd="/changed";' })[race] +
    '}};syncBuiltinESMExports();const {MemoryStore}=await import(' + storeURL + ');const {apply}=await import(' + pluginURL + ');' +
    'const tools=new Map();apply({agents:{get:()=>agent,list:()=>[agent]},on:()=>{},tools:{register:t=>tools.set(t.name,t)},sandboxPolicy:{resolve:()=>({mode})}},{root:' + JSON.stringify(store.root) + '},{MemoryStore});' +
    'await assert.rejects(tools.get("memory_reindex").execute(' + JSON.stringify(args) + ',{agent,signal:controller.signal}));';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await readFile(join(dir, 'MEMORY.md'), 'utf8'), race === 'index' ? 'external index' : before);
  assert.equal((await readdir(join(dir, 'history'))).length, 2); // unused intent retained
  await assert.rejects(lstat(join(dir, '.write-lock')), { code: 'ENOENT' });
});

// Version-2 journals generated by 1.2.0 retained human-label lines.
test('restore accepts unchanged legacy 1.2.0 forget archives with human-label references', async () => {
  const { store, cwd, dir } = await populated();
  const before = '# Imported\n- [Human title](notes.md): old\n';
  await writeFile(join(dir, 'MEMORY.md'), before);
  const old = await store.read(cwd, entry.file);
  await unlink(join(dir, entry.file));
  const missing = await store.read(cwd, entry.file);
  const name = '1792150000000-00000000-0000-4000-8000-000000000000.json';
  const bytes = JSON.stringify({ version: 2, operation: 'forget', scope: 'project', cwd, file: entry.file,
    previousContent: old.content, previousIndex: before, nextContent: null, nextIndex: before,
    previousRevision: old.revision, nextRevision: missing.revision });
  await writeFile(join(dir, 'history', name), bytes);
  const restored = await store.restore(cwd, { file: entry.file, reason: 'Undo 1.2.0 archive', expected_revision: missing.revision, archive_id: name + ':' + digest(bytes) });
  assert.equal(restored.restored, true); assert.equal((await store.read(cwd)).content, before);
  assert.equal((await store.read(cwd, entry.file)).content, old.content);
});

for (const race of ['topic-during-read', 'catalog-during-read', 'index-during-catalog', 'failed-index-rename']) test('reindex handles preparation boundary: ' + race, async () => {
  const { store, cwd, dir } = await populated(), args = await argsFor(store, cwd);
  const before = await readFile(join(dir, 'MEMORY.md'), 'utf8');
  const script = "import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {syncBuiltinESMExports} from 'node:module';let journal=false,changed=false;" +
    'const rename=fs.rename;fs.rename=async(a,b)=>{if(journal&&b.endsWith("/MEMORY.md")&&' + JSON.stringify(race) + '==="failed-index-rename")throw new Error("injected index failure");await rename(a,b);if(b.includes("/history/"))journal=true;};' +
    'const open=fs.open;fs.open=async(...args)=>{const h=await open(...args);if(journal&&!changed&&args[0].endsWith("/notes.md")){' +
    'const close=h.close.bind(h);h.close=async()=>{await close();if(changed)return;changed=true;' +
    ({ 'topic-during-read': 'await fs.writeFile(' + JSON.stringify(join(dir, entry.file)) + ',"raced topic");', 'catalog-during-read': 'await fs.writeFile(' + JSON.stringify(join(dir, 'added.md')) + ',"raced catalog");', 'index-during-catalog': 'await fs.writeFile(' + JSON.stringify(join(dir, 'MEMORY.md')) + ',"raced index");', 'failed-index-rename': '' })[race] +
    '};}return h;};syncBuiltinESMExports();const {MemoryStore}=await import(' + storeURL + ');' +
    'const store=new MemoryStore(' + JSON.stringify(store.root) + ');await assert.rejects(store.reindex(' + JSON.stringify(cwd) + ',' + JSON.stringify(args) + '));';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await readFile(join(dir, 'MEMORY.md'), 'utf8'), race === 'index-during-catalog' ? 'raced index' : before);
  assert.equal((await readdir(join(dir, 'history'))).length, 2);
  await assert.rejects(lstat(join(dir, '.write-lock')), { code: 'ENOENT' });
});

test('reindex rejects FIFO topics without hanging and hardlinked indexes', async () => {
  const { store, cwd, dir, base } = await populated(); const args = await argsFor(store, cwd);
  await unlink(join(dir, entry.file));
  const fifo = spawnSync('mkfifo', [join(dir, entry.file)], { encoding: 'utf8' }); assert.equal(fifo.status, 0, fifo.stderr);
  await assert.rejects(store.reindex(cwd, args), /regular file/);
  await unlink(join(dir, entry.file)); await writeFile(join(dir, entry.file), '# Topic');
  await link(join(dir, 'MEMORY.md'), join(base, 'index-hardlink'));
  await assert.rejects(store.reindex(cwd, args), /Hard links/);
});

test('reindex journal cannot authorize memory_restore', async () => {
  const { store, cwd } = await populated();
  const reset = await store.reindex(cwd, await argsFor(store, cwd));
  const old = await store.read(cwd, entry.file);
  const archive = await store.forget(cwd, { file: entry.file, expected_revision: old.revision, reason: 'Test archive' });
  await assert.rejects(store.restore(cwd, { file: entry.file, expected_revision: archive.revision, reason: 'Wrong journal', archive_id: reset.journal_id }), /scope, project and topic/);
});

test('reindex selectors reject unknown projects, path/symlink aliases and global selectors', async () => {
  const { store, cwd, other, base } = await populated();
  await store.write(other, { ...entry, content: '# Other' });
  const args = await argsFor(store, cwd), alias = join(base, 'alias'); await symlink(other, alias);
  for (const project of [null, '', 'other', other + '/', other + '/.', alias, join(other, 'child'), join(base, 'unknown'), store.root])
    await assert.rejects(store.reindex(cwd, { ...args, project }), /selector|registered|alias/);
  await assert.rejects(store.reindex(cwd, { ...args, project: other }, undefined, undefined, 'global'), /global scope/);
});

test('reindex catches same-byte topic replacement by identity and index case aliases', async () => {
  const { store, cwd, dir } = await populated(), args = await argsFor(store, cwd);
  const script = "import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {syncBuiltinESMExports} from 'node:module';const original=fs.rename;" +
    'fs.rename=async(a,b)=>{await original(a,b);if(b.includes("/history/")){const p=' + JSON.stringify(join(dir, entry.file)) + ';const bytes=await fs.readFile(p);await fs.rename(p,p+".old");await fs.writeFile(p,bytes);}};syncBuiltinESMExports();' +
    'const {MemoryStore}=await import(' + storeURL + ');await assert.rejects(new MemoryStore(' + JSON.stringify(store.root) + ').reindex(' + JSON.stringify(cwd) + ',' + JSON.stringify(args) + '),/STALE_VERSION/);';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr);
  await writeFile(join(dir, 'memory.md'), '# Alias');
  await assert.rejects(store.reindex(cwd, args), /including case|aliases/);
});
