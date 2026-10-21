const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('shared APIs have no dependency on any host integration', () => {
  for (const file of fs.readdirSync(path.join(root, 'src/shared'))) {
    if (!file.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(root, 'src/shared', file), 'utf8');
    assert.doesNotMatch(text, /from\s+['"][^'"]*(?:claude|codex|\/hosts\/)/i, file);
  }
  // Claude Desktop and the Codex plugin are released from their own repositories (ADR 0003).
  for (const removed of ['src/hosts', 'src/claudeRunner.ts', 'manifests', 'dist/hosts', 'dist/claudeRunner.js', 'claude', 'artifacts/codex', '.codex-plugin', 'hooks', 'skills']) {
    assert.equal(fs.existsSync(path.join(root, removed)), false, removed);
  }
  const runner = fs.readFileSync(path.join(root, 'src/runner.ts'), 'utf8');
  assert.doesNotMatch(runner, /codex|hosts\//i, 'the shared runner is the terminal CLI only');
});
