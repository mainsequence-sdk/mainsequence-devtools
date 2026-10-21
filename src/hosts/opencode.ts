import { randomUUID } from 'node:crypto';
import { ActionResult, ToolingError } from '../shared/models';
import { OpenCodeInput, RunnerOptions, runOpenCodeAction } from './opencodeRunner';
import { cleanText, displayOpenCodeResult, openCodeActions } from './opencodePresentation';

export type OpenCodeOperation = { id: string; command: string; status: 'running' | ActionResult['status']; progress: string;
  result?: ActionResult; display?: string };
export function createOpenCodeController(options: Omit<RunnerOptions, 'signal' | 'progress'> & {
  emit?: (operation: OpenCodeOperation) => void;
  completed?: (result: ActionResult) => Promise<void>;
  run?: typeof runOpenCodeAction;
}) {
  const operations = new Map<string, { view: OpenCodeOperation; abort: AbortController }>();
  const running = new Set<AbortController>();
  let closed = false;
  const notify = (view: OpenCodeOperation) => options.emit?.(structuredClone(view));
  const execute = async (input: OpenCodeInput, signal?: AbortSignal, progress?: (message: string) => void): Promise<ActionResult> => {
    const abort = new AbortController();
    if (closed) abort.abort();
    running.add(abort);
    try { return await (options.run ?? runOpenCodeAction)(input, { ...options, signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal, progress }); }
    catch (error) {
      const failure = error instanceof ToolingError ? error : new ToolingError('INTERNAL_ERROR', 'The action could not complete.');
      return { schemaVersion: 1, action: 'command' in input ? 'command' : input.request.action,
        status: failure.code === 'CANCELLED' ? 'cancelled' : 'failure', summary: failure.message,
        error: { code: failure.code, message: failure.message } };
    } finally { running.delete(abort); }
  };
  return {
    execute,
    start(input: OpenCodeInput, perform?: (signal: AbortSignal) => Promise<ActionResult>): OpenCodeOperation {
      if (closed || [...operations.values()].filter(op => op.view.status === 'running').length >= 8) throw new ToolingError('PROJECT_BUSY', 'Too many actions are running, or the plugin is unloading.');
      const id = randomUUID(), abort = new AbortController();
      const view: OpenCodeOperation = { id, command: 'command' in input ? cleanText(input.command) : input.request.action,
        status: 'running', progress: 'Starting the action…' };
      operations.set(id, { view, abort });
      for (const [key, op] of operations) { if (operations.size <= 20) break; if (op.view.status !== 'running') operations.delete(key); }
      notify(view);
      const work = perform ? Promise.resolve().then(() => perform(abort.signal)).catch((): ActionResult => ({ schemaVersion: 1, action: 'mcp-refresh', status: abort.signal.aborted ? 'cancelled' : 'failure', summary: abort.signal.aborted ? 'MCP refresh cancelled.' : 'MCP registrations could not refresh.' }))
        : execute(input, abort.signal, message => { view.progress = cleanText(message); notify(view); });
      void work.then(async result => {
        try { await options.completed?.(result); } catch { /* Preserve the action's authoritative result. Refresh can be retried explicitly. */ }
        view.result = result; view.status = result.status; view.display = displayOpenCodeResult(result); view.progress = result.summary; notify(view);
      });
      return structuredClone(view);
    },
    get(id: string) { const view = operations.get(id)?.view; return view ? structuredClone(view) : null; },
    state() { return { directory: options.cwd, actions: openCodeActions, operations: [...operations.values()].map(op => structuredClone(op.view)) }; },
    cancel(id: string) { const op = operations.get(id); if (!op || op.view.status !== 'running') return false; op.abort.abort(); return true; },
    dispose() { closed = true; for (const abort of running) abort.abort(); for (const op of operations.values()) if (op.view.status === 'running') op.abort.abort(); },
  };
}
