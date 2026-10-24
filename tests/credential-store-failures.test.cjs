const test = require('node:test');
const assert = require('node:assert/strict');
const { openCredentialStore, CredentialStoreError, ForeignEntryError, createDevTools, createNodeHost, saveSession } = require('../dist');
const { memoryStore, fixtureBackend, browserHost } = require('./helpers.cjs');
const backend = 'https://fixture.example';
const privateText = 'private-helper-output private-session-bus private-credential';
const helper = result => openCredentialStore({ platform: 'linux', env: { PATH: '/fixture/bin' }, isExecutable: () => true, run: () => result });
const diagnostics = [
  ['secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY', 'SESSION_UNAVAILABLE'],
  ['secret-tool: Unable to autolaunch a dbus-daemon without a $DISPLAY for X11', 'SESSION_UNAVAILABLE'],
  ['secret-tool: Could not connect: No such file or directory', 'SESSION_UNAVAILABLE'],
  ['GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files', 'SERVICE_UNAVAILABLE'],
  ['GDBus.Error:org.freedesktop.Secret.Error.IsLocked: collection is locked', 'LOCKED'],
  ['GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: permission denied', 'ACCESS_DENIED'],
  ['unknown or localized helper failure', 'HELPER_FAILED'],
];

test('Linux helper diagnostics have fixed public reasons without echoing private process output', () => {
  for (const [stderr, reason] of diagnostics) {
    const store = helper({ status: 1, stdout: privateText, stderr: stderr + '\n' + privateText });
    for (const operation of [() => store.read('service', 'account'), () => store.write('service', 'account', privateText), () => store.remove('service', 'account')]) {
      assert.throws(operation, error => {
        assert.ok(error instanceof CredentialStoreError);
        assert.equal(error.reason, reason);
        assert.doesNotMatch(error.message, /private-helper-output|private-session-bus|private-credential|unknown or localized/);
        if (reason !== 'LOCKED') assert.doesNotMatch(error.message, /store is locked|Unlock/);
        return true;
      });
    }
  }
});

test('helper execution failures, timeouts and unexpected exits stay distinct from missing entries', () => {
  for (const [code, reason] of [['ENOENT', 'HELPER_UNAVAILABLE'], ['ETIMEDOUT', 'HELPER_TIMEOUT'], ['EACCES', 'ACCESS_DENIED'], ['EPERM', 'ACCESS_DENIED'], ['OTHER', 'HELPER_FAILED']]) {
    const store = helper({ status: null, stdout: privateText, stderr: privateText, error: Object.assign(new Error(privateText), { code }) });
    assert.throws(() => store.read('service', 'account'), error => error.reason === reason && !error.message.includes(privateText));
  }
  for (const status of [null, 2]) assert.throws(() => helper({ status, stdout: '', stderr: '' }).read('s', 'a'), { reason: 'HELPER_FAILED' });
  const missing = helper({ status: 1, stdout: '', stderr: '' });
  assert.equal(missing.read('s', 'a'), null); assert.equal(missing.remove('s', 'a'), false);
  // Empty environment context alone is not an error: libsecret can locate the bus.
  assert.equal(helper({ status: 0, stdout: 'record', stderr: '' }).read('s', 'a'), 'record');
});

test('auth-status, login, refresh and logout preserve shared reasons before opening browsers or contacting backends', async () => {
  for (const [stderr, reason] of diagnostics) {
    const store = helper({ status: 1, stdout: privateText, stderr: stderr + '\n' + privateText });
    const host = { ...createNodeHost(), openBrowser: async () => assert.fail('browser must not open') };
    const tooling = createDevTools({ host, store, env: {}, fetch: async () => assert.fail('backend must not be contacted') });
    for (const action of ['auth-status', 'login', 'refresh-token', 'logout']) {
      const result = await tooling.dispatch({ action, backend });
      assert.equal(result.status, 'failure'); assert.equal(result.error.code, 'STORE_ERROR'); assert.equal(result.error.reason, reason);
      assert.equal(result.summary, result.error.message);
      assert.doesNotMatch(JSON.stringify(result), /private-helper-output|private-session-bus|private-credential/);
    }
  }
});

test('invalid records and unclassified persistence errors are safe and never claim a locked keyring', async () => {
  for (const record of ['broken-' + privateText, '[]']) {
    const store = helper({ status: 0, stdout: record, stderr: '' });
    const result = await createDevTools({ host: createNodeHost(), store, env: {} }).dispatch({ action: 'auth-status', backend });
    assert.equal(result.error.reason, 'INVALID_RECORD');
    assert.doesNotMatch(JSON.stringify(result), /private-helper-output|Unlock/);
  }
  const store = memoryStore(); store.read = () => { throw new Error(privateText); };
  for (const action of ['auth-status', 'login']) {
    const result = await createDevTools({ host: createNodeHost(), store, env: {} }).dispatch({ action, backend });
    assert.equal(result.error.code, 'STORE_ERROR'); assert.equal(result.error.reason, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-helper-output|Unlock|store is locked/);
  }
});

test('write and remove failures retain reason codes through session persistence boundaries', async t => {
  const f = await fixtureBackend(t);
  for (const action of ['login', 'refresh-token']) {
    const store = memoryStore();
    saveSession(store, f.backend, { username: 'fixture', access: 'fixture-access-1', refresh: 'fixture-refresh-1' });
    store.write = () => { throw new CredentialStoreError(privateText, 'LOCKED'); };
    const result = await createDevTools({ host: browserHost(), store, env: {} }).dispatch({ action, backend: f.backend });
    assert.equal(result.error.code, 'PERSISTENCE_FAILED'); assert.equal(result.error.reason, 'LOCKED');
    assert.match(result.error.message, /store is locked/); assert.doesNotMatch(JSON.stringify(result), /private-helper-output|fixture-access|fixture-refresh/);
  }
  const store = memoryStore(); store.remove = () => { throw new CredentialStoreError(privateText, 'ACCESS_DENIED'); };
  const result = await createDevTools({ host: createNodeHost(), store, env: {} }).dispatch({ action: 'logout', backend });
  assert.equal(result.error.code, 'STORE_ERROR'); assert.equal(result.error.reason, 'ACCESS_DENIED');
  assert.doesNotMatch(JSON.stringify(result), /private-helper-output/);
});

test('explicit sign-in can still replace a foreign Keychain entry without matching message text', async t => {
  const f = await fixtureBackend(t), store = memoryStore(), read = store.read;
  let first = true;
  store.read = (...args) => { if (first) { first = false; throw new ForeignEntryError(); } return read(...args); };
  const result = await createDevTools({ host: browserHost(), store, env: {} }).dispatch({ action: 'login', backend: f.backend });
  assert.equal(result.status, 'success');
});
