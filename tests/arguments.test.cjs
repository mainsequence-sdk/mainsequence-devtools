const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createDevTools, createNodeHost, parseArguments, tokenizeCommand, HELP, ToolingError } = require('../dist/index.js');

test('command parsing is public API for host runners', () => {
  assert.match(HELP, /^MainSequence developer tooling \(Node 22\+\)/);
  assert.doesNotMatch(HELP, /freeze-env|--message/);
  assert.deepEqual(parseArguments(['sync', '--path', '/a project'], '/cwd').request, { action: 'sync', backend: undefined, root: '/a project', projectType: undefined, dryRun: false });
  assert.equal(parseArguments(['status'], '/cwd').request.root, '/cwd');
  assert.equal(parseArguments(['update-sdk', '--dry-run'], '/cwd').request.dryRun, true);
  assert.deepEqual(parseArguments([], '/cwd'), { json: false, help: true });
  assert.deepEqual(parseArguments(['sync', '--help', '--json'], '/cwd'), { json: true, help: true });
  assert.equal(parseArguments(['resolve', '--path', '--json'], '/cwd').json, false, 'a literal --json option value does not request JSON output');
  assert.deepEqual(parseArguments(['auth-status', '--check', '--backend', 'https://backend.example']).request, { action: 'auth-status', backend: 'https://backend.example', check: true });
});

test('retired sync options and credential or URL flags are refused before dispatch', () => {
  for (const argv of [['sync', '--message', 'Update environment'], ['sync', '-m', 'Update environment'], ['sync', '--dry-run']]) {
    assert.throws(() => parseArguments(argv), error => error instanceof ToolingError && error.code === 'INVALID_REQUEST' && /sync no longer takes (--message|-m|--dry-run)/.test(error.message));
  }
  assert.throws(() => parseArguments(['login', '--access-token', 'SECRET']), error => error instanceof ToolingError && !/SECRET/.test(error.message));
  assert.throws(() => parseArguments(['mcp-add', '--url', 'https://arbitrary.example/mcp']), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseArguments(['status', '--path', '/a', '--path', '/b']), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseArguments(['login', '--path', '/a']), { code: 'INVALID_REQUEST' });
});

test('tokenizer treats quoted shell syntax as literal data and rejects operators, multiline and unclosed quotes', () => {
  assert.deepEqual(tokenizeCommand('status --path "$(echo hi); literal" --backend "/a path"'), ['status', '--path', '$(echo hi); literal', '--backend', '/a path']);
  assert.deepEqual(tokenizeCommand("  sync   --path   '/single quoted'  "), ['sync', '--path', '/single quoted']);
  assert.deepEqual(tokenizeCommand('status --path "escaped \\" quote"'), ['status', '--path', 'escaped " quote']);
  assert.deepEqual(tokenizeCommand(''), []);
  for (const command of ['sync; echo', 'status | cat', 'status\nlogin', 'status --path "unclosed', 'status `id`']) {
    assert.throws(() => tokenizeCommand(command), { code: 'INVALID_REQUEST' });
  }
});

test('typed library rejects incomplete requests before dispatch', async () => {
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  assert.equal((await tooling.dispatch({ action: 'sync' })).error.code, 'INVALID_REQUEST');
  assert.equal((await tooling.dispatch({ action: 'sync', message: 'legacy message' })).error.code, 'INVALID_REQUEST');
  assert.equal((await tooling.dispatch({ action: 'setup', repositoryUid: 'uid' })).error.code, 'INVALID_REQUEST');
  assert.equal((await tooling.dispatch({ action: 'freeze-env', root: '/fixture project' })).error.code, 'UNSUPPORTED_ACTION');
});

test('the ms-devtools runner is the terminal CLI and no longer serves the Codex hook', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ms runner with spaces '));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const runner = path.resolve('dist/runner.js');
  const help = spawnSync(process.execPath, [runner, '--help'], { cwd: temporary, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /MainSequence developer tooling/); assert.doesNotMatch(help.stdout, /freeze-env|--message/);
  const failure = spawnSync(process.execPath, [runner, 'sync', '--message', 'retired', '--json'], { cwd: temporary, encoding: 'utf8' });
  assert.equal(failure.status, 1); assert.equal(JSON.parse(failure.stdout).error.code, 'INVALID_REQUEST'); assert.equal(failure.stderr, '');
  const retired = spawnSync(process.execPath, [runner, 'freeze-env', '--json'], { cwd: temporary, encoding: 'utf8' });
  assert.equal(retired.status, 1); assert.equal(JSON.parse(retired.stdout).error.code, 'UNSUPPORTED_ACTION');
  const hook = spawnSync(process.execPath, [runner, '--codex-hook'], { cwd: temporary, input: JSON.stringify({ prompt: '/ms --help', cwd: temporary }), encoding: 'utf8' });
  assert.notEqual(hook.status, 0); assert.doesNotMatch(hook.stdout, /"decision"/);
});
