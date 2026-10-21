const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('shared APIs have no dependency on the Claude integration', () => {
  for (const file of fs.readdirSync(path.join(root, 'src/shared'))) {
    if (!file.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(root, 'src/shared', file), 'utf8');
    assert.doesNotMatch(text, /from\s+['"][^'"]*(?:claude|\/hosts\/)/i, file);
  }
  assert.equal(fs.existsSync(path.join(root, 'src/claudeRunner.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'manifests/claude')), false);
  assert.equal(fs.existsSync(path.join(root, 'dist/claudeRunner.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'claude')), false);
  assert.equal(fs.readdirSync(path.join(root, 'dist/hosts')).some(name => /claude/i.test(name)), false);
});
