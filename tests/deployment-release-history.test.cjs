const test = require('node:test'), assert = require('node:assert/strict');
const { createDeployments, createNodeHost, WAIT_LIMIT_SECONDS } = require('../dist');
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), backend = 'https://fixture.example';
const API = id(10), AGENT = id(11), SITE = id(12), JOB = id(13), IMAGE = id(14), ENV = id(1), BRANCH = id(5);
const iso = minutes => new Date(Date.parse('2026-11-18T12:00:00Z') + minutes * 60_000).toISOString();
const step = (sequence, name, state, minutes, base = 0) => ({ uid: id(500 + sequence), sequence, name, kind: name.toLowerCase(), state,
  started_at: iso(base), finished_at: state === 'running' || state === 'pending' ? null : iso(base + minutes) });
function run(n, release, state, { minutes = 4, error, type = 'resource_release', steps } = {}) {
  return { uid: id(100 + n), target_type: type, target_uid: release, state, operation: 'build_and_deploy', source: 'repository_event', commit_sha: `abc${n}def0123456`,
    code_repository_branch_uid: BRANCH, created_at: iso(-n * 60), started_at: iso(-n * 60), finished_at: ['queued', 'running'].includes(state) ? null : iso(-n * 60 + minutes),
    target: { uid: release, name: 'release-name', display_name: 'pricing-api', kind: type === 'resource_release' ? 'fastapi' : type, kind_label: { resource_release: 'FastAPI', harness_agent: 'Harness Agent', static_site: 'Static site', job: 'Job' }[type],
      code_repository: { uid: id(4), name: 'pricing-engine' }, code_repository_branch: { uid: BRANCH, repository_branch: 'main' }, revision: { uid: id(20 + n) },
      agent: type === 'harness_agent' ? { uid: id(6), name: 'Risk Analyst' } : null,
      resource_release: ['resource_release', 'harness_agent'].includes(type) ? { uid: release, name: type === 'harness_agent' ? 'tau' : 'app' } : null },
    pipeline: { current_step_key: state === 'running' ? 'deploy' : '', steps: steps || [step(1, 'Build', 'succeeded', 3, -n * 60), step(2, 'Deploy', state === 'succeeded' ? 'succeeded' : state === 'running' ? 'running' : 'failed', minutes, -n * 60)] },
    ...(error ? { error } : {}), billing: { secret: 'never-return' }, cost_summary: { total: 99 } };
}
function fixture({ runs, waitStates, ignoreFilters = false } = {}) {
  const calls = [], state = { username: 'fixture' };
  const allRuns = runs || [run(0, API, 'running'), run(1, JOB, 'running', { type: 'job' }), run(2, API, 'succeeded'), run(3, IMAGE, 'succeeded', { type: 'code_repository_image' }),
    run(4, AGENT, 'failed', { type: 'harness_agent', error: { code: 'image_build_failed', detail: 'no image' } }), run(5, SITE, 'succeeded', { type: 'static_site' })];
  const reads = { wait: 0 };
  const api = createDeployments({ host: createNodeHost(), env: { MAINSEQUENCE_ENDPOINT: backend, MAINSEQUENCE_ACCESS_TOKEN: 'synthetic-secret' }, fetch: async (url, init) => {
    const u = new URL(url); calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method });
    if (u.pathname === '/api/v1/users/me/') return Response.json({ username: state.username });
    if (u.pathname === '/api/v1/deployment-runs/') {
      let rows = allRuns;
      const q = u.searchParams;
      if (!ignoreFilters && q.get('target_type__in')) rows = rows.filter(row => q.get('target_type__in').split(',').includes(row.target_type));
      if (q.get('target_uid')) rows = rows.filter(row => row.target_uid === q.get('target_uid'));
      if (q.get('state__in')) rows = rows.filter(row => q.get('state__in').split(',').includes(row.state));
      return Response.json({ count: rows.length, results: rows });
    }
    if (u.pathname === `/api/v1/deployment-runs/${id(100)}/`) {
      const states = waitStates || ['running']; const now = states[Math.min(reads.wait++, states.length - 1)];
      return Response.json(run(0, API, now));
    }
    return Response.json({ detail: 'not found' }, { status: 404 });
  } });
  return { calls, state, reads, run: (action, args = {}) => api.dispatch({ action, backend, expectedAccount: 'fixture', ...args }) };
}

const NOT_RELEASES = new RegExp([id(101), id(103), JOB, IMAGE].join('|'));
const historyCalls = f => f.calls.filter(call => call.path !== '/api/v1/users/me/');

test('release deployment history is one read of resource release deployments only, newest first', async () => {
  const f = fixture(), result = await f.run('deployment-release-history', { environmentUid: ENV });
  assert.equal(result.status, 'success', result.summary);
  const calls = historyCalls(f);
  assert.deepEqual(calls.map(call => call.path), ['/api/v1/deployment-runs/'], 'no release inventory, revisions, branches or per-release reads');
  const { query } = calls[0];
  assert.equal(query.target_type__in, 'resource_release,harness_agent,static_site');
  assert.deepEqual([query.organization_environment_uid, query.ordering, query.limit, query.offset], [ENV, '-creation_date', '25', '0']);
  assert.ok(Math.abs(Date.parse(query.created_after) - (Date.now() - 86_400_000)) < 60_000, 'the history opens on the last day');
  assert.deepEqual(result.data.results.map(row => row.uid), [id(100), id(102), id(104), id(105)]);
  assert.equal(result.data.count, 4); assert.equal(result.summary, '4 deployments in the last day.');
  assert.doesNotMatch(JSON.stringify(result), NOT_RELEASES, 'no Job or image');
  assert.doesNotMatch(JSON.stringify(result), /never-return|cost_summary|synthetic-secret/);
});

test('each row carries what Command Center\'s columns show', async () => {
  const [api, done, agent, site] = (await fixture().run('deployment-release-history', { environmentUid: ENV })).data.results;
  assert.deepEqual([api.releaseName, api.releaseUid, api.kindLabel, api.repositoryName, api.branchName, api.branchUid], ['app', API, 'FastAPI', 'pricing-engine', 'main', BRANCH]);
  assert.deepEqual([api.commit, api.revisionUid, api.state, api.source, api.startedAt], ['abc0def', id(20), 'running', 'repository_event', iso(0)]);
  assert.deepEqual(api.steps, [{ name: 'Build', state: 'succeeded' }, { name: 'Deploy', state: 'running' }]);
  assert.equal(done.durationMs, 4 * 60_000); assert.equal(done.finishedAt, iso(-116));
  assert.deepEqual([agent.releaseName, agent.agentName, agent.kindLabel, agent.errorCode], ['tau', 'Risk Analyst', 'Harness Agent', 'image_build_failed']); assert.match(agent.error, /no image/);
  assert.deepEqual([site.releaseUid, site.releaseName], [SITE, 'release-name'], 'a target without a release reference is still that release');
});

test('a deployment that ended does not keep a running stage or a growing duration', async () => {
  const ended = run(1, API, 'cancelled', { steps: [step(1, 'Deploy', 'running', 0)] });
  ended.finished_at = null;
  const [row] = (await fixture({ runs: [ended] }).run('deployment-release-history', { environmentUid: ENV })).data.results;
  assert.deepEqual(row.steps, [{ name: 'Deploy', state: 'stopped' }]); assert.equal(row.durationMs, null);
});

test('release history sends its filters to the backend and refuses unknown ones', async () => {
  const f = fixture();
  const result = await f.run('deployment-release-history', { environmentUid: ENV, codeRepositoryBranchUid: BRANCH, releaseUid: API, releaseKind: 'fastapi', search: 'app', days: 30, limit: 50, offset: 50 });
  assert.equal(result.status, 'success', result.summary);
  const { query } = historyCalls(f)[0];
  assert.deepEqual([query.code_repository_branch_uid, query.target_uid, query.target_kind, query.search, query.limit, query.offset], [BRANCH, API, 'fastapi', 'app', '50', '50']);
  assert.equal(query.target_type__in, 'resource_release,harness_agent,static_site', 'a filter never widens the history');
  assert.equal(result.summary, '2 deployments in the last 30 days.');
  for (const bad of [{ releaseKind: 'job' }, { releaseKind: 'toString' }, { releaseUid: 'app' }, { days: 0 }, { days: 91 }, { limit: 101 }, { search: 7 }, { environmentUid: 'nope' }]) {
    const refused = await f.run('deployment-release-history', { environmentUid: ENV, ...bad });
    assert.equal(refused.status, 'failure', JSON.stringify(bad)); assert.equal(refused.error.code, 'INVALID_REQUEST');
  }
});

test('anything that is not a resource release is dropped even if the backend returns it', async () => {
  for (const action of ['deployment-release-history', 'deployment-active']) {
    const result = await fixture({ ignoreFilters: true }).run(action, { environmentUid: ENV });
    assert.ok(result.data.results.length); assert.doesNotMatch(JSON.stringify(result.data.results), NOT_RELEASES, action);
  }
});

test('the active check asks only for queued and running release deployments', async () => {
  const f = fixture(), result = await f.run('deployment-active', { environmentUid: ENV, codeRepositoryBranchUid: BRANCH });
  assert.equal(result.status, 'success');
  const { query } = historyCalls(f)[0];
  assert.deepEqual([query.state__in, query.target_type__in, query.code_repository_branch_uid], ['queued,running', 'resource_release,harness_agent,static_site', BRANCH]);
  assert.deepEqual(result.data.results.map(row => row.uid), [id(100)], 'the running Job is not a release deployment');
  assert.equal(result.summary, '1 deployment in progress.');
  assert.equal((await fixture({ runs: [run(1, API, 'succeeded')] }).run('deployment-active', { environmentUid: ENV })).summary, 'No deployments in progress.');
});

test('a wait returns as soon as the run ends, and says so when it is still running at the limit', async () => {
  const done = fixture({ waitStates: ['running', 'succeeded'] });
  const started = Date.now(), finished = await done.run('deployment-wait', { runUid: id(100), timeoutSeconds: 2 });
  assert.equal(finished.status, 'success', finished.summary); assert.equal(finished.data.finished, true); assert.equal(finished.data.run.state, 'succeeded');
  assert.equal(finished.summary, 'Deployment succeeded.'); assert.ok(Date.now() - started < 4000);
  const still = fixture({ waitStates: ['running'] }), waited = await still.run('deployment-wait', { runUid: id(100), timeoutSeconds: 1 });
  assert.equal(waited.data.finished, false); assert.match(waited.summary, /still running after \d+ s/);
  assert.ok(still.reads.wait >= 2 && still.reads.wait <= 3, `reads ${still.reads.wait}`);
  assert.equal((await still.run('deployment-wait', { runUid: id(100), timeoutSeconds: WAIT_LIMIT_SECONDS + 1 })).error.code, 'INVALID_REQUEST');
  assert.equal((await still.run('deployment-wait', { runUid: id(77), timeoutSeconds: 1 })).data.hidden, true);
});

test('a wait stops when its read is cancelled', async () => {
  const controller = new AbortController();
  const api = createDeployments({ host: createNodeHost(), signal: controller.signal, env: { MAINSEQUENCE_ENDPOINT: backend, MAINSEQUENCE_ACCESS_TOKEN: 'synthetic-secret' },
    fetch: async url => new URL(url).pathname === '/api/v1/users/me/' ? Response.json({ username: 'fixture' }) : Response.json(run(0, API, 'running')) });
  setTimeout(() => controller.abort(), 300);
  const started = Date.now(), result = await api.dispatch({ action: 'deployment-wait', backend, expectedAccount: 'fixture', runUid: id(100), timeoutSeconds: 60 });
  assert.equal(result.status, 'cancelled'); assert.ok(Date.now() - started < 3000);
});
