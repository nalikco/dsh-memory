import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, link, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { MemoryStore, canonical, digest, projectKey } from '../store.mjs';
import { apply } from '../plugin.mjs';

const topic = { file: 'notes.md', content: '# Fact\r\n', summary: 'fact' };
async function fixture() {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-maintenance-')));
  const cwd = join(base, 'repo'), other = join(base, 'other');
  for (const path of [cwd, other]) await mkdir(join(path, '.git'), { recursive: true });
  return { base, cwd, other, store: new MemoryStore(join(base, 'memory')) };
}
async function forget(store, cwd, extra = {}, scope = 'project') {
  const old = await store.read(cwd, topic.file, scope, extra.project);
  return store.forget(cwd, { file: topic.file, reason: 'Obsolete fact', expected_revision: old.revision, ...extra }, undefined, undefined, scope);
}
async function restore(store, cwd, archive, extra = {}, scope = 'project') {
  const old = await store.read(cwd, topic.file, scope, extra.project);
  return store.restore(cwd, { file: topic.file, reason: 'Undo cleanup', archive_id: archive.archive_id, expected_revision: old.revision, ...extra }, undefined, undefined, scope);
}
async function pluginFixture() {
  const f = await fixture(); const tools = new Map();
  let mode = 'workspace-write', active = false, pending = false;
  const agent = { id: 'a', session: { header: { cwd: f.cwd } }, ctx: { get: () => ({ get: () => ({ active, pending }) }) } };
  apply({ agents: { get: () => agent, list: () => [agent] }, on: () => {}, tools: { register: t => tools.set(t.name, t) }, sandboxPolicy: { resolve: () => ({ mode }) } }, { root: f.store.root }, { MemoryStore });
  return { ...f, tools, agent, exec: { agent, signal: new AbortController().signal },
    policy: (m, a = false, p = false) => { mode = m; active = a; pending = p; } };
}
const child = script => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const storeURL = JSON.stringify(new URL('../store.mjs', import.meta.url).href);

test('project discovery is read-only and selectors resolve only exact registered identities', async () => {
  const { store, cwd, other, base } = await fixture();
  assert.deepEqual(await store.projects(), []);
  await assert.rejects(readdir(store.root), { code: 'ENOENT' });
  await store.write(cwd, topic); await store.write(other, topic);
  assert.deepEqual((await store.projects()).map(p => p.cwd), [other, cwd]);
  assert.equal((await store.read(cwd, topic.file, 'project', other)).cwd, other);
  const alias = join(base, 'alias'); await symlink(other, alias);
  for (const project of [null, '', 'other', alias, other + '/', other + '/.', other + '/../other', join(other, 'child'), store.root, (await store.locate(other)).dir, join(base, 'unknown')]) {
    await assert.rejects(store.read(cwd, topic.file, 'project', project), /selector|registered|alias/);
    await assert.rejects(store.list(cwd, 'project', project));
    await assert.rejects(store.write(cwd, { ...topic, project }));
  }
  await assert.rejects(store.read(cwd, topic.file, 'global', other), /global scope/);
  await assert.rejects(store.write(cwd, { ...topic, project: other }, undefined, undefined, 'global'), /global scope/);
});

test('forget archives exact bytes, removes only exact standalone index entries, restore is byte exact', async () => {
  const { store, cwd } = await fixture(); const result = await store.write(cwd, topic);
  const removed = ['- [notes.md](<notes.md>): fact\r\n', '* [notes.md](./notes.md): legacy\n'];
  const preserved = ['# Memory\r\n', '- [longnotes.md](<longnotes.md>): unrelated\r\n', '- [notes.md](<notes.md>): see [other](other.md)\n', 'Prose [notes.md](notes.md)\n', '- [notesXmd](notesXmd): regex trap'];
  const before = preserved[0] + removed.join('') + preserved.slice(1).join('');
  await writeFile(join(result.directory, 'MEMORY.md'), before);
  const old = await store.read(cwd, topic.file); const archive = await forget(store, cwd);
  assert.equal(archive.forgotten, true); assert.equal((await store.read(cwd, topic.file)).content, null);
  assert.equal((await store.read(cwd)).content, preserved.join(''));
  assert.ok(!(await store.list(cwd)).files.includes(topic.file));
  const [id, hash] = archive.archive_id.split(':');
  const bytes = await readFile(join(result.directory, 'history', id)); assert.equal(digest(bytes), hash);
  const journal = JSON.parse(bytes); assert.equal(journal.operation, 'forget'); assert.equal(journal.reason, 'Obsolete fact');
  assert.equal(journal.cwd, cwd); assert.equal(journal.scope, 'project'); assert.equal(journal.previousContent, topic.content);
  assert.equal(journal.previousIndex, before); assert.equal(journal.nextContent, null); assert.equal(journal.nextIndex, preserved.join(''));
  assert.equal(journal.previousRevision, old.revision); assert.equal(journal.nextRevision, archive.revision);
  assert.match(journal.rollback, /memory_restore/); assert.match(journal.commit, /intent only/);
  assert.equal((await lstat(join(result.directory, 'history', id))).mode & 0o777, 0o600);
  const restored = await restore(store, cwd, archive); assert.equal(restored.restored, true);
  assert.equal((await store.read(cwd, topic.file)).content, topic.content); assert.equal((await store.read(cwd)).content, before);
});

test('forget requires revision and valid reason before side effects; missing forget creates nothing', async () => {
  const { store, cwd } = await fixture();
  for (const reason of [undefined, null, 12, '', ' ', 'x\nreason', 'x\rreason', 'x\t', 'x\0', '\u007f', '\u2028', '\u2029', '\ud800', 'x'.repeat(301)])
    await assert.rejects(store.forget(cwd, { file: topic.file, reason, expected_revision: 'a' }), /Reason/);
  for (const expected_revision of [undefined, null, '', 123])
    await assert.rejects(store.forget(cwd, { file: topic.file, reason: 'cleanup', expected_revision }), /READ_REQUIRED/);
  await assert.rejects(forget(store, cwd), /NOT_FOUND/);
  await assert.rejects(readdir(store.root), { code: 'ENOENT' });
  await store.write(cwd, topic); const count = (await readdir(join((await store.locate(cwd)).dir, 'history'))).length;
  for (const file of ['MEMORY.md', 'memory.md', '../notes.md'])
    await assert.rejects(store.forget(cwd, { file, reason: 'cleanup', expected_revision: 'a' }));
  assert.equal((await readdir(join((await store.locate(cwd)).dir, 'history'))).length, count);
});

test('forget rejects stale topic/index revisions and wrong scope/project revisions', async () => {
  const { store, cwd, other } = await fixture();
  await store.write(cwd, topic); await store.write(other, topic); await store.write(null, topic, undefined, undefined, 'global');
  const old = await store.read(cwd, topic.file); await store.write(cwd, { ...topic, file: 'other.md' });
  await assert.rejects(forget(store, cwd, { expected_revision: old.revision }), /STALE_VERSION/);
  const fresh = await store.read(cwd, topic.file);
  for (const [target, scope] of [[other, 'project'], [null, 'global']])
    await assert.rejects(forget(store, target, { expected_revision: fresh.revision }, scope), /STALE_VERSION/);
  const changed = await store.write(cwd, { ...topic, content: '# Changed', expected_revision: fresh.revision });
  await assert.rejects(forget(store, cwd, { expected_revision: fresh.revision }), /STALE_VERSION/);
  assert.ok(changed.saved); assert.notEqual((await store.read(cwd, topic.file)).content, null);
});

test('restore refuses changed index, recreated topic, stale revision and wrong archive identity', async () => {
  const { store, cwd, other } = await fixture(); await store.write(cwd, topic); await store.write(other, topic);
  const archived = await forget(store, cwd);
  await assert.rejects(restore(store, cwd, archived, { expected_revision: 'stale' }), /STALE_VERSION/);
  await store.write(cwd, { ...topic, file: 'other.md' });
  await assert.rejects(restore(store, cwd, archived), /exact post-forget/);
  await store.write(cwd, topic); await assert.rejects(restore(store, cwd, archived), /exact post-forget/);
  const otherArchive = await forget(store, other);
  const dir = (await store.locate(other)).dir; const id = archived.archive_id.split(':')[0];
  await writeFile(join(dir, 'history', id), await readFile(join((await store.locate(cwd)).dir, 'history', id)));
  await assert.rejects(restore(store, other, archived), /scope, project and topic/);
  const archivePath = join(dir, 'history', otherArchive.archive_id.split(':')[0]);
  await writeFile(archivePath, '{}'); await assert.rejects(restore(store, other, otherArchive), /integrity/);
});

test('restore rejects arbitrary history paths and non-forget journals', async () => {
  const { store, cwd } = await fixture(); const written = await store.write(cwd, topic); const archive = await forget(store, cwd);
  for (const archive_id of ['../history/x.json', '/tmp/x.json', archive.archive_id + '/x', '', null])
    await assert.rejects(restore(store, cwd, archive, { archive_id }), /Invalid archive/);
  await assert.rejects(restore(store, cwd, { archive_id: written.journal_id }), /scope, project and topic/);
});

test('global forget/restore and unindexed null-index recovery preserve existing scope semantics', async () => {
  const { store, cwd } = await fixture(); await store.write(null, topic, undefined, undefined, 'global');
  const archive = await forget(store, null, {}, 'global'); await restore(store, null, archive, {}, 'global');
  assert.equal((await store.read(null, topic.file, 'global')).content, topic.content);
  await store.write(cwd, topic); const dir = (await store.locate(cwd)).dir; await unlink(join(dir, 'MEMORY.md'));
  const noIndex = await forget(store, cwd); assert.equal((await store.read(cwd)).content, null);
  await restore(store, cwd, noIndex); assert.equal((await store.read(cwd)).content, null);
  assert.equal((await store.read(cwd, topic.file)).content, topic.content);
});

for (const kind of ['symlink', 'hardlink']) test(kind + ' topic, index, metadata and archive are refused', async () => {
  for (const file of [topic.file, 'MEMORY.md', 'project.json', 'archive']) {
    const { store, cwd, base } = await fixture(); await store.write(cwd, topic);
    const dir = (await store.locate(cwd)).dir;
    let archive, target;
    if (file === 'archive') { archive = await forget(store, cwd); target = join(dir, 'history', archive.archive_id.split(':')[0]); }
    else target = join(dir, file);
    const outside = join(base, 'outside'); await writeFile(outside, await readFile(target)); await unlink(target);
    await (kind === 'symlink' ? symlink : link)(outside, target);
    if (archive) await assert.rejects(restore(store, cwd, archive), /Symlink|Hard links/);
    else await assert.rejects(forget(store, cwd), /Symlink|Hard links/);
    assert.ok((await readFile(outside)).length);
  }
});

test('plugin discovery and cross-project reads work under read-only, writes require full access', async () => {
  const f = await pluginFixture(); await f.store.write(f.cwd, topic); await f.store.write(f.other, topic);
  const call = (name, args) => f.tools.get(name).execute(args, f.exec);
  f.policy('read-only'); assert.equal((await call('memory_projects', {})).projects.length, 2);
  assert.equal((await call('memory_read', { file: topic.file, project: f.other })).cwd, f.other);
  assert.ok((await call('memory_list', { project: f.other })).files.includes(topic.file));
  const old = await f.store.read(f.other, topic.file);
  const args = { file: topic.file, reason: 'cleanup', expected_revision: old.revision, project: f.other };
  f.policy('workspace-write'); await assert.rejects(call('memory_forget', args), /danger-full-access/);
  await assert.rejects(call('memory_write', { ...topic, project: f.other, expected_revision: old.revision }), /danger-full-access/);
  f.policy('danger-full-access'); const archive = await call('memory_forget', args);
  f.policy('workspace-write'); await assert.rejects(call('memory_restore', { ...args, archive_id: archive.archive_id, expected_revision: archive.revision }), /danger-full-access/);
  f.policy('danger-full-access'); assert.equal((await call('memory_restore', { ...args, archive_id: archive.archive_id, expected_revision: archive.revision })).restored, true);
  // Current exact selector and global writes still work in workspace-write.
  f.policy('workspace-write'); assert.equal((await call('memory_write', { ...topic, file: 'new.md', project: f.cwd })).saved, true);
  assert.equal((await call('memory_write', { ...topic, scope: 'global' })).saved, true);
});

test('maintenance tools fail closed for read-only, unknown policy, plan and cancellation', async () => {
  const f = await pluginFixture(); await f.store.write(f.cwd, topic);
  const old = await f.store.read(f.cwd, topic.file); const args = { file: topic.file, reason: 'cleanup', expected_revision: old.revision };
  for (const [mode, active, pending, message] of [['read-only', false, false, /read-only/], ['unknown', false, false, /Unknown/], ['workspace-write', true, false, /plan mode/], ['danger-full-access', false, true, /plan mode/]]) {
    f.policy(mode, active, pending); await assert.rejects(f.tools.get('memory_forget').execute(args, f.exec), message);
  }
  f.policy('workspace-write'); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tools.get('memory_forget').execute(args, { ...f.exec, signal: controller.signal }), /abort/i);
  const archive = await f.tools.get('memory_forget').execute(args, f.exec);
  const restoreArgs = { ...args, archive_id: archive.archive_id, expected_revision: archive.revision };
  for (const [mode, active, pending, message] of [['read-only', false, false, /read-only/], ['unknown', false, false, /Unknown/], ['workspace-write', true, false, /plan mode/], ['danger-full-access', false, true, /plan mode/]]) {
    f.policy(mode, active, pending); await assert.rejects(f.tools.get('memory_restore').execute(restoreArgs, f.exec), message);
  }
  f.policy('danger-full-access'); await assert.rejects(f.tools.get('memory_restore').execute(restoreArgs, { ...f.exec, signal: controller.signal }), /abort/i);
});

test('cross-project selector without session cwd is never workspace-write authority', async () => {
  const f = await pluginFixture(); await f.store.write(f.other, topic); f.agent.session.header.cwd = undefined;
  await assert.rejects(f.tools.get('memory_write').execute({ ...topic, file: 'new.md', project: f.other }, f.exec), /danger-full-access/);
  assert.equal((await f.tools.get('memory_read').execute({ file: topic.file, project: f.other }, f.exec)).cwd, f.other);
});

for (const operation of ['forget', 'restore']) for (const revoke of ['policy', 'cancel', 'index']) test(operation + ' rechecks ' + revoke + ' after journal and before commit', async () => {
  const { store, cwd } = await fixture(); await store.write(cwd, topic);
  const archive = operation === 'restore' ? await forget(store, cwd) : null;
  const old = await store.read(cwd, topic.file); const dir = old.directory;
  const args = { file: topic.file, reason: 'cleanup', expected_revision: old.revision, ...(archive ? { archive_id: archive.archive_id } : {}) };
  child(
    "import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';" +
    "const controller=new AbortController();let allowed=true;const original=fs.rename;" +
    "fs.rename=async(from,to)=>{const r=await original(from,to);if(String(to).includes('/history/')){" +
    (revoke === 'policy' ? "allowed=false;" : revoke === 'cancel' ? "controller.abort();" : 'await fs.writeFile(' + JSON.stringify(join(dir, 'MEMORY.md')) + ',' + JSON.stringify('# External index\n') + ');') +
    "}return r;};syncBuiltinESMExports();const {MemoryStore}=await import(" + storeURL + ');' +
    'try {await new MemoryStore(' + JSON.stringify(store.root) + ').' + operation + '(' + JSON.stringify(cwd) + ',' + JSON.stringify(args) + ',controller.signal,()=>{if(!allowed)throw new Error("revoked");});process.exit(9);}' +
    'catch(e){if(!/revoked|abort|STALE_VERSION/i.test(e.message))throw e;}'
  );
  assert.equal((await store.read(cwd, topic.file)).content, old.content);
  await assert.rejects(lstat(join(dir, '.write-lock')), { code: 'ENOENT' });
});

test('failed forget index commit retains archive and reports no false success', async () => {
  const { store, cwd } = await fixture(); await store.write(cwd, topic); const old = await store.read(cwd, topic.file);
  const before = (await store.read(cwd)).content;
  child("import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.rename;fs.rename=async(a,b)=>{if(b===" + JSON.stringify(join(old.directory, 'MEMORY.md')) + ")throw Object.assign(new Error('injected'),{code:'EIO'});return original(a,b);};syncBuiltinESMExports();const {MemoryStore}=await import(" + storeURL + ');try{await new MemoryStore(' + JSON.stringify(store.root) + ').forget(' + JSON.stringify(cwd) + ',' + JSON.stringify({ file: topic.file, reason: 'cleanup', expected_revision: old.revision }) + ");process.exit(9);}catch(e){if(e.code!=='EIO')throw e;}");
  assert.equal((await store.read(cwd, topic.file)).content, null); assert.equal((await store.read(cwd)).content, before);
  const journals = await Promise.all((await readdir(join(old.directory, 'history'))).map(async name => JSON.parse(await readFile(join(old.directory, 'history', name), 'utf8'))));
  assert.equal(journals.find(j => j.operation === 'forget').previousContent, topic.content);
});

test('metadata cannot override scope, and discovery/selection fail closed on aliases and corrupt identities', async () => {
  const { store, cwd, base } = await fixture(); await store.write(cwd, topic);
  const dir = (await store.locate(cwd)).dir;
  await writeFile(join(dir, 'project.json'), JSON.stringify({ version: 1, cwd, scope: 'global', directory: '/untrusted' }));
  assert.equal((await store.read(cwd, topic.file)).scope, 'project');
  assert.equal((await store.read(cwd, topic.file, 'project', cwd)).scope, 'project');
  const alias = join(base, 'alias'); await symlink(cwd, alias);
  const aliasDir = join(store.root, 'projects', projectKey(alias)); await mkdir(aliasDir);
  await writeFile(join(aliasDir, 'project.json'), JSON.stringify({ version: 1, cwd: alias }));
  await assert.rejects(store.projects(), /Invalid project identity/);
  assert.equal((await store.read(cwd, topic.file)).content, topic.content);
  await writeFile(join(dir, 'project.json'), JSON.stringify({ version: 1, cwd: join(base, 'wrong') }));
  await assert.rejects(store.read(cwd, topic.file, 'project', cwd), /Invalid project identity/);
});

test('restore verifies scope and topic identity even when the archive is copied into the selected history', async () => {
  const { store, cwd } = await fixture(); await store.write(cwd, topic);
  const archive = await forget(store, cwd); const dir = (await store.locate(cwd)).dir;
  await store.write(null, topic, undefined, undefined, 'global'); const globalArchive = await forget(store, null, {}, 'global');
  const id = archive.archive_id.split(':')[0];
  await writeFile(join(store.global().dir, 'history', id), await readFile(join(dir, 'history', id)));
  await assert.rejects(restore(store, null, archive, {}, 'global'), /scope, project and topic/);
  const missing = await store.read(cwd, 'other.md');
  await assert.rejects(store.restore(cwd, { file: 'other.md', archive_id: archive.archive_id, reason: 'restore', expected_revision: missing.revision }), /scope, project and topic/);
  assert.equal((await store.read(null, topic.file, 'global')).revision, globalArchive.revision);
});

test('archive reader supports exact maximum-size imported topics and JSON-escaped indexes', async () => {
  const { store, cwd } = await fixture(); await store.write(cwd, topic); const dir = (await store.locate(cwd)).dir;
  const content = '\0'.repeat(1048576), index = '\0'.repeat(1048576);
  await writeFile(join(dir, topic.file), content); await writeFile(join(dir, 'MEMORY.md'), index);
  const archive = await forget(store, cwd);
  assert.ok((await lstat(join(dir, 'history', archive.archive_id.split(':')[0]))).size > 16 * 1048576);
  await restore(store, cwd, archive); assert.equal((await store.read(cwd, topic.file)).content, content);
  assert.equal((await store.read(cwd)).content, index);
});

for (const operation of ['forget', 'restore']) test(operation + ' finishes index once topic commit is admitted', async () => {
  const { store, cwd } = await fixture(); await store.write(cwd, topic);
  const archive = operation === 'restore' ? await forget(store, cwd) : null;
  const old = await store.read(cwd, topic.file); const args = { file: topic.file, reason: 'cleanup', expected_revision: old.revision, ...(archive ? { archive_id: archive.archive_id } : {}) };
  child("import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const controller=new AbortController();let allowed=true;" +
    (operation === 'forget' ? "const original=fs.unlink;fs.unlink=async(path)=>{const r=await original(path);if(path===" + JSON.stringify(join(old.directory, topic.file)) + "){allowed=false;controller.abort();}return r;};" : "const original=fs.rename;fs.rename=async(from,to)=>{const r=await original(from,to);if(to===" + JSON.stringify(join(old.directory, topic.file)) + "){allowed=false;controller.abort();}return r;};") +
    'syncBuiltinESMExports();const {MemoryStore}=await import(' + storeURL + ');await new MemoryStore(' + JSON.stringify(store.root) + ').' + operation + '(' + JSON.stringify(cwd) + ',' + JSON.stringify(args) + ',controller.signal,()=>{if(!allowed)throw new Error("revoked");});if(!controller.signal.aborted)process.exit(9);');
  assert.equal((await store.read(cwd, topic.file)).content, operation === 'forget' ? null : topic.content);
  assert.equal((await store.read(cwd)).content.includes('- [notes.md]'), operation === 'restore');
});

test('plugin rechecks cross-project policy and session identity after async admission', async () => {
  const f = await pluginFixture(); await f.store.write(f.other, topic);
  f.policy('danger-full-access'); const old = await f.store.read(f.other, topic.file);
  const writing = f.tools.get('memory_forget').execute({ file: topic.file, project: f.other, reason: 'cleanup', expected_revision: old.revision }, f.exec);
  f.policy('workspace-write'); await assert.rejects(writing, /danger-full-access/);
  f.policy('danger-full-access'); const changed = f.tools.get('memory_forget').execute({ file: topic.file, project: f.other, reason: 'cleanup', expected_revision: old.revision }, f.exec);
  f.agent.session = { header: { cwd: f.cwd } }; await assert.rejects(changed, /session identity/);
  assert.equal((await f.store.read(f.other, topic.file)).content, topic.content);
});

test('maintenance selectors reject global, unknown, nonabsolute and aliased projects before mutation', async () => {
  const { store, cwd, base } = await fixture(); await store.write(cwd, topic); const archive = await forget(store, cwd);
  const alias = join(base, 'alias'); await symlink(cwd, alias);
  for (const project of [null, 'repo', alias, cwd + '/', join(base, 'unknown')]) {
    await assert.rejects(store.forget(cwd, { file: topic.file, expected_revision: archive.revision, reason: 'cleanup', project }));
    await assert.rejects(store.restore(cwd, { file: topic.file, expected_revision: archive.revision, reason: 'undo', archive_id: archive.archive_id, project }));
  }
  for (const operation of ['forget', 'restore'])
    await assert.rejects(store[operation](cwd, { file: topic.file, expected_revision: archive.revision, reason: 'cleanup', project: cwd, archive_id: archive.archive_id }, undefined, undefined, 'global'), /global scope/);
  assert.equal((await store.read(cwd, topic.file)).content, null);
});

test('registry directory symlinks fail closed for discovery and selectors', async () => {
  const { store, cwd, other } = await fixture(); await store.write(cwd, topic);
  const dir = (await store.locate(cwd)).dir, aliasDir = join(store.root, 'projects', projectKey(other));
  await symlink(dir, aliasDir);
  await assert.rejects(store.projects(), /Symlink/);
  await assert.rejects(store.read(cwd, topic.file, 'project', other), /Symlink/);
  assert.equal((await store.read(cwd, topic.file)).content, topic.content);
});
