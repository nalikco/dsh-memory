import { open, lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './cli.mjs';
import { MemoryStore, readBytes, noSymlinks } from './store.mjs';

export async function recoverLock({ cwd, root, scope = 'project', confirm = false }) {
  const store = new MemoryStore(root);
  const project = await store.target(scope, cwd);
  const lock = join(project.dir, '.write-lock');
  await noSymlinks(lock);
  const stat = await lstat(lock);
  const text = (await readBytes(lock, 65536)).toString('utf8');
  let record;
  try { record = JSON.parse(text); } catch { throw new Error('Malformed lock; explicit manual investigation required'); }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('Invalid lock PID; explicit manual investigation required');
  try { process.kill(record.pid, 0); throw new Error(`Writer PID ${record.pid} is still alive; lock recovery refused`); }
  catch (e) { if (e.code !== 'ESRCH') throw e; }
  const result = { scope: project.scope, cwd: project.cwd, lock, pid: record.pid, deadWriter: true, removed: false };
  if (!confirm) return result;
  // A second recovery cannot race the old lock removal. Never reclaim this
  // recovery mutex automatically; a crash during recovery fails closed.
  const recovery = join(project.dir, '.lock-recovery');
  const handle = await open(recovery, 'wx', 0o600);
  try {
    const current = await lstat(lock);
    if (current.dev !== stat.dev || current.ino !== stat.ino || (await readBytes(lock, 65536)).toString('utf8') !== text)
      throw new Error('Lock identity changed; recovery refused');
    try { process.kill(record.pid, 0); throw new Error('Writer became live; recovery refused'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    await unlink(lock);
    result.removed = true;
    return result;
  } finally { await handle.close(); await unlink(recovery); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2), {
    values: ['--cwd', '--root', '--scope'], switches: ['--confirm']
  });
  if (!args['--cwd'] && args['--scope'] !== 'global')
    throw new Error('Usage: node recover-lock.mjs --cwd /absolute/project [--scope project] [--root DIR] [--confirm], or --scope global. Default is read-only inspection.');
  console.log(JSON.stringify(await recoverLock({ cwd: args['--cwd'], root: args['--root'], scope: args['--scope'], confirm: args['--confirm'] === true }), null, 2));
}
