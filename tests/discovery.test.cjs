const test = require('node:test');
const assert = require('node:assert/strict');
const { createDevTools, createNodeHost, createSessionService, listEnvironments, bindSessionAccount } = require('../dist');
const backend = 'https://platform.example.test';
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const environment = n => ({ uid: uid(n), name: `Environment ${n}`, is_production: n === 2 });

test('both environment actions share short-page pagination and retain compatible projections', async () => {
  for (const action of ['mcp-environments', 'organization-environments']) {
    const offsets = [];
    const session = { request: async (url, method, apiPath) => {
      assert.equal(url, backend); assert.equal(method, 'GET');
      const offset = Number(new URL(apiPath, backend).searchParams.get('offset')); offsets.push(offset);
      return { count: 3, results: offset === 0 ? [environment(1), environment(2)] : [environment(3)] };
    } };
    const result = await createDevTools({ host: createNodeHost(), session, env: {} }).dispatch({ action, backend });
    assert.equal(result.status, 'success'); assert.deepEqual(offsets, [0, 2]);
    assert.deepEqual(result.data, [1, 2, 3].map(n => ({ uid: uid(n), name: `Environment ${n}`, ...(action === 'mcp-environments' ? { isProduction: n === 2 } : {}) })));
  }
});

test('environment directory supports complete arrays and empty pages, rejects inconsistent/duplicate/unbounded pages', async () => {
  assert.deepEqual(await listEnvironments({ request: async () => [] }, backend), []);
  assert.equal((await listEnvironments({ request: async () => [environment(2)] }, backend))[0].isProduction, true);
  const invalid = [
    [{ count: 1, results: [] }], [{ count: -1, results: [] }], [{ count: 10001, results: [] }],
    [{ count: 1, results: [environment(1), environment(2)] }],
    [{ count: 2, results: [environment(1), environment(1)] }],
    [{ count: 2, results: [environment(1)] }, { count: 2, results: [environment(1)] }],
    [{ count: 2, results: [environment(1)] }, { count: 3, results: [environment(2)] }],
    [{ count: 1, results: [{ uid: 'bad', name: 'Bad' }] }],
    [{ count: 1, results: [{ ...environment(1), name: '\n' }] }],
  ];
  for (const pages of invalid) await assert.rejects(listEnvironments({ request: async () => pages.shift() }, backend), { code: 'API_ERROR' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listEnvironments({ request: async () => { throw new Error('must not fetch'); } }, backend, controller.signal), { name: 'AbortError' });
});

function sessions(options = {}) {
  let saved = { username: 'alice', access: 'alice-access', refresh: 'alice-refresh' };
  const calls = [], writes = [];
  const state = { switchOn: '', retry: '', profileUnavailable: false };
  const session = createSessionService(createNodeHost(), { env: {}, signal: options.signal,
    persistence: { mode: 'machine', name: 'test', read: async () => saved && { ...saved },
      write: async (_backend, value) => { writes.push(value); saved = { ...value }; }, remove: async () => { saved = null; } },
    fetch: async (url, init) => {
      const path = new URL(url).pathname, access = init.headers.Authorization?.replace('Bearer ', '');
      calls.push({ path, access });
      const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      if (path === '/auth/jwt-token/token/refresh/') {
        if (state.switchOn === 'refresh') saved = { username: 'bob', access: 'bob-access', refresh: 'bob-refresh' };
        return reply({ access: 'alice-new', refresh: 'alice-rotated' });
      }
      if (path === '/api/v1/users/me/') {
        if (state.profileUnavailable) return new Response('{}', { status: 503 });
        if (state.switchOn === 'verify') saved = { username: 'bob', access: 'bob-access', refresh: 'bob-refresh' };
        return reply({ username: access.startsWith('bob') ? 'bob' : 'alice' });
      }
      if (state.retry && access === 'alice-access') {
        const user = state.retry;
        saved = { username: user, access: user + '-new', refresh: user + '-rotated' };
        return new Response('{}', { status: 401 });
      }
      if (state.switchOn === 'read') saved = { username: 'bob', access: 'bob-access', refresh: 'bob-refresh' };
      return reply({ count: 1, results: [environment(1)] });
    } });
  return { session, calls, writes, state, change: value => { saved = value; }, saved: () => saved };
}

test('account scope verifies actual credentials, rejects cross-backend calls and custom transports without support', async () => {
  const f = sessions();
  await assert.rejects(bindSessionAccount(f.session, backend, 'bob'), { code: 'AUTH_REJECTED' });
  assert.ok(f.calls.every(c => c.path === '/api/v1/users/me/'));
  const scoped = await bindSessionAccount(f.session, backend, 'alice');
  await assert.rejects(async () => scoped.request('https://other.test', 'GET', '/api/v1/test/'), { code: 'BACKEND_MISMATCH' });
  await assert.rejects(scoped.logout(backend), { code: 'UNSUPPORTED_ACTION' });
  await assert.rejects(bindSessionAccount({}, backend, 'alice'), { code: 'UNSUPPORTED_ACTION' });
  await assert.rejects(bindSessionAccount(f.session, backend, ''), { code: 'INVALID_REQUEST' });
  assert.deepEqual(f.writes, []);
  f.change({ username: 'outdated-display-name', access: 'alice-access', refresh: 'alice-refresh' });
  const current = await bindSessionAccount(f.session, backend, 'alice');
  assert.equal((await current.status(backend)).username, 'alice', 'verified identity wins over cached metadata');
});

test('account changes during identity verification refuse the domain request; changes during a read discard its result', async () => {
  for (const point of ['verify', 'read']) {
    const f = sessions();
    if (point === 'verify') f.state.switchOn = point;
    const api = createDevTools({ host: createNodeHost(), session: f.session, env: {} });
    if (point === 'read') f.state.switchOn = point;
    const result = await api.dispatch({ action: 'mcp-environments', backend, expectedAccount: 'alice' });
    assert.equal(result.status, 'failure'); assert.equal(result.error.code, 'AUTH_REJECTED'); assert.equal(result.data, undefined);
    if (point === 'verify') assert.ok(f.calls.every(c => c.path === '/api/v1/users/me/'));
    assert.ok(f.calls.filter(c => c.path !== '/api/v1/users/me/').every(c => c.access === 'alice-access'));
    assert.deepEqual(f.writes, []);
  }
});

test('401 retry accepts a new token for the same account and refuses a different account without replaying the domain request', async () => {
  for (const next of ['alice', 'bob']) {
    const f = sessions(), scoped = await bindSessionAccount(f.session, backend, 'alice'); f.state.retry = next;
    const request = scoped.request(backend, 'GET', '/api/v1/organization-environments/');
    if (next === 'alice') assert.equal((await request).count, 1);
    else await assert.rejects(request, { code: 'AUTH_REJECTED' });
    const reads = f.calls.filter(c => c.path === '/api/v1/organization-environments/');
    assert.deepEqual(reads.map(c => c.access), next === 'alice' ? ['alice-access', 'alice-new'] : ['alice-access']);
    assert.deepEqual(f.writes, []);
  }
});

test('scoped renewal preserves an account saved by another process and can renew the same account normally', async () => {
  for (const changed of [false, true]) {
    const f = sessions();
    const expired = 'e30.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.sig';
    f.change({ username: 'alice', access: expired, refresh: 'alice-refresh' });
    if (changed) f.state.switchOn = 'refresh';
    if (changed) {
      await assert.rejects(bindSessionAccount(f.session, backend, 'alice'), { code: 'AUTH_REJECTED' });
      assert.equal(f.saved().username, 'bob'); assert.deepEqual(f.writes, []);
    } else {
      const scoped = await bindSessionAccount(f.session, backend, 'alice');
      assert.equal((await scoped.status(backend)).username, 'alice'); assert.equal(f.writes.length, 1);
    }
  }
});

test('project and MCP reads both enforce the optional account precondition; cancellation never returns a directory', async () => {
  for (const action of ['mcp-environments', 'organization-environments']) {
    const f = sessions();
    const api = createDevTools({ host: createNodeHost(), session: f.session, env: {} });
    assert.equal((await api.dispatch({ action, backend, expectedAccount: 'bob' })).error.code, 'AUTH_REJECTED');
    assert.ok(f.calls.every(c => c.path === '/api/v1/users/me/'));
  }
  const controller = new AbortController(), f = sessions({ signal: controller.signal }); controller.abort();
  const api = createDevTools({ host: createNodeHost(), session: f.session, env: {}, signal: controller.signal });
  assert.equal((await api.dispatch({ action: 'mcp-environments', backend, expectedAccount: 'alice' })).status, 'cancelled');
  assert.deepEqual(f.calls, []);
});

test('a rotated refresh pair is kept when profile verification is unavailable; no domain request runs', async () => {
  const f = sessions();
  f.change({ username: 'alice', access: '', refresh: 'alice-refresh' }); f.state.profileUnavailable = true;
  await assert.rejects(bindSessionAccount(f.session, backend, 'alice'), { code: 'API_ERROR' });
  assert.equal(f.saved().access, 'alice-new'); assert.equal(f.saved().refresh, 'alice-rotated');
  assert.equal(f.writes.length, 1);
  assert.ok(f.calls.every(c => c.path === '/api/v1/users/me/' || c.path === '/auth/jwt-token/token/refresh/'));
});
