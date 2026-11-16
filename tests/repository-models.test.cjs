const test = require('node:test');
const assert = require('node:assert/strict');
const { gitHubRepositoryBindingFromResponse } = require('../dist/shared/repositoryModels.js');

const binding = { uid: 'binding-1', code_repository_uid: 'repo-1', code_repository_name: 'binance-connectors', repo_name: 'binance-connectors',
  git_ssh_url: 'git@github.com:mainsequence-projects/binance-connectors.git', git_repo_url: 'https://github.com/mainsequence-projects/binance-connectors.git' };

test('a GitHub binding without a GitHub full name is still a binding: setup clones from its SSH URL', () => {
  for (const github_full_name of ['', '   ', null, undefined]) {
    const parsed = gitHubRepositoryBindingFromResponse({ ...binding, github_full_name }, 'GitHub binding');
    assert.equal(parsed.github_full_name, null, JSON.stringify(github_full_name));
    assert.equal(parsed.git_ssh_url, binding.git_ssh_url);
  }
  assert.equal(gitHubRepositoryBindingFromResponse({ ...binding, github_full_name: ' mainsequence-projects/binance-connectors ' }, 'GitHub binding').github_full_name,
    'mainsequence-projects/binance-connectors');
  assert.throws(() => gitHubRepositoryBindingFromResponse({ ...binding, github_full_name: 'a\nb' }, 'GitHub binding'), /GitHub full name must be a single line/);
  assert.throws(() => gitHubRepositoryBindingFromResponse({ ...binding, uid: '' }, 'GitHub binding'), /GitHub binding UID is required/);
});
