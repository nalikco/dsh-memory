// Implementation module. Imported by index.mjs with a cache-busting query.
const string = description => ({ type: 'string', description });
const scopeParameter = {
  type: 'string',
  enum: ['project', 'global'],
  description: 'Which memory scope: "project" (default, tied to the current working directory) or "global" (shared across every project).'
};
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
    name: 'memory_list', description: 'List Markdown topics in persistent memory. Scope "project" covers only the current working directory; scope "global" is shared across every project. Read-only.',
    parameters: object({ scope: scopeParameter }), output, isConcurrencySafe: () => true,
    execute: async (args, exec) => { exec.signal.throwIfAborted(); return store.list(agentOf(exec).session.header?.cwd, args.scope); }
  });
  ctx.tools.register({
    name: 'memory_read', description: 'Read a complete memory topic or MEMORY.md and get the revision required for updates. Read matching topics before relying on the index. Scope "project" is the current working directory; scope "global" is shared across every project.',
    parameters: object({ file: string('Plain Markdown filename; defaults to MEMORY.md.'), scope: scopeParameter }), output, isConcurrencySafe: () => true,
    execute: async (args, exec) => { exec.signal.throwIfAborted(); return store.read(agentOf(exec).session.header?.cwd, args.file ?? 'MEMORY.md', args.scope); }
  });
  ctx.tools.register({
    name: 'memory_write', description: 'Save durable knowledge to a Markdown topic and update its index. Scope "project" (default) writes memory for the current working directory; scope "global" writes facts shared across every project, such as preferences, environment and cross-project conventions. Explicit persistence outside the workspace. Existing topics require the memory_read revision; history is retained. Disabled in read-only or plan mode. Never store credentials, guesses or temporary progress.',
    parameters: object({ file: string('Plain topic filename, not MEMORY.md.'), content: string('Complete Markdown topic content.'), summary: string('Single-line index description, at most 300 characters.'), expected_revision: string('Revision returned by memory_read. Required for updating an existing topic; recommended for creating after reading.'), scope: scopeParameter }, ['file', 'content', 'summary']),
    output,
    execute: async (args, exec) => {
      const agent = agentOf(exec);
      const assertWritable = () => {
        const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
        if (policy.mode === 'read-only') throw new Error('Memory writes are disabled by read-only policy');
        if (!['workspace-write', 'danger-full-access'].includes(policy.mode)) throw new Error('Unknown memory write policy');
        const plan = agent.ctx.get('planMode');
        const state = plan?.get(agent);
        if (state && (state.active || state.pending === true)) throw new Error('Memory writes are disabled in plan mode');
      };
      assertWritable(); exec.signal.throwIfAborted();
      return store.write(agent.session.header?.cwd, args, exec.signal, assertWritable, args.scope);
    }
  });
}
