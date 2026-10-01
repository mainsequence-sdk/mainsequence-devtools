const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clearSession,
  CredentialStoreError,
  ForeignEntryError,
  openCredentialStore,
  readSession,
  saveSession,
  SESSION_SERVICE,
  sessionAccount
} = require('../dist/shared/machineSession.js');

const BACKEND = 'https://platform.example';
const MARK = 'MainSequenceCLI.session.v1';

/** Apple's `security` program, as far as the extension uses it. `ours` entries carry the mark. */
function fakeSecurity() {
  const entries = new Map();
  const commands = [];
  const key = (service, account) => `${service}\n${account}`;
  const option = (args, name) => args[args.indexOf(name) + 1];
  const notFound = { status: 44, stdout: '', stderr: 'security: The specified item could not be found in the keychain.\n' };

  function run(program, args, options) {
    assert.equal(program, '/usr/bin/security');
    if (args[0] === '-i') {
      const match = /^add-generic-password -U -s (\S+) -a (\S+) -j (\S+) -X ([0-9a-f]+)\n$/.exec(options.input);
      assert.ok(match, 'the secret goes to security on standard input, as one line');
      commands.push(`write ${match[2]}`);
      entries.set(key(match[1], match[2]), { secret: Buffer.from(match[4], 'hex').toString('utf8'), comment: match[3] });
      return { status: 0, stdout: '', stderr: '' };
    }
    const entry = entries.get(key(option(args, '-s'), option(args, '-a')));
    if (args[0] === 'delete-generic-password') {
      commands.push(`delete ${option(args, '-a')}`);
      if (!entry) return notFound;
      entries.delete(key(option(args, '-s'), option(args, '-a')));
      return { status: 0, stdout: '', stderr: '' };
    }
    assert.equal(args[0], 'find-generic-password');
    if (args.includes('-w')) {
      commands.push(`read-secret ${option(args, '-a')}`);
      return entry ? { status: 0, stdout: `${entry.secret}\n`, stderr: '' } : notFound;
    }
    commands.push(`inspect ${option(args, '-a')}`);
    if (!entry) return notFound;
    const comment = entry.comment ? `"${entry.comment}"` : '<NULL>';
    return {
      status: 0,
      stdout: `class: "genp"\nattributes:\n    "acct"<blob>="${option(args, '-a')}"\n    "icmt"<blob>=${comment}\n`,
      stderr: ''
    };
  }

  return {
    entries,
    commands,
    put(account, secret, { ours = true } = {}) {
      entries.set(key(SESSION_SERVICE, account), { secret, comment: ours ? MARK : null });
    },
    store: openCredentialStore({ platform: 'darwin', run, isExecutable: () => true })
  };
}

/** `secret-tool`, as far as the extension uses it. */
function fakeSecretTool({ unavailable = false } = {}) {
  const items = [];
  const calls = [];
  const attributesOf = (args) => {
    const attributes = {};
    for (let index = 0; index < args.length; index += 2) attributes[args[index]] = args[index + 1];
    return attributes;
  };
  const matches = (item, wanted) => Object.entries(wanted).every(([name, value]) => item.attributes[name] === value);

  function run(program, args, options) {
    assert.equal(program, '/usr/bin/secret-tool');
    calls.push({ args, input: options.input });
    if (unavailable) return { status: 1, stdout: '', stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n' };
    if (args[0] === 'lookup') {
      const item = items.find(candidate => matches(candidate, attributesOf(args.slice(1))));
      return item ? { status: 0, stdout: item.secret, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'store') {
      const attributes = attributesOf(args.slice(2));
      const existing = items.find(candidate => JSON.stringify(candidate.attributes) === JSON.stringify(attributes));
      if (existing) existing.secret = options.input;
      else items.push({ label: args[1], attributes, secret: options.input });
      return { status: 0, stdout: '', stderr: '' };
    }
    const before = items.length;
    const wanted = attributesOf(args.slice(1));
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (matches(items[index], wanted)) items.splice(index, 1);
    }
    return { status: before === items.length ? 1 : 0, stdout: '', stderr: '' };
  }

  return {
    items,
    calls,
    store: openCredentialStore({
      platform: 'linux',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      run,
      isExecutable: candidate => candidate === '/usr/bin/secret-tool'
    })
  };
}

test('the session entry of a backend has the name the CLIs give it', () => {
  // The first 16 hexadecimal digits of SHA-256 of the backend URL, as the Python CLI computes them.
  assert.equal(SESSION_SERVICE, 'MainSequenceCLI.auth');
  assert.equal(sessionAccount('https://api.main-sequence.app/'), 'default.7f0feafc6447d21a');
  assert.equal(sessionAccount('http://127.0.0.1:8000'), 'default.63767aa5615dabad');
  assert.equal(sessionAccount('127.0.0.1:8000'), 'default.63767aa5615dabad');
});

test('no store is opened where the extension can reach none', () => {
  assert.equal(openCredentialStore({ platform: 'win32' }), null);
  assert.equal(openCredentialStore({ platform: 'linux', env: { PATH: '/usr/bin' }, isExecutable: () => false }), null);
  assert.equal(openCredentialStore({ platform: 'darwin', isExecutable: () => false }), null);
});

test('macOS: a session is saved as the record the CLIs read, and read after its attributes alone', () => {
  const security = fakeSecurity();
  const account = sessionAccount(BACKEND);

  saveSession(security.store, `${BACKEND}/`, { username: 'José', access: 'access-1', refresh: 'refresh-1' });
  const entry = security.entries.get(`${SESSION_SERVICE}\n${account}`);
  assert.equal(entry.comment, MARK);
  assert.match(entry.secret, /^[\x20-\x7e]+$/);
  assert.deepEqual(JSON.parse(entry.secret), {
    v: 1,
    backend: BACKEND,
    username: 'José',
    access: 'access-1',
    refresh: 'refresh-1'
  });

  security.commands.length = 0;
  assert.deepEqual(readSession(security.store, BACKEND), { username: 'José', access: 'access-1', refresh: 'refresh-1' });
  assert.deepEqual(security.commands, [`inspect ${account}`, `read-secret ${account}`]);
});

test('macOS: the secret of an entry another program wrote is never asked for', () => {
  const security = fakeSecurity();
  const account = sessionAccount(BACKEND);
  security.put(account, JSON.stringify({ v: 1, backend: BACKEND, access: 'a', refresh: 'r' }), { ours: false });

  // Asking would show the consent dialog, in every process that starts.
  assert.throws(() => readSession(security.store, BACKEND), ForeignEntryError);
  assert.deepEqual(security.commands, [`inspect ${account}`]);

  // A login replaces it: deleting needs no consent.
  security.commands.length = 0;
  saveSession(security.store, BACKEND, { username: 'ada', access: 'b', refresh: 'r' });
  assert.deepEqual(security.commands, [`delete ${account}`, `write ${account}`]);
  assert.equal(readSession(security.store, BACKEND).access, 'b');
});

test('macOS: an entry this process read is updated in place', () => {
  const security = fakeSecurity();
  const account = sessionAccount(BACKEND);
  security.put(account, JSON.stringify({ v: 1, backend: BACKEND, username: 'ada', access: 'a', refresh: 'r' }));

  readSession(security.store, BACKEND);
  security.commands.length = 0;
  saveSession(security.store, BACKEND, { username: 'ada', access: 'b', refresh: 'r' });

  // No delete: another process never finds the session missing while it is renewed.
  assert.deepEqual(security.commands, [`write ${account}`]);
});

test('macOS: logout removes both account names without reading them, and a record too long is refused', () => {
  const security = fakeSecurity();
  const account = sessionAccount(BACKEND);
  security.put(account, '{}');
  security.put('default', JSON.stringify({ access: 'legacy', refresh: 'r' }));
  assert.equal(clearSession(security.store, BACKEND), true);
  assert.deepEqual(security.commands, [`delete ${account}`, 'delete default']);
  assert.equal(clearSession(security.store, BACKEND), false);

  assert.throws(
    () => saveSession(security.store, BACKEND, { username: '', access: 'a'.repeat(2000), refresh: 'r' }),
    error => error instanceof CredentialStoreError && /too long/.test(error.message)
  );
});

test('macOS: logout succeeds when the legacy entry was written by another program', () => {
  const security = fakeSecurity();
  const account = sessionAccount(BACKEND);
  security.put(account, JSON.stringify({ v: 1, backend: BACKEND, access: 'a', refresh: 'r' }));
  security.put('default', JSON.stringify({ access: 'foreign', refresh: 'r' }), { ours: false });
  assert.equal(clearSession(security.store, BACKEND), true);
  assert.equal(security.entries.size, 0);
  assert.ok(!security.commands.some(command => command.startsWith('read-secret')), 'no secret is asked for');
});

test('a record is read by its fields whatever its version, like the other readers', () => {
  const security = fakeSecurity();
  security.put(sessionAccount(BACKEND), JSON.stringify({ v: 2, backend: BACKEND, username: 'ada', access: 'a', refresh: 'r' }));
  assert.deepEqual(readSession(security.store, BACKEND), { username: 'ada', access: 'a', refresh: 'r' });
});

test('a record of another backend is not this backend\'s session, and the old unscoped entry is read', () => {
  const security = fakeSecurity();
  const account = sessionAccount(BACKEND);
  security.put(account, JSON.stringify({ v: 1, backend: 'https://other.example', access: 'a', refresh: 'r' }));
  assert.equal(readSession(security.store, BACKEND), null);

  const legacy = fakeSecurity();
  legacy.put('default', JSON.stringify({ username: 'ada', access: 'legacy-access', refresh: 'legacy-refresh' }));
  assert.equal(readSession(legacy.store, BACKEND).refresh, 'legacy-refresh');
});

test('Linux: the session is the one Secret Service item every tool replaces in place', () => {
  const secretTool = fakeSecretTool();
  const account = sessionAccount(BACKEND);

  saveSession(secretTool.store, BACKEND, { username: 'ada', access: 'a', refresh: 'r' });
  saveSession(secretTool.store, BACKEND, { username: 'ada', access: 'b', refresh: 'r' });

  assert.equal(secretTool.items.length, 1);
  assert.deepEqual(secretTool.items[0].attributes, {
    service: SESSION_SERVICE,
    username: account,
    application: 'Python keyring library'
  });
  assert.equal(secretTool.items[0].label, `--label=Password for '${account}' on '${SESSION_SERVICE}'`);
  const stored = secretTool.calls.filter(call => call.args[0] === 'store');
  assert.equal(stored.every(call => !call.args.join(' ').includes('"access"')), true);
  assert.equal(stored[1].input.endsWith('\n'), false);
  assert.equal(readSession(secretTool.store, BACKEND).access, 'b');

  assert.equal(clearSession(secretTool.store, BACKEND), true);
  assert.equal(readSession(secretTool.store, BACKEND), null);
});

test('Linux: a Secret Service that cannot be reached is an error, not a missing session', () => {
  const secretTool = fakeSecretTool({ unavailable: true });
  assert.throws(
    () => readSession(secretTool.store, BACKEND),
    error => error instanceof CredentialStoreError && !(error instanceof ForeignEntryError)
  );
});
