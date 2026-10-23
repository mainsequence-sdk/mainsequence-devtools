const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDevTools, createNodeHost, createSessionService, ToolingError, parseArguments, HELP,
  projectToolName, isProjectToolName, projectToolDefinition, projectToolDefinitions, projectToolResult, projectToolTimeoutMs,
  projectToolRegistration, readProjectToolCatalog, readProjectToolCatalogFile, createProjectToolCatalog, projectToolCatalogPath, mainSequenceStateDirectory } = require('../dist/index.js');

// The shared project-tool registry (ADR 0004). The catalog cases were the Codex plugin's
// tests/panel-tool-catalog.test.cjs before the registry moved here.
const backend = 'https://backend.example.test';
const environmentUid = '10000000-0000-4000-8000-000000000001';
const releaseUid = '30000000-0000-4000-8000-000000000001';
const row = { backend, resource_release_uid: releaseUid, name: 'Metrics', display_name: 'Research project',
  mcp_connection: { url: 'https://project.example.test/mcp', transport: 'streamable-http', resource_metadata_url: 'https://project.example.test/.well-known/oauth-protected-resource?resource_release_uid=' + releaseUid,
    organization_environment_uid: environmentUid, organization_environment_name: 'Research', active_revision_uid: '20000000-0000-4000-8000-000000000001' } };
const metrics = { name: 'metrics', description: 'Inspect metrics', inputSchema: { type: 'object', properties: { window: { type: 'string' } } }, annotations: { readOnlyHint: true, title: 'ignored' }, _meta: { 'mainsequence.ai/timeout-seconds/v1': 60 } };
const ok = (action, data) => ({ schemaVersion: 1, action, status: 'success', summary: 'ok', data });
const failure = (action, code, summary) => ({ schemaVersion: 1, action, status: 'failure', summary, error: { code, message: summary } });

async function fixture(t, respond) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'nested', 'project-tool-catalog.json');
  const actions = []; let notified = 0;
  const dispatch = () => async request => { actions.push(request); return respond(request, actions); };
  const catalog = createProjectToolCatalog({ file, dispatch, notify: () => { notified++; } });
  return { root, file, actions, catalog, notified: () => notified };
}
const healthy = (tools = [metrics], rows = [row]) => request => request.action === 'auth-status' ? ok(request.action, { backend, authenticated: true, source: 'machine' })
  : request.action === 'mcp-list' ? ok(request.action, rows)
  : request.action === 'mcp-tools' ? ok(request.action, { connection: row, tools })
  : failure(request.action, 'INVALID_REQUEST', 'unexpected ' + request.action);

test('tool names are the ones Claude Desktop registers, so one remote tool has one name in both hosts', () => {
  // Frozen vector: the name Claude registered for the CRM contacts list on the reference workstation.
  assert.equal(projectToolName('http://127.0.0.1:8000', '18595d12-f92a-4960-84cd-0c6798a1ad25', '2de75e21-bfe1-4b77-b668-6916488ed317', 'crm_contacts_list'), 'ms_crm_contacts_list_183f8138');
  assert.notEqual(projectToolName('http://local-backend:8000', '18595d12-f92a-4960-84cd-0c6798a1ad25', '2de75e21-bfe1-4b77-b668-6916488ed317', 'crm_contacts_list'), 'ms_crm_contacts_list_183f8138', 'the backend string is part of the identity');
  // Codex qualifies the name as mcp__mainsequence__<name> under 64 characters: 19 + 44.
  const long = projectToolName(backend, environmentUid, releaseUid, 'crm.prospecting/profiles-create-with-a-very-long-name');
  assert.match(long, /^ms_crm_prospecting_profiles-create-_[0-9a-f]{1,8}$/); assert.ok(long.length <= 44);
  assert.ok(isProjectToolName('ms_metrics_1')); assert.equal(isProjectToolName('mainsequence_open'), false); assert.equal(isProjectToolName(7), false);
});

test('definitions carry the shared description, an object schema, the four hints and the per-connection cap', () => {
  const definition = projectToolDefinition(row, metrics);
  assert.equal(definition.name, projectToolName(backend, environmentUid, releaseUid, 'metrics'));
  assert.equal(definition.title, 'Metrics: metrics');
  assert.equal(definition.description, 'MainSequence Metrics [Research]: Inspect metrics');
  assert.deepEqual(definition.inputSchema, metrics.inputSchema);
  assert.deepEqual(definition.annotations, { openWorldHint: true, readOnlyHint: true }, 'only the four boolean hints, open-world by default');
  // The label is the release's name, else its repository's name, else the release UID; the environment its name, else its UID.
  const nameless = { ...row, name: undefined, mcp_connection: { ...row.mcp_connection, organization_environment_name: undefined } };
  assert.equal(projectToolDefinition(nameless, { name: 'bare', inputSchema: { properties: {} } }).description, `MainSequence Research project [${environmentUid}]: bare`);
  assert.equal(projectToolDefinition({ ...nameless, display_name: '  ' }, { name: 'bare', inputSchema: {} }).description, `MainSequence ${releaseUid} [${environmentUid}]: bare`);
  assert.deepEqual(projectToolDefinition(row, { name: 'bare', inputSchema: { properties: {} } }).inputSchema, { type: 'object', properties: {} }, 'a schema without a type is an object schema');
  assert.deepEqual(projectToolDefinition(row, { name: 'closed', inputSchema: { type: 'object' }, annotations: { openWorldHint: false, destructiveHint: 'yes' } }).annotations, { openWorldHint: false });
  assert.equal(projectToolDefinitions(row, Array.from({ length: 130 }, (_, i) => ({ name: `tool_${i}`, inputSchema: { type: 'object' } }))).length, 80, 'registration keeps the 80-tool cap');
  assert.equal(projectToolDefinitions(row, [metrics, metrics, { name: 7 }, { name: 'noschema' }]).length, 1, 'duplicate and invalid tools are dropped');
});

test('projectToolResult is the shape both plugins built: remote blocks, one JSON block with summary, effects, error and structuredContent, isError on any failure', () => {
  // Pinned to the Claude Desktop hook's toolResult fixtures (claude-ui.test.cjs) before the registry moved here.
  const success = projectToolResult({ schemaVersion: 1, action: 'mcp-call', status: 'success', summary: 'The MCP tool completed.',
    data: { content: [{ type: 'text', text: 'Found 2 contacts' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: false, structuredContent: { count: 2 } } });
  assert.deepEqual(success.content.slice(0, 2), [{ type: 'text', text: 'Found 2 contacts' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], 'remote blocks pass through untouched');
  assert.deepEqual(JSON.parse(success.content[2].text), { summary: 'The MCP tool completed.', structuredContent: { count: 2 } });
  assert.deepEqual(success.structuredContent, { count: 2 }); assert.equal(success.isError, undefined);
  const plain = projectToolResult({ schemaVersion: 1, action: 'mcp-call', status: 'success', summary: 'ok', data: { content: [{ type: 'resource_link', uri: 'file:///report.pdf', name: 'report' }, 'junk', { type: 7 }] } });
  assert.deepEqual(plain, { content: [{ type: 'resource_link', uri: 'file:///report.pdf', name: 'report' }] }, 'a success with blocks and no structured content is the blocks alone');
  const failed = projectToolResult({ schemaVersion: 1, action: 'mcp-call', status: 'failure', summary: 'The connected MCP tool returned an error.', error: { code: 'MCP_TOOL_ERROR', message: 'The connected MCP tool returned an error.' },
    data: { content: [{ type: 'text', text: 'missing uid' }], isError: true }, effects: { state: 'partial-or-uncertain', message: 'verify' } });
  assert.equal(failed.isError, true); assert.equal(failed.content[0].text, 'missing uid', 'the remote tool\'s own content is preserved');
  assert.deepEqual(JSON.parse(failed.content[1].text), { summary: 'The connected MCP tool returned an error.', effects: { state: 'partial-or-uncertain', message: 'verify' }, error: { code: 'MCP_TOOL_ERROR', message: 'The connected MCP tool returned an error.' } });
  assert.deepEqual(failed.structuredContent, JSON.parse(failed.content[1].text), 'a failure without structured content carries the JSON block as structured content, as the Codex server returned it');
  // Pinned to the Codex server's expectation for a call refused before any project request.
  const refused = projectToolResult({ schemaVersion: 1, action: 'mcp-call', status: 'failure', summary: 'No session is saved for this backend. Run login.', error: { code: 'NOT_AUTHENTICATED', message: 'No session is saved for this backend. Run login.' } });
  assert.equal(refused.isError, true); assert.equal(refused.content.length, 1); assert.equal(refused.content[0].type, 'text');
  assert.equal(JSON.parse(refused.content[0].text).error.code, 'NOT_AUTHENTICATED'); assert.equal(refused.structuredContent.error.code, 'NOT_AUTHENTICATED');
  assert.equal(projectToolResult({ schemaVersion: 1, action: 'mcp-call', status: 'cancelled', summary: 'The MCP action was cancelled.', error: { code: 'CANCELLED', message: 'The MCP action was cancelled.' } }).isError, true);
});

test('a tool that advertises a longer run gets it, capped at 300 s; otherwise the default budget applies', () => {
  assert.equal(projectToolTimeoutMs(undefined), 120_000);
  assert.equal(projectToolTimeoutMs(metrics), 120_000, 'a hint below the default does not shorten it');
  assert.equal(projectToolTimeoutMs({ ...metrics, _meta: { 'mainsequence.ai/timeout-seconds/v1': 240 } }), 240_000);
  assert.equal(projectToolTimeoutMs({ ...metrics, _meta: { 'mainsequence.ai/timeout-seconds/v1': 900 } }), 300_000);
  assert.equal(projectToolTimeoutMs({ ...metrics, _meta: { 'mainsequence.ai/timeout-seconds/v1': 900 } }, 400_000), 400_000, 'a host that asks for more keeps its own budget');
  for (const hint of ['60', -1, 0, Infinity, NaN, null]) assert.equal(projectToolTimeoutMs({ ...metrics, _meta: { 'mainsequence.ai/timeout-seconds/v1': hint } }, 5_000), 5_000);
});

test('the catalog lives beside the saved connections in the shared state directory, and the CLI can read it', () => {
  const env = { APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' };
  assert.equal(path.dirname(projectToolCatalogPath(env)), mainSequenceStateDirectory(env));
  assert.equal(path.basename(projectToolCatalogPath()), 'project-tool-catalog.json');
  assert.match(mainSequenceStateDirectory(), process.platform === 'darwin' ? /Library\/Application Support\/MainSequenceCLI$/ : process.platform === 'win32' ? /MainSequenceCLI$/ : /\.config\/mainsequence$/);
  assert.deepEqual(parseArguments(['mcp-catalog', '--refresh', '--backend', backend]).request, { action: 'mcp-catalog', backend, refresh: 'force' });
  assert.deepEqual(parseArguments(['mcp-catalog']).request, { action: 'mcp-catalog', backend: undefined });
  assert.throws(() => parseArguments(['mcp-list', '--refresh']), { code: 'INVALID_REQUEST' });
  assert.match(HELP, /mcp-catalog \[--refresh\]/);
});

test('a damaged cache is an empty catalog; valid rows become definitions with the remote schema and bindings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-catalog-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'catalog.json');
  assert.equal(readProjectToolCatalogFile(file), null);
  await fs.writeFile(file, '{not json'); assert.equal(readProjectToolCatalogFile(file), null);
  await fs.writeFile(file, JSON.stringify({ version: 2, connections: [] })); assert.equal(readProjectToolCatalogFile(file), null);
  await fs.writeFile(file, JSON.stringify({ version: 1, updatedAt: 'x', connections: [
    { backend, releaseUid: releaseUid.toUpperCase(), environmentUid, environmentName: 'Research', name: 'Metrics', tools: [metrics, { name: 7 }, { name: 'noschema' }, { name: 'bare', inputSchema: { properties: {} } }] },
    { backend, releaseUid: 'not-a-uuid', environmentUid, tools: [] }, 'junk'] }));
  const catalog = readProjectToolCatalogFile(file);
  assert.equal(catalog.connections.length, 1); assert.equal(catalog.connections[0].releaseUid, releaseUid);
  assert.deepEqual(catalog.connections[0].tools.map(tool => tool.name), ['metrics', 'bare']);
  assert.deepEqual(catalog.connections[0].tools[0].annotations, { readOnlyHint: true }, 'only the four boolean hints survive');
  assert.equal('_meta' in catalog.connections[0].tools[0], false, 'the cache holds schemas and labels only');
  const { definitions, bindings } = projectToolRegistration(catalog);
  assert.equal(definitions[0].name, projectToolName(backend, environmentUid, releaseUid, 'metrics'));
  assert.equal(definitions[0].description, 'MainSequence Metrics [Research]: Inspect metrics');
  assert.deepEqual(definitions[0].inputSchema, metrics.inputSchema);
  assert.deepEqual(definitions[0].annotations, { openWorldHint: true, readOnlyHint: true });
  assert.deepEqual(definitions[1].inputSchema, { type: 'object', properties: {} }, 'a schema without a type is an object schema');
  assert.deepEqual(bindings.get(definitions[0].name), { backend, environmentUid, environmentName: 'Research', releaseUid, connection: 'Metrics', tool: 'metrics' });
  assert.deepEqual(projectToolRegistration(catalog, { backend: 'https://elsewhere.example.test' }).definitions, [], 'a scope selects connections by backend');
  assert.equal(projectToolRegistration(catalog, { backend, environmentUid: environmentUid.toUpperCase() }).definitions.length, 2, 'and by environment');
});

test('a scoped read replaces only the connections in scope, keeps an unreadable connection\'s earlier tools and propagates cancellation', async () => {
  const otherEnvironment = '10000000-0000-4000-8000-000000000002', otherRelease = '30000000-0000-4000-8000-000000000002';
  const previous = { version: 1, updatedAt: 'x', connections: [
    { backend, releaseUid, environmentUid, environmentName: 'Research', name: 'Old', tools: [{ name: 'stale', inputSchema: { type: 'object' }, annotations: {} }] },
    { backend, releaseUid: otherRelease, environmentUid: otherEnvironment, environmentName: 'Production', name: 'Other', tools: [metrics] },
    { backend: 'https://elsewhere.example.test', releaseUid, environmentUid, environmentName: 'Research', name: 'Elsewhere', tools: [metrics] }] };
  const actions = [];
  const read = await readProjectToolCatalog(async request => { actions.push(request); return healthy()(request); }, { backend, environmentUid, previous });
  assert.equal(read.backend, backend); assert.deepEqual(read.unavailable, []); assert.equal(read.retained, 0);
  assert.deepEqual(read.catalog.connections.map(c => [c.backend, c.name, c.tools.map(tool => tool.name)]),
    [[backend, 'Metrics', ['metrics']], [backend, 'Other', ['metrics']], ['https://elsewhere.example.test', 'Elsewhere', ['metrics']]], 'the other environment and the other backend are carried over');
  assert.deepEqual(actions.map(a => a.action), ['auth-status', 'mcp-list', 'mcp-tools']);
  assert.ok(actions.slice(1).every(a => a.environmentUid === environmentUid && a.backend === backend && a.expectedAccount === undefined));
  assert.equal(actions[1].readOnly, true);
  const degraded = await readProjectToolCatalog(async request => request.action === 'mcp-tools'
    ? failure(request.action, 'BACKEND_UNREACHABLE', 'The project MCP initialize request to https://project.example.test timed out after 120 s. It was not retried.') : healthy()(request), { backend, previous });
  assert.deepEqual(degraded.unavailable, ['Metrics']); assert.equal(degraded.retained, 1);
  assert.deepEqual(degraded.catalog.connections.map(c => [c.name, c.tools.map(tool => tool.name)]), [['Old', ['stale']], ['Elsewhere', ['metrics']]], 'an unscoped read covers the whole backend: the removed connection loses its tools, the unreadable one keeps them');
  await assert.rejects(readProjectToolCatalog(async request => request.action === 'mcp-tools'
    ? { schemaVersion: 1, action: request.action, status: 'cancelled', summary: 'stopped', error: { code: 'CANCELLED', message: 'stopped' } } : healthy()(request), { backend }), { code: 'CANCELLED' });
  await assert.rejects(readProjectToolCatalog(async request => ok(request.action, { backend, authenticated: false, source: 'none' }), { backend }), { code: 'NOT_AUTHENTICATED' });
  await assert.rejects(readProjectToolCatalog(healthy(), { backend, environmentUid: 'research' }), { code: 'INVALID_REQUEST' });
});

test('refresh reads every saved connection once, writes the cache without secrets and announces the change', async t => {
  const f = await fixture(t, healthy());
  assert.deepEqual(f.catalog.list(), []); assert.equal(f.catalog.state().count, 0);
  assert.equal(await f.catalog.refresh(true), true);
  assert.deepEqual(f.actions.map(a => a.action), ['auth-status', 'mcp-list', 'mcp-tools']);
  assert.equal(f.actions[1].readOnly, true); assert.equal(f.actions[2].backend, backend); assert.equal(f.actions[2].releaseUid, releaseUid);
  assert.equal(f.actions[2].expectedAccount, undefined, 'registered tools bind to the saved connection, not to an account snapshot');
  const [definition] = f.catalog.list();
  assert.equal(definition.name, projectToolName(backend, environmentUid, releaseUid, 'metrics'));
  assert.deepEqual(f.catalog.binding(definition.name), { backend, environmentUid, environmentName: 'Research', releaseUid, connection: 'Metrics', tool: 'metrics' });
  assert.equal(f.notified(), 1);
  const written = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(written.version, 1); assert.equal(written.connections[0].tools[0].name, 'metrics');
  assert.doesNotMatch(JSON.stringify(written), /mcp_connection|resource_metadata_url|token/);
  if (process.platform !== 'win32') assert.equal(((await fs.stat(f.file)).mode & 0o777).toString(8), '600');
  const state = f.catalog.state();
  assert.equal(state.count, 1); assert.deepEqual(state.connections, [{ backend, releaseUid, environmentUid, environmentName: 'Research', name: 'Metrics', tools: 1 }]);
  assert.equal(state.error, null); assert.equal(state.refreshing, false); assert.deepEqual(state.unavailable, []);
  const view = f.catalog.view({ backend });
  assert.equal(view.definitions.length, 1); assert.deepEqual(Object.keys(view.bindings), [definition.name]);
  // A fresh cache is not read again without force; a forced refresh with the same catalog announces nothing.
  assert.equal(await f.catalog.refresh(), false); assert.equal(f.actions.length, 3);
  await f.catalog.refresh(true); assert.equal(f.actions.length, 6); assert.equal(f.notified(), 1);
});

test('an unreadable connection keeps its earlier tools; a removed connection loses them', async t => {
  let mode = 'healthy';
  const f = await fixture(t, request => mode === 'healthy' || request.action !== 'mcp-tools' ? healthy(undefined, mode === 'removed' ? [] : [row])(request)
    : failure(request.action, 'BACKEND_UNREACHABLE', 'The project MCP initialize request to https://project.example.test timed out after 120 s. It was not retried.'));
  await f.catalog.refresh(true); const before = f.catalog.list();
  mode = 'failing'; await f.catalog.refresh(true);
  assert.deepEqual(f.catalog.list(), before); assert.deepEqual(f.catalog.state().unavailable, ['Metrics']); assert.equal(f.catalog.state().retained, 1); assert.equal(f.catalog.state().error, null);
  mode = 'removed'; await f.catalog.refresh(true);
  assert.deepEqual(f.catalog.list(), []); assert.deepEqual(f.catalog.state().unavailable, []); assert.equal(f.notified(), 2);
});

test('without a session nothing is read and the state says so; a signed-out refresh keeps the cached tools', async t => {
  let authenticated = true;
  const f = await fixture(t, request => request.action === 'auth-status' ? ok(request.action, { backend, authenticated, source: authenticated ? 'machine' : 'none' }) : healthy()(request));
  await f.catalog.refresh(true); authenticated = false; const count = f.actions.length;
  assert.equal(await f.catalog.refresh(true), false);
  assert.equal(f.actions.length, count + 1); assert.equal(f.catalog.state().error.code, 'NOT_AUTHENTICATED'); assert.equal(f.catalog.list().length, 1);
});

test('a listing is scoped to the current backend once a refresh learned it, so another backend\'s cached connections stay out of a host\'s tool list', async t => {
  const elsewhere = { backend: 'https://elsewhere.example.test', releaseUid, environmentUid, environmentName: 'Research', name: 'Elsewhere', tools: [metrics] };
  const f = await fixture(t, healthy());
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(f.file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), connections: [elsewhere] }));
  const catalog = createProjectToolCatalog({ file: f.file, dispatch: () => healthy(), notify: () => { f.changed = (f.changed || 0) + 1; } });
  assert.equal(catalog.list().length, 1, 'before the backend is known the whole cache is listed');
  assert.equal(await catalog.refresh(), false, 'the cache is fresh');
  assert.deepEqual(catalog.list(), [], 'knowing the backend scopes the listing'); assert.equal(f.changed, 1, 'and the change is announced');
  assert.equal(catalog.list({ backend: elsewhere.backend }).length, 1); assert.ok(catalog.binding(projectToolName(elsewhere.backend, environmentUid, releaseUid, 'metrics')), 'a binding resolves whatever its backend');
  await catalog.refresh(true);
  assert.deepEqual(catalog.list().map(d => d.description), ['MainSequence Metrics [Research]: Inspect metrics']);
  assert.equal(readProjectToolCatalogFile(f.file).connections.length, 2, 'the other backend\'s connection is kept in the shared file');
});

test('one process refreshes at a time; the others reuse its file, a stale lock is cleared, and a waiting refresh takes the lock when it is freed', async t => {
  const f = await fixture(t, healthy());
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(f.file + '.lock', '{"pid":1}');
  assert.equal(await f.catalog.refresh(true), false);
  assert.deepEqual(f.actions.map(a => a.action), ['auth-status'], 'a live lock means another process is already refreshing: only the session was checked');
  assert.equal(f.catalog.state().error, null, 'a background refresh that found a live lock is not an error');
  const old = new Date(Date.now() - 11 * 60_000); await fs.utimes(f.file + '.lock', old, old);
  await f.catalog.refresh(true); assert.equal(f.actions.length, 4); assert.equal(await fs.stat(f.file + '.lock').catch(e => e.code), 'ENOENT');
  const other = createProjectToolCatalog({ file: f.file, dispatch: () => async request => { if (request.action === 'auth-status') return healthy()(request); throw new Error('the other process must not read'); } });
  assert.equal(other.list().length, 1, 'a second server process reads the shared cache');
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.catalog.update(releaseUid, [metrics, { name: 'export', inputSchema: { type: 'object' } }]);
  assert.equal(other.list().length, 2, 'a change written by one process is visible to the next list of another');
  assert.equal(other.binding(projectToolName(backend, environmentUid, releaseUid, 'export')).tool, 'export');
  await other.refresh(); assert.equal(other.state().count, 2, 'a fresh shared cache is not refreshed again');
  // A refresh that may wait (the mcp-catalog action) takes the lock once the other process frees it, and reports when it cannot.
  await fs.writeFile(f.file + '.lock', '{"pid":1}');
  const count = f.actions.length;
  setTimeout(() => fs.rm(f.file + '.lock', { force: true }), 300);
  assert.equal(await f.catalog.refresh(true, { waitMs: 5_000 }), true); assert.equal(f.actions.length, count + 3);
  await fs.writeFile(f.file + '.lock', '{"pid":1}');
  assert.equal(await f.catalog.refresh(true, { waitMs: 300 }), false); assert.equal(f.catalog.state().error.code, 'PROJECT_BUSY');
  await fs.rm(f.file + '.lock', { force: true });
});

test('disposing a host mid-refresh aborts it and frees the shared lock immediately', async t => {
  let release;
  const f = await fixture(t, request => request.action === 'mcp-tools' ? new Promise(resolve => { release = () => resolve(healthy()(request)); }) : healthy()(request));
  const refresh = f.catalog.refresh(true);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await fs.stat(f.file + '.lock').then(() => true, () => false), true, 'the refresh holds the lock');
  f.catalog.dispose();
  assert.equal(await fs.stat(f.file + '.lock').then(() => true, e => e.code), 'ENOENT', 'the lock is freed synchronously');
  release(); await refresh;
  const other = createProjectToolCatalog({ file: f.file, dispatch: () => healthy() });
  await other.refresh(true); assert.equal(other.list().length, 1, 'the next host refreshes without waiting for the stale-lock timeout');
});

test('a disabled catalog still serves the cache but never reads or writes on its own', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-catalog-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'catalog.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, updatedAt: '2020-01-01T00:00:00.000Z', connections: [{ backend, releaseUid, environmentUid, environmentName: 'Research', name: 'Metrics', tools: [metrics] }] }));
  const catalog = createProjectToolCatalog({ file, disabled: true, dispatch: () => async () => { throw new Error('disabled catalogs do not dispatch'); } });
  assert.equal(catalog.list().length, 1);
  assert.equal(await catalog.refresh(true), false); await catalog.update(releaseUid, []);
  assert.equal(catalog.list().length, 1);
});

/** A real project MCP server behind the public dispatcher, with a fake platform session: the
 * mcp-catalog and mcp-tool-call actions, the per-tool timeout and the precise error messages. */
async function projectFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-project-tools-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = { mode: 'json', hint: undefined, invoked: 0, endpoint: undefined };
  const tool = () => ({ name: 'set_value', description: 'Write a fixture value', inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
    annotations: { destructiveHint: true }, ...(state.hint ? { _meta: { 'mainsequence.ai/timeout-seconds/v1': state.hint } } : {}) });
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const message = JSON.parse(text);
    const reply = result => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };
    if (req.headers.authorization !== 'Bearer fixture-release-token') return res.writeHead(401).end();
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} } });
    if (message.method === 'notifications/initialized') return res.writeHead(202).end();
    if (message.method === 'tools/list') return reply({ tools: [tool()] });
    if (message.method === 'tools/call') {
      state.invoked++;
      if (state.mode === 'hang') return;
      if (state.mode === '503') return res.writeHead(503).end('busy');
      if (state.mode === 'rpc-error') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'value must be a number\u0007 fixture-release-token' } })); }
      return reply({ content: [{ type: 'text', text: 'value=' + message.params.arguments.value }], structuredContent: { value: message.params.arguments.value }, isError: state.mode === 'tool-error' });
    }
    res.writeHead(400).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const project = 'http://127.0.0.1:' + server.address().port;
  const endpoint = () => state.endpoint || project;
  const connection = () => ({ backend, resource_release_uid: releaseUid, name: 'metatable-mcp', mcp_connection: { url: endpoint() + '/mcp', transport: 'streamable-http',
    resource_metadata_url: backend + '/.well-known/oauth-protected-resource/mcp?resource_release_uid=' + releaseUid,
    organization_environment_uid: environmentUid, organization_environment_name: 'Research', active_revision_uid: '20000000-0000-4000-8000-000000000001' } });
  const connections = path.join(dir, 'connections.json'), catalogFile = path.join(dir, 'project-tool-catalog.json');
  const save = () => fs.writeFile(connections, JSON.stringify([connection()]));
  await save();
  const unsupported = async () => { throw new ToolingError('UNSUPPORTED_ACTION', 'fixture'); };
  const session = { sanitize: value => value.split('fixture-release-token').join('[redacted]'),
    status: async input => ({ backend: input, authenticated: true, source: 'environment', persistence: 'environment', store: null, username: 'fixture-user' }),
    login: unsupported, refresh: unsupported, logout: unsupported,
    request: async (input, method, apiPath) => {
      if (apiPath === '/api/v1/resource-releases/' + releaseUid + '/') return { uid: releaseUid, release_kind: 'fastapi', mcp_connection: connection().mcp_connection };
      if (apiPath === '/api/v1/resource-releases/' + releaseUid + '/exchange-launch/') return { mode: 'token', release_kind: 'fastapi', token: 'fixture-release-token', rpc_url: endpoint() + '/' };
      throw new ToolingError('API_ERROR', 'unexpected ' + method + ' ' + apiPath);
    } };
  const create = (extra = {}) => createDevTools({ host: createNodeHost(), session, env: {}, mcpConnectionsPath: connections, projectToolCatalogPath: catalogFile, projectRequestTimeoutMs: 300, ...extra });
  return { dir, state, project, connections, catalogFile, create, save };
}

test('mcp-catalog answers from the shared file at once, re-reads the saved connections on request and scopes by environment', async t => {
  const f = await projectFixture(t);
  const cached = await f.create().dispatch({ action: 'mcp-catalog', backend });
  assert.equal(cached.status, 'success', cached.summary); assert.equal(cached.data.count, 0); assert.equal(cached.data.refreshed, false); assert.equal(cached.data.file, f.catalogFile);
  assert.match(cached.summary, /from the shared catalog/);
  const refreshed = await f.create().dispatch({ action: 'mcp-catalog', backend, environmentUid, refresh: 'force' });
  assert.equal(refreshed.status, 'success', refreshed.summary); assert.equal(refreshed.data.refreshed, true); assert.equal(refreshed.data.count, 1);
  assert.match(refreshed.summary, /1 project MCP tools from 1 saved connections, catalogs re-read\./);
  const name = projectToolName(backend, environmentUid, releaseUid, 'set_value');
  assert.deepEqual(refreshed.data.definitions.map(d => [d.name, d.description, d.annotations]), [[name, 'MainSequence metatable-mcp [Research]: Write a fixture value', { openWorldHint: true, destructiveHint: true }]]);
  assert.deepEqual(refreshed.data.bindings[name], { backend, environmentUid, environmentName: 'Research', releaseUid, connection: 'metatable-mcp', tool: 'set_value' });
  assert.deepEqual(refreshed.data.connections, [{ backend, releaseUid, environmentUid, environmentName: 'Research', name: 'metatable-mcp', tools: 1 }]);
  assert.equal(refreshed.data.environmentUid, environmentUid); assert.deepEqual(refreshed.data.unavailable, []); assert.equal(refreshed.data.error, null);
  assert.doesNotMatch(await fs.readFile(f.catalogFile, 'utf8'), /fixture-release-token|resource_metadata_url/);
  const again = await f.create().dispatch({ action: 'mcp-catalog', backend });
  assert.equal(again.data.count, 1, 'the next process registers from the file without a network request'); assert.equal(again.data.refreshed, false);
  assert.equal((await f.create().dispatch({ action: 'mcp-catalog', backend, environmentUid: '10000000-0000-4000-8000-000000000009' })).data.count, 0, 'another environment sees none of them');
  assert.equal((await f.create().dispatch({ action: 'mcp-catalog', backend, refresh: true })).data.refreshed, false, 'a fresh cache is not re-read without force');
  assert.equal((await f.create().dispatch({ action: 'mcp-catalog', backend, environmentUid: 'research' })).error.code, 'INVALID_REQUEST');
  assert.equal((await f.create().dispatch({ action: 'mcp-catalog', backend, refresh: 'yes' })).error.code, 'INVALID_REQUEST');
  // A failed re-read reports why and still returns what the file holds.
  f.state.endpoint = 'https://127.0.0.1:1'; await f.save();
  const degraded = await f.create().dispatch({ action: 'mcp-catalog', backend, refresh: 'force' });
  assert.equal(degraded.status, 'success', degraded.summary); assert.deepEqual(degraded.data.unavailable, ['metatable-mcp']); assert.equal(degraded.data.retained, 1); assert.equal(degraded.data.count, 1);
  assert.match(degraded.summary, /metatable-mcp could not be read now; earlier tools stay registered/);
});

test('mcp-tool-call answers in the shared result shape and honours a tool\'s advertised timeout', async t => {
  const f = await projectFixture(t);
  const call = extra => f.create().dispatch({ action: 'mcp-tool-call', backend, environmentUid, releaseUid, tool: 'set_value', arguments: { value: 4 }, ...extra });
  const result = await call();
  assert.equal(result.status, 'success', result.summary); assert.equal(result.action, 'mcp-tool-call'); assert.equal(result.summary, 'The MCP tool completed.');
  assert.deepEqual(result.data.content[0], { type: 'text', text: 'value=4' }); assert.deepEqual(JSON.parse(result.data.content[1].text), { summary: 'The MCP tool completed.', structuredContent: { value: 4 } });
  assert.deepEqual(result.data.structuredContent, { value: 4 }); assert.equal(result.data.isError, undefined);
  f.state.mode = 'tool-error';
  const refused = await call();
  assert.equal(refused.status, 'failure'); assert.equal(refused.error.code, 'MCP_TOOL_ERROR'); assert.equal(refused.data.isError, true);
  assert.equal(refused.data.content[0].text, 'value=4'); assert.equal(JSON.parse(refused.data.content[1].text).error.code, 'MCP_TOOL_ERROR'); assert.equal(refused.effects.state, 'partial-or-uncertain');
  assert.equal((await call({ tool: 'missing' })).data.structuredContent.error.code, 'INVALID_REQUEST', 'a refusal before the call is the JSON block alone');
  // The default project budget is 120 s; this fixture lowers it to 0.3 s. A tool that advertises
  // one second gets one second: the hint is honoured when it is larger than the budget.
  f.state.mode = 'hang';
  let started = Date.now(), timeout = await call();
  assert.equal(timeout.error.code, 'BACKEND_UNREACHABLE'); assert.match(timeout.summary, /^The project MCP tools\/call set_value request to http:\/\/127\.0\.0\.1:\d+ timed out after 0\.3 s\. It was not retried\.$/);
  assert.equal(timeout.effects.state, 'partial-or-uncertain', 'a timed-out call may have run');
  f.state.hint = 1; started = Date.now(); timeout = await call();
  assert.match(timeout.summary, /timed out after 1 s/); assert.ok(Date.now() - started >= 900, 'the advertised second was waited for');
});

test('errors say which endpoint answered which request: HTTP status, redacted JSON-RPC message, timeout or connection failure', async t => {
  const f = await projectFixture(t);
  const call = () => f.create().dispatch({ action: 'mcp-call', backend, releaseUid, tool: 'set_value', arguments: { value: 1 } });
  f.state.mode = '503';
  const status = await call();
  assert.equal(status.error.code, 'API_ERROR'); assert.match(status.summary, /^The project MCP http:\/\/127\.0\.0\.1:\d+ returned HTTP 503 for tools\/call set_value\.$/);
  f.state.mode = 'rpc-error';
  const rejected = await call();
  assert.equal(rejected.error.code, 'API_ERROR');
  assert.match(rejected.summary, /^The MCP endpoint rejected tools\/call set_value \(JSON-RPC -32602\): value must be a number \[redacted\]$/, 'the server\'s own message, without control characters or credentials');
  // A closed port: the release credential exchange succeeds, the project's initialize cannot connect.
  const closed = http.createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
  f.state.endpoint = 'http://127.0.0.1:' + port; await f.save();
  const unreachable = await call();
  assert.equal(unreachable.error.code, 'BACKEND_UNREACHABLE');
  assert.match(unreachable.summary, new RegExp(`^The project MCP initialize request to http://127\\.0\\.0\\.1:${port} failed before a response arrived \\(ECONNREFUSED\\)\\. It was not retried\\.$`));
  assert.equal(unreachable.effects, undefined, 'nothing was invoked');
  // The platform session names the backend, method and path the same way.
  const platform = (fetch, options = {}) => createSessionService(createNodeHost(), { env: { MAINSEQUENCE_ENDPOINT: backend, MAINSEQUENCE_ACCESS_TOKEN: 'fixture-platform-token' }, store: null, fetch, ...options });
  await assert.rejects(platform(async () => new Response('busy', { status: 503 })).request(backend, 'GET', '/api/v1/code-repositories/'),
    error => error.code === 'API_ERROR' && error.message === `The backend ${backend} returned HTTP 503 for GET /api/v1/code-repositories/.`);
  await assert.rejects(platform(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); }).request(backend, 'GET', '/api/v1/code-repositories/'),
    error => error.code === 'BACKEND_UNREACHABLE' && error.message === `The backend ${backend} could not be reached for GET /api/v1/code-repositories/: ECONNREFUSED. The saved session has been kept.`);
  await assert.rejects(platform((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), { requestTimeoutMs: 50 }).request(backend, 'POST', '/api/v1/agents/', {}),
    error => error.code === 'BACKEND_UNREACHABLE' && error.message === `The backend ${backend} could not be reached for POST /api/v1/agents/: the request timed out after 0.1 s. The saved session has been kept.`);
});
