const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDevTools, createNodeHost } = require('../dist/index.js');
const { readPythonSdkStatus } = require('../dist/shared/pythonSdkStatus.js');
const { npmCommand } = require('../dist/shared/projects.js');
const { project, memoryStore } = require('./helpers.cjs');

test('status reports project-local capabilities and a safe session without invoking MCP', async t => {
  const p = await project(t, 'vite_react');
  const result = await createDevTools({ host: createNodeHost(), env: {}, store: memoryStore() }).dispatch({ action: 'status', root: p.root, backend: 'https://fixture.example' });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.data.project.projectType, 'vite_react');
  assert.equal(result.data.capabilities.find(c => c.action === 'sync').state, 'available');
  assert.equal(result.data.capabilities.find(c => c.action === 'freeze-env').state, 'unsupported');
  assert.equal(result.data.capabilities.find(c => c.action === 'skills-sync').state, 'unsupported');
  assert.equal(result.data.session.authenticated, false);
});

test('Python SDK source status identifies stable source metadata without implying registry publication', async () => {
  let requested;
  const status = await readPythonSdkStatus('8.1.27', async url => { requested = url; return new Response('[project]\nname = "mainsequence"\nversion = "8.1.28"\n[tool.test]\nversion = "wrong"\n'); });
  assert.match(requested, /\/main\/pyproject.toml$/);
  assert.equal(status.latestSourceVersion, '8.1.28'); assert.equal(status.registryPublicationVerified, false);
  assert.equal((await readPythonSdkStatus('8.1.27', async ()=>{ throw Error('offline'); })).sourceStatus, 'unavailable');
});

test('old CLI capability and dry-run support are checked before executing an action', async t => {
  const p = await project(t);
  await fs.writeFile(path.join(p.root, '.venv/bin/mainsequence'), `#!${process.execPath}\nconsole.log('Usage: old command');\n`, { mode: 0o755 });
  const result = await createDevTools({ host: createNodeHost(), env: {}, store: null }).dispatch({ action: 'update-sdk', root: p.root, backend: 'https://fixture.example', dryRun: true });
  assert.equal(result.error.code, 'MISSING_PREREQUISITE'); assert.equal(result.effects, undefined);
});

test('npm bootstrap uses fixed argument arrays on POSIX and Windows', () => {
  assert.deepEqual(npmCommand('ci', 'linux'), { executable: 'npm', args: ['ci'] });
  assert.deepEqual(npmCommand('ci', 'win32'), { executable: 'cmd.exe', args: ['/d', '/s', '/c', 'npm ci'] });
});
