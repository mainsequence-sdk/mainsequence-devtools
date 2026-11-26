import { ActionResult, HostServices, ToolingError } from './models';
import { createSessionService, requireBackend } from './session';
import type { SessionLock } from './sharedTransport';
import { bindSessionAccount } from './accountScope';

/** Read-only deployment history for the pane and the model tool: no billing, cost or credential fields. */
export type DeploymentRequest =
  { action: 'deployment-history'; backend: string; expectedAccount: string; environmentUid: string; codeRepositoryBranchUid?: string; limit?: number; offset?: number }
  | { action: 'deployment-run'; backend: string; expectedAccount: string; runUid: string; kind?: 'deployment_run' | 'workflow_run' }
  | { action: 'deployment-logs'; backend: string; expectedAccount: string; runUid: string; stepUid?: string; cursor?: string; limit?: number }
  | { action: 'deployment-release-history'; backend: string; expectedAccount: string; environmentUid: string; codeRepositoryBranchUid?: string; releaseUid?: string; releaseKind?: string; search?: string; days?: number; limit?: number; offset?: number }
  | { action: 'deployment-active'; backend: string; expectedAccount: string; environmentUid: string; codeRepositoryBranchUid?: string }
  | { action: 'deployment-wait'; backend: string; expectedAccount: string; runUid: string; timeoutSeconds?: number };
export const DEPLOYMENT_ACTIONS = new Set(['deployment-history', 'deployment-run', 'deployment-logs', 'deployment-release-history', 'deployment-active', 'deployment-wait']);
/** Release kinds as the backend names them, with the words to show when it sends no label. */
export const RELEASE_KINDS: Record<string, string> = { fastapi: 'API', harness_agent: 'Agent', static_site: 'Static site' };
/** A run in any other state has ended and never changes again. */
export const ACTIVE_RUN_STATES = new Set(['queued', 'running']);
/** How often a wait re-reads its run, and the longest one call waits. */
export const WAIT_INTERVAL_MS = 10_000;
export const WAIT_LIMIT_SECONDS = 120;
/** Command Center's wording for a run that answers 404: it never says whether the record exists. */
export const HIDDEN_DEPLOYMENT = "You can't see this deployment. A deployment is shown to the people who can see its release or Job.";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACTIVE = new Set(['pending', 'queued', 'running']);
const RUN_PATH = /^\/api\/v1\/(?:deployment-runs\/[a-f0-9-]{36}\/(?:logs\/)?|deployment-history\/[a-f0-9-]{36}\/)$/;
/** The target types whose deployments are a resource release's. A Job, its image and an image build are not. */
export const RELEASE_TARGETS = new Set(['resource_release', 'harness_agent', 'static_site']);
/** How far back release deployment history reads when no window is chosen. */
export const RELEASE_HISTORY_DAYS = 1;

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
  const target = rec(run.target), release = rec(target.resource_release), repository = rec(target.code_repository), branch = rec(target.code_repository_branch);
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
  const state = text(run.state, 40) || 'unknown', workflowStepKeys = list(run.workflow_step_keys).slice(0, 40).map(key => text(key, 200));
  return { kind: 'deployment_run' as const, uid, state, outcome: text(run.outcome, 100), operation: text(run.operation, 60), source: text(run.source, 60),
    targetLabel: text(target.display_name || target.name, 200) || text(run.target_type, 60), targetType: text(run.target_type, 60),
    repositoryUid: optionalUuid(repository.uid), repositoryName: text(repository.name, 200),
    branchUid: optionalUuid(run.code_repository_branch_uid) ?? optionalUuid(branch.uid), branchName: text(branch.repository_branch, 200),
    commit: text(run.commit_sha, 40).slice(0, 7), createdAt, startedAt, finishedAt, durationMs: duration(startedAt, finishedAt, now),
    currentStepKey: text(rec(run.pipeline).current_step_key, 200), steps,
    workflowStepKeys, workflowRun: workflow, blockedBy: state === 'blocked' && workflow ? blockedBy(uid, workflowStepKeys, workflow) : null,
    logsAvailable: rec(run.logs).state === 'available' || typeof rec(run.logs).url === 'string', error: errorText(run.error), errorCode: errorCode(run.error),
    releaseName: text(release.name, 200) || (RELEASE_TARGETS.has(text(run.target_type, 60)) ? text(target.name, 200) : ''), agentName: text(rec(target.agent).name, 200),
    targetKind: text(target.kind, 60), targetKindLabel: text(target.kind_label, 100), revisionUid: optionalUuid(rec(target.revision).uid),
    releaseUid: optionalUuid(release.uid) ?? (RELEASE_TARGETS.has(text(run.target_type, 60)) ? optionalUuid(target.uid) ?? optionalUuid(run.target_uid) : null) };
}
type Run = NonNullable<ReturnType<typeof deploymentRun>>;

/** Workflow step states that keep the steps needing them from running. */
const FAILED_STEP_STATES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'stopped', 'timed_out']);
/** Workflow step states of a step that did not run because a step it needs did not succeed. */
const UNRUN_STEP_STATES = new Set(['blocked', 'skipped', 'superseded']);
/**
 * Why the workflow blocked this deployment, as Command Center says it (`migrate failed · 2 blocked`): the workflow
 * and the steps that failed. Walks back from this deployment's own steps through the steps they need, past the
 * ones that did not run, to the ones that failed. When that leads nowhere, every step that failed is named.
 */
function blockedBy(uid: string, ownKeys: string[], workflow: NonNullable<ReturnType<typeof workflowRun>>) {
  const byKey = new Map(workflow.steps.map(step => [step.key, step]));
  const queue = workflow.steps.filter(step => ownKeys.includes(step.key) || step.deploymentRunUid === uid).map(step => step.key);
  const seen = new Set<string>(), causes = new Set<string>();
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    const step = byKey.get(key);
    if (!step || seen.has(key)) continue;
    seen.add(key);
    if (FAILED_STEP_STATES.has(step.state)) causes.add(key);
    else if (UNRUN_STEP_STATES.has(step.state)) queue.push(...step.needs);
  }
  const failed = workflow.steps.filter(step => causes.size ? causes.has(step.key) : FAILED_STEP_STATES.has(step.state));
  return { workflowRunUid: workflow.uid, workflowPath: workflow.workflowPath, workflowState: workflow.state,
    steps: failed.map(step => ({ key: step.key, state: step.state })) };
}

function errorCode(value: unknown): string {
  const code = rec(value).code;
  return typeof code === 'string' ? text(code, 100) : '';
}
/** One deployment of a resource release, as a history row shows it. */
function releaseDeployment(run: Run) {
  const active = ACTIVE_RUN_STATES.has(run.state);
  return { uid: run.uid, releaseUid: run.releaseUid, releaseName: run.releaseName, agentName: run.agentName, kind: run.targetKind,
    kindLabel: run.targetKindLabel || RELEASE_KINDS[run.targetKind] || run.targetKind.replace(/_/g, ' '), revisionUid: run.revisionUid, commit: run.commit,
    repositoryName: run.repositoryName, branchUid: run.branchUid, branchName: run.branchName, state: run.state, outcome: run.outcome, source: run.source,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: active || run.finishedAt ? run.durationMs : null,
    error: run.error, errorCode: run.errorCode, blockedBy: run.blockedBy,
    // A stage left running in a deployment that has ended was stopped, as Command Center shows it.
    steps: run.steps.map(step => ({ name: step.name || step.key, state: !active && step.state === 'running' ? 'stopped' : step.state })) };
}
function page(value: unknown, what: string): { count: number; results: unknown[] } {
  const body = rec(value);
  if (!Array.isArray(body.results) || !Number.isInteger(body.count) || (body.count as number) < 0) throw new ToolingError('API_ERROR', `${what} ${what.endsWith('s') ? 'are' : 'is'} unavailable.`);
  return { count: body.count as number, results: body.results };
}
function releaseQuery(environmentUid: string, branchUid: string, values: Record<string, string>): URLSearchParams {
  const query = new URLSearchParams({ organization_environment_uid: environmentUid, target_type__in: [...RELEASE_TARGETS].join(','), ordering: '-creation_date', ...values });
  if (branchUid) query.set('code_repository_branch_uid', branchUid);
  return query;
}
function releaseDeployments(rows: unknown[], now: number) {
  return rows.filter(row => RELEASE_TARGETS.has(text(rec(row).target_type, 60)))
    .map(row => deploymentRun(row, now)).filter((run): run is Run => !!run).map(releaseDeployment);
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
      } else if (input.action === 'deployment-release-history') {
        // Command Center's Deployment History narrowed to resource releases: one read, newest first.
        const environmentUid = uuid(input.environmentUid, 'Choose an organization environment first.');
        const days = integer(input.days, 1, 90, RELEASE_HISTORY_DAYS, 'Choose between 1 and 90 days of deployment history.');
        const limit = integer(input.limit, 1, 100, 25, 'Request between 1 and 100 deployments.');
        const offset = integer(input.offset, 0, 1_000_000, 0, 'The deployment history offset is invalid.');
        const branchUid = input.codeRepositoryBranchUid === undefined ? '' : uuid(input.codeRepositoryBranchUid, 'Choose a repository branch from the current environment.');
        const releaseUid = input.releaseUid === undefined ? '' : uuid(input.releaseUid, 'Choose a release from the current environment.');
        if (input.releaseKind !== undefined && !(typeof input.releaseKind === 'string' && Object.hasOwn(RELEASE_KINDS, input.releaseKind))) throw new ToolingError('INVALID_REQUEST', `Choose a release kind: ${Object.keys(RELEASE_KINDS).join(', ')}.`);
        if (input.search !== undefined && typeof input.search !== 'string') throw new ToolingError('INVALID_REQUEST', 'Search with text.');
        const kind = input.releaseKind || '', search = text(input.search ?? '', 300).trim();
        // With its workflow run, a blocked row can name the workflow step that failed.
        const query = releaseQuery(environmentUid, branchUid, { created_after: new Date(now - days * 86_400_000).toISOString(), limit: String(limit), offset: String(offset), include: 'workflow_run' });
        if (releaseUid) query.set('target_uid', releaseUid);
        if (kind) query.set('target_kind', kind);
        if (search) query.set('search', search);
        const found = page(await scoped.request<any>(backend, 'GET', `/api/v1/deployment-runs/?${query}`), 'The deployment history');
        data = { environmentUid, branchUid: branchUid || null, releaseUid: releaseUid || null, releaseKind: kind || null, search: search || null,
          days, count: found.count, limit, offset, now: at, results: releaseDeployments(found.results, now) };
        summary = `${found.count} ${found.count === 1 ? 'deployment' : 'deployments'} in the last ${days === 1 ? 'day' : `${days} days`}.`;
      } else if (input.action === 'deployment-active') {
        // The cheap check: only release deployments still queued or running, one at most per release.
        const environmentUid = uuid(input.environmentUid, 'Choose an organization environment first.');
        const branchUid = input.codeRepositoryBranchUid === undefined ? '' : uuid(input.codeRepositoryBranchUid, 'Choose a repository branch from the current environment.');
        const query = releaseQuery(environmentUid, branchUid, { state__in: [...ACTIVE_RUN_STATES].join(','), limit: '100' });
        const found = page(await scoped.request<any>(backend, 'GET', `/api/v1/deployment-runs/?${query}`), 'The deployment history');
        data = { environmentUid, branchUid: branchUid || null, count: found.count, now: at, results: releaseDeployments(found.results, now) };
        summary = found.count ? `${found.count} ${found.count === 1 ? 'deployment' : 'deployments'} in progress.` : 'No deployments in progress.';
      } else if (input.action === 'deployment-wait') {
        // Re-reads one run every ten seconds until it ends or the wait runs out; never longer than two minutes.
        const runUid = uuid(input.runUid, 'Choose a deployment run.');
        const timeout = integer(input.timeoutSeconds, 1, WAIT_LIMIT_SECONDS, 60, `Wait between 1 and ${WAIT_LIMIT_SECONDS} seconds.`);
        const deadline = now + timeout * 1000;
        for (let reads = 1; ; reads++) {
          const row = await scoped.request<any>(backend, 'GET', `/api/v1/deployment-runs/${runUid}/?include=workflow_run`);
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
