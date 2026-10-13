import { readdir, readFile, lstat, open, chmod, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './cli.mjs';
import { MemoryStore, canonical, digest, noSymlinks, atomicWrite, exclusive, below, validateTopic, readBytes, projectKey, decodeUtf8 } from './store.mjs';

async function walk(dir, prefix = '') {
  const files = [];
  await noSymlinks(dir);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error(`Import refuses symlink: ${join(dir, e.name)}`);
    if (e.isDirectory()) files.push(...await walk(join(dir, e.name), rel));
    else if (e.isFile()) files.push(rel);
    else throw new Error(`Import refuses special file: ${rel}`);
  }
  return files.sort();
}
async function existing(path) {
  try { return await readBytes(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function assertNoCaseAliases(dir, files) {
  await noSymlinks(dir);
  let names;
  try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const file of files) {
    if (names.some(name => name !== file && name.toLowerCase() === file.toLowerCase()))
      throw new Error(`Case-colliding destination topic: ${file}`);
  }
}
export async function migrate({ source = join(homedir(), '.claude', 'projects'), destination, mapping, apply = false }) {
  const store = new MemoryStore(destination);
  await noSymlinks(source);
  await noSymlinks(store.root);
  source = canonical(resolve(source));
  store.root = canonical(store.root);
  if (below(source, store.root) || below(store.root, source)) throw new Error('Import source and destination must not overlap');
  const plans = [];
  const keys = new Set();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Import refuses symlink project root: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const dir = join(source, entry.name, 'memory');
    try { await lstat(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const files = await walk(dir);
    if (!files.length) continue;
    if (!Object.hasOwn(mapping, entry.name) || typeof mapping[entry.name] !== 'string') throw new Error(`No unambiguous project mapping for ${entry.name}`);
    const cwd = canonical(mapping[entry.name]);
    // Migration identities are explicit, including separate nested projects.
    const project = { version: 1, cwd, dir: join(store.root, 'projects', projectKey(cwd)) };
    const identity = await existing(join(project.dir, 'project.json'));
    if (identity) {
      const meta = JSON.parse(identity.toString('utf8'));
      if (meta.version !== 1 || meta.cwd !== cwd) throw new Error(`Destination project mapping conflict: ${cwd}`);
    }
    if (keys.has(project.dir)) throw new Error(`Multiple sources map to ${cwd}`);
    keys.add(project.dir);
    await assertNoCaseAliases(project.dir, files);
    const records = [], topicNames = new Set();
    for (const file of files) {
      try { if (file !== 'MEMORY.md') validateTopic(file); }
      catch (e) { throw new Error(`Unsupported imported topic ${file}: ${e.message}`); }
      if (topicNames.has(file.toLowerCase())) throw new Error(`Case-colliding imported topics: ${file}`);
      topicNames.add(file.toLowerCase());
      const bytes = await readBytes(join(dir, file));
      decodeUtf8(bytes);
      const target = join(project.dir, file);
      const current = await existing(target);
      if (current && digest(current) !== digest(bytes)) throw new Error(`Import conflict, refusing overwrite: ${target}`);
      records.push({ file, bytes: bytes.length, sha256: digest(bytes) });
    }
    plans.push({ slug: entry.name, source: dir, project, records });
  }
  const result = { applied: apply, projects: plans.length, files: plans.reduce((n, p) => n + p.records.length, 0), bytes: plans.reduce((n, p) => n + p.records.reduce((k, r) => k + r.bytes, 0), 0), entries: [] };
  for (const plan of plans) {
    if (apply) await exclusive(plan.project.dir, async () => {
      await assertNoCaseAliases(plan.project.dir, plan.records.map(record => record.file));
      await store.ensure(plan.project);
      for (const record of plan.records) {
        const src = join(plan.source, record.file), target = join(plan.project.dir, record.file);
        // Copy the verified bytes, not a pathname that may now name another source.
        const bytes = await readBytes(src);
        if (digest(bytes) !== record.sha256) throw new Error(`Source changed since preflight: ${src}`);
        await noSymlinks(target);
        if (!(await existing(target))) {
          const temp = join(plan.project.dir, `.import-${randomUUID()}`);
          try {
            const handle = await open(temp, 'wx', 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            if (digest(await readBytes(temp)) !== record.sha256) throw new Error('Import staging verification failed');
            // link() publishes all verified bytes atomically and refuses overwrite.
            // A crash after publication may leave two links; recovery must remove
            // the owned .import-* link before the strict reader accepts the topic.
            try { await link(temp, target); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        }
        if (digest(await readBytes(target)) !== record.sha256) throw new Error(`Destination verification failed: ${target}`);
        await chmod(target, 0o600);
      }
      const importPath = join(plan.project.dir, 'import.json');
      // Preserve the original evidence, including original import time, on reruns.
      if (!(await existing(importPath))) await atomicWrite(importPath, JSON.stringify({ version: 1, source: plan.source, importedAt: new Date().toISOString(), files: plan.records }, null, 2) + '\n');
    });
    result.entries.push({ slug: plan.slug, cwd: plan.project.cwd, directory: plan.project.dir, files: plan.records.length });
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2), {
    values: ['--map', '--source', '--destination'], switches: ['--apply']
  });
  const mapPath = args['--map'];
  if (!mapPath) throw new Error('Usage: node migrate.mjs --map mapping.json [--source DIR] [--destination DIR] [--apply]. Default is dry-run.');
  const mapping = JSON.parse(await readFile(mapPath, 'utf8'));
  console.log(JSON.stringify(await migrate({ mapping, source: args['--source'], destination: args['--destination'], apply: args['--apply'] === true }), null, 2));
}
