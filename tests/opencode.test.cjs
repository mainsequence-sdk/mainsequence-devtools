const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { project } = require('./helpers.cjs');
const { runOpenCodeAction } = require('../dist/hosts/opencodeRunner.js');
const { executeOpenCodeInput } = require('../dist/hosts/opencodeProtocol.js');
const { createOpenCodeController } = require('../dist/hosts/opencode.js');
const { installOpenCode } = require('../dist/hosts/opencodeInstall.js');
const runner = path.resolve('dist/runner.js');
const fixtureEnv = { PATH: process.env.PATH };

test('OpenCode explicit commands parse as data; malformed input and retired sync arguments never dispatch', async () => {
  let calls = 0;
  const dispatch = async request => { calls++; return { schemaVersion: 1, action: request.action, status: 'success', summary: 'ok' }; };
  for (const command of ['/ms --help', 'sync --message "old behavior"', 'sync; echo secret', 'sync\nnext', 'sync "unclosed']) {
    const result = await executeOpenCodeInput({ command }, dispatch, '/fixture');
    assert.equal(result.status, command === '/ms --help' ? 'success' : 'failure');
  }
  assert.equal(calls, 0);
  await executeOpenCodeInput({ command: 'sync --path "/fixture with spaces"' }, dispatch, '/fixture');
  assert.equal(calls, 1);
  assert.equal((await executeOpenCodeInput({ request: { action: 'login' } }, dispatch, '/fixture')).status, 'failure');
});

for (const type of ['python', 'vite_react']) test(`OpenCode Node runner executes ${type} sync through the existing SDK without exposing private output`, async t => {
  const f = await project(t, type);
  const head = f.git(['rev-parse', 'HEAD']);
  const progress = [];
  const result = await runOpenCodeAction({ command: '/ms sync' }, { runner, cwd: f.root, nodePath: process.execPath, env: fixtureEnv, progress: text => progress.push(text) });
  assert.equal(result.status, 'success', result.summary);
  assert(progress.some(line => line.includes('Running sync')));
  assert.equal(f.git(['rev-parse', 'HEAD']), head);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'fixture-invocation.json'))).args, ['code-repository', 'sync', '--path', '.']);
  assert(!JSON.stringify(result).includes('fixture-access-1'));
});

test('runner workspace is per action; concurrent requests never change the host cwd', async t => {
  const a = await project(t, 'vite_react');
  const b = await project(t, 'python');
  const original = process.cwd();
  const results = await Promise.all([a, b].map(f => runOpenCodeAction({ command: 'sync' }, { runner, cwd: f.root, nodePath: process.execPath, env: fixtureEnv })));
  assert(results.every(result => result.status === 'success'));
  assert.equal(process.cwd(), original);
  for (const f of [a, b]) assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'fixture-invocation.json'))).args[1], 'sync');
});

test('controller cancellation kills running SDK work, preserves uncertainty and unload aborts tool operations', async t => {
  const f = await project(t, 'vite_react', true, 3000);
  const controller = createOpenCodeController({ runner, cwd: f.root, nodePath: process.execPath, env: fixtureEnv });
  t.after(() => controller.dispose());
  const op = controller.start({ command: 'sync' });
  for (let i = 0; i < 100 && !controller.get(op.id).progress.startsWith('Running sync'); i++) await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(controller.cancel(op.id), true);
  for (let i = 0; i < 100 && controller.get(op.id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(controller.get(op.id).status, 'cancelled');
  assert(controller.get(op.id).result.effects);
  const tools = createOpenCodeController({ runner, cwd: f.root, run: (_input, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ schemaVersion: 1, action: 'mcp-call', status: 'cancelled', summary: 'stopped' }), { once: true })) });
  const active = tools.execute({ request: { action: 'mcp-list' } });
  tools.dispose();
  assert.equal((await active).status, 'cancelled');
});

test('missing Node is actionable; malformed child protocol is bounded and never treated as success', async t => {
  await assert.rejects(runOpenCodeAction({ command: '--help' }, { runner, cwd: process.cwd(), nodePath: '/does-not-exist/node' }), error => error.code === 'MISSING_PREREQUISITE');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-protocol-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const child = path.join(dir, 'child.cjs');
  await fs.writeFile(child, 'console.log("private malformed output");setTimeout(()=>{},10000)');
  const result = await runOpenCodeAction({ command: 'sync' }, { runner: child, cwd: dir, nodePath: process.execPath });
  assert.equal(result.status, 'failure'); assert(result.effects); assert(!JSON.stringify(result).includes('private malformed'));
});

test('installer is self-contained, preserves unrelated files, updates only owned paths and refuses foreign directories', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-opencode-install-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'opencode.jsonc'); await fs.writeFile(config, '// user configuration\n{}\n');
  await installOpenCode(['--project', dir]);
  const plugin = path.join(dir, '.opencode/plugins/mainsequence-devtools');
  assert.equal(JSON.parse(await fs.readFile(path.join(plugin, 'runtime.json'))).nodePath, process.execPath);
  assert.equal(JSON.parse(await fs.readFile(path.join(plugin, 'package.json'))).exports['./tui'], './tui.mjs');
  assert(await fs.stat(path.join(plugin, 'dist/shared/mcp.js')));
  await installOpenCode(['--project', dir]);
  assert.equal(await fs.readFile(config, 'utf8'), '// user configuration\n{}\n');
  await fs.rm(path.join(plugin, 'package.json'));
  await assert.rejects(installOpenCode(['--project', dir]), /kept/);
  assert(await fs.stat(path.join(plugin, 'index.mjs')));
});

test('native terminal slash and palette commands show readable results and a cancellable progress dialog, without an agent API', async () => {
  const plugin = (await import(pathToFileURL(path.resolve('opencode/tui.mjs')))).default;
  let commands;
  const dialogs = [], toasts = [], progress = [];
  let resolveSelection, cancelled = false, disposed = false, poll = 0;
  const rpc = {
    events: { on: () => () => { disposed = true; } },
    start: async ({ command }) => { assert.equal(command, '--help'); return { id: 'one', status: 'running' }; },
    get: async () => ++poll < 2 ? { id: 'one', status: 'running', progress: 'Working' } : { id: 'one', status: 'success', display: 'MainSequence\nSign in\n/ms login', progress: 'Ready', result: { status: 'success' } },
    cancel: async () => { cancelled = true; return true; },
  };
  const cleanup = plugin.setup({ client: { rpc: () => rpc }, location: { directory: '/fixture' }, data: { location: { default: () => ({ directory: '/fixture' }) } },
    keymap: { layer: callback => { commands = callback().commands; } },
    ui: { toast: { show: value => toasts.push(value) }, dialog: { set() {}, clear: () => resolveSelection?.(),
      alert: async value => dialogs.push(value), select: value => { progress.push(value); return new Promise(resolve => { resolveSelection = resolve; }); } } },
  });
  const command = commands.find(command => command.slash?.name === 'ms');
  assert.equal(command.slash.arguments, true);
  await command.run('/ms --help');
  assert(dialogs[0].message.includes('/ms login')); assert(!dialogs[0].message.startsWith('{'));
  assert(progress[0].options.some(option => option.value === 'cancel'));
  assert(toasts.some(toast => toast.variant === 'success'));
  assert.equal(cancelled, false);
  cleanup(); assert.equal(disposed, true);
});
