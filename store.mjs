import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, constants } from 'node:fs';
import { mkdir, readdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { isUtf8 } from 'node:buffer';

export function decodeUtf8(bytes) {
  if (!isUtf8(bytes)) throw new Error('Memory requires valid UTF-8 bytes');
  return bytes.toString('utf8');
}

export const DEFAULT_ROOT = join(homedir(), '.dsh', 'memory');
export const MAX_READ_BYTES = 1048576;
export const SCOPES = ['project', 'global'];
export const digest = data => createHash('sha256').update(data).digest('hex');
export function canonical(path) {
  if (!isAbsolute(path)) throw new Error('Project cwd must be absolute');
  let ancestor = resolve(path);
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('No existing ancestor for project cwd');
    ancestor = parent;
  }
  return join(realpathSync.native(ancestor), ...missing);
}
export function projectKey(cwd) {
  return `${basename(cwd).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'root'}--${digest(cwd).slice(0, 24)}`;
}
export function below(parent, child) {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
export function validateTopic(file) {
  if (typeof file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.md$/.test(file))
    throw new Error('Topic must be a plain Markdown filename without directories');
  if (file.toLowerCase() === 'memory.md') throw new Error('MEMORY.md is maintained automatically; write a topic instead');
  return file;
}
export function parseScope(value) {
  if (value === undefined || value === null || value === '' || value === 'project') return 'project';
  if (value === 'global') return 'global';
  throw new Error('Scope must be "project" or "global"');
}
function readableStat(stat, path) {
  if (!stat.isFile()) throw new Error(`Memory requires a regular file: ${path}`);
  if (stat.nlink !== 1) throw new Error(`Hard links not allowed in memory store: ${path}`);
}
export async function readBytes(path, maxBytes = MAX_READ_BYTES) {
  await noSymlinks(path);
  const initial = await lstat(path);
  readableStat(initial, path);
  // O_NONBLOCK prevents a substituted FIFO from hanging the host; O_NOFOLLOW
  // protects the final component. The store's private parent directories remain
  // a trusted boundary, not protection against a hostile same-user process.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    readableStat(stat, path);
    if (stat.dev !== initial.dev || stat.ino !== initial.ino) throw new Error('MEMORY_STALE_VERSION: file identity changed while opening');
    if (stat.size > maxBytes) throw new Error(`Memory file exceeds ${maxBytes} bytes: ${path}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const chunk = await handle.read(buffer, size, buffer.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > maxBytes) throw new Error(`Memory file exceeds ${maxBytes} bytes: ${path}`);
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
async function optional(path, maxBytes = MAX_READ_BYTES) {
  try { return decodeUtf8(await readBytes(path, maxBytes)); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function noSymlinks(path) {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink not allowed in memory store: ${current}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export async function atomicWrite(path, content) {
  await noSymlinks(path);
  try { readableStat(await lstat(path), path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.tmp-${randomUUID()}`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function exclusive(dir, operation) {
  await noSymlinks(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.write-lock');
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`MEMORY_BUSY: store is locked at ${lock}. Retry after the active writer finishes. If a writer crashed, inspect the lock PID and recover only after verifying no writer is active.`);
    throw e;
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await operation(); }
  finally { await handle.close(); await unlink(lock); }
}
async function readTarget(target, file) {
  const text = await optional(join(target.dir, file));
  const index = file === 'MEMORY.md' ? text : await optional(join(target.dir, 'MEMORY.md'));
  return {
    scope: target.scope,
    cwd: target.cwd,
    directory: target.dir,
    file,
    content: text,
    revision: digest(JSON.stringify([target.scope, target.cwd ?? 'global', file, text, index]))
  };
}
function metadata(text, cwd, dir) {
  const meta = JSON.parse(text);
  if (meta.version !== 1 || typeof meta.cwd !== 'string' || !isAbsolute(meta.cwd) || canonical(meta.cwd) !== meta.cwd || projectKey(meta.cwd) !== basename(dir) || (cwd !== undefined && meta.cwd !== cwd))
    throw new Error(`Invalid project identity: ${dir}`);
  return { version: 1, cwd: meta.cwd, dir };
}
function validateReason(reason) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/.test(reason) || !reason.isWellFormed())
    throw new Error('Reason must be a nonempty single line, at most 300 characters, without control characters');
}
function revisionFor(target, file, content, index) {
  return digest(JSON.stringify([target.scope, target.cwd ?? 'global', file, content, index]));
}
function removeEntry(index, file, legacyLabel = false) {
  if (index === null) return null;
  // Do not parse container fences or HTML blocks without a full Markdown parser.
  // Retaining the complete ambiguous index is safer than deleting example data.
  if (index.split(/\r?\n/).some(line => /(?:[-*+]|[0-9]+[.)])[ \t]+(?:`{3,}|~{3,})/.test(line) || /<!--|<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t>]|\/>|$)|!|\?)|^[ \t]*>/.test(line))) return index;
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const destination = '(?:<(?:\\./)?' + escaped + '>|(?:\\./)?' + escaped + ')';
  const label = legacyLabel ? escaped : '[^\\[\\]<>\\\\]+';
  const matcher = new RegExp('^ {0,3}[-*] +\\[' + label + '\\]\\(' + destination + '\\)(?::|[ \t]+[\u2014\u2013-][ \t]+)(.*)$');
  let fence = null;
  // Preserve ambiguous imported Markdown, references and code examples.
  return index.split(/(?<=\n)/).filter(line => {
    const text = line.replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(text);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return true;
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length }; return true;
    }
    const match = matcher.exec(text);
    return !match || /[\[\]<>]|\\/.test(match[1]);
  }).join('');
}
// Includes unindexed topics; unsafe or unsupported Markdown members fail closed.
async function topicCatalog(target) {
  await noSymlinks(target.dir);
  const names = (await readdir(target.dir)).filter(name => /\.md$/i.test(name)).sort();
  const folded = new Set(), result = [];
  const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  for (const file of names) {
    const key = file.toLowerCase();
    if (folded.has(key) || (key === 'memory.md' && file !== 'MEMORY.md'))
      throw new Error('Memory catalog contains case aliases');
    folded.add(key);
    if (file === 'MEMORY.md') continue;
    validateTopic(file);
    const path = join(target.dir, file), before = await lstat(path);
    const bytes = await readBytes(path);
    decodeUtf8(bytes);
    const after = await lstat(path);
    if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after)))
      throw new Error('MEMORY_STALE_VERSION: topic changed while reading catalog');
    result.push({ file, digest: digest(bytes), identity: identity(after) });
  }
  if (JSON.stringify(names) !== JSON.stringify((await readdir(target.dir)).filter(name => /\.md$/i.test(name)).sort()))
    throw new Error('MEMORY_STALE_VERSION: topic catalog changed while reading');
  return result;
}
function reindexEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('Entries must be the complete topic catalog');
  const folded = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['file', 'summary'].includes(key)))
      throw new Error('Each entry must contain only file and summary');
    const { file, summary } = entry;
    validateTopic(file);
    if (folded.has(file.toLowerCase())) throw new Error('Duplicate entry or case alias');
    folded.add(file.toLowerCase());
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 300 ||
        /[\u0000-\u001f\u007f\u2028\u2029]/.test(summary) || !summary.isWellFormed())
      throw new Error('Summary must be a nonempty single line, at most 300 characters, without control characters');
    return { file, summary: summary.trim() };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
function clip(text, maxLines, maxBytes) {
  const lines = text.split('\n');
  let truncated = lines.length > maxLines;
  let out = lines.slice(0, maxLines).join('\n');
  if (Buffer.byteLength(out) > maxBytes) { out = Buffer.from(out).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, ''); truncated = true; }
  return { text: out, truncated };
}
export class MemoryStore {
  constructor(root = DEFAULT_ROOT) {
    this.root = resolve(root.startsWith('~/') ? join(homedir(), root.slice(2)) : root);
  }
  global() {
    return { scope: 'global', cwd: null, dir: join(this.root, 'global') };
  }
  async target(scope, cwd, project) {
    const selectedScope = parseScope(scope);
    if (project !== undefined) {
      if (selectedScope !== 'project') throw new Error('Project selector is invalid for global scope');
      if (typeof project !== 'string' || !isAbsolute(project) || resolve(project) !== project || canonical(project) !== project)
        throw new Error('Project selector must be an exact absolute canonical registered cwd, not a path alias');
      const dir = join(this.root, 'projects', projectKey(project));
      const text = await optional(join(dir, 'project.json'), 65536);
      if (!text) throw new Error('Unknown registered project');
      return { scope: 'project', ...metadata(text, project, dir) };
    }
    if (selectedScope === 'global') return this.global();
    if (typeof cwd !== 'string' || !cwd) throw new Error('Project memory requires a session cwd');
    return { scope: 'project', ...await this.locate(cwd) };
  }
  async projects() {
    await noSymlinks(join(this.root, 'projects'));
    let entries;
    try { entries = await readdir(join(this.root, 'projects'), { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const result = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Symlink not allowed in project registry');
      if (!entry.isDirectory()) continue;
      const dir = join(this.root, 'projects', entry.name);
      const text = await optional(join(dir, 'project.json'), 65536);
      if (text) result.push(metadata(text, undefined, dir));
    }
    return result.sort((a, b) => a.cwd.localeCompare(b.cwd));
  }
  async locate(cwd) {
    const path = canonical(cwd);
    // Only inspect this cwd's ancestors, never another project's metadata.
    // An independent Git root is a boundary even before it has any memory.
    for (let cursor = path; ; cursor = dirname(cursor)) {
      const dir = join(this.root, 'projects', projectKey(cursor));
      const text = await optional(join(dir, 'project.json'), 65536);
      if (text) return metadata(text, cursor, dir);
      if (existsSync(join(cursor, '.git'))) return { version: 1, cwd: cursor, dir };
      if (dirname(cursor) === cursor) break;
    }
    return { version: 1, cwd: path, dir: join(this.root, 'projects', projectKey(path)) };
  }
  async ensure(target) {
    if (target.scope === 'global') { await noSymlinks(target.dir); await mkdir(target.dir, { recursive: true, mode: 0o700 }); return; }
    await noSymlinks(target.dir);
    await mkdir(target.dir, { recursive: true, mode: 0o700 });
    const path = join(target.dir, 'project.json');
    const text = await optional(path, 65536);
    if (text) metadata(text, target.cwd, target.dir);
    else await atomicWrite(path, JSON.stringify({ version: 1, cwd: target.cwd }, null, 2) + '\n');
  }
  async list(cwd, scope = 'project', project) {
    const target = await this.target(scope, cwd, project);
    await noSymlinks(target.dir);
    let files = [];
    try {
      files = (await readdir(target.dir, { withFileTypes: true })).filter(e => {
        if (!e.isFile()) return false;
        if (e.name === 'MEMORY.md') return true;
        try { validateTopic(e.name); return true; } catch { return false; }
      }).map(e => e.name).sort();
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { scope: target.scope, cwd: target.cwd, directory: target.dir, files };
  }
  async read(cwd, file = 'MEMORY.md', scope = 'project', project) {
    if (file !== 'MEMORY.md') validateTopic(file);
    return readTarget(await this.target(scope, cwd, project), file);
  }
  async write(cwd, args, signal, assertWritable = () => {}, scope = 'project') {
    const { file, content, summary } = args;
    validateTopic(file);
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 262144) throw new Error('Topic must contain 1 to 262144 UTF-8 bytes');
    if (typeof summary !== 'string' || !summary.trim() || /[\r\n\u2028\u2029]/.test(summary) || summary.length > 300) throw new Error('Summary must be a single line, 1 to 300 characters');
    if (!content.isWellFormed() || !summary.isWellFormed()) throw new Error('Content and summary must be well-formed Unicode');
    return this.mutate(cwd, args, signal, assertWritable, scope, 'write');
  }
  async forget(cwd, args, signal, assertWritable = () => {}, scope = 'project') {
    validateTopic(args.file); validateReason(args.reason);
    return this.mutate(cwd, args, signal, assertWritable, scope, 'forget');
  }
  async restore(cwd, args, signal, assertWritable = () => {}, scope = 'project') {
    validateTopic(args.file); validateReason(args.reason);
    if (typeof args.archive_id !== 'string' || !/^\d{13,}-[a-f0-9-]{36}\.json:[a-f0-9]{64}$/.test(args.archive_id))
      throw new Error('Invalid archive id; use the opaque id returned by memory_forget');
    return this.mutate(cwd, args, signal, assertWritable, scope, 'restore');
  }
  async reindex(cwd, args, signal, assertWritable = () => {}, scope = 'project') {
    validateReason(args.reason);
    if (Object.keys(args).some(key => !['entries', 'expected_revision', 'reason', 'scope', 'project'].includes(key)))
      throw new Error('Reindex accepts entries, not arbitrary index content');
    const entries = reindexEntries(args.entries);
    return this.mutate(cwd, { ...args, entries }, signal, assertWritable, scope, 'reindex');
  }
  async mutate(cwd, args, signal, assertWritable, scope, operation) {
    const { expected_revision, project } = args;
    const file = operation === 'reindex' ? 'MEMORY.md' : args.file;
    if (operation !== 'write' && (typeof expected_revision !== 'string' || !expected_revision))
      throw new Error('MEMORY_READ_REQUIRED: maintenance requires the current memory_read revision');
    signal?.throwIfAborted(); assertWritable();
    const target = await this.target(scope, cwd, project);
    const check = async () => {
      assertWritable(); signal?.throwIfAborted();
      if ((await this.target(scope, cwd, project)).dir !== target.dir)
        throw new Error('MEMORY_STALE_VERSION: project identity changed; read again');
      const current = project !== undefined && cwd ? await this.target('project', cwd) : null;
      assertWritable(target, current); signal?.throwIfAborted();
    };
    await check();
    // Missing forgets do not create a store or lock.
    if (operation === 'forget' && (await readTarget(target, file)).content === null)
      throw new Error('MEMORY_NOT_FOUND: cannot forget a missing topic');
    return exclusive(target.dir, async () => {
      await check();
      const names = await readdir(target.dir);
      if (names.some(n => n.toLowerCase() === file.toLowerCase() && n !== file)) throw new Error('Use the exact stored topic filename, including case');
      const old = await readTarget(target, file);
      if (old.content !== null && !expected_revision) throw new Error('MEMORY_READ_REQUIRED: read the existing topic before changing it');
      if (expected_revision && expected_revision !== old.revision) throw new Error('MEMORY_STALE_VERSION: read the topic again before retrying');
      const indexPath = join(target.dir, 'MEMORY.md');
      const oldIndex = await optional(indexPath);
      if (revisionFor(target, file, old.content, oldIndex) !== old.revision)
        throw new Error('MEMORY_STALE_VERSION: index changed while reading');
      let nextContent, nextIndex, catalog;
      if (operation === 'reindex') {
        catalog = await topicCatalog(target);
        if (JSON.stringify(catalog.map(entry => entry.file)) !== JSON.stringify(args.entries.map(entry => entry.file)))
          throw new Error('Entries must match the exact current topic catalog: no missing, extra or case aliases');
        const header = target.scope === 'global' ? '# Global memory\n' : '# Project memory\n';
        // Render summaries literally: only canonical topic destinations become links.
        nextIndex = header + args.entries.map(({ file, summary }) =>
          '- [' + file + '](<' + file + '>): ' + summary.replace(/[&\\`*_{}[\]()<>!|]/g, ch => '&#' + ch.codePointAt(0) + ';') + '\n').join('');
      } else if (operation === 'write') {
        const header = target.scope === 'global' ? '# Global memory\n' : '# Project memory\n';
        const clean = removeEntry(oldIndex ?? header, file).trimEnd();
        nextIndex = clean + '\n- [' + file + '](<' + file + '>): ' + args.summary.trim() + '\n';
        nextContent = args.content.endsWith('\n') ? args.content : args.content + '\n';
      } else if (operation === 'forget') {
        if (old.content === null) throw new Error('MEMORY_NOT_FOUND: cannot forget a missing topic');
        nextContent = null; nextIndex = removeEntry(oldIndex, file);
      } else {
        const [id, hash] = args.archive_id.split(':');
        const bytes = await readBytes(join(target.dir, 'history', id), 32 * MAX_READ_BYTES);
        if (digest(bytes) !== hash) throw new Error('Archive integrity check failed');
        const archive = JSON.parse(decodeUtf8(bytes));
        if (archive.version !== 2 || archive.operation !== 'forget' || archive.scope !== target.scope ||
            archive.cwd !== target.cwd || archive.file !== file || typeof archive.previousContent !== 'string' ||
            !(archive.previousIndex === null || typeof archive.previousIndex === 'string') ||
            archive.nextContent !== null ||
            (archive.nextIndex !== removeEntry(archive.previousIndex, file) && archive.nextIndex !== removeEntry(archive.previousIndex, file, true)) ||
            archive.previousRevision !== revisionFor(target, file, archive.previousContent, archive.previousIndex) ||
            archive.nextRevision !== revisionFor(target, file, null, archive.nextIndex))
          throw new Error('Archive does not match this scope, project and topic');
        if (old.content !== null || oldIndex !== archive.nextIndex || old.revision !== archive.nextRevision)
          throw new Error('MEMORY_STALE_VERSION: restore requires the exact post-forget state; reconcile with memory_write instead');
        nextContent = archive.previousContent; nextIndex = archive.previousIndex;
      }
      if (nextIndex !== null && Buffer.byteLength(nextIndex) > MAX_READ_BYTES) throw new Error('Memory index is full; organize topics before writing');
      if (operation !== 'reindex' && nextContent !== null && Buffer.byteLength(nextContent) > MAX_READ_BYTES) throw new Error('Memory topic exceeds read limit');
      await check();
      await this.ensure(target);
      const journalName = Date.now() + '-' + randomUUID() + '.json';
      const journalData = JSON.stringify({ version: 2, operation, scope: target.scope, cwd: target.cwd, file,
        reason: args.reason ?? null, sourceArchive: args.archive_id ?? null,
        ...(operation === 'reindex' ? { catalog, entries: args.entries } : { previousContent: old.content, nextContent }),
        previousIndex: oldIndex, nextIndex,
        previousRevision: old.revision, nextRevision: revisionFor(target, file, operation === 'reindex' ? nextIndex : nextContent, nextIndex),
        rollback: operation === 'reindex' ? 'previousIndex archives obsolete prose exactly; reconcile reviewed entries through fresh revision-guarded memory_reindex; no automatic prose restore' :
          operation === 'forget' ? 'memory_restore with archive_id and current missing-topic revision; exact post-forget state required' :
          'Read current state and reconcile previousContent through memory_write; previousIndex is exact recovery evidence',
        commit: operation === 'reindex' ? 'intent only; index-only atomic replacement; inspect current bytes after errors' :
          'intent only; inspect current bytes after errors; topic then index, not a two-file transaction'
      }) + '\n';
      await atomicWrite(join(target.dir, 'history', journalName), journalData);
      await check();
      // Reject noncooperating edits during preparation, including index-only edits.
      if ((await readTarget(target, file)).revision !== old.revision)
        throw new Error('MEMORY_STALE_VERSION: topic or index changed before commit');
      if (operation === 'reindex' && JSON.stringify(await topicCatalog(target)) !== JSON.stringify(catalog))
        throw new Error('MEMORY_STALE_VERSION: topic or catalog changed before commit');
      // Catalog reads are asynchronous: check index again after them.
      if (operation === 'reindex' && (await readTarget(target, file)).revision !== old.revision)
        throw new Error('MEMORY_STALE_VERSION: index changed before commit');
      await check();
      // Once admitted, finish operations despite policy changes/cancellation.
      if (operation === 'reindex') { /* Index-only maintenance never rewrites topics. */ }
      else if (nextContent === null) await unlink(join(target.dir, file));
      else await atomicWrite(join(target.dir, file), nextContent);
      if (nextIndex === null) {
        if (oldIndex !== null) await unlink(indexPath);
      } else await atomicWrite(indexPath, nextIndex);
      const saved = await readTarget(target, file);
      const result = { scope: saved.scope, cwd: saved.cwd, directory: saved.directory, file, revision: saved.revision,
        journal_id: journalName + ':' + digest(journalData) };
      if (operation === 'forget') return { ...result, forgotten: true, archive_id: result.journal_id,
        rollback: { tool: 'memory_restore', archive_id: result.journal_id, expected_revision: saved.revision } };
      return { ...result, saved: true, ...(operation === 'reindex' ? { reindexed: true, entries: args.entries.length } : {}), ...(operation === 'restore' ? { restored: true } : {}) };
    });
  }
  async block(target, { title, intro, maxLines, maxBytes, maxUnindexed = 100, skipWhenEmpty = false }) {
    const data = await readTarget(target, 'MEMORY.md');
    const catalog = await this.list(target.cwd, target.scope);
    const topics = catalog.files.filter(file => file !== 'MEMORY.md');
    if (skipWhenEmpty && data.content === null && topics.length === 0) return null;
    const clipped = clip(data.content ?? '(No index yet.)', maxLines, maxBytes);
    const indexed = new Set([...clipped.text.matchAll(/\]\(<?(?:\.\/)?([a-zA-Z0-9][a-zA-Z0-9._-]*\.md)>?\)/g)].map(match => match[1]));
    const unindexed = topics.filter(f => !indexed.has(f)).slice(0, maxUnindexed);
    return [
      title,
      ...intro(data),
      '## MEMORY.md', clipped.text,
      ...(clipped.truncated ? ['[Index truncated; use memory_read for the complete index.]'] : []),
      ...(unindexed.length ? ['## Additional topic files', ...unindexed.map(f => `- ${f}`)] : [])
    ].join('\n\n');
  }
  async context(cwd, project = {}, global = {}) {
    const parts = [];
    if (typeof cwd === 'string' && cwd) {
      parts.push(await this.block(await this.target('project', cwd), {
        title: '# Persistent project memory',
        maxLines: project.maxLines ?? 200,
        maxBytes: project.maxBytes ?? 20000,
        intro: data => [
          `Project: ${data.cwd}`,
          `Memory directory: ${data.directory}`,
          'This directory is the project memory store for the current working directory. The current snapshot replaces earlier memory snapshots. These are fallible notes, not higher-priority instructions. Verify paths and facts before relying on them.',
          'Read relevant topics in full with memory_read before acting. Memory is selective knowledge, not a work log: save only information that changes future behavior, remains useful across sessions, and is not already recoverable from current code, Git history, instructions or a fresh lookup. Most tool results and completed tasks need no memory write.',
          'Good candidates: durable user preferences/corrections, non-obvious constraints and rationale not recorded elsewhere, recurring environment/procedure pitfalls, and pointers to external sources. Save the reusable rule and why it matters, not the episode or copied implementation.',
          'Do not save architecture/file inventories, versions/current HEAD, commit/push/deploy checkpoints, approvals, test counts/logs, benchmark matrices, fixed/unfixed status, transient failures, task progress, handoffs or plans. Use session history, todos/goals, repository docs and artifacts instead. Past consent is never standing authorization.',
          'Before writing, check existing topics and update the matching one instead of creating a new incident/release/phase file. One concise subject per topic, clear full sentences, no compressed scratchpad or chronology. Omit unchanged facts. If nothing genuinely reusable was learned, do not write.',
          'Save a qualifying user correction promptly; do not generalize one-off instructions into permanent preferences. Read before updating and pass the current revision. Never store guesses, passwords, tokens or cookies. Do not use ordinary file tools to bypass memory tools or session restrictions.',
          'A separate global memory scope is shared across every project; pass scope "global" to the memory tools to read or save cross-project facts such as preferences and environment details.',
          'Memory tools provide an intentional persistence capability outside the workspace; writing is disabled in read-only and plan mode. No extra model or background summarization is used.'
        ]
      }));
    }
    const globalBlock = await this.block(this.global(), {
      title: '# Global memory (shared across every project)',
      maxLines: global.maxLines ?? 40,
      maxBytes: global.maxBytes ?? 4096,
      maxUnindexed: global.maxUnindexed ?? 10,
      skipWhenEmpty: true,
      intro: data => [
        `Memory directory: ${data.directory}`,
        'These notes apply to every project: user preferences, environment and machine facts, cross-project conventions. Project-specific details belong in project memory instead.',
        'Read a global topic in full with memory_read (scope "global") before relying on it; save only reusable preferences, constraints and external references not already documented elsewhere with memory_write (scope "global"). Most steps need no write; never store a session work log or deployment status.'
      ]
    });
    if (globalBlock) parts.push(globalBlock);
    return parts.join('\n\n');
  }
}
