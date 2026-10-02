const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createCodexHost, handleCodexPrompt } = require('../dist/hosts/codex.js');
const { createDevTools, createNodeHost } = require('../dist/index.js');
const { tokenizeCommand } = require('../dist/shared/arguments.js');
const { project } = require('./helpers.cjs');

test('an unreachable sync backend blocks promptly without invoking the SDK workflow or reporting mutations', async t => {
  const p = await project(t);
  const head = p.git(['rev-parse', 'HEAD']);
  const host = createCodexHost(async (url, options) => {
    assert.equal(url, 'https://fixture.example/api/v1/');
    assert.equal(options.method, 'HEAD');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers, undefined);
    throw new Error('private network details');
  });
  const tooling = createDevTools({ host, env: {}, store: null });
  const output = await handleCodexPrompt({ prompt: '/ms sync --message " migrations updated fix" --backend https://fixture.example --json\n', cwd: p.root }, tooling.dispatch);
  assert.equal(output.decision, 'block');
  const result = JSON.parse(output.reason);
  assert.equal(result.error.code, 'BACKEND_UNREACHABLE');
  assert.equal(result.effects, undefined);
  assert.match(result.summary, /Start the backend/);
  assert.doesNotMatch(output.reason, /private network details/);
  assert.equal(p.git(['rev-parse', 'HEAD']), head);
  assert.equal(await fs.stat(path.join(p.root, 'fixture-invocation.json')).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(p.root, '.git', 'mainsequence-devtools.lock')).then(() => true).catch(() => false), false);
});

for (const type of ['python', 'vite_react']) {
  test(`Codex ${type} sync executes the SDK and blocks after a real commit/tag`, async t => {
    const p = await project(t, type);
    await fs.writeFile(path.join(p.root, 'change.txt'), 'sync from Codex\n');
    const host = createCodexHost(async () => new Response(null, { status: 401 }));
    const tooling = createDevTools({ host, env: {}, store: null });
    const output = await handleCodexPrompt({ prompt: '/ms sync --message " migrations updated fix" --backend https://fixture.example\n', cwd: p.root }, tooling.dispatch);
    assert.equal(output.decision, 'block');
    assert.doesNotMatch(output.reason, /Failed|schemaVersion/);
    assert.equal(p.git(['log', '-1', '--format=%s']), 'migrations updated fix');
    assert.equal(p.git(['tag']), 'fixture-sync');
  });
}

test('cancelling backend preflight keeps sync out of the SDK', async () => {
  const controller = new AbortController();
  const host = createCodexHost(async (_url, options) => {
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new Error('aborted');
  });
  await assert.rejects(host.prepareProjectAction({ backend: 'https://fixture.example' }, 'sync', controller.signal), error => error.code === 'CANCELLED');
});

test('a backend that never responds has a bounded sync preflight', async () => {
  const host = createCodexHost(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('private transport output')), { once: true });
  }));
  const started = Date.now();
  await assert.rejects(host.prepareProjectAction({ backend: 'https://fixture.example' }, 'sync'), error => error.code === 'BACKEND_UNREACHABLE' && !error.message.includes('private transport output'));
  assert.ok(Date.now() - started < 7000, 'An unresponsive backend must not leave sync waiting indefinitely.');
});

test('ordinary prompts pass through without dispatch; explicit /ms actions block on success and failure', async () => {
  let called = 0;
  const dispatch = async request => { called++; return { schemaVersion: 1, action: request.action, status: 'failure', summary: 'fixture failure' }; };
  for (const prompt of ['hello', ':ms --help', 'ms: --help', '/mss --help', 'please run /ms sync', 'Explain the /ms status command']) assert.equal(await handleCodexPrompt({ prompt }, dispatch), undefined);
  assert.equal(called, 0);
  const output = await handleCodexPrompt({ hook_event_name: 'UserPromptSubmit', prompt: '/ms sync -m "Update environment"', cwd: '/temporary path' }, dispatch);
  assert.equal(output.decision, 'block'); assert.match(output.reason, /MainSequence · Sync project · Failed\n\nfixture failure/); assert.equal(called, 1);
  assert.equal(output.systemMessage, undefined, 'The host displays the blocking reason; do not duplicate it as a warning.');
  const invalid = await handleCodexPrompt({ prompt: '/ms login --access-token SECRET' }, dispatch);
  assert.equal(invalid.decision, 'block'); assert.doesNotMatch(invalid.reason, /SECRET/); assert.equal(called, 1);
  assert.equal(await handleCodexPrompt({ hook_event_name: 'SessionStart', prompt: '/ms status' }, dispatch), undefined);
});

test('native slash-menu skill mentions dispatch only for this plugin and stay out of inference', async () => {
  const skillPath = path.resolve('skills/ms/SKILL.md');
  const mention = `[$mainsequence-devtools:ms?label=ms](${skillPath})`;
  let calls = 0;
  const dispatch = async request => { calls++; return { schemaVersion: 1, action: request.action, status: 'success', summary: 'fixture success', data: { root: request.root, message: request.message } }; };
  const help = await handleCodexPrompt({ prompt: `${mention} --help` }, dispatch);
  assert.equal(help.decision, 'block'); assert.match(help.reason, /\/ms sync --message "Describe your changes"/); assert.equal(calls, 0);
  const sync = await handleCodexPrompt({ prompt: `${mention} sync --message "Update environment (fixture)" --json`, cwd: '/fixture project' }, dispatch);
  assert.equal(sync.decision, 'block');
  assert.deepEqual(JSON.parse(sync.reason).data, { root: '/fixture project', message: 'Update environment (fixture)' });
  assert.equal(calls, 1);
  for (const prompt of [`Discuss ${mention} status`, `[$other:ms](${skillPath}) status`, `[$ms](/other/plugin/skills/ms/SKILL.md) status`]) assert.equal(await handleCodexPrompt({ prompt }, dispatch), undefined);
  assert.equal(calls, 1);
});

test('desktop trailing newline is accepted for raw commands and native skill mentions', async () => {
  const skillPath = path.resolve('skills/ms/SKILL.md');
  const mention = `[$mainsequence-devtools:ms](${skillPath})`;
  const dispatch = async () => { throw new Error('Help must not dispatch an action'); };
  for (const prefix of ['/ms', mention]) {
    for (const ending of ['\n', '\r\n', '  \n\n']) {
      const output = await handleCodexPrompt({ prompt: `${prefix} --help${ending}` }, dispatch);
      assert.equal(output.decision, 'block');
      assert.match(output.reason, /^MainSequence\n\nGet started\n\nSign in\n\/ms login/);
      assert.doesNotMatch(output.reason, /schemaVersion|\\n|ms-devtools/);
    }
    const empty = await handleCodexPrompt({ prompt: `${prefix}\n` }, dispatch);
    assert.match(empty.reason, /\/ms sync --message "Describe your changes"/);
  }
});

test('hook parser treats quoted shell syntax as literal data and rejects operators/multiline/unclosed quotes', async () => {
  assert.deepEqual(tokenizeCommand('sync --message "$(echo hi); literal" --path "/a path"'), ['sync', '--message', '$(echo hi); literal', '--path', '/a path']);
  for (const command of ['sync; echo', 'status\nlogin', '\n--help', '--help\nstatus\n', 'sync -m "unclosed']) {
    const result = await handleCodexPrompt({ prompt: '/ms ' + command }, async () => { throw new Error('must not dispatch'); });
    assert.equal(result.decision, 'block'); assert.match(result.reason, /Failed/); assert.match(result.reason, /For commands and examples: \/ms --help/);
  }
});

test('Codex results are readable by default and retain structured output only with --json', async () => {
  const result = { schemaVersion: 1, action: 'sync', status: 'failure', summary: 'Sync stopped after a commit.', error: { code: 'PROCESS_FAILED', message: 'Sync stopped after a commit.' }, effects: { state: 'partial-or-uncertain', message: 'Review the commit before retrying.' } };
  const dispatch = async () => result;
  const readable = await handleCodexPrompt({ prompt: '/ms sync -m "fixture"' }, dispatch);
  assert.equal(readable.decision, 'block');
  assert.match(readable.reason, /Failed\n\nSync stopped after a commit\./);
  assert.match(readable.reason, /Changes may be incomplete\nReview the commit before retrying\./);
  assert.doesNotMatch(readable.reason, /schemaVersion|PROCESS_FAILED|\\n/);
  const structured = await handleCodexPrompt({ prompt: '/ms sync -m "fixture" --json' }, dispatch);
  assert.equal(structured.decision, 'block');
  assert.deepEqual(JSON.parse(structured.reason), result);
  const help = await handleCodexPrompt({ prompt: '/ms --help --json' }, dispatch);
  assert.equal(JSON.parse(help.reason).action, 'help');
  assert.equal(JSON.parse(help.reason).status, 'success');
});

test('Codex help is compact, with discoverable full and command-specific options', async () => {
  const dispatch = async () => { throw new Error('Help must not run an action'); };
  const help = await handleCodexPrompt({ prompt: '/ms --help' }, dispatch);
  assert.ok(help.reason.split('\n').length < 24);
  assert.match(help.reason, /All commands: \/ms --help --all/);
  assert.doesNotMatch(help.reason, /login\||freeze-env\||Node 22|MCP/);
  const all = await handleCodexPrompt({ prompt: '/ms --help --all' }, dispatch);
  assert.match(all.reason, /Account\n/);
  assert.match(all.reason, /\/ms setup --uid UID --branch BRANCH --base-dir DIR/);
  assert.match(all.reason, /\/ms env-cleanup/);
  const sync = await handleCodexPrompt({ prompt: '/ms sync --help' }, dispatch);
  assert.match(sync.reason, /--dry-run  Preview the operation/);
  assert.match(sync.reason, /--path DIR/);
  assert.doesNotMatch(sync.reason, /\/ms setup/);
});

test('Codex repository, session and project results show useful fields without JSON dumps', async () => {
  const run = (action, data) => handleCodexPrompt({ prompt: `/ms ${action}` }, async () => ({ schemaVersion: 1, action, status: 'success', summary: `${action} completed.`, data }));
  const data = [{ uid: 'repo-1', code_repository_name: 'Research', code_repository_type: 'python', branches: [{ uid: 'branch-1', repository_branch: 'main' }] }];
  const listed = await run('repositories', data);
  assert.match(listed.reason, /1 code repository\n\n1\. Research\n   Python · main\n   ID: repo-1/);
  assert.doesNotMatch(listed.reason, /code_repository|repository_branch|"uid"|\{|\}/);
  const empty = await run('repositories', []);
  assert.match(empty.reason, /No code repositories found\./);
  const session = { authenticated: true, username: 'fixture-user', backend: 'https://fixture.example', source: 'machine', persistence: 'machine', store: 'technical-store-name' };
  const account = await run('auth-status', session);
  assert.match(account.reason, /Signed in as fixture-user\nBackend: https:\/\/fixture\.example\nLogin shared with your SDKs/);
  assert.doesNotMatch(account.reason, /authenticated|technical-store-name|\{|\}/);
  const status = await run('status', { project: { root: '/fixture project', projectType: 'python', branch: 'main', gitCommonDir: '/internal-lock-directory' }, session, capabilities: [{ action: 'sync', state: 'available' }] });
  assert.match(status.reason, /Folder: \/fixture project\nProject type: Python\nBranch: main/);
  assert.match(status.reason, /Sync project: Available/);
  assert.doesNotMatch(status.reason, /gitCommonDir|internal-lock-directory|"root"|\{|\}/);
  const sdk = await run('sdk-status', { installed: null, latestSourceVersion: '8.1.27', registryPublicationVerified: false });
  assert.match(sdk.reason, /Installed version: Not installed/);
  assert.match(sdk.reason, /Latest source version: 8\.1\.27/);
  assert.match(sdk.reason, /Registry publication verified: No/);
  const structured = await handleCodexPrompt({ prompt: '/ms repositories --json' }, async () => ({ schemaVersion: 1, action: 'repositories', status: 'success', summary: 'repositories completed.', data }));
  assert.deepEqual(JSON.parse(structured.reason).data, data);
});

test('a literal --json message value does not request JSON output', async () => {
  const output = await handleCodexPrompt({ prompt: '/ms sync --message "--json"' }, async request => ({ schemaVersion: 1, action: request.action, status: 'success', summary: 'sync completed.', data: { message: request.message } }));
  assert.match(output.reason, /MainSequence · Sync project\n\nCompleted successfully\./);
  assert.match(output.reason, /Message: --json/);
  assert.doesNotMatch(output.reason, /schemaVersion|\{|\}/);
});

test('typed library rejects incomplete requests before dispatch', async () => {
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  assert.equal((await tooling.dispatch({ action: 'sync', message: 'test' })).error.code, 'INVALID_REQUEST');
  assert.equal((await tooling.dispatch({ action: 'setup', repositoryUid: 'uid' })).error.code, 'INVALID_REQUEST');
});

test('built plugin is self-contained and works outside the checkout, including paths with spaces', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ms plugin with spaces '));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const target = path.join(temporary, 'installed plugin');
  await fs.cp(path.resolve('artifacts/codex/mainsequence-devtools'), target, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(target, '.codex-plugin/plugin.json')));
  assert.equal(manifest.hooks, './hooks/hooks.json');
  assert.equal(manifest.skills, './skills/');
  assert.match(await fs.readFile(path.join(target, 'skills/ms/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  assert.equal(await fs.stat(path.join(target, 'plugin.json')).then(()=>true).catch(()=>false), false);
  assert.equal(await fs.stat(path.join(target, 'node_modules')).then(()=>true).catch(()=>false), false);
  const hooks = JSON.parse(await fs.readFile(path.join(target, 'hooks/hooks.json')));
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, 'node "${PLUGIN_ROOT}/dist/runner.js" --codex-hook');
  assert.equal(hooks.hooks.UserPromptSubmit[0].matcher, undefined);
  const help = spawnSync(process.execPath, [path.join(target, 'dist/runner.js'), '--help'], { cwd: temporary, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /MainSequence developer tooling/);
  const ordinary = spawnSync(process.execPath, [path.join(target, 'dist/runner.js'), '--codex-hook'], { input: JSON.stringify({ prompt: 'ordinary prompt', cwd: temporary }), cwd: temporary, encoding: 'utf8' });
  assert.equal(ordinary.status, 0); assert.equal(ordinary.stdout, '');
  const mention = `[$mainsequence-devtools:ms?label=ms](${path.join(target, 'skills/ms/SKILL.md')})`;
  const action = spawnSync(process.execPath, [path.join(target, 'dist/runner.js'), '--codex-hook'], { input: JSON.stringify({ prompt: mention + ' --help', cwd: temporary }), cwd: temporary, encoding: 'utf8' });
  assert.equal(action.status, 0); assert.equal(JSON.parse(action.stdout).decision, 'block');
  const failure = spawnSync(process.execPath, [path.join(target, 'dist/runner.js'), 'sync', '--json'], { cwd: temporary, encoding: 'utf8' });
  assert.equal(failure.status, 1); assert.equal(JSON.parse(failure.stdout).error.code, 'INVALID_REQUEST');
  assert.equal(failure.stderr, '');
});
