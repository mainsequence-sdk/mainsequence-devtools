const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'artifacts', 'codex', 'mainsequence-devtools');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(root, 'manifests', 'codex'), target, { recursive: true });
// One source of brand assets serves both plugin and skill UI metadata.
fs.cpSync(path.join(target, 'assets'), path.join(target, 'skills', 'ms', 'assets'), { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(target, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'docs'), path.join(target, 'docs'), { recursive: true });
for (const filename of ['README.md', 'LICENSE', 'NOTICE']) {
  if (fs.existsSync(path.join(root, filename))) fs.copyFileSync(path.join(root, filename), path.join(target, filename));
}
const manifest = JSON.parse(fs.readFileSync(path.join(target, '.codex-plugin', 'plugin.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Manifest and tooling versions differ.');
fs.writeFileSync(path.join(target, 'build-info.json'), JSON.stringify({ version: pkg.version, node: pkg.engines.node, phase: 2 }, null, 2) + '\n');
fs.chmodSync(path.join(root, 'dist', 'runner.js'), 0o755);
fs.chmodSync(path.join(target, 'dist', 'runner.js'), 0o755);
// Codex 0.159.2 skips hooks for Agent Plugins root manifests. Ship its supported
// compatibility entry point; a root plugin.json would take precedence and disable it.
fs.rmSync(path.join(root, 'plugin.json'), { force: true });
fs.cpSync(path.join(target, '.codex-plugin'), path.join(root, '.codex-plugin'), { recursive: true });
fs.copyFileSync(path.join(target, 'build-info.json'), path.join(root, 'build-info.json'));
fs.cpSync(path.join(target, 'hooks'), path.join(root, 'hooks'), { recursive: true });
fs.rmSync(path.join(root, 'skills'), { recursive: true, force: true });
fs.cpSync(path.join(target, 'skills'), path.join(root, 'skills'), { recursive: true });
fs.rmSync(path.join(root, 'assets'), { recursive: true, force: true });
fs.cpSync(path.join(target, 'assets'), path.join(root, 'assets'), { recursive: true });
const marketplace = path.join(root, 'artifacts', 'local-marketplace');
fs.mkdirSync(path.join(marketplace, '.agents', 'plugins'), { recursive: true });
fs.mkdirSync(path.join(marketplace, 'plugins'), { recursive: true });
const localPlugin = path.join(marketplace, 'plugins', 'mainsequence-devtools');
fs.rmSync(localPlugin, { recursive: true, force: true });
fs.cpSync(target, localPlugin, { recursive: true });
fs.writeFileSync(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'mainsequence-local', interface: { displayName: 'MainSequence local' }, plugins: [{ name: 'mainsequence-devtools', source: { source: 'local', path: './plugins/mainsequence-devtools' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }] }, null, 2) + '\n');
console.log('Built artifacts/codex/mainsequence-devtools (no runtime npm dependencies).');
