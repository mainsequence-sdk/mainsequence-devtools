const test = require('node:test'), assert = require('node:assert/strict');
const { createDeployments, createNodeHost, releaseStats, WAIT_LIMIT_SECONDS } = require('../dist');
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), backend = 'https://fixture.example';
const API = id(10), AGENT = id(11), SITE = id(12), ENV = id(1), BRANCH = id(5);
const iso = minutes => new Date(Date.parse('2026-11-18T12:00:00Z') + minutes * 60_000).toISOString();
const step = (sequence, name, state, minutes, base = 0) => ({ uid: id(500 + sequence), sequence, name, kind: name.toLowerCase(), state,
  started_at: iso(base), finished_at: state === 'running' || state === 'pending' ? null : iso(base + minutes) });
function run(n, release, state, { minutes = 4, error, type = 'resource_release', steps } = {}) {
  return { uid: id(100 + n), target_type: type, target_uid: release, state, operation: 'build_and_deploy', source: 'repository_event', commit_sha: `abc${n}def0123456`,
    code_repository_branch_uid: BRANCH, created_at: iso(-n * 60), started_at: iso(-n * 60), finished_at: ['queued', 'running'].includes(state) ? null : iso(-n * 60 + minutes),
    target: { uid: release, display_name: 'pricing-api', code_repository: { uid: id(4), name: 'pricing-engine' }, code_repository_branch: { uid: BRANCH, repository_branch: 'main' },
      resource_release: type === 'static_site' ? null : { uid: release, name: 'x' } },
    pipeline: { current_step_key: state === 'running' ? 'deploy' : '', steps: steps || [step(1, 'Build', 'succeeded', 3, -n * 60), step(2, 'Deploy', state === 'succeeded' ? 'succeeded' : state === 'running' ? 'running' : 'failed', minutes, -n * 60)] },
    ...(error ? { error } : {}), billing: { secret: 'never-return' }, cost_summary: { total: 99 } };
}
function fixture({ runs, waitStates } = {}) {
  const calls = [], state = { username: 'fixture' };
  const allRuns = runs || [run(0, API, 'running'), run(1, API, 'succeeded'), run(2, API, 'failed', { error: { code: 'runtime_readiness_timeout', detail: 'not ready' } }),
    run(3, AGENT, 'failed', { type: 'harness_agent', error: { code: 'image_build_failed' } }), run(4, AGENT, 'superseded', { type: 'harness_agent' }), run(5, SITE, 'succeeded', { type: 'static_site' })];
  const reads = { wait: 0 };
  const api = createDeployments({ host: createNodeHost(), env: { MAINSEQUENCE_ENDPOINT: backend, MAINSEQUENCE_ACCESS_TOKEN: 'synthetic-secret' }, fetch: async (url, init) => {
    const u = new URL(url); calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method });
    if (u.pathname === '/api/v1/users/me/') return Response.json({ username: state.username });
    if (u.pathname === '/api/v1/resource-releases/') return Response.json({ count: 3, results: [
      { uid: API, name: 'pricing-api', release_kind: 'fastapi', code_repository_branch_uid: BRANCH, active_revision: id(20), desired_revision: id(21), workload_user_uid: 'w' },
      { uid: AGENT, name: 'risk-agent', release_kind: 'harness_agent', code_repository_branch_uid: BRANCH },
      { uid: SITE, name: 'docs-site', release_kind: 'static_site', code_repository_branch_uid: BRANCH }] });
    if (u.pathname === `/api/v1/resource-releases/${API}/`) return Response.json({ uid: API, name: 'pricing-api', release_kind: 'fastapi', code_repository_branch_uid: BRANCH, active_revision: id(20), desired_revision: id(21) });
    if (u.pathname === `/api/v1/resource-releases/${API}/revisions/`) return Response.json({ count: 2, results: [
      { uid: id(21), state: 'pending', commit_sha: 'abc0def0123456', configuration_revision: 15, created_at: iso(0) },
      { uid: id(20), state: 'ready', commit_sha: 'abc1def0123456', configuration_revision: 14, created_at: iso(-60), activated_at: iso(-56) }] });
    if (u.pathname === '/api/v1/deployment-runs/') {
      let rows = allRuns;
      if (u.searchParams.get('target_uid__in')) rows = rows.filter(row => u.searchParams.get('target_uid__in').split(',').includes(row.target_uid));
      if (u.searchParams.get('target_uid')) rows = rows.filter(row => row.target_uid === u.searchParams.get('target_uid'));
      if (u.searchParams.get('state__in')) rows = rows.filter(row => u.searchParams.get('state__in').split(',').includes(row.state));
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

test('the release list reads one page of releases and their runs in one more request, grouped by release', async () => {
  const f = fixture(), result = await f.run('deployment-releases', { environmentUid: ENV, days: 30 });
  assert.equal(result.status, 'success', result.summary);
  const reads = f.calls.filter(call => call.path !== '/api/v1/users/me/');
  assert.deepEqual(reads.map(call => call.path), ['/api/v1/resource-releases/', '/api/v1/deployment-runs/']);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.equal(reads[0].query.organization_environment_uid, ENV);
  assert.deepEqual(reads[1].query.target_uid__in.split(','), [API, AGENT, SITE]);
  assert.ok(Date.parse(reads[1].query.created_after) <= Date.now() - 29 * 86_400_000, 'the window starts 30 days back');
  const [api, agent, site] = result.data.results;
  assert.deepEqual([api.kindLabel, agent.kindLabel, site.kindLabel], ['API', 'Agent', 'Static site']);
  assert.deepEqual(api.recent.map(item => item.state), ['running', 'succeeded', 'failed']);
  assert.equal(api.activeRun.uid, id(100)); assert.equal(api.activeRun.stepsTotal, 2);
  assert.equal(api.lastRun.uid, id(100)); assert.equal(api.repositoryName, 'pricing-engine'); assert.equal(api.branchName, 'main');
  assert.equal(api.stats.succeeded, 1); assert.equal(api.stats.failed, 1); assert.equal(api.stats.active, 1); assert.equal(api.stats.successRate, 0.5);
  assert.equal(agent.activeRun, null); assert.equal(agent.stats.superseded, 1);
  assert.equal(site.recent.length, 1, 'a static site run without a release reference still counts by its target');
  assert.match(result.summary, /3 releases; 1 deploying/);
  assert.doesNotMatch(JSON.stringify(result), /never-return|cost_summary|synthetic-secret/);
});

test('the release list passes its filters to the backend and refuses unknown ones', async () => {
  const f = fixture();
  assert.equal((await f.run('deployment-releases', { environmentUid: ENV, codeRepositoryBranchUid: BRANCH, releaseKind: 'fastapi', search: 'pricing' })).status, 'success');
  const query = f.calls.find(call => call.path === '/api/v1/resource-releases/').query;
  assert.equal(query.code_repository_branch_uid, BRANCH); assert.equal(query.release_kind, 'fastapi'); assert.equal(query.search, 'pricing');
  for (const bad of [{ releaseKind: 'streamlit' }, { days: 0 }, { days: 91 }, { limit: 101 }, { search: 7 }, { environmentUid: 'nope' }]) {
    const result = await f.run('deployment-releases', { environmentUid: ENV, ...bad });
    assert.equal(result.status, 'failure', JSON.stringify(bad)); assert.equal(result.error.code, 'INVALID_REQUEST');
  }
});

test('a release history shows what is serving, what is wanted, its runs and their stats', async () => {
  const f = fixture(), result = await f.run('deployment-release', { environmentUid: ENV, releaseUid: API, days: 7 });
  assert.equal(result.status, 'success', result.summary);
  const runs = f.calls.find(call => call.path === '/api/v1/deployment-runs/').query;
  assert.equal(runs.target_uid, API); assert.equal(runs.organization_environment_uid, ENV); assert.equal(runs.ordering, '-creation_date');
  const { release, stats } = result.data;
  assert.equal(release.activeRevision.commit, 'abc1def'); assert.equal(release.activeRevision.configurationRevision, 14);
  assert.equal(release.desiredRevision.commit, 'abc0def'); assert.equal(release.repositoryName, 'pricing-engine');
  assert.equal(result.data.runs.length, 3); assert.equal(result.data.runs[2].errorCode, 'runtime_readiness_timeout');
  assert.deepEqual(stats.commonFailure, { code: 'runtime_readiness_timeout', count: 1, of: 1 });
  assert.equal(stats.medianMs, 4 * 60_000);
  assert.deepEqual(stats.slowestStage, { name: 'Deploy', medianMs: 4 * 60_000 });
  const hidden = await f.run('deployment-release', { environmentUid: ENV, releaseUid: id(99) });
  assert.equal(hidden.status, 'success'); assert.equal(hidden.data.hidden, true); assert.match(hidden.summary, /can't see this release/);
});

test('release stats count only decided runs toward the success rate and ignore unfinished durations', () => {
  const t = s => new Date(Date.parse('2026-11-18T12:00:00Z') + s * 1000).toISOString();
  const runs = [
    { state: 'succeeded', finishedAt: 'x', durationMs: 1000, startedAt: t(0), steps: [{ state: 'succeeded', name: 'Build', durationMs: 600, startedAt: t(0) }, { state: 'succeeded', name: 'Deploy', durationMs: 400, startedAt: t(1) }] },
    { state: 'succeeded', finishedAt: 'x', durationMs: 3000, startedAt: t(0), steps: [{ state: 'succeeded', name: 'Build', durationMs: 2600, startedAt: t(0) }, { state: 'succeeded', name: 'Deploy', durationMs: 400, startedAt: t(3) }] },
    { state: 'succeeded', finishedAt: 'x', durationMs: 2000, steps: [] },
    { state: 'blocked', errorCode: 'quota', steps: [] }, { state: 'failed', errorCode: '', steps: [{ state: 'failed', errorCode: 'image_build_failed' }] },
    { state: 'blocked', errorCode: '', outcome: 'workflow_prerequisite_failed', steps: [] }, { state: 'blocked', errorCode: '', outcome: 'workflow_prerequisite_failed', steps: [] },
    { state: 'superseded', steps: [] }, { state: 'cancelled', steps: [] }, { state: 'running', durationMs: 99_000, steps: [] }];
  const stats = releaseStats(runs);
  assert.equal(stats.runs, 10); assert.equal(stats.active, 1); assert.equal(stats.successRate, 3 / 7);
  assert.equal(stats.medianMs, 2000); assert.equal(stats.p90Ms, 3000);
  assert.deepEqual(stats.slowestStage, { name: 'Build', medianMs: 600 });
  assert.deepEqual(stats.commonFailure, { code: 'workflow_prerequisite_failed', count: 2, of: 4 }, 'a blocked run without an error code is named by its outcome');
  const waiting = releaseStats([{ state: 'succeeded', finishedAt: 'x', durationMs: 300_000, startedAt: t(0), steps: [{ state: 'succeeded', name: 'Deploy', durationMs: 60_000, startedAt: t(240) }] }]);
  assert.deepEqual(waiting.slowestStage, { name: 'Waiting to start', medianMs: 240_000 }, 'the wait before the first stage counts as a stage');
  assert.equal(releaseStats([]).successRate, null); assert.equal(releaseStats([]).medianMs, null); assert.equal(releaseStats([]).commonFailure, null);
});

test('the active check asks only for queued and running runs', async () => {
  const f = fixture(), result = await f.run('deployment-active', { environmentUid: ENV, codeRepositoryBranchUid: BRANCH });
  assert.equal(result.status, 'success');
  const query = f.calls.find(call => call.path === '/api/v1/deployment-runs/').query;
  assert.equal(query.state__in, 'queued,running'); assert.equal(query.code_repository_branch_uid, BRANCH);
  assert.equal(result.data.count, 1); assert.equal(result.data.runs[0].uid, id(100)); assert.equal(result.summary, '1 deployment in progress.');
  const quiet = fixture({ runs: [run(1, API, 'succeeded')] });
  assert.equal((await quiet.run('deployment-active', { environmentUid: ENV })).summary, 'No deployments in progress.');
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
