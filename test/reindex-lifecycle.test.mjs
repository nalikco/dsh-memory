import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore,canonical} from '../store.mjs';
for(const summary of ['Use flags (carefully)','CODEX_HOME & data','[bad](missing.md) <x> `code`','back\\slash _bold_ *star* {curly} !bang |pipe'])test('canonical summary lifecycle: '+summary,async()=>{
 const cwd=canonical(await mkdtemp(join(tmpdir(),'dsh-reindex-cycle-')));const store=new MemoryStore(join(cwd,'memory'));
 await store.write(cwd,{file:'topic.md',content:'# Lesson\n',summary:'original'});
 const idx=await store.read(cwd);await store.reindex(cwd,{entries:[{file:'topic.md',summary}],expected_revision:idx.revision,reason:'Review'});
 const rendered=(await store.read(cwd)).content;assert.equal((rendered.match(/\]\(<topic.md>\)/g)||[]).length,1);
 const old=await store.read(cwd,'topic.md');await store.write(cwd,{file:'topic.md',content:'# Lesson updated\n',summary:'Updated fact',expected_revision:old.revision});
 assert.equal((await store.read(cwd)).content,'# Project memory\n- [topic.md](<topic.md>): Updated fact\n');
 const fresh=await store.read(cwd,'topic.md');const archive=await store.forget(cwd,{file:'topic.md',expected_revision:fresh.revision,reason:'Archive'});assert.equal((await store.read(cwd)).content,'# Project memory\n');
 await store.restore(cwd,{file:'topic.md',archive_id:archive.archive_id,expected_revision:archive.revision,reason:'Undo'});assert.equal((await store.read(cwd)).content,'# Project memory\n- [topic.md](<topic.md>): Updated fact\n');
});
