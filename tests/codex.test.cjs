const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { handleCodexPrompt } = require('../dist/hosts/codex.js');
const { createDevTools, createNodeHost } = require('../dist/index.js');
const { tokenizeCommand } = require('../dist/shared/arguments.js');

test('ordinary prompts pass through without dispatch; explicit /ms actions block on success and failure', async () => {
  let called = 0;
  const dispatch = async request => { called++; return { schemaVersion: 1, action: request.action, status: 'failure', summary: 'fixture failure' }; };
  for (const prompt of ['hello', ':ms --help', 'ms: --help', '/mss --help', 'please run /ms sync', 'Explain the /ms status command']) assert.equal(await handleCodexPrompt({ prompt }, dispatch), undefined);
  assert.equal(called, 0);
  const output = await handleCodexPrompt({ hook_event_name: 'UserPromptSubmit', prompt: '/ms sync -m "Update environment"', cwd: '/temporary path' }, dispatch);
  assert.equal(output.decision, 'block'); assert.equal(JSON.parse(output.reason).status, 'failure'); assert.equal(called, 1);
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
  assert.equal(help.decision, 'block'); assert.equal(JSON.parse(help.reason).action, 'help'); assert.equal(calls, 0);
  const sync = await handleCodexPrompt({ prompt: `${mention} sync --message "Update environment (fixture)"`, cwd: '/fixture project' }, dispatch);
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
      assert.equal(JSON.parse(output.reason).status, 'success');
      assert.equal(JSON.parse(output.reason).action, 'help');
    }
    const empty = await handleCodexPrompt({ prompt: `${prefix}\n` }, dispatch);
    assert.equal(JSON.parse(empty.reason).action, 'help');
  }
});

test('hook parser treats quoted shell syntax as literal data and rejects operators/multiline/unclosed quotes', async () => {
  assert.deepEqual(tokenizeCommand('sync --message "$(echo hi); literal" --path "/a path"'), ['sync', '--message', '$(echo hi); literal', '--path', '/a path']);
  for (const command of ['sync; echo', 'status\nlogin', '\n--help', '--help\nstatus\n', 'sync -m "unclosed']) {
    const result = await handleCodexPrompt({ prompt: '/ms ' + command }, async () => { throw new Error('must not dispatch'); });
    assert.equal(result.decision, 'block'); assert.equal(JSON.parse(result.reason).error.code, 'INVALID_REQUEST');
  }
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
