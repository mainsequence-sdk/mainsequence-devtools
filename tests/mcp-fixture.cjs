const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDevTools, createNodeHost } = require('../dist/index.js');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-mcp-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [], state = { denied: false, mode: 'json', token: 'private-release-credential', exchanged: 0, invoked: 0 };
  const uid = 'b0a5ee29-f649-46ab-a040-38504838a131';
  const secondUid = 'b0a5ee29-f649-46ab-a040-38504838a132';
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
      organization_environment_name: releaseUid === uid ? 'Research' : 'Production',
      organization_environment_uid: releaseUid === uid ? 'ba034541-73b4-4c5b-81ad-16516d8a8f94' : '9d85df93-3ec5-48cb-802b-bc8d84bb06e4', active_revision_uid: '21fe3fba-e8fa-4010-b2bd-4a16d873ec28' } });
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
        const value = row(id); value.resource_release_uid = value.uid; delete value.uid; return value;
      }) } });
    }
    if (state.denied) return res.writeHead(403).end();
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
  return { dir, file, uid, secondUid, backend, row, project, calls, state, create, dispatch };
}

module.exports = { fixture };
