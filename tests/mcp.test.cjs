const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDevTools, createNodeHost } = require('../dist/index.js');
const { parseArguments } = require('../dist/shared/arguments.js');
const { readMcpResponse } = require('../dist/shared/mcpTransport.js');
const { memoryStore } = require('./helpers.cjs');
const { saveSession, readSession } = require('../dist/shared/machineSession.js');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-mcp-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [], state = { denied: false, mode: 'json', token: 'private-release-credential', exchanged: 0, invoked: 0,
    labels: true, labelsDenied: false, branchDenied: false, branchMismatch: false };
  const uid = 'b0a5ee29-f649-46ab-a040-38504838a131';
  const secondUid = 'b0a5ee29-f649-46ab-a040-38504838a132';
  const branchUid = 'c1d2e3f4-0000-4000-8000-000000000001';
  const tool = { name: 'set_value', description: 'Write a fixture value', inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    annotations: { readOnlyHint: false, destructiveHint: true } };
  const listen = async handler => {
    const server = http.createServer(async (req, res) => {
      try { await handler(req, res); } catch { res.writeHead(500).end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return 'http://127.0.0.1:' + server.address().port;
  };
  const body = async req => { let text = ''; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : undefined; };
  const reply = (res, id, result) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
  const project = await listen(async (req, res) => {
    const message = await body(req);
    calls.push({ server: 'project', path: req.url, method: message?.method, authorization: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer ' + state.token) return res.writeHead(401).end();
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/mcp');
    assert.equal(req.headers['mcp-protocol-version'], '2025-11-25');
    assert.match(req.headers.accept, /application\/json/); assert.match(req.headers.accept, /text\/event-stream/);
    if (message.method === 'initialize') {
      if (state.mode === 'stateful') res.setHeader('Mcp-Session-Id', 'unsupported-session');
      return reply(res, message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
    }
    if (message.method === 'notifications/initialized') return res.writeHead(202).end();
    if (message.method === 'tools/list') return reply(res, message.id, message.params.cursor
      ? { tools: [tool] } : { tools: [{ name: 'read_value', inputSchema: { type: 'object' } }], nextCursor: 'page-2' });
    if (message.method === 'tools/call') {
      state.invoked++;
      if (state.mode === 'disconnect') return req.socket.destroy();
      if (state.mode === 'timeout') return;
      if (state.mode === 'redirect') return res.writeHead(307, { location: '/other' }).end();
      const result = { content: [{ type: 'text', text: 'value=' + message.params.arguments.value + ' ' + state.token }],
        structuredContent: { value: message.params.arguments.value, nested: [state.token] }, isError: state.mode === 'tool-error' };
      if (state.mode === 'sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': keepalive\r\n\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\r\n\r\n');
        return res.end('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\r\n\r\n');
      }
      return reply(res, state.mode === 'wrong-id' ? message.id + 1 : message.id, result);
    }
    res.writeHead(400).end();
  });
  let backend;
  const row = (releaseUid = uid) => ({ uid: releaseUid, name: 'metatable-mcp', release_kind: 'fastapi',
    mcp_connection: { url: state.endpoint || project + '/mcp', transport: 'streamable-http',
      resource_metadata_url: backend + '/.well-known/oauth-protected-resource/mcp?resource_release_uid=' + releaseUid,
      organization_environment_uid: 'ba034541-73b4-4c5b-81ad-16516d8a8f94', active_revision_uid: '21fe3fba-e8fa-4010-b2bd-4a16d873ec28' } });
  backend = await listen(async (req, res) => {
    const message = await body(req);
    calls.push({ server: 'platform', path: req.url, method: message?.method, authorization: req.headers.authorization });
    if (req.url === '/auth/jwt-token/token/refresh/') {
      assert.equal(message.refresh, 'private-refresh-token');
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ access: 'private-platform-token', refresh: 'private-rotated-refresh' }));
    }
    if (req.headers.authorization !== 'Bearer private-platform-token') return res.writeHead(401).end();
    if (req.url === '/mcp') {
      if (message.method === 'initialize') return reply(res, message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} } });
      if (message.method === 'notifications/initialized') return res.writeHead(202).end();
      assert.equal(message.params.name, 'resource_release.mcp_endpoints');
      return reply(res, message.id, { content: [], structuredContent: { count: 2, results: [uid, secondUid].map(id => {
        const value = row(id); value.resource_release_uid = value.uid; delete value.uid; value.code_repository_branch_uid = branchUid; return value;
      }) } });
    }
    if (state.denied) return res.writeHead(403).end();
    if (req.url.startsWith('/api/v1/resource-releases/?')) {
      // The directory projection names a release and its repository branch; the detail below does not.
      if (!state.labels) return res.writeHead(404).end('{}');
      if (state.labelsDenied) return res.writeHead(403).end();
      const search = new URL(req.url, backend).searchParams.get('search') || '';
      const results = [uid, secondUid].filter(id => id.includes(search)).map(id => ({ uid: id, name: 'metatable-mcp', release_kind: 'fastapi', code_repository_branch_uid: branchUid }));
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ count: results.length, results }));
    }
    if (req.url === '/api/v1/code-repository-branches/' + branchUid + '/') {
      if (state.branchDenied) return res.writeHead(403).end();
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ uid: state.branchMismatch ? secondUid : branchUid, code_repository_uid: 'repo-1', code_repository_name: 'MetaTablesApi', repository_branch: 'main', is_initialized: true }));
    }
    if (req.url === '/api/v1/resource-releases/' + uid + '/' || req.url === '/api/v1/resource-releases/' + secondUid + '/') {
      const value = row(req.url.includes(secondUid) ? secondUid : uid);
      // Release detail has capability metadata, but no discovery-only display name.
      delete value.name;
      value.mcp_enabled = !state.noMcp;
      if (state.noMcp) value.mcp_connection = null;
      Object.assign(value, state.detail);
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(value));
    }
    if (req.url.endsWith('/exchange-launch/')) {
      state.exchanged++; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ mode: 'token', release_kind: 'fastapi', token: state.token, rpc_url: state.rpc || project + '/' }));
    }
    res.writeHead(404).end();
  });
  const file = path.join(dir, 'connections.json');
  const create = extra => createDevTools({ host: createNodeHost(), env: { MAINSEQUENCE_ENDPOINT: backend, MAINSEQUENCE_ACCESS_TOKEN: 'private-platform-token' },
    mcpConnectionsPath: file, requestTimeoutMs: 500, ...extra });
  const dispatch = (action, extra = {}, instance = create()) => instance.dispatch({ action, backend, releaseUid: uid, ...extra });
  return { dir, file, uid, secondUid, branchUid, backend, row, project, calls, state, create, dispatch };
}

test('conversation workflow discovers, saves, immediately calls and remembers MCP connections across client instances', async t => {
  const f = await fixture(t);
  const discovered = await f.dispatch('mcp-discover');
  assert.equal(discovered.status, 'success'); assert.equal(discovered.data.count, 2);
  assert.equal((await f.dispatch('mcp-list')).data.length, 0);
  const added = await f.dispatch('mcp-add');
  assert.equal(added.status, 'success'); assert.equal(added.data.tools.length, 2);
  assert.equal(added.data.tools[1].annotations.destructiveHint, true, 'ordinary write tools are available');
  await f.dispatch('mcp-add'); assert.equal((await f.dispatch('mcp-list')).data.length, 1, 'repeat add is idempotent');
  const invoked = await f.dispatch('mcp-call', { tool: 'set_value', arguments: { value: 42 } }, f.create());
  assert.equal(invoked.status, 'success'); assert.equal(invoked.data.structuredContent.value, 42);
  assert.equal(f.state.invoked, 1);
  assert.equal((await f.dispatch('mcp-add', { releaseUid: f.secondUid })).status, 'success');
  assert.equal((await f.dispatch('mcp-list')).data.length, 2, 'same display name is disambiguated by UID');
  for (const output of [discovered, added, invoked, await f.dispatch('mcp-tools'), await fs.readFile(f.file, 'utf8')]) {
    assert.doesNotMatch(JSON.stringify(output), /private-platform-token|private-release-credential|private-refresh-token/);
  }
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.ok(f.calls.filter(c => c.server === 'project').every(c => c.authorization === 'Bearer private-release-credential'));
  assert.equal((await f.create().dispatch({ action: 'mcp-list', backend: 'https://other.example' })).data.length, 0);
  assert.equal((await f.dispatch('mcp-remove')).status, 'success');
  assert.equal((await f.dispatch('mcp-list')).data.length, 1);
  assert.equal((await f.dispatch('mcp-call', { tool: 'set_value', arguments: {} })).status, 'failure');
});

test('release detail and saved connections work without a display name or another discovery request', async t => {
  const f = await fixture(t);
  f.state.labels = false;
  const detail = await fetch(f.backend + '/api/v1/resource-releases/' + f.uid + '/', {
    headers: { Authorization: 'Bearer private-platform-token' },
  }).then(response => response.json());
  assert.equal(Object.hasOwn(detail, 'name'), false, 'detail matches the backend contract');
  assert.equal(detail.mcp_enabled, true);
  const added = await f.dispatch('mcp-add');
  assert.equal(added.status, 'success');
  assert.equal(added.data.connection.resource_release_uid, f.uid);
  assert.equal(Object.hasOwn(added.data.connection, 'name'), false);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(f.file, 'utf8'))[0], 'name'), false);

  // Existing named records and records with no usable label remain readable.
  for (const name of [undefined, 'legacy display label', '', null, 17]) {
    const saved = { ...added.data.connection, name };
    await fs.writeFile(f.file, JSON.stringify([saved]));
    const listed = await f.dispatch('mcp-list', {}, f.create());
    assert.equal(listed.status, 'success');
    assert.equal(listed.data[0].name, name === 'legacy display label' ? name : undefined);
    assert.equal((await f.dispatch('mcp-tools', {}, f.create())).status, 'success');
    const called = await f.dispatch('mcp-call', { tool: 'set_value', arguments: { value: 12 } }, f.create());
    assert.equal(called.status, 'success');
    assert.equal(called.data.structuredContent.value, 12);
  }
  assert.equal(f.calls.some(call => call.server === 'platform' && call.path === '/mcp'), false,
    'UID-based operations do not fetch discovery to fill display metadata');
});

test('connecting stores the release and repository names; listing reads them locally and completes older records once', async t => {
  const f = await fixture(t);
  const platform = () => f.calls.filter(call => call.server === 'platform').length;
  const stored = () => fs.readFile(f.file, 'utf8').then(JSON.parse);
  const added = await f.dispatch('mcp-add');
  assert.equal(added.status, 'success');
  assert.deepEqual([added.data.connection.name, added.data.connection.display_name, added.data.connection.code_repository_branch_uid],
    ['metatable-mcp', 'MetaTablesApi', f.branchUid]);
  assert.deepEqual(Object.keys((await stored())[0]), ['backend', 'resource_release_uid', 'name', 'display_name', 'code_repository_branch_uid', 'mcp_connection']);
  let before = platform();
  const listed = await f.dispatch('mcp-list', {}, f.create());
  assert.equal(listed.data[0].display_name, 'MetaTablesApi');
  assert.equal(platform(), before, 'a labelled record lists without any backend request');
  assert.equal((await f.dispatch('mcp-tools', {}, f.create())).data.connection.display_name, 'MetaTablesApi', 'tool listings carry the saved labels');

  // A record saved by an earlier version has no labels: the first listing that can read them stores them.
  const legacy = { backend: f.backend, resource_release_uid: f.uid, mcp_connection: added.data.connection.mcp_connection };
  await fs.writeFile(f.file, JSON.stringify([legacy]));
  f.state.branchDenied = true;
  let result = await f.dispatch('mcp-list', {}, f.create());
  assert.equal(result.status, 'success');
  assert.equal(result.data[0].name, 'metatable-mcp'); assert.equal(result.data[0].display_name, undefined);
  assert.equal((await stored())[0].name, 'metatable-mcp', 'the part that could be read is stored');
  f.state.branchDenied = false;
  result = await f.dispatch('mcp-list', {}, f.create());
  assert.equal(result.data[0].display_name, 'MetaTablesApi');
  assert.equal((await stored())[0].display_name, 'MetaTablesApi');
  before = platform();
  await f.dispatch('mcp-list', {}, f.create());
  assert.equal(platform(), before, 'a completed record is not looked up again');

  // An unreadable directory, a mismatched branch and malformed stored labels leave the record usable.
  const cases = [[() => { f.state.labelsDenied = true; }, {}], [() => { f.state.labels = false; }, {}],
    [() => { f.state.branchMismatch = true; }, { name: 'metatable-mcp', code_repository_branch_uid: f.branchUid }]];
  for (const [setup, expected] of cases) {
    await fs.writeFile(f.file, JSON.stringify([{ ...legacy, display_name: 17, code_repository_branch_uid: 'not-a-uuid' }]));
    Object.assign(f.state, { labelsDenied: false, labels: true, branchMismatch: false }); setup();
    result = await f.dispatch('mcp-list', {}, f.create());
    assert.equal(result.status, 'success');
    assert.deepEqual([result.data[0].name, result.data[0].display_name, result.data[0].code_repository_branch_uid],
      [expected.name, undefined, expected.code_repository_branch_uid]);
    assert.equal((await f.dispatch('mcp-call', { tool: 'set_value', arguments: { value: 5 } }, f.create())).data.structuredContent.value, 5);
  }
  Object.assign(f.state, { labelsDenied: false, labels: true, branchMismatch: false });

  // A held lock defers storing the labels; the listing still shows them.
  await fs.writeFile(f.file, JSON.stringify([legacy]));
  await fs.writeFile(f.file + '.lock', 'fixture-owner');
  result = await f.dispatch('mcp-list', {}, f.create());
  assert.equal(result.status, 'success'); assert.equal(result.data[0].display_name, 'MetaTablesApi');
  assert.equal(Object.hasOwn((await stored())[0], 'display_name'), false);
  await fs.unlink(f.file + '.lock');
  await f.dispatch('mcp-list', {}, f.create());
  assert.equal((await stored())[0].display_name, 'MetaTablesApi');

  // Discovery rows carry the release name and branch without a repository lookup.
  before = f.calls.length;
  const discovered = await f.dispatch('mcp-discover');
  assert.deepEqual(discovered.data.results.map(row => [row.name, row.code_repository_branch_uid]), [['metatable-mcp', f.branchUid], ['metatable-mcp', f.branchUid]]);
  assert.equal(f.calls.slice(before).filter(call => call.server === 'platform' && call.path !== '/mcp').length, 0);
  assert.doesNotMatch(JSON.stringify([added, listed, result, discovered, await stored()]), /private-platform-token|private-release-credential/);
});

test('nameless release details still validate identity and all required MCP metadata before exchanging credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.dispatch('mcp-add')).status, 'success');
  const connection = f.row().mcp_connection;
  const invalidDetails = [
    { uid: f.secondUid, mcp_connection: f.row(f.secondUid).mcp_connection },
    { mcp_connection: null },
    ...[
      { transport: 'sse' },
      { url: f.project + '/other' },
      { resource_metadata_url: f.row(f.secondUid).mcp_connection.resource_metadata_url },
      { organization_environment_uid: 'invalid' },
      { active_revision_uid: 'invalid' },
    ].map(fields => ({ mcp_connection: { ...connection, ...fields } })),
  ];
  const saved = await fs.readFile(f.file, 'utf8');
  const exchanged = f.state.exchanged, projectCalls = f.calls.filter(call => call.server === 'project').length;
  for (const detail of invalidDetails) {
    f.state.detail = detail;
    for (const action of ['mcp-add', 'mcp-tools', 'mcp-call']) {
      const result = await f.dispatch(action, { tool: 'set_value', arguments: { value: 1 } });
      assert.equal(result.status, 'failure', JSON.stringify({ action, detail }));
    }
  }
  assert.equal(f.state.exchanged, exchanged);
  assert.equal(f.calls.filter(call => call.server === 'project').length, projectCalls);
  assert.equal(f.state.invoked, 0);
  assert.equal(await fs.readFile(f.file, 'utf8'), saved);
});

test('revocation, removed capabilities, changed URLs, and a wrong credential target stop before project execution', async t => {
  const f = await fixture(t); await f.dispatch('mcp-add');
  f.state.denied = true;
  assert.equal((await f.dispatch('mcp-tools')).error.code, 'AUTH_REJECTED');
  f.state.denied = false; f.state.noMcp = true;
  assert.equal((await f.dispatch('mcp-tools')).error.code, 'API_ERROR');
  f.state.noMcp = false; f.state.endpoint = 'https://changed.example/mcp';
  assert.equal((await f.dispatch('mcp-call', { tool: 'set_value', arguments: {} })).error.code, 'INVALID_REQUEST');
  f.state.endpoint = undefined; f.state.rpc = 'https://wrong.example/';
  assert.equal((await f.dispatch('mcp-tools')).error.code, 'API_ERROR');
  assert.equal(f.state.invoked, 0);
  assert.equal((await f.dispatch('mcp-list')).data.length, 1, 'failures preserve saved metadata');
});

test('failed tools are not replayed and return uncertainty with credentials redacted', async t => {
  const f = await fixture(t); await f.dispatch('mcp-add');
  for (const mode of ['disconnect', 'timeout', 'redirect', 'wrong-id', 'tool-error']) {
    f.state.mode = mode;
    const before = f.state.invoked;
    const result = await f.dispatch('mcp-call', { tool: 'set_value', arguments: { value: 1 } });
    assert.equal(result.status, 'failure', mode); assert.equal(f.state.invoked, before + 1, mode);
    assert.equal(result.effects.state, 'partial-or-uncertain', mode);
    assert.doesNotMatch(JSON.stringify(result), /private-release-credential|private-platform-token/);
  }
});

test('POST SSE and paginated tools work; unsupported stateful endpoints are not saved', async t => {
  const f = await fixture(t); f.state.mode = 'sse'; await f.dispatch('mcp-add');
  assert.equal((await f.dispatch('mcp-call', { tool: 'set_value', arguments: { value: 3 } })).data.structuredContent.value, 3);
  await f.dispatch('mcp-remove'); f.state.mode = 'stateful';
  assert.equal((await f.dispatch('mcp-add')).error.code, 'UNSUPPORTED_ACTION');
  assert.equal((await f.dispatch('mcp-list')).data.length, 0);
});

test('expired saved platform sessions refresh privately before discovery', async t => {
  const f = await fixture(t), store = memoryStore();
  saveSession(store, f.backend, { username: 'person', access: '', refresh: 'private-refresh-token' });
  const result = await f.dispatch('mcp-discover', {}, f.create({ env: {}, store }));
  assert.equal(result.status, 'success');
  assert.equal(readSession(store, f.backend).refresh, 'private-rotated-refresh');
  assert.doesNotMatch(JSON.stringify(result), /private-refresh|private-rotated|private-platform/);
});

test('unknown tools, invalid inputs, cancellation and corrupt connection stores fail safely', async t => {
  const f = await fixture(t); await f.dispatch('mcp-add');
  assert.equal((await f.dispatch('mcp-call', { tool: 'missing', arguments: {} })).error.code, 'INVALID_REQUEST');
  assert.equal((await f.dispatch('mcp-call', { tool: 'set_value', arguments: [] })).error.code, 'INVALID_REQUEST');
  assert.equal((await f.dispatch('mcp-add', { releaseUid: '../../wrong' })).error.code, 'INVALID_REQUEST');
  assert.equal((await f.dispatch('mcp-discover', { limit: -1 })).error.code, 'INVALID_REQUEST');
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.dispatch('mcp-call', { tool: 'set_value', arguments: {} }, f.create({ signal: controller.signal }))).status, 'cancelled');
  assert.equal(f.state.invoked, 0);
  await fs.writeFile(f.file, 'not json');
  assert.equal((await f.dispatch('mcp-list')).error.code, 'STORE_ERROR');
  assert.equal(await fs.readFile(f.file, 'utf8'), 'not json');
});

test('runner accepts structured tool arguments from a file, never credential flags or arbitrary URLs', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'arguments.json');
  await fs.writeFile(file, JSON.stringify({ value: 17, text: 'a literal $(command) with "quotes"' }));
  const parsed = parseArguments(['mcp-call', '--uid', f.uid, '--tool', 'set_value', '--arguments-file', file, '--json']);
  assert.equal(parsed.request.arguments.value, 17);
  assert.equal((await f.dispatch('mcp-add')).status, 'success');
  assert.equal((await f.create().dispatch(parsed.request)).status, 'success');
  assert.throws(() => parseArguments(['mcp-add', '--token', 'private-value']));
  assert.throws(() => parseArguments(['mcp-add', '--url', 'https://arbitrary.example/mcp']));
  await fs.writeFile(file, '[]');
  assert.throws(() => parseArguments(['mcp-call', '--arguments-file', file]));
});

test('SSE handles chunked CRLF and rejects malformed or mismatched responses', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) {
    for (const text of ['data: {"jsonrpc":"2.0","id":7,"result":{}}\r', '\n\r', '\n']) controller.enqueue(encoder.encode(text));
    controller.close();
  } });
  assert.deepEqual(await readMcpResponse(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), { id: 7 }), { jsonrpc: '2.0', id: 7, result: {} });
  await assert.rejects(readMcpResponse(new Response('data: {"id":8,"result":{}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), { id: 7 }));
});

test('packaged client works across separate processes without the checkout or runtime dependencies', async t => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const f = await fixture(t), installed = path.join(f.dir, 'installed package');
  // The published package is its compiled distribution; hosts vendor it without node_modules.
  await fs.cp(path.resolve('dist'), path.join(installed, 'dist'), { recursive: true });
  await fs.copyFile(path.resolve('package.json'), path.join(installed, 'package.json'));
  assert.equal(await fs.stat(path.join(installed, 'node_modules')).then(() => true).catch(() => false), false);
  const env = { PATH: process.env.PATH, MAINSEQUENCE_ENDPOINT: f.backend, MAINSEQUENCE_ACCESS_TOKEN: 'private-platform-token' };
  const run = async action => {
    const result = await promisify(execFile)(process.execPath, ['-e',
      'const {createDevTools,createNodeHost}=require(process.argv[1]); createDevTools({host:createNodeHost(),mcpConnectionsPath:process.argv[2]}).dispatch(JSON.parse(process.argv[3])).then(r=>console.log(JSON.stringify(r)))',
      path.join(installed, 'dist/index.js'), f.file, JSON.stringify({ action, releaseUid: f.uid, tool: 'set_value', arguments: { value: 8 } })],
      { cwd: f.dir, env });
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /private-platform-token|private-release-credential/);
    return JSON.parse(result.stdout);
  };
  const discovered = await promisify(execFile)(process.execPath, [path.join(installed, 'dist/runner.js'), 'mcp-discover', '--json'], { cwd: f.dir, env });
  assert.equal(JSON.parse(discovered.stdout).data.count, 2, 'actual packaged CLI calls central discovery');
  assert.equal((await run('mcp-add')).status, 'success');
  assert.equal((await run('mcp-list')).data.length, 1);
  assert.equal((await run('mcp-call')).data.structuredContent.value, 8);
  assert.equal((await run('mcp-remove')).status, 'success');
  assert.equal((await run('mcp-list')).data.length, 0);
});

test('in-flight cancellation returns promptly and never retries the project write', async t => {
  const f = await fixture(t); await f.dispatch('mcp-add'); f.state.mode = 'timeout';
  const controller = new AbortController();
  const call = f.dispatch('mcp-call', { tool: 'set_value', arguments: {} }, f.create({ signal: controller.signal }));
  for (let n = 0; n < 100 && !f.state.invoked; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.state.invoked, 1); controller.abort();
  const result = await call;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.effects.state, 'partial-or-uncertain');
  assert.equal(f.state.invoked, 1);
});

test('saved-connection locking protects other entries and preserves the file on failure', async t => {
  const f = await fixture(t); await f.dispatch('mcp-add');
  const before = await fs.readFile(f.file, 'utf8');
  await fs.writeFile(f.file + '.lock', 'fixture-owner');
  assert.equal((await f.dispatch('mcp-add', { releaseUid: f.secondUid })).error.code, 'PROJECT_BUSY');
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  await fs.unlink(f.file + '.lock');
  assert.equal((await f.dispatch('mcp-add', { releaseUid: f.secondUid })).status, 'success');
  assert.equal((await f.dispatch('mcp-list')).data.length, 2);
});

test('plain HTTP off-loopback, URL credentials and endpoint query strings are rejected before exchange', async t => {
  const f = await fixture(t);
  for (const url of ['http://project.example/mcp', 'https://user:password@project.example/mcp', 'https://project.example/mcp?token=private']) {
    f.state.endpoint = url;
    assert.equal((await f.dispatch('mcp-add')).error.code, 'API_ERROR');
  }
  assert.equal(f.state.exchanged, 0);
  assert.equal((await f.dispatch('mcp-list')).data.length, 0);
});

test('read-only saved listing preserves legacy bytes without label requests, locks or connection changes', async t => {
  const f = await fixture(t);
  const legacy = { ...f.row(), backend: f.backend, resource_release_uid: f.uid };
  delete legacy.name; delete legacy.uid;
  const foreign = { ...legacy, backend: 'https://elsewhere.test' };
  const bytes = JSON.stringify([legacy, foreign], null, 4) + '\n\n';
  await fs.writeFile(f.file, bytes); await fs.writeFile(f.file + '.lock', 'other process');
  const before = f.calls.length;
  const result = await f.dispatch('mcp-list', { readOnly: true, environmentUid: legacy.mcp_connection.organization_environment_uid });
  assert.equal(result.status, 'success'); assert.equal(result.data.length, 1); assert.equal(result.data[0].name, undefined);
  assert.equal(f.calls.length, before); assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
  assert.equal(await fs.readFile(f.file + '.lock', 'utf8'), 'other process');
  assert.equal((await f.dispatch('mcp-list', { readOnly: 'yes' })).error.code, 'INVALID_REQUEST');
  assert.equal((await f.dispatch('mcp-list', { readOnly: true, environmentUid: f.secondUid })).data.length, 0);
});

test('read-only saved listing retains corrupt files and does not create missing stores', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.dispatch('mcp-list', { readOnly: true })).data, []);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  await fs.writeFile(f.file, '{corrupt');
  const result = await f.dispatch('mcp-list', { readOnly: true });
  assert.equal(result.error.code, 'STORE_ERROR'); assert.equal(await fs.readFile(f.file, 'utf8'), '{corrupt');
  assert.deepEqual(f.calls, []);
});

test('optional discovery enrichment resolves shared branches once, preserves names, and never saves connections', async t => {
  const f = await fixture(t);
  const plain = await f.dispatch('mcp-discover');
  assert.equal(plain.data.results[0].display_name, undefined);
  const enriched = await f.dispatch('mcp-discover', { enrichNames: true });
  assert.equal(enriched.status, 'success'); assert.ok(enriched.data.results.every(row => row.display_name === 'MetaTablesApi' && row.name === 'metatable-mcp'));
  assert.equal(f.calls.filter(c => c.path === '/api/v1/code-repository-branches/' + f.branchUid + '/').length, 1);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  f.state.branchDenied = true;
  const unavailable = await f.dispatch('mcp-discover', { enrichNames: true });
  assert.equal(unavailable.status, 'success'); assert.equal(unavailable.data.count, 2); assert.equal(unavailable.data.results[0].display_name, undefined);
  assert.equal((await f.dispatch('mcp-discover', { enrichNames: 'yes' })).error.code, 'INVALID_REQUEST');
  assert.equal(f.state.invoked, 0); assert.equal(f.state.exchanged, 0);
});
