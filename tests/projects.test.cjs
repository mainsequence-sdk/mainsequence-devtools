const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDevTools, createNodeHost } = require('../dist/index.js');
const { runProcess } = require('../dist/shared/process.js');
const { withProjectLock } = require('../dist/shared/projects.js');
const { renderMachineEnv } = require('../dist/shared/envfile.js');
const { canonicalRepositoryDir } = require('../dist/shared/repositories.js');
const { saveSession } = require('../dist/shared/machineSession.js');
const { project, fixtureBackend, memoryStore } = require('./helpers.cjs');

for (const type of ['python', 'vite_react']) {
  test(`${type}: SDK-local sync preserves argv and runs a real Git commit/tag in a path with spaces`, async t => {
    const p = await project(t, type);
    const store = memoryStore();
    saveSession(store, 'https://fixture.example', { username: 'user', access: 'fixture-access-1', refresh: 'fixture-refresh-1' });
    const progress = [];
    const tooling = createDevTools({ host: createNodeHost(text => progress.push(text)), env: { ...process.env, MAINSEQUENCE_ENDPOINT: 'https://fixture.example' }, store });
    const message = 'Commit "quotes", $(touch should-not-exist); literal $HOME';
    await fs.writeFile(path.join(p.root, 'change.txt'), 'modified\n');
    const result = await tooling.dispatch({ action: 'sync', root: path.join(p.root, '.git', '..'), message, projectType: type });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(p.git(['log', '-1', '--format=%s']), message);
    assert.equal(p.git(['tag']), 'fixture-sync');
    const invocation = JSON.parse(await fs.readFile(path.join(p.root, 'fixture-invocation.json')));
    assert.deepEqual(invocation.args, ['code-repository', 'sync', '--path', '.', '-m', message]);
    assert.equal(invocation.endpoint, 'https://fixture.example');
    assert.equal(await fs.stat(path.join(p.root, 'should-not-exist')).then(()=>true).catch(()=>false), false);
    assert.doesNotMatch(JSON.stringify({ result, progress }), /fixture-access|fixture-refresh|fixture-leak/);
    assert.equal(await fs.stat(path.join(p.root, '.git', 'mainsequence-devtools.lock')).then(()=>true).catch(()=>false), false);
  });
}

test('dry-run executes CLI preflight without project or Git mutation', async t => {
  const p = await project(t);
  const head = p.git(['rev-parse', 'HEAD']);
  const result = await createDevTools({ host: createNodeHost(), env: {}, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example', message: 'preview', dryRun: true });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(p.git(['rev-parse', 'HEAD']), head); assert.equal(p.git(['tag']), '');
  const invocation = JSON.parse(await fs.readFile(path.join(p.root, 'fixture-invocation.json')));
  assert.equal(invocation.args.at(-1), '--dry-run');
});

test('missing project SDK is reported without falling back to a global SDK', async t => {
  const p = await project(t, 'python', false);
  const result = await createDevTools({ host: createNodeHost(), env: {}, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example', message: 'test' });
  assert.equal(result.error.code, 'MISSING_PREREQUISITE'); assert.equal(result.effects, undefined);
});

test('sync failure after a commit reports uncertain effects without retry or rollback', async t => {
  const p = await project(t);
  await fs.writeFile(path.join(p.root, 'change.txt'), 'partial mutation\n');
  const result = await createDevTools({ host: createNodeHost(), env: { ...process.env, FIXTURE_FAIL: '1' }, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example', message: 'partial' });
  assert.equal(result.error.code, 'PROCESS_FAILED', JSON.stringify(result));
  assert.equal(result.effects.state, 'partial-or-uncertain');
  assert.equal(p.git(['rev-list', '--count', 'HEAD']), '2');
  assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh|fixture-leak/);
});

test('repository locks reject concurrent mutation and clean up after failure', async t => {
  const p = await project(t);
  let release; const blocked = new Promise(resolve => release = resolve);
  const first = withProjectLock(path.join(p.root, '.git'), () => blocked);
  await new Promise(resolve => setTimeout(resolve, 10));
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  const result = await tooling.dispatch({ action: 'env-cleanup', root: p.root, backend: 'https://fixture.example' });
  assert.equal(result.error.code, 'PROJECT_BUSY');
  release(); await first;
  assert.equal((await tooling.dispatch({ action: 'env-cleanup', root: p.root, backend: 'https://fixture.example' })).status, 'success');
});

test('cancellation stops the SDK process and reports partial effects', async t => {
  const p = await project(t), controller = new AbortController();
  await fs.writeFile(path.join(p.root, 'change.txt'), 'cancelled mutation\n');
  const tooling = createDevTools({ host: createNodeHost(), env: { ...process.env, FIXTURE_SLOW: '1' }, store: null, signal: controller.signal });
  const running = tooling.dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example', message: 'cancel' });
  const deadline = Date.now() + 3000;
  while (!(await fs.stat(path.join(p.root, 'fixture-invocation.json')).then(()=>true).catch(()=>false))) {
    assert.ok(Date.now() < deadline, 'SDK process started'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(result.effects.state, 'partial-or-uncertain');
  assert.equal(await fs.stat(path.join(p.root, '.git', 'mainsequence-devtools.lock')).then(()=>true).catch(()=>false), false);
});

test('env cleanup removes export/whitespace legacy credentials, preserves app settings, and refuses tracked/symlink files', async t => {
  assert.match(renderMachineEnv('MAINSEQUENCE_AUTH_MODE=custom_runtime_credential\n', 'https://fixture.example'), /MAINSEQUENCE_AUTH_MODE=custom_runtime_credential/);
  const p = await project(t), tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  await fs.writeFile(path.join(p.root, '.env'), 'APP_SETTING=keep\nexport MAINSEQUENCE_ACCESS_TOKEN = old\n MAINSEQUENCE_REFRESH_TOKEN=old-r\nMAINSEQUENCE_RUNTIME_CREDENTIAL_ID=id\nMAINSEQUENCE_RUNTIME_CREDENTIAL_SECRET=secret\nMAINSEQUENCE_AUTH_MODE="runtime_credential"\nMAINSEQUENCE_TOKEN=unsupported\nMAINSEQUENCE_ENDPOINT=https://old.example\n');
  const blocked = await tooling.dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example', message: 'test' });
  assert.equal(blocked.error.code, 'INVALID_REQUEST');
  const result = await tooling.dispatch({ action: 'env-cleanup', root: p.root, backend: 'https://fixture.example' });
  assert.equal(result.status, 'success');
  const text = await fs.readFile(path.join(p.root, '.env'), 'utf8');
  assert.equal(text, 'APP_SETTING=keep\n\n# BEGIN MAINSEQUENCE AUTH (managed by VS Code)\nMAINSEQUENCE_ENDPOINT=https://fixture.example\n# END MAINSEQUENCE AUTH\n');
  assert.equal((await fs.stat(path.join(p.root, '.env'))).mode & 0o777, 0o600);
  const written = await fs.stat(path.join(p.root, '.env'));
  assert.equal((await tooling.dispatch({ action: 'env-cleanup', root: p.root, backend: 'https://fixture.example' })).status, 'success');
  const again = await fs.stat(path.join(p.root, '.env'));
  assert.deepEqual([again.ino, again.mtimeMs], [written.ino, written.mtimeMs], 'a file already in machine form is not written again');
  p.git(['add', '-f', '.env']);
  assert.equal((await tooling.dispatch({ action: 'env-cleanup', root: p.root, backend: 'https://fixture.example' })).error.code, 'INVALID_REQUEST');
  p.git(['reset', '--', '.env']); await fs.unlink(path.join(p.root, '.env'));
  const target = path.join(p.base, 'outside.env'); await fs.writeFile(target, 'outside'); await fs.symlink(target, path.join(p.root, '.env'));
  assert.equal((await tooling.dispatch({ action: 'env-cleanup', root: p.root, backend: 'https://fixture.example' })).error.code, 'INVALID_REQUEST');
  assert.equal(await fs.readFile(target, 'utf8'), 'outside');
});

test('inherited environment credentials cannot be sent to another backend', async t => {
  const p = await project(t);
  const result = await createDevTools({ host: createNodeHost(), env: { MAINSEQUENCE_ENDPOINT: 'https://a.example', MAINSEQUENCE_ACCESS_TOKEN: 'private-identity' }, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://b.example', message: 'test' });
  assert.equal(result.error.code, 'BACKEND_MISMATCH'); assert.equal(result.effects, undefined);
});

test('platform skills and absent native host capabilities report unsupported without MCP', async t => {
  const p = await project(t);
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  for (const action of ['skills-sync', 'open-folder', 'signed-terminal']) assert.equal((await tooling.dispatch({ action, root: p.root, backend: 'https://fixture.example' })).error.code, 'UNSUPPORTED_ACTION');
});

test('Git resolution checks exact identity/branch/commit and supports workspaces inside the root', async t => {
  const p = await project(t), fixture = await fixtureBackend(t), store = memoryStore();
  saveSession(store, fixture.backend, { username: 'shared', access: 'fixture-access-1', refresh: 'r' });
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store });
  await fs.mkdir(path.join(p.root, 'src'));
  const result = await tooling.dispatch({ action: 'resolve', root: path.join(p.root, 'src'), backend: fixture.backend });
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.data.project.repositoryIdentity, 'github.com/Example/Shared');
  assert.equal(result.data.resolution.commit_sha, p.git(['rev-parse', 'HEAD']));
  p.git(['checkout', '--detach']);
  assert.equal((await tooling.dispatch({ action: 'resolve', root: p.root, backend: fixture.backend })).error.code, 'INVALID_GIT_CONTEXT');
});

test('Node sdk-status exposes only supported metadata fields', async t => {
  const p = await project(t, 'vite_react');
  const result = await createDevTools({ host: createNodeHost(), env: {}, store: null }).dispatch({ action: 'sdk-status', root: p.root, backend: 'https://fixture.example' });
  assert.equal(result.status, 'success'); assert.equal(result.data.installed, '0.5.11');
  assert.equal(result.data.updateAvailable, false); assert.equal(result.data.updateSupported, true); assert.equal(result.data.refresh_token, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-password|fixture-url-token/);
});

test('process timeout is bounded and does not leak child output', async t => {
  const p = await project(t);
  const result = await runProcess({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], cwd: p.root, timeoutMs: 30 });
  assert.equal(result.timedOut, true); assert.equal(result.exitCode, null);
});

test('canonical repository layout rejects path traversal UIDs', () => {
  assert.equal(canonicalRepositoryDir('/base', 'Fixture Org', 'uid-1', 'My Repo'), '/base/fixture-org/projects/my-repo-uid-1');
  for (const uid of ['../bad', '..', '.', 'a/b']) assert.throws(() => canonicalRepositoryDir('/base', 'org', uid, 'name'));
});
