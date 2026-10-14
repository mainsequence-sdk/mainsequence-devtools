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
const { buildCodeRepositoryCliInvocations, codeRepositoryActionPreview, sanitizeCommitMessage } = require('../dist/index.js');
const { project, fixtureBackend, memoryStore } = require('./helpers.cjs');

const exists = file => fs.stat(file).then(() => true).catch(() => false);

for (const type of ['python', 'vite_react']) {
  test(`${type}: sync runs exactly code-repository sync --path . and changes no Git state, in a path with spaces`, async t => {
    const p = await project(t, type);
    const store = memoryStore();
    saveSession(store, 'https://fixture.example', { username: 'user', access: 'fixture-access-1', refresh: 'fixture-refresh-1' });
    const progress = [];
    const tooling = createDevTools({ host: createNodeHost(text => progress.push(text)), env: { ...process.env, MAINSEQUENCE_ENDPOINT: 'https://fixture.example' }, store });
    const head = p.git(['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(p.root, 'change.txt'), 'modified\n');
    const result = await tooling.dispatch({ action: 'sync', root: path.join(p.root, '.git', '..'), projectType: type });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.match(result.summary, /Dependency files were refreshed\. Nothing was committed or pushed/);
    const invocation = JSON.parse(await fs.readFile(path.join(p.root, 'fixture-invocation.json')));
    assert.deepEqual(invocation.args, ['code-repository', 'sync', '--path', '.']);
    assert.equal(invocation.endpoint, 'https://fixture.example');
    for (const file of type === 'python' ? ['uv.lock', 'requirements.txt'] : ['package-lock.json']) assert.equal(await exists(path.join(p.root, file)), true, file);
    assert.equal(p.git(['rev-parse', 'HEAD']), head);
    assert.equal(p.git(['tag']), '');
    assert.equal(p.git(['status', '--porcelain', '--', 'change.txt']), 'M change.txt', 'the person commits their own changes');
    assert.doesNotMatch(JSON.stringify({ result, progress }), /fixture-access|fixture-refresh|fixture-leak/);
    assert.equal(await exists(path.join(p.root, '.git', 'mainsequence-devtools.lock')), false);
  });

  test(`${type}: an installed SDK with the retired release sync is reported unavailable and never run`, async t => {
    const p = await project(t, type, 'release-sync');
    const head = p.git(['rev-parse', 'HEAD']);
    const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
    const required = type === 'python' ? /mainsequence 9\.0\.5 or later/ : /@dev-mainsequence\/command-center-sdk 0\.5\.13 or later/;
    const status = await tooling.dispatch({ action: 'status', root: p.root, backend: 'https://fixture.example', projectType: type });
    const capability = status.data.capabilities.find(item => item.action === 'sync');
    assert.equal(capability.state, 'unavailable');
    assert.match(capability.reason, /retired release sync/); assert.match(capability.reason, /Run update-sdk/); assert.match(capability.reason, required);
    assert.equal(status.data.capabilities.find(item => item.action === 'update-sdk').state, 'available');
    const result = await tooling.dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example', projectType: type });
    assert.equal(result.error.code, 'MISSING_PREREQUISITE'); assert.match(result.summary, required);
    assert.equal(result.effects, undefined);
    assert.equal(await exists(path.join(p.root, 'fixture-invocation.json')), false, 'the old sync must not run');
    assert.equal(p.git(['rev-parse', 'HEAD']), head);
  });
}

test('a sync request that still carries a commit message is accepted and the message is ignored', async t => {
  const p = await project(t);
  const result = await createDevTools({ host: createNodeHost(), env: {}, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example', message: 'Commit "quotes", $(touch should-not-exist)' });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(p.root, 'fixture-invocation.json'))).args, ['code-repository', 'sync', '--path', '.']);
  assert.equal(p.git(['rev-list', '--count', 'HEAD']), '1');
  assert.equal(await exists(path.join(p.root, 'should-not-exist')), false);
});

test('sync has no dry-run mode and never reaches the SDK with one', async t => {
  const p = await project(t);
  const result = await createDevTools({ host: createNodeHost(), env: {}, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example', dryRun: true });
  assert.equal(result.error.code, 'INVALID_REQUEST'); assert.equal(result.effects, undefined);
  assert.equal(await exists(path.join(p.root, 'fixture-invocation.json')), false);
});

test('freeze-env is no longer an action; sync replaces it', async t => {
  const p = await project(t);
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  const result = await tooling.dispatch({ action: 'freeze-env', root: p.root, backend: 'https://fixture.example' });
  assert.equal(result.error.code, 'UNSUPPORTED_ACTION'); assert.match(result.summary, /freeze-env was removed: sync now refreshes/);
  assert.equal(result.effects, undefined);
  assert.equal(await exists(path.join(p.root, 'fixture-invocation.json')), false);
  const status = await tooling.dispatch({ action: 'status', root: p.root, backend: 'https://fixture.example' });
  assert.equal(status.data.capabilities.some(item => item.action === 'freeze-env'), false);
});

test('public CLI helpers build the dependency sync and no freeze-env or commit-message invocation', () => {
  assert.deepEqual(codeRepositoryActionPreview('python', 'sync'), ['mainsequence code-repository sync --path .']);
  assert.deepEqual(codeRepositoryActionPreview('vite_react', 'sync', 'ignored message'), ['command-center-sdk code-repository sync --path .']);
  for (const type of ['python', 'vite_react']) assert.deepEqual(codeRepositoryActionPreview(type, 'freezeEnv'), []);
  const cli = { codeRepositoryType: 'vite_react', commandName: 'command-center-sdk', packageName: '@dev-mainsequence/command-center-sdk', executable: '/node', prefixArgs: ['/entry.mjs'], available: true, bootstrapAction: 'installDependencies', bootstrapLabel: '', missingMessage: '' };
  assert.deepEqual(buildCodeRepositoryCliInvocations(cli, 'sync', { commitMessage: '' }).map(item => item.args), [['/entry.mjs', 'code-repository', 'sync', '--path', '.']]);
  assert.equal(sanitizeCommitMessage(' kept\nfor callers '), 'kept for callers');
});

test('missing project SDK is reported without falling back to a global SDK', async t => {
  const p = await project(t, 'python', false);
  const result = await createDevTools({ host: createNodeHost(), env: {}, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example' });
  assert.equal(result.error.code, 'MISSING_PREREQUISITE'); assert.equal(result.effects, undefined);
});

test('sync failure reports uncertain effects without retry or rollback', async t => {
  const p = await project(t);
  const result = await createDevTools({ host: createNodeHost(), env: { ...process.env, FIXTURE_FAIL: '1' }, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example' });
  assert.equal(result.error.code, 'PROCESS_FAILED', JSON.stringify(result));
  assert.equal(result.effects.state, 'partial-or-uncertain');
  assert.equal(p.git(['rev-list', '--count', 'HEAD']), '1');
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
  const running = tooling.dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example' });
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
  const blocked = await tooling.dispatch({ action: 'sync', root: p.root, backend: 'https://fixture.example' });
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
  const result = await createDevTools({ host: createNodeHost(), env: { MAINSEQUENCE_ENDPOINT: 'https://a.example', MAINSEQUENCE_ACCESS_TOKEN: 'private-identity' }, store: null }).dispatch({ action: 'sync', root: p.root, backend: 'https://b.example' });
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

test('MCP skills capability follows the explicit host opt-in while the default stays unsupported', async t => {
  const p = await project(t);
  for (const enabled of [false, true]) {
    const result = await createDevTools({ host: createNodeHost(), env: {}, store: null, allowMcpSkills: enabled }).dispatch({ action: 'status', root: p.root, backend: 'https://fixture.example' });
    assert.equal(result.status, 'success');
    const capability = result.data.capabilities.find(item => item.action === 'skills-sync');
    assert.equal(capability.state, enabled ? 'available' : 'unsupported');
  }
});
