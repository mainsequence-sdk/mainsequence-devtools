const assert = require('node:assert/strict');
const test = require('node:test');
const { HostAuthSession, createSessionService, createDevTools } = require('../dist/index.js');
const { memoryStore, fixtureBackend, browserHost } = require('./helpers.cjs');
function secrets() { const values = new Map(); return { values, async get(k) { return values.get(k); }, async store(k,v) { values.set(k,v); }, async delete(k) { values.delete(k); } }; }
function state() { const values = new Map(); return { get(k,d) { return values.get(k) ?? d; }, async update(k,v) { values.set(k,v); } }; }

test('opt-in host fallback uses the same PKCE/refresh service without opening a native store', async t => {
  const fixture = await fixtureBackend(t), secret = secrets();
  const owner = new HostAuthSession(secret, state(), null);
  const session = createSessionService(browserHost(), { store: null, persistence: owner.persistence(), env: {} });
  const tooling = createDevTools({ host: browserHost(), session, store: null, env: {} });
  const login = await tooling.dispatch({ action: 'login', backend: fixture.backend });
  assert.equal(login.status, 'success'); assert.equal(login.data.persistence, 'host');
  assert.equal(secret.values.size, 1);
  const [a,b] = await Promise.all([session.refresh(fixture.backend), session.refresh(fixture.backend)]);
  assert.equal(a.source, 'host'); assert.equal(b.source, 'host');
  assert.equal(fixture.calls.filter(c => c.path.includes('/refresh/')).length, 1);
  assert.equal((await owner.get(fixture.backend)).refresh, 'fixture-refresh-2');
  assert.doesNotMatch(JSON.stringify(login), /fixture-access|fixture-refresh/);
  const logout = await tooling.dispatch({ action: 'logout', backend: fixture.backend });
  assert.equal(logout.status, 'success'); assert.equal(secret.values.size, 0);
});

test('native host adoption and backend selection share the exact SDK records', async t => {
  const fixture = await fixtureBackend(t), store = memoryStore();
  const owner = new HostAuthSession(secrets(), state(), store);
  await owner.save({ username:'one', access:'old-access', refresh:'old-refresh' }, fixture.backend);
  const other = 'https://other.fixture.test';
  await owner.save({ username:'two', access:'other-access', refresh:'other-refresh' }, other);
  const session = createSessionService(browserHost(), { store:null, persistence:owner.persistence(), env:{} });
  await owner.get(fixture.backend);
  // A CLI rotates while the UI's read cache is still active.
  await owner.save({ username:'one', access:'fixture-access-1', refresh:'fixture-refresh-1' }, fixture.backend);
  await session.refresh(fixture.backend);
  assert.equal(fixture.calls.find(c => c.path.includes('/refresh/')).body.refresh, 'fixture-refresh-1');
  assert.equal((await owner.get(other)).refresh, 'other-refresh');
  assert.equal((await session.status(fixture.backend)).persistence, 'machine');
  await session.logout(fixture.backend);
  assert.equal((await owner.get(other)).access, 'other-access');
});
