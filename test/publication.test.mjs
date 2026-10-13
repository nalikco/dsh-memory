import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { MemoryStore, canonical } from '../store.mjs';
import { migrate } from '../migrate.mjs';
import { recoverLock } from '../recover-lock.mjs';
import { parseArgs } from '../cli.mjs';

async function fixture() {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-publication-test-')));
  const cwd = join(base, 'repo');
  await mkdir(join(cwd, '.git'), { recursive: true });
  return { base, cwd, store: new MemoryStore(join(base, 'memory')) };
}
const topic = (file = 'notes.md') => ({ file, content: '# Fact\n', summary: 'fact' });

test('CLI rejects unknown, duplicate and missing-value flags', () => {
  const schema = { values: ['--root'], switches: ['--confirm'] };
  for (const args of [['--root'], ['--root', '--confirm'], ['--unknown'], ['--confirm', '--confirm'], ['--root', 'a', '--root', 'b']])
    assert.throws(() => parseArgs(args, schema), /Unknown|Duplicate|Missing/);
  assert.deepEqual({ ...parseArgs(['--root', '/a b', '--confirm'], schema) }, { '--root': '/a b', '--confirm': true });
});

test('CLI invalid arguments fail before touching the requested store', async () => {
  const { cwd, store } = await fixture();
  for (const [script, args] of [
    ['recover-lock.mjs', ['--cwd', cwd, '--confirm', '--root']],
    ['recover-lock.mjs', ['--scope', 'global', '--root', '--confirm']],
    ['migrate.mjs', ['--map', 'missing.json', '--destination', '--apply']]
  ]) {
    const result = spawnSync(process.execPath, [new URL(`../${script}`, import.meta.url).pathname, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing value/);
  }
  await assert.rejects(readdir(store.root), { code: 'ENOENT' });
});

test('global lock recovery inspects, refuses live owners and removes only confirmed dead locks', async () => {
  const { store } = await fixture();
  await store.write(null, topic(), undefined, undefined, 'global');
  const lock = join(store.global().dir, '.write-lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(recoverLock({ root: store.root, scope: 'global', confirm: true }), /still alive/);
  await writeFile(lock, JSON.stringify({ pid: 2147483647 }));
  assert.equal((await recoverLock({ root: store.root, scope: 'global' })).removed, false);
  const result = await recoverLock({ root: store.root, scope: 'global', confirm: true });
  assert.equal(result.scope, 'global');
  assert.equal(result.cwd, null);
  assert.equal(result.removed, true);
  await store.write(null, topic('after.md'), undefined, undefined, 'global');
});

test('recovery CLI supports global scope without cwd', async () => {
  const { store } = await fixture();
  await store.write(null, topic(), undefined, undefined, 'global');
  const lock = join(store.global().dir, '.write-lock');
  await writeFile(lock, JSON.stringify({ pid: 2147483647 }));
  const run = (...flags) => spawnSync(process.execPath, [new URL('../recover-lock.mjs', import.meta.url).pathname, '--scope', 'global', '--root', store.root, ...flags], { encoding: 'utf8' });
  const dry = run(); assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).removed, false);
  const confirmed = run('--confirm'); assert.equal(confirmed.status, 0, confirmed.stderr); assert.equal(JSON.parse(confirmed.stdout).removed, true);
});

test('migration refuses destination case aliases before copying', async () => {
  const { base, cwd, store } = await fixture();
  await store.write(cwd, topic('Notes.md'));
  const source = join(base, 'source'); const dir = join(source, 'slug', 'memory');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'notes.md'), '# Fact\n');
  for (const apply of [false, true])
    await assert.rejects(migrate({ source, destination: store.root, mapping: { slug: cwd }, apply }), /Case-colliding destination/);
  assert.deepEqual((await store.list(cwd)).files, ['MEMORY.md', 'Notes.md']);
});

test('migration CLI uses parsed paths and defaults to dry-run', async () => {
  const { base, cwd, store } = await fixture();
  const source = join(base, 'source'); const dir = join(source, 'slug', 'memory');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'notes.md'), '# Fact\n');
  const mapping = join(base, 'map.json'); await writeFile(mapping, JSON.stringify({ slug: cwd }));
  const run = (...flags) => spawnSync(process.execPath, [new URL('../migrate.mjs', import.meta.url).pathname, '--map', mapping, '--source', source, '--destination', store.root, ...flags], { encoding: 'utf8' });
  const dry = run(); assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).applied, false);
  assert.equal((await store.read(cwd, 'notes.md')).content, null);
  const applied = run('--apply'); assert.equal(applied.status, 0, applied.stderr);
  assert.equal((await store.read(cwd, 'notes.md')).content, '# Fact\n');
});

test('invalid UTF-8 topics and indexes fail closed instead of lossy revisions', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic());
  const dir = (await store.locate(cwd)).dir;
  await writeFile(join(dir, 'notes.md'), Buffer.from([0xff]));
  await assert.rejects(store.read(cwd, 'notes.md'), /valid UTF-8/);
  await assert.rejects(store.write(cwd, { ...topic(), expected_revision: 'anything' }), /valid UTF-8/);
  assert.deepEqual(await readFile(join(dir, 'notes.md')), Buffer.from([0xff]));
  await writeFile(join(dir, 'notes.md'), '# Fact\n'); await writeFile(join(dir, 'MEMORY.md'), Buffer.from([0xfe]));
  await assert.rejects(store.read(cwd), /valid UTF-8/);
});

test('malformed Unicode content and summaries are rejected before store creation', async () => {
  const { cwd, store } = await fixture();
  await assert.rejects(store.write(cwd, { ...topic(), content: '\ud800' }), /Unicode/);
  await assert.rejects(store.write(cwd, { ...topic(), summary: '\udfff' }), /Unicode/);
  await assert.rejects(readdir(store.root), { code: 'ENOENT' });
});

test('migration rejects invalid UTF-8 source during dry-run before publication', async () => {
  const { base, cwd, store } = await fixture();
  const source = join(base, 'source'); const dir = join(source, 'slug', 'memory');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'notes.md'), Buffer.from([0xff]));
  await assert.rejects(migrate({ source, destination: store.root, mapping: { slug: cwd }, apply: true }), /valid UTF-8/);
  assert.equal((await store.read(cwd, 'notes.md')).content, null);
});

test('unindexed topic names are not hidden by longer filename substrings', async () => {
  const { cwd, store } = await fixture(); await store.write(cwd, topic('longnotes.md'));
  const dir = (await store.locate(cwd)).dir;
  await writeFile(join(dir, 'notes.md'), '# Unindexed\n');
  const context = await store.context(cwd);
  assert.match(context, /## Additional topic files\n\n- notes\.md/);
});

test('bundle and package metadata are portable and exclude local artifacts', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(!patch.includes('/Users/') && !patch.includes('/home/'));
  assert.ok(pkg.files.includes('store.mjs') && pkg.files.includes('cli.mjs'));
  for (const path of ['mapping.json', 'AGENTS.recovered.md', 'reference', 'RECHECK.md']) assert.ok(!pkg.files.includes(path));
  assert.equal(pkg.scripts.prepare, undefined); assert.equal(pkg.scripts.postinstall, undefined);
  for (const file of ['index.mjs', 'plugin.mjs', 'store.mjs', 'cli.mjs', 'migrate.mjs', 'recover-lock.mjs', 'LICENSE', 'SECURITY.md', 'locale/en.json', 'locale/zh.json'])
    assert.ok((await readFile(new URL(`../${file}`, import.meta.url))).length > 0);
});
