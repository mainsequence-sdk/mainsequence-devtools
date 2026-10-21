// @ts-check
import { Plugin } from '@opencode/plugin';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import core from './dist/hosts/opencode.js';
import presentation from './dist/hosts/opencodePresentation.js';
import { MainSequence } from './rpc.mjs';
import { withNativePermissions } from './permissions.mjs';

/** @param {Record<string, unknown>} properties @param {string[]} required */
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const backendProperty = { backend: { type: 'string', description: 'Optional MainSequence backend URL.' } };
const uidProperty = { releaseUid: { type: 'string', description: 'Exact resource release UUID from discovery or saved connections.' } };
/** @param {unknown} value @returns {any} */
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** @param {import('./dist/shared/models.js').ActionResult} result */
function toolResult(result) {
  if (result.status !== 'success') throw new Error(result.summary + (result.effects ? '\n' + result.effects.message : '') +
    (result.data === undefined ? '' : '\n' + JSON.stringify(result.data)));
  const data = record(result.data);
  /** @type {import('@opencode/plugin/promise/tool').Result['content']} */
  const content = Array.isArray(data.content) ? data.content.map((/** @type {any} */ item) => {
    if (item.type === 'text') return { type: 'text', text: String(item.text) };
    if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') return { type: 'file', uri: `data:${item.mimeType};base64,${item.data}`, mime: item.mimeType };
    if (item.type === 'resource' && typeof item.resource?.text === 'string') return { type: 'text', text: item.resource.text };
    return { type: 'text', text: JSON.stringify(item) };
  }) : presentation.displayOpenCodeResult(result);
  return { content, output: result };
}

export default withNativePermissions(Plugin.define({
  id: 'mainsequence.devtools',
  async setup(ctx) {
    const extraBackends = new Set();
    /** @param {import('./dist/shared/models.js').ActionResult} result */
    const rememberBackend = result => {
      if (result.status === 'success' && result.action === 'mcp-add') {
        const backend = record(result.data).connection?.backend;
        if (typeof backend === 'string') extraBackends.add(backend);
      }
    };
    let installedNode;
    try { installedNode = JSON.parse(readFileSync(new URL('./runtime.json', import.meta.url), 'utf8')).nodePath; } catch { /* Uninstalled package: use PATH. */ }
    const controller = core.createOpenCodeController({
      cwd: ctx.location.directory,
      runner: fileURLToPath(new URL('./dist/runner.js', import.meta.url)),
      nodePath: typeof ctx.options.nodePath === 'string' ? ctx.options.nodePath : installedNode,
      env: { ...process.env, ...(typeof ctx.options.backend === 'string' ? { MAINSEQUENCE_ENDPOINT: ctx.options.backend } : {}) },
      emit: operation => { void registration?.events.emit('updated', operation).catch(() => {}); },
      completed: async result => { rememberBackend(result); if (result.status === 'success' && ['mcp-add', 'mcp-remove', 'login', 'logout', 'refresh-token'].includes(result.action)) await refresh(); },
    });
    /** @type {Array<{connection:any, tools:any[]}>} */
    let catalogs = [];
    let disposed = false;
    /** @type {Promise<import('./dist/shared/models.js').ActionResult> | undefined} */
    let refreshing;
    /** @param {AbortSignal | undefined} signal */
    async function refresh(signal = undefined) {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const saved = await controller.execute({ request: { action: 'mcp-list' } }, signal);
        const selections = saved.status === 'success' && Array.isArray(saved.data) ? [...saved.data] : [];
        const currentBackends = new Set(selections.map(connection => connection.backend));
        for (const backend of extraBackends) {
          if (currentBackends.has(backend) || signal?.aborted || disposed) continue;
          const extra = await controller.execute({ request: { action: 'mcp-list', backend } }, signal);
          if (extra.status === 'success' && Array.isArray(extra.data)) selections.push(...extra.data);
        }
        const next = [];
        const failures = [];
        if (saved.status === 'success') {
          for (const connection of selections) {
            if (disposed) break;
            const result = await controller.execute({ request: { action: 'mcp-tools', backend: connection.backend, releaseUid: connection.resource_release_uid } }, signal);
            if (result.status === 'success') next.push(record(result.data));
            else failures.push({ name: presentation.connectionLabel(connection), message: result.summary });
          }
        }
        catalogs = next;
        if (!disposed) await ctx.tool.reload();
        return saved.status !== 'success' ? saved : { schemaVersion: /** @type {const} */ (1), action: 'mcp-refresh',
          status: /** @type {const} */ ('success'), summary: `${next.length} project MCP catalogs refreshed.`, data: { connected: next.length, unavailable: failures } };
      })();
      try { return await refreshing; } finally { refreshing = undefined; }
    }
    const registration = await ctx.rpc.register(MainSequence, {
      start: async input => {
        const command = String(record(input).command);
        return controller.start({ command }, command.trim().replace(/^\/ms\s*/, '') === 'mcp-refresh' ? refresh : undefined);
      },
      get: async input => controller.get(String(record(input).id)),
      cancel: async input => controller.cancel(String(record(input).id)),
      state: async () => controller.state(),
      refresh: async (_input, context) => ({ ...await refresh(context.signal) }),
    });
    const commandRegistration = await ctx.command.transform(editor => {
      editor.add({ name: 'ms', description: 'MainSequence developer actions — executes directly without a model', execute: async ({ prompt }) => {
        const operation = controller.start({ command: prompt.text }, prompt.text.trim() === 'mcp-refresh' ? refresh : undefined);
        // Wait for execution before reporting the command complete; never call session.prompt/generate.
        while (!disposed && controller.get(operation.id)?.status === 'running') await new Promise(resolve => setTimeout(resolve, 50));
      } });
    });
    const toolRegistration = await ctx.tool.transform(editor => {
      editor.namespace({ name: 'mainsequence', description: 'Discover and connect MainSequence project MCPs using the existing developer login.' });
      /** @param {string} name @param {string} description @param {any} input @param {string} action */
      const add = (name, description, input, action) => editor.add({ name, description, input, output: {},
        options: { namespace: 'mainsequence', permission: `mainsequence_${name}`, codemode: true },
        execute: async (input, context) => {
          await context.progress({ status: description });
          if (action === 'mcp-refresh') return toolResult(await refresh(context.signal));
          const result = await controller.execute({ request: /** @type {import('./dist/shared/mcp.js').McpRequest} */ ({ ...record(input), action }) }, context.signal,
            message => { void context.progress({ status: message }); });
          rememberBackend(result);
          if (result.status === 'success' && (action === 'mcp-add' || action === 'mcp-remove')) await refresh(context.signal);
          return toolResult(result);
        },
      });
      add('discover', 'Find project MCPs by name and Environment. Supports pagination; discovery does not connect them.', schema({ ...backendProperty, search: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }), 'mcp-discover');
      add('connections', 'List saved project MCP selections.', schema(backendProperty), 'mcp-list');
      add('connect', 'Verify and save a selected project MCP, then register its live tools.', schema({ ...backendProperty, ...uidProperty }, ['releaseUid']), 'mcp-add');
      add('disconnect', 'Forget a selected MCP and remove its registered tools. Does not log out.', schema({ ...backendProperty, ...uidProperty }, ['releaseUid']), 'mcp-remove');
      add('tools', 'Read the current tool catalog for a connected project MCP.', schema({ ...backendProperty, ...uidProperty }, ['releaseUid']), 'mcp-tools');
      add('refresh', 'Refresh all selected project MCP tool registrations.', schema(), 'mcp-refresh');
      for (const { connection, tools } of catalogs) {
        const identity = createHash('sha256').update(connection.backend + '\n' + connection.resource_release_uid).digest('hex').slice(0, 24);
        const namespace = `mainsequence_project_${identity}`;
        const label = presentation.connectionLabel(connection);
        editor.namespace({ name: namespace, description: label });
        for (const tool of tools) {
          // Hash the original name as well: OpenCode normalizes punctuation, which can otherwise collide.
          const name = String(tool.name).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40) + '_' + createHash('sha256').update(tool.name).digest('hex').slice(0, 8);
          editor.add({ name, description: `${label}: ${tool.description || tool.name}`, input: tool.inputSchema, output: {},
            options: { namespace, permission: `${namespace}_${name}`, codemode: true },
            execute: async (input, context) => {
              return toolResult(await controller.execute({ request: { action: 'mcp-call', backend: connection.backend,
              releaseUid: connection.resource_release_uid, tool: tool.name, arguments: record(input) } }, context.signal,
              message => { void context.progress({ status: message }); }));
            },
          });
        }
      }
    });
    // Restore saved selections after the server has registered tools/RPC. No model is involved.
    void refresh().catch(() => {});
    return async () => { disposed = true; controller.dispose(); await commandRegistration.dispose(); await toolRegistration.dispose(); await registration.dispose(); };
  },
}));
