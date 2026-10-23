import { ActionResult, HostServices, ToolingError } from './models';
import { createSessionService, requireBackend } from './session';
import type { SessionLock } from './sharedTransport';
import { bindSessionAccount } from './accountScope';

/** Read-only deployment history for the pane and the model tool: no billing, cost or credential fields. */
export type DeploymentRequest =
  { action: 'deployment-history'; backend: string; expectedAccount: string; environmentUid: string; codeRepositoryBranchUid?: string; limit?: number; offset?: number }
  | { action: 'deployment-run'; backend: string; expectedAccount: string; runUid: string; kind?: 'deployment_run' | 'workflow_run' }
  | { action: 'deployment-logs'; backend: string; expectedAccount: string; runUid: string; stepUid?: string; cursor?: string; limit?: number };
export const DEPLOYMENT_ACTIONS = new Set(['deployment-history', 'deployment-run', 'deployment-logs']);
/** Command Center's wording for a run that answers 404: it never says whether the record exists. */
export const HIDDEN_DEPLOYMENT = "You can't see this deployment. A deployment is shown to the people who can see its release or Job.";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACTIVE = new Set(['pending', 'queued', 'running']);
const RUN_PATH = /^\/api\/v1\/(?:deployment-runs\/[a-f0-9-]{36}\/(?:logs\/)?|deployment-history\/[a-f0-9-]{36}\/)$/;

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
        startedAt, finishedAt, durationMs: duration(startedAt, finishedAt, now), error: errorText(step.error) };
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
    logsAvailable: rec(run.logs).state === 'available' || typeof rec(run.logs).url === 'string', error: errorText(run.error) };
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
      } else throw new ToolingError('INVALID_REQUEST', 'Unknown deployment action.');
      await scoped.status(backend, true);
      return JSON.parse(session.sanitize(JSON.stringify({ schemaVersion: 1, action, status: 'success', summary, data }))); 
    } catch (error) { const failure = options.signal?.aborted ? new ToolingError('CANCELLED', 'The read was cancelled.') : error instanceof ToolingError ? error : new ToolingError('API_ERROR', 'Deployment information is unavailable.'); return { schemaVersion: 1, action, status: failure.code === 'CANCELLED' ? 'cancelled' : 'failure', summary: failure.message, error: { code: failure.code, message: failure.message } }; }
  }
  return { dispatch };
}
