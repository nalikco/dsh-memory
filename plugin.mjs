// Implementation module. Imported by index.mjs with a cache-busting query.
const string = description => ({ type: 'string', description });
const scopeParameter = {
  type: 'string',
  enum: ['project', 'global'],
  description: 'Which memory scope: "project" (default, tied to the current working directory) or "global" (shared across every project).'
};
const projectParameter = string('Exact absolute registered project cwd from memory_projects. Not a directory/store path or alias. Project scope only; omit for current project.');
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
};
const budget = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid project memory ${label} budget`);
  return value;
};

export function apply(ctx, config = {}, { MemoryStore, DEFAULT_ROOT }) {
  const store = new MemoryStore(config.root ?? DEFAULT_ROOT);
  const maxLines = budget(config.maxIndexLines ?? 200, 1, 2000, 'index line');
  const maxBytes = budget(config.maxIndexBytes ?? 20000, 100, 100000, 'index byte');
  const maxGlobalLines = budget(config.maxGlobalIndexLines ?? 40, 1, 2000, 'global index line');
  const maxGlobalBytes = budget(config.maxGlobalIndexBytes ?? 4096, 100, 100000, 'global index byte');
  const agentOf = exec => {
    const agent = exec.agent && ctx.agents.get(exec.agent.id);
    if (!agent?.session) throw new Error('Project memory requires a live agent');
    return agent;
  };
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    const agent = ctx.agents.list().find(a => a === context.scope);
    if (!agent?.session) return result;
    context.signal?.throwIfAborted();
    const text = await store.context(agent.session.header?.cwd, { maxLines, maxBytes }, { maxLines: maxGlobalLines, maxBytes: maxGlobalBytes });
    return { ...result, contexts: [...result.contexts.filter(c => c.name !== 'project-memory'), { name: 'project-memory', text }] };
  });
  ctx.tools.register({
    name: 'memory_projects', description: 'Read-only discovery of registered project memory identities. Returns exact absolute cwd selectors; does not register projects or create stores.',
    parameters: object({}), output, isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted(); agentOf(exec);
      const projects = (await store.projects()).map(p => ({ cwd: p.cwd, directory: p.dir }));
      exec.signal.throwIfAborted(); return { projects };
    }
  });
  ctx.tools.register({
    name: 'memory_list', description: 'List Markdown topics in persistent memory. Scope "project" defaults to the current project; optional project selects an exact registered cwd; scope "global" is shared across every project. Read-only.',
    parameters: object({ scope: scopeParameter, project: projectParameter }), output, isConcurrencySafe: () => true,
    execute: async (args, exec) => { exec.signal.throwIfAborted(); return store.list(agentOf(exec).session.header?.cwd, args.scope, args.project); }
  });
  ctx.tools.register({
    name: 'memory_read', description: 'Read a complete memory topic or MEMORY.md and get the revision required for updates. Read matching topics before relying on the index. Scope "project" defaults to the current working directory; optional project selects a registered cwd; scope "global" is shared across every project.',
    parameters: object({ file: string('Plain Markdown filename; defaults to MEMORY.md.'), scope: scopeParameter, project: projectParameter }), output, isConcurrencySafe: () => true,
    execute: async (args, exec) => { exec.signal.throwIfAborted(); return store.read(agentOf(exec).session.header?.cwd, args.file ?? 'MEMORY.md', args.scope, args.project); }
  });
  ctx.tools.register({
    name: 'memory_write', description: 'Save selective cross-session knowledge, not a work log, and update its index. Use only for reusable preferences/corrections, non-obvious constraints/rationale or external references not already recoverable from code, Git or instructions. Most tasks need no write; update an existing subject, never create checkpoint/push/test/deploy diaries. Scope "project" (default) writes memory for the current working directory; scope "global" writes facts shared across every project, such as preferences, environment and cross-project conventions. Explicit persistence outside the workspace. Existing topics require the memory_read revision; history is retained. Disabled in read-only or plan mode. Optional project selects an exact registered cwd; cross-project writes require danger-full-access. Never store credentials, guesses or temporary progress.',
    parameters: object({ file: string('Plain topic filename, not MEMORY.md.'), content: string('Complete Markdown topic content.'), summary: string('Single-line index description, at most 300 characters.'), expected_revision: string('Revision returned by memory_read. Required for updating an existing topic; recommended for creating after reading.'), scope: scopeParameter, project: projectParameter }, ['file', 'content', 'summary']),
    output,
    execute: (args, exec) => mutate('write', args, exec)
  });
  ctx.tools.register({
    name: 'memory_reindex',
    description: 'Authorized maintenance: reset MEMORY.md to a clean canonical index, intentionally replacing all imported prose. Supply complete entries for every current top-level topic, including unindexed topics, current MEMORY.md revision and reason. Exact previous/next index is archived in history; topic bodies are unchanged. No arbitrary index text. Disabled in read-only/plan mode; cross-project mutation requires danger-full-access.',
    parameters: object({ entries: { type: 'array', items: object({ file: string('Exact stored plain topic filename, including case; not MEMORY.md.'), summary: string('Nonempty single-line summary, at most 300 characters, without control characters; rendered as literal text.') }, ['file', 'summary']) },
      expected_revision: string('Current revision from memory_read for MEMORY.md, including a missing-index revision.'),
      reason: string('Explicit index reset reason; nonempty single line, at most 300 characters, without control characters.'),
      scope: scopeParameter, project: projectParameter
    }, ['entries', 'expected_revision', 'reason']),
    output, execute: (args, exec) => mutate('reindex', args, exec)
  });
  for (const operation of ['forget', 'restore']) {
    ctx.tools.register({
      name: 'memory_' + operation,
      description: operation === 'forget' ?
        'Archive a topic and remove its standalone index entries. Requires current memory_read revision and reason. Retains exact recovery bytes, returns opaque archive_id. Not secure erasure. Disabled in read-only/plan mode; cross-project mutation requires danger-full-access.' :
        'Undo memory_forget using its opaque archive_id, current missing-topic revision and reason. Requires exact post-forget state, including index. Never accepts arbitrary history paths. Disabled in read-only/plan mode; cross-project mutation requires danger-full-access.',
      parameters: object({ file: string('Plain topic filename, not MEMORY.md.'),
        expected_revision: string('Current revision returned by memory_read for this topic.'),
        reason: string('Nonempty single-line reason, at most 300 characters; no control characters.'),
        ...(operation === 'restore' ? { archive_id: string('Opaque archive_id returned by memory_forget; never a path.') } : {}),
        scope: scopeParameter, project: projectParameter
      }, ['file', 'expected_revision', 'reason', ...(operation === 'restore' ? ['archive_id'] : [])]),
      output, execute: (args, exec) => mutate(operation, args, exec)
    });
  }
  async function mutate(operation, args, exec) {
    const agent = agentOf(exec);
    const session = agent.session;
    const cwd = session.header?.cwd;
    let crossProject = args.project !== undefined; // Fail closed before async resolution.
    const assertWritable = (target, current) => {
      if (target && args.project !== undefined) crossProject = !current || target.cwd !== current.cwd;
      exec.signal.throwIfAborted();
      if (agentOf(exec) !== agent || agent.session !== session || session.header?.cwd !== cwd) throw new Error('Memory session identity changed');
      const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
      if (policy.mode === 'read-only') throw new Error('Memory writes are disabled by read-only policy');
      if (!['workspace-write', 'danger-full-access'].includes(policy.mode)) throw new Error('Unknown memory write policy');
      const state = agent.ctx.get('planMode')?.get(agent);
      if (state && (state.active || state.pending === true)) throw new Error('Memory writes are disabled in plan mode');
      if (crossProject && policy.mode !== 'danger-full-access') throw new Error('Cross-project memory writes require danger-full-access');
    };
    // Resolve identity without mutation; only an exact current project is allowed
    // under workspace-write. An absent cwd never grants current-project authority.
    exec.signal.throwIfAborted();
    const selected = await store.target(args.scope, cwd, args.project);
    if (args.project !== undefined) {
      const current = cwd ? await store.target('project', cwd) : null;
      crossProject = !current || selected.cwd !== current.cwd;
    } else crossProject = false;
    assertWritable();
    return store[operation](cwd, args, exec.signal, assertWritable, args.scope);
  }
}
