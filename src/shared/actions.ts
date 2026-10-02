import { ActionRequest, ActionResult, HostServices, ProjectAction, SessionService, ToolingError } from './models';
import { MachineSessionService } from './session';
import { listRepositories, projectContext, resolveBackend, resolveRepository } from './repositories';
import { DRY_RUN_ACTIONS, projectCapabilities, runProjectAction, setupRepository, withProjectLock } from './projects';

export function createDevTools(options: ConstructorParameters<typeof MachineSessionService>[1] & { host: HostServices; session?: SessionService & { sanitize?(text: string): string }; allowMcpSkills?: boolean; allowLegacyProjectCredentials?: boolean }) {
  const { host, session: suppliedSession, allowMcpSkills, allowLegacyProjectCredentials, ...sessionOptions } = options;
  const session = suppliedSession ?? new MachineSessionService(host, sessionOptions);
  const env = { ...(options.env ?? process.env) };
  async function dispatch(request: ActionRequest): Promise<ActionResult> {
    const state = { mutationStarted: false };
    const action = request?.action || 'unknown';
    try {
      validateRequest(request);
      options.signal?.throwIfAborted();
      let data: unknown;
      if (['login', 'logout', 'refresh-token', 'auth-status', 'repositories'].includes(action)) {
        const backend = await resolveBackend(request.backend, undefined, env);
        if (request.action === 'login') data = await session.login(backend);
        else if (request.action === 'logout') data = await session.logout(backend);
        else if (request.action === 'refresh-token') data = await session.refresh(backend);
        else if (request.action === 'auth-status') data = await session.status(backend, request.check);
        else data = await listRepositories(session, backend);
      } else if (request.action === 'setup') {
        data = await setupRepository(host, session, { ...request, backend: await resolveBackend(request.backend, undefined, env) }, { env, signal: options.signal, state });
      } else if ('root' in request) {
        const context = await projectContext(host, request.root, request.backend, request.projectType, env, options.signal);
        if (request.action === 'status') data = { project: context, capabilities: await projectCapabilities(host, context, env, options.signal), session: await session.status(context.backend) };
        else if (request.action === 'resolve') data = { project: context, resolution: await resolveRepository(session, context) };
        else {
          const operation = () => runProjectAction(host, session, context, request.action as ProjectAction, { ...request, env, signal: options.signal, state, fetch: options.fetch, allowMcpSkills, allowLegacyProjectCredentials });
          data = ['sdk-status', 'open-folder', 'signed-terminal'].includes(action) || ('dryRun' in request && request.dryRun)
            ? await operation() : await withProjectLock(context.gitCommonDir, operation);
        }
      }
      const summary = action === 'auth-status' ? ((data as any).authenticated ? 'The selected session is usable.' : 'No usable session is selected.')
        : action === 'login' ? 'Signed in; the machine session was saved and verified.'
        : action === 'refresh-token' ? 'The saved machine session was renewed.'
        : action === 'logout' ? ((data as any).revoked ? 'The machine session was revoked and removed.' : 'The local machine session was removed; remote revocation was not confirmed.')
        : action === 'sync' ? 'Dependency files were refreshed. Nothing was committed or pushed: review the changes, then commit and push them yourself.'
        : `${action} completed.`;
      return safeResult({ schemaVersion: 1, action, status: 'success', summary, data });
    } catch (error) {
      const failure = options.signal?.aborted ? new ToolingError('CANCELLED', 'The action was cancelled.')
        : error instanceof ToolingError ? error : new ToolingError('INTERNAL_ERROR', 'The action could not complete. Check the required local tools and project permissions.');
      return safeResult({ schemaVersion: 1, action, status: failure.code === 'CANCELLED' ? 'cancelled' : 'failure', summary: failure.message,
        error: { code: failure.code, message: failure.message },
        ...(state.mutationStarted ? { effects: { state: 'partial-or-uncertain' as const, message: 'Files, dependencies, keys, or remote state may have changed. Inspect the result before retrying; no automatic rollback was attempted.' } } : {})
      });
    }
  }
  function safeResult(result: ActionResult): ActionResult {
    // The dispatcher is the one public output boundary for every host.
    const sanitize = (value: unknown): unknown => {
      if (typeof value === 'string') return session.sanitize?.(value) ?? value;
      if (Array.isArray(value)) return value.map(sanitize);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
      return value;
    };
    return sanitize(result) as ActionResult;
  }
  return { dispatch };
}

const ACTIONS = new Set(['login', 'logout', 'refresh-token', 'auth-status', 'repositories', 'status', 'resolve', 'setup', 'sync', 'sdk-status', 'update-sdk', 'update-agents', 'install-skills', 'skills-sync', 'install', 'env-cleanup', 'open-folder', 'signed-terminal']);
// Removed actions keep a specific answer, so that an older host learns what replaced them.
const RETIRED_ACTIONS: Record<string, string> = {
  'freeze-env': 'freeze-env was removed: sync now refreshes the lock file, the environment and requirements.txt. Run sync instead.',
};
export function validateRequest(request: ActionRequest): void {
  if (request && typeof request.action === 'string' && Object.hasOwn(RETIRED_ACTIONS, request.action)) throw new ToolingError('UNSUPPORTED_ACTION', RETIRED_ACTIONS[request.action]);
  if (!request || !ACTIONS.has(request.action)) throw new ToolingError('INVALID_REQUEST', 'Unknown developer action. Run --help for supported commands.');
  if (!['login', 'logout', 'refresh-token', 'auth-status', 'repositories', 'setup'].includes(request.action) && !('root' in request)) throw new ToolingError('INVALID_REQUEST', 'A project root is required.');
  if ('root' in request && (typeof request.root !== 'string' || !request.root.trim() || request.root.includes('\0'))) throw new ToolingError('INVALID_REQUEST', 'A project root is required.');
  if (request.backend !== undefined && typeof request.backend !== 'string') throw new ToolingError('INVALID_REQUEST', 'Backend must be a URL string.');
  if ('projectType' in request && request.projectType && !['python', 'vite_react'].includes(request.projectType)) throw new ToolingError('INVALID_REQUEST', 'Project type must be python or vite_react.');
  // A sync request from an older host may still carry a commit message. Sync ignores it.
  if ('dryRun' in request && request.dryRun && !(DRY_RUN_ACTIONS as readonly string[]).includes(request.action)) throw new ToolingError('INVALID_REQUEST', 'This action has no dry-run mode.');
  if (request.action === 'setup') {
    for (const value of [request.repositoryUid, request.branch, request.baseDir]) if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new ToolingError('INVALID_REQUEST', 'Setup requires --uid, --branch, and --base-dir.');
  }
}
