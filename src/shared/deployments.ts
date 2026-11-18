import { ActionResult, HostServices, ToolingError } from './models';
import { createSessionService, requireBackend } from './session';
import type { SessionLock } from './sharedTransport';
import { bindSessionAccount } from './accountScope';

/** Read-only deployment history for the pane and the model tool: no billing, cost or credential fields. */
export type DeploymentRequest =
  { action: 'deployment-history'; backend: string; expectedAccount: string; environmentUid: string; codeRepositoryBranchUid?: string; limit?: number; offset?: number }
  | { action: 'deployment-run'; backend: string; expectedAccount: string; runUid: string; kind?: 'deployment_run' | 'workflow_run' }
  | { action: 'deployment-logs'; backend: string; expectedAccount: string; runUid: string; stepUid?: string; cursor?: string; limit?: number }
  | { action: 'deployment-releases'; backend: string; expectedAccount: string; environmentUid: string; codeRepositoryBranchUid?: string; releaseKind?: string; search?: string; days?: number; limit?: number; offset?: number }
  | { action: 'deployment-release'; backend: string; expectedAccount: string; environmentUid: string; releaseUid: string; days?: number; limit?: number }
  | { action: 'deployment-active'; backend: string; expectedAccount: string; environmentUid: string; codeRepositoryBranchUid?: string }
  | { action: 'deployment-wait'; backend: string; expectedAccount: string; runUid: string; timeoutSeconds?: number };
export const DEPLOYMENT_ACTIONS = new Set(['deployment-history', 'deployment-run', 'deployment-logs', 'deployment-releases', 'deployment-release', 'deployment-active', 'deployment-wait']);
/** Release kinds as the backend names them, with the words the pane shows. */
export const RELEASE_KINDS: Record<string, string> = { fastapi: 'API', harness_agent: 'Agent', agent: 'Agent', static_site: 'Static site' };
/** A run in any other state has ended and never changes again. */
export const ACTIVE_RUN_STATES = new Set(['queued', 'running']);
/** How often a wait re-reads its run, and the longest one call waits. */
export const WAIT_INTERVAL_MS = 10_000;
export const WAIT_LIMIT_SECONDS = 120;
/** The stage name release stats give the time a run waits before its first stage starts. */
export const WAITING_STAGE = 'Waiting to start';
/** Command Center's wording for a run that answers 404: it never says whether the record exists. */
export const HIDDEN_DEPLOYMENT = "You can't see this deployment. A deployment is shown to the people who can see its release or Job.";
export const HIDDEN_RELEASE = "You can't see this release. A release is shown to the people it is shared with.";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACTIVE = new Set(['pending', 'queued', 'running']);
const RUN_PATH = /^\/api\/v1\/(?:deployment-runs\/[a-f0-9-]{36}\/(?:logs\/)?|deployment-history\/[a-f0-9-]{36}\/|resource-releases\/[a-f0-9-]{36}\/(?:revisions\/)?)$/;
const RELEASE_TARGETS = new Set(['resource_release', 'harness_agent', 'static_site']);

function uuid(value: unknown, message: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ToolingError('INVALID_REQUEST', message);
  return value.toLowerCase();
}
function integer(value: unknown, minimum: number, maximum: number, fallback: number, message: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new ToolingError('INVALID_REQUEST', message);
  return value as number;
}
const text = (value: unknown, limit = 4000): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').slice(0, limit) : '';
const optionalUuid = (value: unknown): string | null => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
function when(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function duration(start: string | null, end: string | null, now: number): number | null {
  if (!start) return null;
  const from = Date.parse(start), to = end ? Date.parse(end) : now;
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
}
function errorText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return text(value, 2000);
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    const detail = [row.detail, row.message, row.reason].find(item => typeof item === 'string' && item.trim());
    const code = typeof row.code === 'string' ? row.code : '';
    if (detail || code) return text([code, detail].filter(Boolean).join(': '), 2000);
    try { return text(JSON.stringify(value), 1000); } catch { return 'Error details unavailable.'; }
  }
  return text(String(value), 500);
}
const earliest = (values: (string | null)[]): string | null => values.filter((value): value is string => !!value).sort()[0] ?? null;
const latest = (values: (string | null)[]): string | null => values.filter((value): value is string => !!value).sort().at(-1) ?? null;
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const rec = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** An ADR-074 workflow run: the sealed step graph in plan order and the runs it owns. */
export function workflowRun(row: unknown, now: number) {
  const run = rec(row);
  const uid = optionalUuid(run.uid);
  if (!uid) return null;
  const steps = list(run.steps).slice(0, 60).map(item => {
    const step = rec(item);
    const startedAt = when(step.dispatch_started_at) ?? when(step.dispatch_authorized_at), finishedAt = when(step.finished_at);
    const key = text(step.step_key, 200);
    return { id: key, key, operation: text(step.operation, 100), resourceKey: text(step.resource_key, 200), state: text(step.state, 40) || 'unknown',
      reason: text(step.reason, 500), needs: list(step.needs).slice(0, 40).map(need => text(need, 200)), deploymentRunUid: optionalUuid(step.deployment_run_uid),
      startedAt, finishedAt, durationMs: duration(startedAt, finishedAt, now), error: errorText(step.error) };
  });
  const createdAt = when(run.creation_date), finishedAt = when(run.finished_at);
  const startedAt = earliest([createdAt, ...steps.map(step => step.startedAt)]) ?? createdAt;
  const deploymentRuns = list(run.deployment_runs).slice(0, 40).flatMap(item => {
    const owned = rec(item), ownedUid = optionalUuid(owned.uid);
    return ownedUid ? [{ uid: ownedUid, targetLabel: text(owned.target_label, 200), targetType: text(owned.target_type, 60), state: text(owned.state, 40) || 'unknown',
      workflowStepKeys: list(owned.workflow_step_keys).slice(0, 40).map(key => text(key, 200)),
      createdAt: when(owned.created_at), startedAt: when(owned.started_at), finishedAt: when(owned.finished_at) }] : [];
  });
  return { kind: 'workflow_run' as const, uid, state: text(run.state, 40) || 'unknown', reason: text(run.reason, 500), workflowPath: text(run.workflow_path, 300),
    repositoryUid: optionalUuid(run.code_repository_uid), repositoryName: text(run.code_repository_name, 200),
    branchUid: optionalUuid(run.code_repository_branch_uid), branchName: text(run.repository_branch, 200),
    commit: text(run.commit_sha, 40).slice(0, 7), createdAt, startedAt, finishedAt: finishedAt ?? (ACTIVE.has(text(run.state, 40)) ? null : latest(steps.map(step => step.finishedAt))),
    durationMs: duration(startedAt, finishedAt ?? (ACTIVE.has(text(run.state, 40)) ? null : latest(steps.map(step => step.finishedAt))), now),
    steps, deploymentRuns, error: errorText(run.error) };
}

/** A deployment run: its pipeline stages in `sequence` order and, when included, the workflow run that started it. */
export function deploymentRun(row: unknown, now: number) {
  const run = rec(row);
  const uid = optionalUuid(run.uid);
  if (!uid) return null;
  const target = rec(run.target), repository = rec(target.code_repository), branch = rec(target.code_repository_branch);
  const steps = list(rec(run.pipeline).steps).map(rec).filter(step => Number.isFinite(Number(step.sequence)))
    .sort((a, b) => Number(a.sequence) - Number(b.sequence)).slice(0, 60).map(step => {
      const startedAt = when(step.started_at), finishedAt = when(step.finished_at);
      const stepUid = optionalUuid(step.uid), key = text(step.key, 200);
      return { id: stepUid ?? key, uid: stepUid, sequence: Number(step.sequence), key, name: text(step.name, 200), kind: text(step.kind, 60),
        state: text(step.state, 40) || 'unknown', outcome: text(step.outcome, 100), reason: text(step.reason ?? step.skip_reason, 500),
        startedAt, finishedAt, durationMs: duration(startedAt, finishedAt, now), error: errorText(step.error), errorCode: errorCode(step.error) };
    });
  const createdAt = when(run.created_at), finishedAt = when(run.finished_at);
  const startedAt = when(run.started_at) ?? earliest(steps.map(step => step.startedAt)) ?? createdAt;
  const workflow = run.workflow_run ? workflowRun(run.workflow_run, now) : null;
  return { kind: 'deployment_run' as const, uid, state: text(run.state, 40) || 'unknown', outcome: text(run.outcome, 100), operation: text(run.operation, 60), source: text(run.source, 60),
    targetLabel: text(target.display_name || target.name, 200) || text(run.target_type, 60), targetType: text(run.target_type, 60),
    repositoryUid: optionalUuid(repository.uid), repositoryName: text(repository.name, 200),
    branchUid: optionalUuid(run.code_repository_branch_uid) ?? optionalUuid(branch.uid), branchName: text(branch.repository_branch, 200),
    commit: text(run.commit_sha, 40).slice(0, 7), createdAt, startedAt, finishedAt, durationMs: duration(startedAt, finishedAt, now),
    currentStepKey: text(rec(run.pipeline).current_step_key, 200), steps,
    workflowStepKeys: list(run.workflow_step_keys).slice(0, 40).map(key => text(key, 200)), workflowRun: workflow,
    logsAvailable: rec(run.logs).state === 'available' || typeof rec(run.logs).url === 'string', error: errorText(run.error), errorCode: errorCode(run.error),
    releaseUid: optionalUuid(rec(target.resource_release).uid) ?? (RELEASE_TARGETS.has(text(run.target_type, 60)) ? optionalUuid(target.uid) ?? optionalUuid(run.target_uid) : null) };
}
type Run = NonNullable<ReturnType<typeof deploymentRun>>;

function errorCode(value: unknown): string {
  const code = rec(value).code;
  return typeof code === 'string' ? text(code, 100) : '';
}
function percentile(sorted: number[], share: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];
}
const numbers = (values: (number | null)[]) => values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);

/** What a set of runs says about a release: counts by state, success rate over runs that
 *  either deployed or failed, durations of the runs that succeeded, the stage that takes
 *  longest and the failure seen most. The backend has no statistics endpoint. */
export function releaseStats(runs: Run[]) {
  const counts: Record<string, number> = { succeeded: 0, failed: 0, blocked: 0, cancelled: 0, superseded: 0, skipped: 0, active: 0 };
  const stages = new Map<string, (number | null)[]>(), failures = new Map<string, number>();
  for (const run of runs) {
    if (ACTIVE_RUN_STATES.has(run.state)) { counts.active++; continue; }
    if (run.state in counts) counts[run.state]++;
    if (run.state === 'succeeded') {
      // A run can sit for minutes before its first stage, waiting on its workflow (an image
      // build in another run): that wait is counted as a stage of its own.
      const first = earliest(run.steps.map(step => step.startedAt)), waited = duration(run.startedAt, first, Number.NaN);
      if (waited !== null) stages.set(WAITING_STAGE, [...(stages.get(WAITING_STAGE) || []), waited]);
      for (const step of run.steps) if (step.state === 'succeeded') {
        const name = step.name || step.key || step.kind;
        if (name) stages.set(name, [...(stages.get(name) || []), step.durationMs]);
      }
    }
    if (run.state === 'failed' || run.state === 'blocked') {
      // Blocked runs often say why only in their outcome (workflow_prerequisite_failed).
      const code = run.errorCode || run.steps.find(step => step.errorCode)?.errorCode || run.outcome || 'unknown';
      failures.set(code, (failures.get(code) || 0) + 1);
    }
  }
  const decided = counts.succeeded + counts.failed + counts.blocked;
  const durations = numbers(runs.filter(run => run.state === 'succeeded' && run.finishedAt).map(run => run.durationMs));
  let slowestStage: { name: string; medianMs: number } | null = null;
  for (const [name, values] of stages) {
    const median = percentile(numbers(values), 0.5);
    if (median !== null && (!slowestStage || median > slowestStage.medianMs)) slowestStage = { name, medianMs: median };
  }
  const [code, count] = [...failures].sort((a, b) => b[1] - a[1])[0] || [];
  return { runs: runs.length, ...counts, successRate: decided ? counts.succeeded / decided : null,
    medianMs: percentile(durations, 0.5), p90Ms: percentile(durations, 0.9), slowestStage,
    commonFailure: code ? { code, count: count as number, of: counts.failed + counts.blocked } : null };
}
function runSummary(run: Run) {
  return { uid: run.uid, state: run.state, outcome: run.outcome, operation: run.operation, source: run.source, commit: run.commit,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: run.durationMs, error: run.error, errorCode: run.errorCode,
    currentStepKey: run.currentStepKey, stepsDone: run.steps.filter(step => step.state === 'succeeded').length, stepsTotal: run.steps.length,
    releaseUid: run.releaseUid, targetLabel: run.targetLabel, repositoryName: run.repositoryName, branchName: run.branchName };
}
function releaseRow(row: unknown) {
  const release = rec(row), kind = text(release.release_kind, 40);
  return { uid: optionalUuid(release.uid), name: text(release.name, 200), kind, kindLabel: RELEASE_KINDS[kind] || kind.replace(/_/g, ' '),
    branchUid: optionalUuid(release.code_repository_branch_uid), activeRevisionUid: optionalUuid(release.active_revision), desiredRevisionUid: optionalUuid(release.desired_revision) };
}
function revisionRow(row: unknown) {
  const revision = rec(row);
  return { uid: optionalUuid(revision.uid), state: text(revision.state, 40), commit: text(revision.commit_sha, 40).slice(0, 7),
    configurationRevision: Number.isInteger(revision.configuration_revision) ? revision.configuration_revision as number : null,
    createdAt: when(revision.created_at), activatedAt: when(revision.activated_at) };
}
const since = (days: number, now: number) => new Date(now - days * 86_400_000).toISOString();
function page(value: unknown, what: string): { count: number; results: unknown[] } {
  const body = rec(value);
  if (!Array.isArray(body.results) || !Number.isInteger(body.count) || (body.count as number) < 0) throw new ToolingError('API_ERROR', `${what} ${what.endsWith('s') ? 'are' : 'is'} unavailable.`);
  return { count: body.count as number, results: body.results };
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ToolingError('CANCELLED', 'The read was cancelled.')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(new ToolingError('CANCELLED', 'The read was cancelled.')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function historyEntry(row: unknown, now: number) {
  const kind = rec(row).kind;
  return kind === 'workflow_run' ? workflowRun(row, now) : kind === 'deployment_run' ? deploymentRun(row, now) : null;
}

function logEntry(row: unknown) {
  const entry = rec(row);
  return { sequence: Number.isFinite(Number(entry.sequence)) ? Number(entry.sequence) : null, timestamp: when(entry.timestamp), stepUid: optionalUuid(entry.step_uid),
    source: text(entry.source, 100), stream: text(entry.stream, 20), level: text(entry.level, 20), text: text(entry.text, 4000) };
}

/** A read-only bridge over the public session service; the saved credentials never leave it. */
export function createDeployments(options: { host: HostServices; signal?: AbortSignal; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; sessionLock?: SessionLock }) {
  const transport = options.fetch ?? fetch;
  const session = createSessionService(options.host, { env: options.env, signal: options.signal, requestTimeoutMs: 30_000, sessionLock: options.sessionLock,
    fetch: async (input, init) => {
      const response = await transport(input, init);
      // A run the reader may not see answers 404. Describe it without asserting existence,
      // adapting only canonical run responses inside the authenticated transport.
      if (response.status === 404 && RUN_PATH.test(new URL(String(input)).pathname)) {
        await response.body?.cancel().catch(() => {});
        return new Response(JSON.stringify({ hidden: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    } });

  async function dispatch(input: DeploymentRequest): Promise<ActionResult> {
    const action = input?.action || 'unknown';
    try {
      const backend = requireBackend(input.backend);
      const scoped = await bindSessionAccount(session, backend, input.expectedAccount);
      const now = Date.now(), at = new Date(now).toISOString();
      let data: unknown, summary: string;
      if (input.action === 'deployment-history') {
        const environmentUid = uuid(input.environmentUid, 'Choose an organization environment first.');
        const limit = integer(input.limit, 1, 100, 25, 'Request between 1 and 100 deployment history entries.');
        const offset = integer(input.offset, 0, 1_000_000, 0, 'The deployment history offset is invalid.');
        const branchUid = input.codeRepositoryBranchUid === undefined ? '' : uuid(input.codeRepositoryBranchUid, 'Choose a repository branch from the current environment.');
        const page = await scoped.request<any>(backend, 'GET',
          `/api/v1/deployment-history/?organization_environment_uid=${environmentUid}&limit=${limit}&offset=${offset}${branchUid ? `&code_repository_branch_uid=${branchUid}` : ''}`);
        if (!page || !Array.isArray(page.results) || !Number.isInteger(page.count) || page.count < 0) throw new ToolingError('API_ERROR', 'The deployment history is unavailable.');
        const results = page.results.map((row: unknown) => historyEntry(row, now)).filter(Boolean);
        data = { environmentUid, branchUid: branchUid || null, count: page.count, limit, offset, now: at, results };
        summary = `${page.count} deployment history ${page.count === 1 ? 'entry' : 'entries'}.`;
      } else if (input.action === 'deployment-run') {
        const runUid = uuid(input.runUid, 'Choose a deployment or workflow run.');
        const kind = input.kind === 'workflow_run' ? 'workflow_run' : 'deployment_run';
        const row = await scoped.request<any>(backend, 'GET', kind === 'workflow_run'
          ? `/api/v1/deployment-history/${runUid}/` : `/api/v1/deployment-runs/${runUid}/?include=workflow_run`);
        if (rec(row).hidden === true) { data = { hidden: true, uid: runUid, kind, now: at }; summary = HIDDEN_DEPLOYMENT; }
        else {
          const run = kind === 'workflow_run' ? workflowRun(row, now) : deploymentRun(row, now);
          if (!run || run.uid !== runUid) throw new ToolingError('API_ERROR', 'The deployment run record is unavailable.');
          data = { hidden: false, uid: runUid, kind, run, now: at };
          summary = `${kind === 'workflow_run' ? 'Workflow run' : 'Deployment'} ${run.state}.`;
        }
      } else if (input.action === 'deployment-logs') {
        const runUid = uuid(input.runUid, 'Choose a deployment run.');
        const stepUid = input.stepUid === undefined ? '' : uuid(input.stepUid, 'Choose a stage of this deployment run.');
        const limit = integer(input.limit, 1, 200, 200, 'Request between 1 and 200 log entries.');
        if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_.:=~-]{1,4000}$/.test(input.cursor))) throw new ToolingError('INVALID_REQUEST', 'Use a log cursor returned by the previous page.');
        const cursor = input.cursor || '';
        const page = await scoped.request<any>(backend, 'GET',
          `/api/v1/deployment-runs/${runUid}/logs/?limit=${limit}${stepUid ? `&step_uid=${stepUid}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (rec(page).hidden === true) { data = { hidden: true, uid: runUid, now: at }; summary = HIDDEN_DEPLOYMENT; }
        else {
          if (!page || !Array.isArray(page.entries)) throw new ToolingError('API_ERROR', 'The deployment logs are unavailable.');
          const entries = page.entries.slice(0, limit).map(logEntry);
          data = { hidden: false, runUid, stepUid: stepUid || null, cursor: cursor || null, nextCursor: typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor.slice(0, 4000) : null,
            complete: page.complete === true, entries, now: at };
          summary = `${entries.length} log ${entries.length === 1 ? 'entry' : 'entries'}.`;
        }
      } else if (input.action === 'deployment-releases') {
        // Two reads: one page of releases, then their runs of the window in one request.
        const environmentUid = uuid(input.environmentUid, 'Choose an organization environment first.');
        const days = integer(input.days, 1, 90, 30, 'Choose between 1 and 90 days of release history.');
        const limit = integer(input.limit, 1, 100, 50, 'Request between 1 and 100 releases.');
        const offset = integer(input.offset, 0, 1_000_000, 0, 'The release list offset is invalid.');
        const branchUid = input.codeRepositoryBranchUid === undefined ? '' : uuid(input.codeRepositoryBranchUid, 'Choose a repository branch from the current environment.');
        if (input.releaseKind !== undefined && !(typeof input.releaseKind === 'string' && input.releaseKind in RELEASE_KINDS)) throw new ToolingError('INVALID_REQUEST', `Choose a release kind: ${Object.keys(RELEASE_KINDS).join(', ')}.`);
        if (input.search !== undefined && typeof input.search !== 'string') throw new ToolingError('INVALID_REQUEST', 'Search with text.');
        const kind = input.releaseKind || '', search = text(input.search ?? '', 300).trim();
        const query = new URLSearchParams({ organization_environment_uid: environmentUid, ordering: 'name', limit: String(limit), offset: String(offset) });
        if (branchUid) query.set('code_repository_branch_uid', branchUid);
        if (kind) query.set('release_kind', kind);
        if (search) query.set('search', search);
        const releases = page(await scoped.request<any>(backend, 'GET', `/api/v1/resource-releases/?${query}`), 'The release list');
        const rows = releases.results.map(releaseRow).filter(row => row.uid);
        let runs: Run[] = [], inWindow = 0;
        if (rows.length) {
          const runQuery = new URLSearchParams({ organization_environment_uid: environmentUid, target_uid__in: rows.map(row => row.uid).join(','),
            created_after: since(days, now), ordering: '-creation_date', limit: '500' });
          const found = page(await scoped.request<any>(backend, 'GET', `/api/v1/deployment-runs/?${runQuery}`), 'The deployment runs');
          inWindow = found.count; runs = found.results.map(row => deploymentRun(row, now)).filter((run): run is Run => !!run);
        }
        const byRelease = new Map<string, Run[]>();
        for (const run of runs) if (run.releaseUid) byRelease.set(run.releaseUid, [...(byRelease.get(run.releaseUid) || []), run]);
        const results = rows.map(row => {
          const own = byRelease.get(row.uid as string) || [], last = own[0], active = own.find(run => ACTIVE_RUN_STATES.has(run.state));
          return { ...row, repositoryName: last?.repositoryName || '', branchName: last?.branchName || '', recent: own.slice(0, 10).map(run => ({ uid: run.uid, state: run.state })),
            lastRun: last ? runSummary(last) : null, activeRun: active ? runSummary(active) : null, stats: releaseStats(own) };
        });
        const deploying = results.filter(row => row.activeRun).length;
        data = { environmentUid, branchUid: branchUid || null, releaseKind: kind || null, search: search || null, days, count: releases.count, limit, offset, now: at,
          runsCounted: runs.length, runsInWindow: inWindow, runsTruncated: inWindow > runs.length, results };
        summary = `${releases.count} ${releases.count === 1 ? 'release' : 'releases'}${deploying ? `; ${deploying} deploying` : ''}.`;
      } else if (input.action === 'deployment-release') {
        const environmentUid = uuid(input.environmentUid, 'Choose an organization environment first.');
        const releaseUid = uuid(input.releaseUid, 'Choose a release from the current environment.');
        const days = integer(input.days, 1, 90, 30, 'Choose between 1 and 90 days of release history.');
        const limit = integer(input.limit, 1, 200, 100, 'Request between 1 and 200 runs.');
        const body = await scoped.request<any>(backend, 'GET', `/api/v1/resource-releases/${releaseUid}/`);
        if (rec(body).hidden === true) { data = { hidden: true, uid: releaseUid, now: at }; summary = HIDDEN_RELEASE; }
        else {
          const release = releaseRow(body);
          if (release.uid !== releaseUid) throw new ToolingError('API_ERROR', 'The release record is unavailable.');
          const revisionBody = rec(await scoped.request<any>(backend, 'GET', `/api/v1/resource-releases/${releaseUid}/revisions/?limit=20`));
          const revisions = list(revisionBody.results).map(revisionRow);
          const runQuery = new URLSearchParams({ target_uid: releaseUid, organization_environment_uid: environmentUid, created_after: since(days, now), ordering: '-creation_date', limit: String(limit) });
          const found = page(await scoped.request<any>(backend, 'GET', `/api/v1/deployment-runs/?${runQuery}`), 'The deployment runs');
          const runs = found.results.map(row => deploymentRun(row, now)).filter((run): run is Run => !!run);
          const revision = (uid: string | null) => uid ? revisions.find(item => item.uid === uid) || { uid, state: '', commit: '', configurationRevision: null, createdAt: null, activatedAt: null } : null;
          data = { hidden: false, uid: releaseUid, environmentUid, days, now: at,
            release: { ...release, repositoryName: runs[0]?.repositoryName || '', branchName: runs[0]?.branchName || '',
              activeRevision: revision(release.activeRevisionUid), desiredRevision: revision(release.desiredRevisionUid) },
            count: found.count, counted: runs.length, truncated: found.count > runs.length, runs: runs.map(runSummary), stats: releaseStats(runs) };
          summary = `${release.name || 'Release'}: ${found.count} ${found.count === 1 ? 'run' : 'runs'} in ${days} ${days === 1 ? 'day' : 'days'}.`;
        }
      } else if (input.action === 'deployment-active') {
        // The cheap check: only runs still queued or running, which the backend allows one of per target.
        const environmentUid = uuid(input.environmentUid, 'Choose an organization environment first.');
        const branchUid = input.codeRepositoryBranchUid === undefined ? '' : uuid(input.codeRepositoryBranchUid, 'Choose a repository branch from the current environment.');
        const query = new URLSearchParams({ organization_environment_uid: environmentUid, state__in: [...ACTIVE_RUN_STATES].join(','), ordering: '-creation_date', limit: '20' });
        if (branchUid) query.set('code_repository_branch_uid', branchUid);
        const found = page(await scoped.request<any>(backend, 'GET', `/api/v1/deployment-runs/?${query}`), 'The deployment runs');
        const runs = found.results.map(row => deploymentRun(row, now)).filter((run): run is Run => !!run).map(runSummary);
        data = { environmentUid, branchUid: branchUid || null, count: found.count, now: at, runs };
        summary = found.count ? `${found.count} ${found.count === 1 ? 'deployment' : 'deployments'} in progress.` : 'No deployments in progress.';
      } else if (input.action === 'deployment-wait') {
        // Re-reads one run every ten seconds until it ends or the wait runs out; never longer than two minutes.
        const runUid = uuid(input.runUid, 'Choose a deployment run.');
        const timeout = integer(input.timeoutSeconds, 1, WAIT_LIMIT_SECONDS, 60, `Wait between 1 and ${WAIT_LIMIT_SECONDS} seconds.`);
        const deadline = now + timeout * 1000;
        for (let reads = 1; ; reads++) {
          const row = await scoped.request<any>(backend, 'GET', `/api/v1/deployment-runs/${runUid}/`);
          const read = Date.now(), readAt = new Date(read).toISOString();
          if (rec(row).hidden === true) { data = { hidden: true, uid: runUid, now: readAt }; summary = HIDDEN_DEPLOYMENT; break; }
          const run = deploymentRun(row, read);
          if (!run || run.uid !== runUid) throw new ToolingError('API_ERROR', 'The deployment run record is unavailable.');
          const finished = !ACTIVE_RUN_STATES.has(run.state);
          if (finished || read >= deadline) {
            data = { hidden: false, uid: runUid, run, finished, waitedMs: read - now, reads, now: readAt };
            summary = finished ? `Deployment ${run.state}.` : `Deployment still ${run.state} after ${Math.round((read - now) / 1000)} s.`;
            break;
          }
          await pause(Math.min(WAIT_INTERVAL_MS, deadline - read), options.signal);
        }
      } else throw new ToolingError('INVALID_REQUEST', 'Unknown deployment action.');
      await scoped.status(backend, true);
      return JSON.parse(session.sanitize(JSON.stringify({ schemaVersion: 1, action, status: 'success', summary, data }))); 
    } catch (error) { const failure = options.signal?.aborted ? new ToolingError('CANCELLED', 'The read was cancelled.') : error instanceof ToolingError ? error : new ToolingError('API_ERROR', 'Deployment information is unavailable.'); return { schemaVersion: 1, action, status: failure.code === 'CANCELLED' ? 'cancelled' : 'failure', summary: failure.message, error: { code: failure.code, message: failure.message } }; }
  }
  return { dispatch };
}
