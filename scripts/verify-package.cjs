// Check the public package export from an isolated consumer without npm installation or SDKs.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
async function main() {
  const archive = path.resolve(process.argv[2] || `artifacts/dev-mainsequence-devtools-${require('../package.json').version}.tgz`);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ms npm consumer '));
  try {
    const packageDir = path.join(temporary, 'node_modules', '@dev-mainsequence', 'devtools');
    await fs.mkdir(packageDir, { recursive: true });
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', packageDir, '--strip-components=1'], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error('Could not unpack the local npm artifact.');
    const manifest = JSON.parse(await fs.readFile(path.join(packageDir, '.codex-plugin/plugin.json'), 'utf8'));
    const pkg = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
    for (const removed of ['claude', 'dist/claudeRunner.js', 'dist/hosts/claudeAccounts.js']) {
      if (await fs.stat(path.join(packageDir, removed)).then(() => true).catch(() => false)) throw new Error('Shared package contains the removed Claude implementation: ' + removed);
    }
    if (manifest.version !== pkg.version || manifest.hooks !== './hooks/hooks.json') throw new Error('The npm artifact must contain the versioned Codex compatibility manifest.');
    if (manifest.skills !== './skills/' || !await fs.stat(path.join(packageDir, 'skills/ms/SKILL.md')).then(() => true).catch(() => false)) throw new Error('The npm artifact must contain the native ms slash-menu registration.');
    if (!await fs.stat(path.join(packageDir, 'skills/mainsequence-mcp/SKILL.md')).then(() => true).catch(() => false)) throw new Error('The npm artifact must contain the conversational MCP skill.');
    if (!await fs.stat(path.join(packageDir, 'dist/shared/mcp.js')).then(() => true).catch(() => false)) throw new Error('The npm artifact must contain the MCP client.');
    const opencode = JSON.parse(await fs.readFile(path.join(packageDir, 'opencode/package.json'), 'utf8'));
    if (opencode.version !== pkg.version || opencode.exports['./tui'] !== './tui.mjs' || !opencode.mainsequenceArtifact) throw new Error('The npm artifact must contain the versioned OpenCode server and terminal entries.');
    const project = path.join(temporary, 'OpenCode project with spaces');
    const install = spawnSync(process.execPath, [path.join(packageDir, 'dist/runner.js'), 'opencode-install', '--project', project], { encoding: 'utf8' });
    if (install.status !== 0) throw new Error('The packaged OpenCode installer failed: ' + install.stderr);
    if (!await fs.stat(path.join(project, '.opencode/plugins/mainsequence-devtools/ui/opencodePresentation.mjs')).then(() => true).catch(() => false)) throw new Error('The installed artifact must contain ESM terminal presentation code.');
    if (await fs.stat(path.join(packageDir, 'plugin.json')).then(() => true).catch(() => false)) throw new Error('A root Agent Plugins manifest suppresses hooks in the tested Codex runtime.');
    await fs.writeFile(path.join(temporary, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createDevTools, createNodeHost, createProjectOperations, updateDevcontainerJsonc } from '@dev-mainsequence/devtools';
assert.equal(typeof createProjectOperations, 'function');
assert.match(updateDevcontainerJsonc('{}', 'example:latest'), /example:latest/);
const tools = createDevTools({ host: createNodeHost(), env: {}, store: null });
const result = await tools.dispatch({ action: 'auth-status', backend: 'https://fixture.example' });
assert.equal(result.status, 'success');
assert.equal(result.data.persistence, 'unavailable');
await assert.rejects(import('@dev-mainsequence/devtools/dist/shared/session.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log('Public npm API and packaged OpenCode installation passed from an isolated consumer, without SDKs or runtime npm dependencies.');
`);
    const result = spawnSync(process.execPath, ['consumer.mjs'], { cwd: temporary, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Public consumer check failed: ' + result.stderr);
    process.stdout.write(result.stdout);
    if (process.env.MS_OPENCODE_BINARY) {
      // Validate what we ship, rather than accidentally loading this checkout's plugin.
      const native = spawnSync(process.execPath, [path.resolve(__dirname, 'verify-opencode-host.cjs')], {
        env: { ...process.env, MS_OPENCODE_PACKAGE: packageDir }, encoding: 'utf8', timeout: 120_000,
      });
      if (native.status !== 0) throw new Error('Packaged OpenCode host check failed: ' + (native.stderr || native.error?.message || 'host stopped'));
      process.stdout.write(native.stdout);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
