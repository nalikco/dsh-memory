import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, canonical } from '../store.mjs';

const cases = [
  '- [notes.md](<notes.md>): see [other][ref]\n[ref]: other.md\n',
  '- [notes.md](<notes.md>): see [other]\n[other]: other.md\n',
  '- [notes.md](<notes.md>): see [other][]\n[other]: other.md\n',
  '```markdown\n- [notes.md](<notes.md>): example\n```\n',
  '~~~~md\n- [notes.md](<notes.md>): example\n~~~\n- [notes.md](notes.md): still fenced\n~~~~\n',
  '    - [notes.md](<notes.md>): indented code\n',
  '\t- [notes.md](<notes.md>): tab code\n',
  '- [notes.md](<notes.md): malformed\n',
  '- [notes.md](notes.md>): malformed\n',
  '- [notes.md](<notes.md>): <https://example.org>\n',
  '- [notes.md](notes.md): see [other](other.md)\r\n',
];
for (const [i, preserved] of cases.entries()) test('forget preserves ambiguous imported index case ' + i, async () => {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-index-cleanup-')));
  const store = new MemoryStore(join(base, 'memory'));
  const initial = await store.write(base, { file: 'notes.md', content: '# Notes\n', summary: 'Fact' });
  const before = '# Project memory\r\n' + preserved + '- [notes.md](<notes.md>): actual entry\n' + '- [notes.md](notes.md) \u2014 imported legacy entry\n';
  await writeFile(join(initial.directory, 'MEMORY.md'), before);
  const old = await store.read(base, 'notes.md');
  const archive = await store.forget(base, { file: 'notes.md', reason: 'Regression', expected_revision: old.revision });
  assert.equal((await store.read(base)).content, '# Project memory\r\n' + preserved);
  await store.restore(base, { file: 'notes.md', reason: 'Undo regression', archive_id: archive.archive_id, expected_revision: archive.revision });
  assert.equal((await store.read(base)).content, before);
});

for (const preserved of ['- <pre>\n  - [notes.md](<notes.md>): example\n  text</pre>\n', '-\t```markdown\n  - [notes.md](notes.md): example\n  ```\n', '- ```markdown\n  - [notes.md](<notes.md>): example\n  ```\n', '<!--\n- [notes.md](<notes.md>): comment\n-->\n', '<pre>\n- [notes.md](<notes.md>): example\n</pre>\n', '> quote\n- [notes.md](<notes.md>): ambiguous continuation\n']) test('forget retains complete ambiguous block index ' + preserved.slice(0, 12), async () => {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-index-block-')));
  const store = new MemoryStore(join(base, 'memory'));
  const initial = await store.write(base, { file: 'notes.md', content: '# Notes\n', summary: 'Fact' });
  const before = '# Project memory\n' + preserved + '- [notes.md](notes.md): actual entry\n';
  await writeFile(join(initial.directory, 'MEMORY.md'), before);
  const old = await store.read(base, 'notes.md');
  const archived = await store.forget(base, { file: 'notes.md', reason: 'Regression', expected_revision: old.revision });
  assert.equal((await store.read(base)).content, before);
  assert.equal((await store.read(base, 'notes.md')).content, null);
  await store.restore(base, { file: 'notes.md', reason: 'Undo', archive_id: archived.archive_id, expected_revision: archived.revision });
  assert.equal((await store.read(base)).content, before);
});

for (const label of ['Human title', 'Человеческий заголовок', 'Different.filename', 'Title (with parentheses)']) for (const destination of ['notes.md', './notes.md', '<notes.md>', '<./notes.md>']) test('forget removes exact destination regardless label: ' + label + ' ' + destination, async () => {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-index-label-'))), store = new MemoryStore(join(base, 'memory'));
  const saved = await store.write(base, { file: 'notes.md', content: '# Notes\n', summary: 'Fact' });
  const preserve = '- [notes.md](other.md): same label, wrong destination\n- [Human title](notes-long.md): longer destination\n';
  const before = '# Project memory\r\n- [' + label + '](' + destination + '): old fact\r\n* [' + label + '](' + destination + ') \u2014 legacy fact\n' + preserve;
  await writeFile(join(saved.directory, 'MEMORY.md'), before);
  const old = await store.read(base, 'notes.md');
  const archived = await store.forget(base, { file: 'notes.md', reason: 'Regression', expected_revision: old.revision });
  assert.equal((await store.read(base)).content, '# Project memory\r\n' + preserve);
  await store.restore(base, { file: 'notes.md', reason: 'Undo', archive_id: archived.archive_id, expected_revision: archived.revision });
  assert.equal((await store.read(base)).content, before);
});

for (const preserved of [
  '- [Human title](notes.md): see [other](other.md)\n',
  '- [Human title](notes.md): see [other][ref]\n[ref]: other.md\n',
  '- [Human title](notes.md): see [other]\n[other]: other.md\n',
  '- [Human title](notes.md): see [other][]\n[other]: other.md\n',
  '- [Human [nested] title](notes.md): fact\n',
  '- [Escaped \\] title](notes.md): fact\n',
  '\x60\x60\x60md\n- [Human title](notes.md): example\n\x60\x60\x60\n',
  '    - [Human title](notes.md): code\n',
  '- [Human title](notes.md#anchor): different destination\n',
  '- [Human title](notes.md?query): different destination\n',
  '- [Human title](NOTES.md): case alias\n',
  '- [Human title](%6eotes.md): encoded alias\n',
  '- [Human title](notes.md "title"): ambiguous\n',
]) test('human-label removal preserves ambiguity ' + preserved.slice(0, 40), async () => {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-index-label-safe-'))), store = new MemoryStore(join(base, 'memory'));
  const saved = await store.write(base, { file: 'notes.md', content: '# Notes\n', summary: 'Fact' });
  const before = '# Project memory\n' + preserved + '- [Human title](notes.md): actual entry\n';
  await writeFile(join(saved.directory, 'MEMORY.md'), before);
  const old = await store.read(base, 'notes.md');
  await store.forget(base, { file: 'notes.md', reason: 'Regression', expected_revision: old.revision });
  assert.equal((await store.read(base)).content, '# Project memory\n' + preserved);
});

test('write replaces human-label standalone entries without touching unrelated prose', async () => {
  const base = canonical(await mkdtemp(join(tmpdir(), 'dsh-index-write-label-'))), store = new MemoryStore(join(base, 'memory'));
  const saved = await store.write(base, { file: 'notes.md', content: '# Notes\n', summary: 'Fact' });
  await writeFile(join(saved.directory, 'MEMORY.md'), '# Imported\n- [Human title](notes.md): old\nUnrelated prose\n');
  await store.write(base, { file: 'notes.md', content: '# Updated\n', summary: 'New', expected_revision: (await store.read(base, 'notes.md')).revision });
  assert.equal((await store.read(base)).content, '# Imported\nUnrelated prose\n- [notes.md](<notes.md>): New\n');
});
