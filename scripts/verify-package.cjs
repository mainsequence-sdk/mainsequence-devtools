// Check the public package export from an isolated consumer without npm installation or SDKs.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const exists = file => fs.stat(file).then(() => true).catch(() => false);
async function main() {
  const archive = path.resolve(process.argv[2] || `artifacts/dev-mainsequence-devtools-${require('../package.json').version}.tgz`);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ms npm consumer '));
  try {
    const packageDir = path.join(temporary, 'node_modules', '@dev-mainsequence', 'devtools');
    await fs.mkdir(packageDir, { recursive: true });
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', packageDir, '--strip-components=1'], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error('Could not unpack the local npm artifact.');
    const pkg = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
    for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/runner.js', 'dist/shared/mcp.js', 'README.md', 'LICENSE', 'NOTICE']) {
      if (!await exists(path.join(packageDir, required))) throw new Error('The npm artifact must contain ' + required);
    }
    // Host integrations are released from their own repositories; the shared package carries neither.
    for (const removed of ['claude', 'dist/claudeRunner.js', 'dist/hosts', '.codex-plugin', 'hooks', 'skills', 'assets', 'build-info.json', 'plugin.json', 'docs', 'manifests']) {
      if (await exists(path.join(packageDir, removed))) throw new Error('Shared package contains a host integration file: ' + removed);
    }
    if (pkg.bin['ms-devtools'] !== './dist/runner.js') throw new Error('The npm artifact must expose the ms-devtools runner.');
    await fs.writeFile(path.join(temporary, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createDevTools, createNodeHost, createProjectOperations, updateDevcontainerJsonc, parseArguments, tokenizeCommand, HELP } from '@dev-mainsequence/devtools';
assert.equal(typeof createProjectOperations, 'function');
assert.match(updateDevcontainerJsonc('{}', 'example:latest'), /example:latest/);
assert.match(HELP, /^MainSequence developer tooling/);
assert.deepEqual(tokenizeCommand('status --path "a folder"'), ['status', '--path', 'a folder']);
assert.equal(parseArguments(['status', '--path', '/a project'], '/cwd').request.root, '/a project');
const tools = createDevTools({ host: createNodeHost(), env: {}, store: null });
const result = await tools.dispatch({ action: 'auth-status', backend: 'https://fixture.example' });
assert.equal(result.status, 'success');
assert.equal(result.data.persistence, 'unavailable');
await assert.rejects(import('@dev-mainsequence/devtools/dist/shared/session.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log('Public npm API passed from an isolated ESM consumer, without SDKs or runtime npm dependencies.');
`);
    const result = spawnSync(process.execPath, ['consumer.mjs'], { cwd: temporary, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Public consumer check failed: ' + result.stderr);
    process.stdout.write(result.stdout);
    const runner = path.join(packageDir, 'dist/runner.js');
    const help = spawnSync(process.execPath, [runner, '--help'], { cwd: temporary, encoding: 'utf8' });
    if (help.status !== 0 || !/MainSequence developer tooling/.test(help.stdout)) throw new Error('The packaged runner must print its help.');
    const hook = spawnSync(process.execPath, [runner, '--codex-hook'], { cwd: temporary, input: JSON.stringify({ prompt: '/ms --help' }), encoding: 'utf8' });
    if (hook.status === 0 || /decision/.test(hook.stdout)) throw new Error('The shared runner must not serve the Codex hook; that entry point lives in the Codex plugin.');
    console.log('Packaged ms-devtools runner serves the terminal CLI only.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
