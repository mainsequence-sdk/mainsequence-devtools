const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createNodeHost } = require('../dist/shared/process.js');
const { createProjectOperations, validateDockerImage, validateDockerPlatform } = require('../dist/index.js');
const { updateDevcontainerJsonc } = require('../dist/index.js');
const { project, git } = require('./helpers.cjs');

async function localProject(t) {
  const fixture = await project(t, 'python', false);
  const baseDir = await fs.realpath(fixture.base);
  const root = path.join(baseDir, 'fixture-org', 'projects', 'example-repo-1');
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.rename(fixture.root, root);
  return { root, baseDir, organization: 'Fixture Org' };
}

test('devcontainer JSONC edits preserve comments, nested values, CRLF and custom fields', () => {
  const source = '{\r\n  // keep account-specific settings\r\n  "image": "old:tag", /* keep inline */\r\n  "customizations": {"vscode": {"extensions": ["a.b",],},},\r\n  "workspaceFolder": "/custom",\r\n  "remoteEnv": {"EXAMPLE": "https://example.test//path"},\r\n}\r\n';
  const edited = updateDevcontainerJsonc(source, 'registry.test/team/app:next');
  assert.ok(edited.includes('// keep account-specific settings\r\n'));
  assert.ok(edited.includes('"image": "registry.test/team/app:next", /* keep inline */'));
  assert.ok(edited.includes('"customizations": {"vscode": {"extensions": ["a.b",],},},'));
  assert.ok(edited.includes('"workspaceFolder": "/custom"'));
  assert.ok(edited.includes('"remoteEnv": {"EXAMPLE": "https://example.test//path"},'));
  assert.match(edited, /"workspaceMount": "source=\$\{localWorkspaceFolder\}/);
  assert.equal(updateDevcontainerJsonc(edited, 'registry.test/team/app:next'), edited);
});

test('devcontainer JSONC parser rejects malformed, duplicate, executable and incompatible configurations', () => {
  for (const source of ['[]', '{"image":"a","image":"b"}', '{/*', '{"image":undefined}', '{"value":NaN}', '{"value":()=>true}', '{"image": "bad\nvalue"}']) {
    assert.throws(() => updateDevcontainerJsonc(source, 'app:tag'), error => error.code === 'INVALID_REQUEST');
  }
  for (const source of ['{"build":{"dockerfile":"Dockerfile"}}', '{"dockerComposeFile":"compose.yml"}']) {
    assert.throws(() => updateDevcontainerJsonc(source, 'app:tag'), error => error.code === 'UNSUPPORTED_ACTION');
  }
  const source = '{"name":"A", "custom":{"quote":"\\\"", "escaped":"\\\\"} /* tail */}';
  const edited = updateDevcontainerJsonc(source, 'app:tag');
  assert.ok(edited.includes('/* tail */'));
  assert.equal(updateDevcontainerJsonc(edited, 'app:tag'), edited);
  for (const compact of ['{"image":"old"}', '{"name":"example"}', '{"custom":{"a":true}}']) {
    const patched = updateDevcontainerJsonc(compact, 'app:tag');
    assert.equal(updateDevcontainerJsonc(patched, 'app:tag'), patched);
  }
});

test('Docker image and platform validation reject shell text, extra flags and multi-platform load', () => {
  for (const image of ['app:latest', 'registry.test:5000/team/app:Release-2', 'team/my_app:tag', 'app__name:latest']) assert.equal(validateDockerImage(image), image);
  for (const image of ['app; touch /tmp/pwn', '$(echo hello)', '-t', 'app --push', 'https://host/app', 'App:tag', 'app@sha256:abc', '../app']) assert.throws(() => validateDockerImage(image));
  assert.equal(validateDockerPlatform(undefined), 'linux/amd64');
  assert.equal(validateDockerPlatform('linux/arm64'), 'linux/arm64');
  for (const platform of ['linux/amd64,linux/arm64', '--push', 'linux/arm64;echo', 'windows/amd64']) assert.throws(() => validateDockerPlatform(platform));
});

test('Docker preview is read-only and build uses argv plus the shared repository lock', async t => {
  const { root } = await localProject(t);
  await fs.writeFile(path.join(root, 'Dockerfile'), 'FROM scratch\n');
  const node = createNodeHost(); const calls = [];
  const host = { ...node, async runProcess(spec) {
    if (spec.executable !== 'docker') return node.runProcess(spec);
    assert.equal(await fs.readFile(path.join(root, '.git', 'mainsequence-devtools.lock'), 'utf8').then(Boolean), true);
    calls.push(spec); return { exitCode: 0, stdout: 'fixture-private-output', stderr: 'fixture-private-error' };
  } };
  const adapter = createProjectOperations({ host });
  const preview = await adapter.dispatch({ action: 'docker-preview', root, image: 'team/app:next', platform: 'linux/arm64' });
  assert.equal(preview.status, 'success'); assert.equal(preview.data.built, false); assert.equal(calls.length, 0);
  await assert.rejects(fs.stat(path.join(root, '.devcontainer')), { code: 'ENOENT' });
  const result = await adapter.dispatch({ action: 'docker-build', root, image: 'team/app:next', platform: 'linux/arm64' });
  assert.equal(result.status, 'success'); assert.equal(result.data.built, true);
  assert.deepEqual(calls[0].args, ['buildx', 'build', '--platform', 'linux/arm64', '--load', '-t', 'team/app:next', '-f', 'Dockerfile', '.']);
  assert.equal(calls[0].cwd, root);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
  await assert.rejects(fs.stat(path.join(root, '.git', 'mainsequence-devtools.lock')), { code: 'ENOENT' });
});

test('Docker cancellation and failure release shared lock and report partial effects', async t => {
  const { root } = await localProject(t); await fs.writeFile(path.join(root, 'Dockerfile'), 'FROM scratch\n');
  const node = createNodeHost(), abort = new AbortController();
  const host = { ...node, async runProcess(spec) {
    if (spec.executable !== 'docker') return node.runProcess(spec);
    assert.equal(spec.signal, abort.signal); abort.abort();
    return { exitCode: null, stdout: '', stderr: 'secret build log', cancelled: true };
  } };
  const cancelled = await createProjectOperations({ host, signal: abort.signal }).dispatch({ action: 'docker-build', root });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.effects.state, 'partial-or-uncertain');
  await assert.rejects(fs.stat(path.join(root, '.git', 'mainsequence-devtools.lock')), { code: 'ENOENT' });
  const failed = await createProjectOperations({ host: { ...node, runProcess: spec => spec.executable === 'docker' ? Promise.resolve({ exitCode: 3, stdout: '', stderr: 'secret build log' }) : node.runProcess(spec) } }).dispatch({ action: 'docker-build', root });
  assert.equal(failed.error.code, 'PROCESS_FAILED'); assert.doesNotMatch(JSON.stringify(failed), /secret build log/);
});

test('devcontainer saving requires fresh content digest and preserves unrelated JSONC', async t => {
  const { root } = await localProject(t), host = createNodeHost();
  const directory = path.join(root, '.devcontainer'), target = path.join(directory, 'devcontainer.json');
  await fs.mkdir(directory);
  const before = '{\n // Keep this\n "image": "old:tag",\n "forwardPorts": [3000,],\n "workspaceMount": "custom mount",\n}\n';
  await fs.writeFile(target, before);
  const preview = await createProjectOperations({ host }).dispatch({ action: 'devcontainer-preview', root, image: 'app:new' });
  assert.equal(preview.status, 'success'); assert.equal(await fs.readFile(target, 'utf8'), before);
  const differentImage = await createProjectOperations({ host }).dispatch({ action: 'devcontainer-write', root, image: 'other:new', expectedDigest: preview.data.expectedDigest });
  assert.equal(differentImage.error.code, 'INVALID_REQUEST');
  await fs.appendFile(target, '// external change\n');
  const stale = await createProjectOperations({ host }).dispatch({ action: 'devcontainer-write', root, image: 'app:new', expectedDigest: preview.data.expectedDigest });
  assert.equal(stale.error.code, 'INVALID_REQUEST');
  const current = await createProjectOperations({ host }).dispatch({ action: 'devcontainer-preview', root, image: 'app:new' });
  const saved = await createProjectOperations({ host }).dispatch({ action: 'devcontainer-write', root, image: 'app:new', expectedDigest: current.data.expectedDigest });
  assert.equal(saved.status, 'success'); assert.equal(await fs.readFile(target, 'utf8'), current.data.after);
  assert.match(current.data.after, /"forwardPorts": \[3000,\]/); assert.match(current.data.after, /"workspaceMount": "custom mount"/);
  const unchanged = await createProjectOperations({ host }).dispatch({ action: 'devcontainer-preview', root, image: 'app:new' });
  assert.equal(unchanged.data.changed, false);
});

test('devcontainer writes refuse symlink directories and configuration files', async t => {
  const { root, baseDir } = await localProject(t), host = createNodeHost();
  const outside = path.join(baseDir, 'outside'); await fs.mkdir(outside);
  const dir = path.join(root, '.devcontainer'); await fs.symlink(outside, dir, 'dir');
  let result = await createProjectOperations({ host }).dispatch({ action: 'devcontainer-preview', root, image: 'app:tag' });
  assert.equal(result.error.code, 'INVALID_REQUEST');
  await fs.unlink(dir); await fs.mkdir(dir);
  const external = path.join(outside, 'config.json'); await fs.writeFile(external, '{}');
  await fs.symlink(external, path.join(dir, 'devcontainer.json'));
  result = await createProjectOperations({ host }).dispatch({ action: 'devcontainer-preview', root, image: 'app:tag' });
  assert.equal(result.error.code, 'INVALID_REQUEST'); assert.equal(await fs.readFile(external, 'utf8'), '{}');
});

test('local discovery maps UID suffixes without following symlink directories', async t => {
  const selection = await localProject(t), host = createNodeHost();
  await fs.symlink(selection.root, path.join(path.dirname(selection.root), 'shortcut-repo-2'), 'dir');
  const result = await createProjectOperations({ host }).dispatch({ action: 'local-repositories', ...selection, repositories: [{ uid: 'repo-1', name: 'Example' }] });
  assert.equal(result.status, 'success'); assert.equal(result.data.items.length, 1);
  assert.deepEqual(result.data.items[0], { name: 'Example', path: selection.root, repositoryUid: 'repo-1', isGitRepository: true });
});

test('local discovery keeps a missing base folder read-only and rejects redirected organization folders', async t => {
  const selection = await localProject(t), host = createNodeHost();
  const baseDir = path.join(selection.baseDir, 'not created');
  const empty = await createProjectOperations({ host }).dispatch({ action: 'local-repositories', baseDir, organization: selection.organization });
  assert.equal(empty.status, 'success'); assert.deepEqual(empty.data.items, []);
  await assert.rejects(fs.stat(baseDir), { code: 'ENOENT' });
  const alternate = path.join(selection.baseDir, 'redirected'); await fs.symlink(path.join(selection.baseDir, 'fixture-org'), alternate, 'dir');
  const rejected = await createProjectOperations({ host }).dispatch({ action: 'local-repositories', baseDir: selection.baseDir, organization: 'redirected' });
  assert.equal(rejected.error.code, 'INVALID_REQUEST');
});

test('deletion confirmation survives worker restart and removes only the selected local repository', async t => {
  const selection = await localProject(t), host = createNodeHost();
  const keep = path.join(path.dirname(selection.root), 'keep'); await fs.mkdir(keep); await fs.writeFile(path.join(keep, 'keep.txt'), 'preserve');
  const missing = await createProjectOperations({ host }).dispatch({ action: 'delete-local', ...selection });
  assert.equal(missing.error.code, 'INVALID_REQUEST');
  const preview = await createProjectOperations({ host }).dispatch({ action: 'delete-local-preview', ...selection });
  assert.equal(preview.status, 'success');
  const result = await createProjectOperations({ host }).dispatch({ action: 'delete-local', ...selection, confirmation: preview.data.confirmation });
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.data.remoteRepositoryRetained, true);
  await assert.rejects(fs.stat(selection.root), { code: 'ENOENT' }); assert.equal(await fs.readFile(path.join(keep, 'keep.txt'), 'utf8'), 'preserve');
});

test('deletion rejects changed context, outside paths, symlinks and busy repositories', async t => {
  const selection = await localProject(t), host = createNodeHost();
  const adapter = createProjectOperations({ host });
  const preview = await adapter.dispatch({ action: 'delete-local-preview', ...selection });
  await fs.writeFile(path.join(selection.root, 'untracked.txt'), 'new work');
  const changed = await adapter.dispatch({ action: 'delete-local', ...selection, confirmation: preview.data.confirmation });
  assert.equal(changed.error.code, 'INVALID_REQUEST');
  const latest = await adapter.dispatch({ action: 'delete-local-preview', ...selection });
  const lock = path.join(selection.root, '.git', 'mainsequence-devtools.lock'); await fs.writeFile(lock, 'someone else');
  const busy = await adapter.dispatch({ action: 'delete-local', ...selection, confirmation: latest.data.confirmation });
  assert.equal(busy.error.code, 'PROJECT_BUSY'); assert.equal(await fs.readFile(lock, 'utf8'), 'someone else');
  await fs.unlink(lock);
  const outside = await adapter.dispatch({ action: 'delete-local-preview', ...selection, baseDir: path.join(selection.baseDir, 'fixture-org') });
  assert.equal(outside.error.code, 'INVALID_REQUEST');
  const linked = path.join(path.dirname(selection.root), 'linked'); await fs.symlink(selection.root, linked, 'dir');
  const symlink = await adapter.dispatch({ action: 'delete-local-preview', ...selection, root: linked });
  assert.equal(symlink.error.code, 'INVALID_REQUEST');
  assert.equal(git(selection.root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});

