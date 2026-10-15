const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDevTools, createNodeHost, sessionAccount } = require('../dist/index.js');
const { MachineSessionService } = require('../dist/shared/session.js');
const { saveSession, readSession, SESSION_SERVICE, clearSession } = require('../dist/shared/machineSession.js');
const { memoryStore, fixtureBackend, browserHost } = require('./helpers.cjs');

test('standalone browser login uses the existing PKCE contract, verifies persistence and hides secrets', async t => {
  const { backend, calls } = await fixtureBackend(t);
  const store = memoryStore();
  let authorization;
  const tooling = createDevTools({ host: browserHost(async authorize => {
    authorization = authorize;
    assert.equal(authorize.pathname, '/auth/cli/authorize/');
    assert.equal(authorize.searchParams.get('client_id'), 'mainsequence-cli');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    const wrong = new URL(authorize.searchParams.get('redirect_uri'));
    wrong.searchParams.set('state', 'wrong'); wrong.searchParams.set('code', 'bad');
    assert.equal((await fetch(wrong)).status, 400, 'wrong state does not consume the valid callback');
  }), env: {}, store });
  const login = await tooling.dispatch({ action: 'login', backend });
  assert.equal(login.status, 'success');
  assert.equal(login.data.username, 'José');
  const exchange = calls.find(call => call.path === '/auth/cli/token/');
  assert.equal(crypto.createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
  const record = store.records.get(SESSION_SERVICE + '\n' + sessionAccount(backend));
  assert.match(record, /^[\x20-\x7e]+$/);
  assert.equal(JSON.parse(record).v, 1);
  assert.equal(JSON.parse(record).backend, backend);
  assert.equal((await tooling.dispatch({ action: 'auth-status', backend, check: true })).data.checked, true);
  const refresh = await tooling.dispatch({ action: 'refresh-token', backend });
  assert.equal(refresh.status, 'success');
  assert.equal(readSession(store, backend).refresh, 'fixture-refresh-2');
  assert.equal((await tooling.dispatch({ action: 'repositories', backend })).data[0].uid, 'repo-1');
  const logout = await tooling.dispatch({ action: 'logout', backend });
  assert.deepEqual(logout.data, { revoked: true });
  assert.equal(store.records.size, 0);
  for (const result of [login, refresh, logout]) assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh|code_verifier|authorization-code/);
});

test('store unavailable and failed persistence never report a successful browser login', async t => {
  const { backend } = await fixtureBackend(t);
  let opened = 0;
  const host = { ...browserHost(), openBrowser: async () => { opened++; return true; } };
  const unavailable = await createDevTools({ host, env: {}, store: null }).dispatch({ action: 'login', backend });
  assert.equal(unavailable.error.code, 'STORE_UNAVAILABLE'); assert.equal(opened, 0);
  const store = memoryStore(); store.write = () => { throw new Error('fixture-secret'); };
  const failure = await createDevTools({ host: browserHost(), env: {}, store }).dispatch({ action: 'login', backend });
  assert.equal(failure.error.code, 'PERSISTENCE_FAILED'); assert.doesNotMatch(JSON.stringify(failure), /fixture-secret|fixture-refresh|fixture-access/);
});

test('renewal rereads a session written by another SDK and deduplicates concurrent renewal', async t => {
  const { backend, calls } = await fixtureBackend(t);
  const store = memoryStore(); saveSession(store, backend, { username: 'shared', access: 'stale', refresh: 'initial' });
  const service = new MachineSessionService(createNodeHost(), { env: {}, store });
  await service.status(backend);
  saveSession(store, backend, { username: 'shared', access: 'newer', refresh: 'externally-rotated' });
  await Promise.all([service.refresh(backend), service.refresh(backend), service.refresh(backend)]);
  const renewals = calls.filter(call => call.path.includes('/refresh/'));
  assert.equal(renewals.length, 1); assert.equal(renewals[0].body.refresh, 'externally-rotated');
  assert.equal(readSession(store, backend).username, 'shared');
});

test('401 rereads a newer machine access token and does not unnecessarily renew', async t => {
  const fixture = await fixtureBackend(t);
  const store = memoryStore(); saveSession(store, fixture.backend, { username: '', access: 'stale', refresh: 'r' });
  let first = true;
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    if (first && response.status === 401) { first = false; saveSession(store, fixture.backend, { username: '', access: 'fixture-access-1', refresh: 'new-r' }); }
    return response;
  };
  const result = await createDevTools({ host: createNodeHost(), env: {}, store, fetch: fetchImpl }).dispatch({ action: 'repositories', backend: fixture.backend });
  assert.equal(result.status, 'success'); assert.equal(fixture.calls.filter(call => call.path.includes('/refresh/')).length, 0);
});

test('explicit environment rejection stays on that identity and mismatched backends fail', async t => {
  const { backend, calls } = await fixtureBackend(t);
  const store = memoryStore(); saveSession(store, backend, { username: 'machine-user', access: 'fixture-access-1', refresh: 'saved-refresh' });
  const env = { MAINSEQUENCE_ENDPOINT: backend, MAINSEQUENCE_ACCESS_TOKEN: 'rejected-process-token' };
  const tooling = createDevTools({ host: createNodeHost(), env, store });
  const failure = await tooling.dispatch({ action: 'repositories', backend });
  assert.equal(failure.error.code, 'AUTH_REJECTED'); assert.equal(calls.length, 1);
  assert.match(failure.error.message, /credentials set in this process's environment \(MAINSEQUENCE_ACCESS_TOKEN \/ MAINSEQUENCE_REFRESH_TOKEN\)/);
  assert.match(failure.error.message, /Start the process without them to use the saved session/);
  assert.doesNotMatch(failure.error.message, /rejected-process-token/);
  const mismatch = await tooling.dispatch({ action: 'auth-status', backend: 'https://another.example' });
  assert.equal(mismatch.error.code, 'BACKEND_MISMATCH');
  assert.equal(readSession(store, backend).refresh, 'saved-refresh');
});

test('an unreachable backend preserves the session and is distinct from rejected auth', async () => {
  const backend = 'https://fixture.example', store = memoryStore();
  saveSession(store, backend, { username: 'saved', access: 'a', refresh: 'r' });
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store, fetch: async () => { throw new Error('secret network error'); } });
  const result = await tooling.dispatch({ action: 'auth-status', backend, check: true });
  assert.equal(result.error.code, 'BACKEND_UNREACHABLE'); assert.equal(readSession(store, backend).access, 'a');
  assert.doesNotMatch(JSON.stringify(result), /secret network/);
});

test('login cancellation and timeout close the callback server without persisting a session', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(), store = memoryStore();
    let redirect;
    const tooling = createDevTools({ host: { ...createNodeHost(), async openBrowser(url) { redirect = new URL(url).searchParams.get('redirect_uri'); if (cancel) controller.abort(); return true; } }, env: {}, store, signal: controller.signal, loginTimeoutMs: 30 });
    const result = await tooling.dispatch({ action: 'login', backend: 'https://fixture.example' });
    assert.equal(result.error.code, cancel ? 'CANCELLED' : 'LOGIN_TIMEOUT'); assert.equal(store.records.size, 0);
    await assert.rejects(fetch(redirect));
  }
});

test('backend record identity is exact; refresh-only records work and logout removes the legacy unscoped entry like the CLIs', async t => {
  const { backend } = await fixtureBackend(t), store = memoryStore();
  saveSession(store, backend, { username: 'refresh-only', access: '', refresh: 'fixture-refresh-1' });
  const result = await createDevTools({ host: createNodeHost(), store, env: {} }).dispatch({ action: 'auth-status', backend, check: true });
  assert.equal(result.status, 'success'); assert.equal(readSession(store, backend).access, 'fixture-access-2');
  store.write(SESSION_SERVICE, 'default', JSON.stringify({ v: 1, backend: 'https://other.example', access: 'other', refresh: 'other-r' }));
  clearSession(store, backend);
  // The Python and Command Center CLIs remove the unscoped entry of old versions unread; so does this.
  assert.equal(readSession(store, 'https://other.example'), null);
  assert.notEqual(sessionAccount('https://HOST.example:443/path'), sessionAccount('https://host.example/path'));
});

test('checked status without a session fails; unchecked status reports safe storage capability', async () => {
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  const status = await tooling.dispatch({ action: 'auth-status', backend: 'https://fixture.example' });
  assert.equal(status.data.persistence, 'unavailable'); assert.equal(status.data.authenticated, false);
  assert.equal((await tooling.dispatch({ action: 'auth-status', backend: 'https://fixture.example', check: true })).error.code, 'NOT_AUTHENTICATED');
});

test('login obtains a missing username from the existing profile endpoint', async t => {
  const { backend } = await fixtureBackend(t), store = memoryStore();
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    if (new URL(url).pathname === '/auth/cli/token/') {
      const pair = await response.json(); delete pair.username; return new Response(JSON.stringify(pair));
    }
    return response;
  };
  const result = await createDevTools({ host: browserHost(), env: {}, store, fetch: fetchImpl }).dispatch({ action: 'login', backend });
  assert.equal(result.status, 'success'); assert.equal(result.data.username, 'José'); assert.equal(readSession(store, backend).username, 'José');
});

test('a refused renewal names the saved session, its expiry and the sign-in, and keeps the session', async t => {
  const { backend } = await fixtureBackend(t);
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const expiredRefresh = `${part({ alg: 'none' })}.${part({ exp: Math.floor(Date.now() / 1000) - 3600 })}.signature`;
  const store = memoryStore(); saveSession(store, backend, { username: 'shared', access: 'stale-access', refresh: expiredRefresh });
  const fetchImpl = async (url, init) => String(url).endsWith('/auth/jwt-token/token/refresh/')
    ? new Response(JSON.stringify({ detail: 'Token is invalid or expired' }), { status: 401 })
    : fetch(url, init);
  const result = await createDevTools({ host: createNodeHost(), env: {}, store, fetch: fetchImpl }).dispatch({ action: 'repositories', backend });
  assert.equal(result.error.code, 'AUTH_REJECTED');
  assert.match(result.error.message, /^The backend refused the saved session for http:\/\/127\.0\.0\.1:\d+: it expired on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. Sign in again\.$/);
  assert.equal(readSession(store, backend).refresh, expiredRefresh);
});


test('per-request timeout accommodates the advertised agent deadline and rejects values beyond the cap before HTTP', async t => {
  const { backend, calls } = await fixtureBackend(t);
  const store = memoryStore(); saveSession(store, backend, {username:'fixture',access:'fixture-access-1',refresh:'fixture-refresh-1'});
  const service = new MachineSessionService(createNodeHost(), {env:{},store});
  await service.request(backend, 'GET', '/api/v1/code-repositories/', undefined, true, {timeoutMs:145000});
  const count = calls.length;
  for (const timeoutMs of [0,-1,NaN,Infinity,300001]) {
    await assert.rejects(service.request(backend, 'GET', '/api/v1/code-repositories/', undefined, true, {timeoutMs}), error => error.code === 'INVALID_REQUEST');
  }
  assert.equal(calls.length, count);
});
