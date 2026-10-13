export const name = 'project-memory';
export const inject = ['agents', 'systemPrompt', 'tools', 'sandboxPolicy'];

// The packaged Loader caches ESM modules by URL for the process lifetime, so editing
// this package's files would otherwise never take effect. Keep this entry tiny and
// stable, and re-import the implementation with a per-activation cache-busting query.
export async function apply(ctx, config = {}) {
  const rev = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const [plugin, store] = await Promise.all([
    import(`./plugin.mjs?rev=${rev}`),
    import(`./store.mjs?rev=${rev}`)
  ]);
  return plugin.apply(ctx, config, store);
}
