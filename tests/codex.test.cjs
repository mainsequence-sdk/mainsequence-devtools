const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { handleCodexPrompt } = require('../dist/hosts/codex.js');
const { createDevTools, createNodeHost } = require('../dist/index.js');
const { parseArguments, tokenizeCommand } = require('../dist/shared/arguments.js');
const { project, fixtureBackend } = require('./helpers.cjs');

for (const type of ['python', 'vite_react']) {
  test(`Codex ${type} sync refreshes dependency files through the SDK, contacts no backend and changes no Git state`, async t => {
    const p = await project(t, type), backend = await fixtureBackend(t);
    const head = p.git(['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(p.root, 'change.txt'), 'sync from Codex\n');
    const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
    const output = await handleCodexPrompt({ prompt: `/ms sync --backend ${backend.backend}\n`, cwd: p.root }, tooling.dispatch);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /^MainSequence · Refresh dependency files\n\nDependency files were refreshed\. Nothing was committed or pushed: review the changes, then commit and push them yourself\./);
    assert.doesNotMatch(output.reason, /Failed|schemaVersion/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(p.root, 'fixture-invocation.json'))).args, ['code-repository', 'sync', '--path', '.']);
    assert.deepEqual(backend.calls, [], 'sync makes no backend request');
    assert.equal(p.git(['rev-parse', 'HEAD']), head);
    assert.equal(p.git(['tag']), '');
    assert.equal(await fs.stat(path.join(p.root, '.git', 'mainsequence-devtools.lock')).then(() => true).catch(() => false), false);
  });
}

test('retired sync options and freeze-env are refused before dispatch or the SDK', async () => {
  const dispatch = async () => { throw new Error('must not dispatch'); };
  for (const command of ['sync --message "Update environment"', 'sync -m "Update environment"', 'sync --dry-run']) {
    const output = await handleCodexPrompt({ prompt: `/ms ${command}` }, dispatch);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /^MainSequence · Command · Failed\n\nsync no longer takes (--message|-m|--dry-run): it refreshes dependency files and does not commit, tag or push\. Commit and push the changes yourself\./);
  }
  assert.deepEqual(parseArguments(['sync', '--path', '/a project'], '/cwd').request, { action: 'sync', backend: undefined, root: '/a project', projectType: undefined, dryRun: false });
  assert.equal(parseArguments(['update-sdk', '--dry-run'], '/cwd').request.dryRun, true);
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  const freeze = JSON.parse((await handleCodexPrompt({ prompt: '/ms freeze-env --json', cwd: '/fixture project' }, tooling.dispatch)).reason);
  assert.equal(freeze.error.code, 'UNSUPPORTED_ACTION'); assert.match(freeze.summary, /Run sync instead/);
});

test('ordinary prompts pass through without dispatch; explicit /ms actions block on success and failure', async () => {
  let called = 0;
  const dispatch = async request => { called++; return { schemaVersion: 1, action: request.action, status: 'failure', summary: 'fixture failure' }; };
  for (const prompt of ['hello', ':ms --help', 'ms: --help', '/mss --help', 'please run /ms sync', 'Explain the /ms status command']) assert.equal(await handleCodexPrompt({ prompt }, dispatch), undefined);
  assert.equal(called, 0);
  const output = await handleCodexPrompt({ hook_event_name: 'UserPromptSubmit', prompt: '/ms sync', cwd: '/temporary path' }, dispatch);
  assert.equal(output.decision, 'block'); assert.match(output.reason, /MainSequence · Refresh dependency files · Failed\n\nfixture failure/); assert.equal(called, 1);
  assert.equal(output.systemMessage, undefined, 'The host displays the blocking reason; do not duplicate it as a warning.');
  const invalid = await handleCodexPrompt({ prompt: '/ms login --access-token SECRET' }, dispatch);
  assert.equal(invalid.decision, 'block'); assert.doesNotMatch(invalid.reason, /SECRET/); assert.equal(called, 1);
  assert.equal(await handleCodexPrompt({ hook_event_name: 'SessionStart', prompt: '/ms status' }, dispatch), undefined);
});

test('native slash-menu skill mentions dispatch only for this plugin and stay out of inference', async () => {
  const skillPath = path.resolve('skills/ms/SKILL.md');
  const mention = `[$mainsequence-devtools:ms?label=ms](${skillPath})`;
  let calls = 0;
  const dispatch = async request => { calls++; return { schemaVersion: 1, action: request.action, status: 'success', summary: 'fixture success', data: { root: request.root, keys: Object.keys(request).sort() } }; };
  const help = await handleCodexPrompt({ prompt: `${mention} --help` }, dispatch);
  assert.equal(help.decision, 'block'); assert.match(help.reason, /Refresh dependency files\n\/ms sync\n/); assert.equal(calls, 0);
  const sync = await handleCodexPrompt({ prompt: `${mention} sync --path "/fixture project (spaces)" --json`, cwd: '/fixture project' }, dispatch);
  assert.equal(sync.decision, 'block');
  assert.deepEqual(JSON.parse(sync.reason).data, { root: '/fixture project (spaces)', keys: ['action', 'backend', 'dryRun', 'projectType', 'root'] });
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
    assert.match(empty.reason, /Refresh dependency files\n\/ms sync\n/);
  }
});

test('hook parser treats quoted shell syntax as literal data and rejects operators/multiline/unclosed quotes', async () => {
  assert.deepEqual(tokenizeCommand('status --path "$(echo hi); literal" --backend "/a path"'), ['status', '--path', '$(echo hi); literal', '--backend', '/a path']);
  for (const command of ['sync; echo', 'status\nlogin', '\n--help', '--help\nstatus\n', 'status --path "unclosed']) {
    const result = await handleCodexPrompt({ prompt: '/ms ' + command }, async () => { throw new Error('must not dispatch'); });
    assert.equal(result.decision, 'block'); assert.match(result.reason, /Failed/); assert.match(result.reason, /For commands and examples: \/ms --help/);
  }
});

test('Codex results are readable by default and retain structured output only with --json', async () => {
  const result = { schemaVersion: 1, action: 'sync', status: 'failure', summary: 'Sync stopped after the lock file changed.', error: { code: 'PROCESS_FAILED', message: 'Sync stopped after the lock file changed.' }, effects: { state: 'partial-or-uncertain', message: 'Review the changed files before retrying.' } };
  const dispatch = async () => result;
  const readable = await handleCodexPrompt({ prompt: '/ms sync' }, dispatch);
  assert.equal(readable.decision, 'block');
  assert.match(readable.reason, /Failed\n\nSync stopped after the lock file changed\./);
  assert.match(readable.reason, /Changes may be incomplete\nReview the changed files before retrying\./);
  assert.doesNotMatch(readable.reason, /schemaVersion|PROCESS_FAILED|\\n/);
  const structured = await handleCodexPrompt({ prompt: '/ms sync --json' }, dispatch);
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
  assert.doesNotMatch(help.reason, /login\||freeze-env|Node 22|MCP/);
  const all = await handleCodexPrompt({ prompt: '/ms --help --all' }, dispatch);
  assert.match(all.reason, /Account\n/);
  assert.match(all.reason, /\/ms setup --uid UID --branch BRANCH --base-dir DIR/);
  assert.match(all.reason, /\/ms env-cleanup/);
  assert.match(all.reason, /\/ms sync\n  Refresh dependency files/);
  assert.doesNotMatch(all.reason, /freeze-env|--message/);
  const sync = await handleCodexPrompt({ prompt: '/ms sync --help' }, dispatch);
  assert.match(sync.reason, /^MainSequence · Refresh dependency files\n\n\/ms sync\n\nPython: updates uv\.lock, the project environment and requirements\.txt\.\nNode: updates package-lock\.json, then runs npm ci\.\nNothing is committed or pushed: review the changes, then commit and push them yourself\.\n\nOptions\n/);
  assert.match(sync.reason, /--path DIR/);
  assert.doesNotMatch(sync.reason, /--dry-run|--message|\/ms setup/);
  assert.match((await handleCodexPrompt({ prompt: '/ms update-sdk --help' }, dispatch)).reason, /--dry-run  Preview the operation/);
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
  assert.match(status.reason, /Refresh dependency files: Available/);
  assert.doesNotMatch(status.reason, /gitCommonDir|internal-lock-directory|"root"|\{|\}/);
  const sdk = await run('sdk-status', { installed: null, latestSourceVersion: '8.1.27', registryPublicationVerified: false });
  assert.match(sdk.reason, /Installed version: Not installed/);
  assert.match(sdk.reason, /Latest source version: 8\.1\.27/);
  assert.match(sdk.reason, /Registry publication verified: No/);
  const structured = await handleCodexPrompt({ prompt: '/ms repositories --json' }, async () => ({ schemaVersion: 1, action: 'repositories', status: 'success', summary: 'repositories completed.', data }));
  assert.deepEqual(JSON.parse(structured.reason).data, data);
});

test('a literal --json option value does not request JSON output', async () => {
  const output = await handleCodexPrompt({ prompt: '/ms resolve --path "--json"' }, async request => ({ schemaVersion: 1, action: request.action, status: 'success', summary: `${request.action} completed.`, data: { root: request.root } }));
  assert.match(output.reason, /MainSequence · Find the backend repository\n\nCompleted successfully\./);
  assert.match(output.reason, /Folder: --json/);
  assert.doesNotMatch(output.reason, /schemaVersion|\{|\}/);
});

test('typed library rejects incomplete requests before dispatch', async () => {
  const tooling = createDevTools({ host: createNodeHost(), env: {}, store: null });
  assert.equal((await tooling.dispatch({ action: 'sync' })).error.code, 'INVALID_REQUEST');
  assert.equal((await tooling.dispatch({ action: 'sync', message: 'legacy message' })).error.code, 'INVALID_REQUEST');
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
  const failure = spawnSync(process.execPath, [path.join(target, 'dist/runner.js'), 'sync', '--message', 'retired', '--json'], { cwd: temporary, encoding: 'utf8' });
  assert.equal(failure.status, 1); assert.equal(JSON.parse(failure.stdout).error.code, 'INVALID_REQUEST');
  assert.equal(failure.stderr, '');
  const retired = spawnSync(process.execPath, [path.join(target, 'dist/runner.js'), 'freeze-env', '--json'], { cwd: temporary, encoding: 'utf8' });
  assert.equal(retired.status, 1); assert.equal(JSON.parse(retired.stdout).error.code, 'UNSUPPORTED_ACTION');
  assert.doesNotMatch(spawnSync(process.execPath, [path.join(target, 'dist/runner.js'), '--help'], { encoding: 'utf8' }).stdout, /freeze-env|--message/);
});
