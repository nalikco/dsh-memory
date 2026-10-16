import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore,canonical} from '../store.mjs';
import {apply} from '../plugin.mjs';

test('context promotes selective memory and explicitly rejects work diaries',async()=>{
 const base=canonical(await mkdtemp(join(tmpdir(),'dsh-selective-')));const store=new MemoryStore(join(base,'memory'));
 const context=await store.context(base);
 for(const term of ['Most tool results and completed tasks need no memory write','current code, Git history, instructions or a fresh lookup','commit/push/deploy checkpoints','test counts/logs','fixed/unfixed status','do not write','update the matching one','Past consent is never standing authorization']) assert.ok(context.includes(term),term);
 assert.ok(!context.includes('Save durable discoveries and user corrections immediately'));
 await assert.rejects(readdir(store.root),{code:'ENOENT'});
 const tools=new Map();apply({agents:{get:()=>{},list:()=>[]},on:()=>{},tools:{register:t=>tools.set(t.name,t)}},{root:store.root},{MemoryStore});
 assert.match(tools.get('memory_write').description,/Most tasks need no write/);
 assert.match(tools.get('memory_write').description,/not already recoverable from code, Git or instructions/);
});

test('global-only sessions retain selective-write guidance',async()=>{
 const base=canonical(await mkdtemp(join(tmpdir(),'dsh-selective-global-')));const store=new MemoryStore(join(base,'memory'));
 await store.write(null,{file:'preference.md',content:'# Preference\n',summary:'preference'},undefined,undefined,'global');
 const context=await store.context(null);assert.ok(context.includes('Most steps need no write'));assert.ok(context.includes('never store a session work log or deployment status'));
});
