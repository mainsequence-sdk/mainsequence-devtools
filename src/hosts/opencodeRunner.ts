import { spawn } from 'node:child_process';
import { ActionResult, ToolingError } from '../shared/models';
import { McpRequest } from '../shared/mcp';

export type OpenCodeInput = { command: string } | { request: McpRequest };
export type RunnerMessage = { type: 'progress'; message: string } | { type: 'result'; result: ActionResult };
export type RunnerOptions = { runner: string; cwd: string; nodePath?: string; env?: NodeJS.ProcessEnv;
  signal?: AbortSignal; progress?: (message: string) => void; timeoutMs?: number };
const maximum = 16_000_000;

/** A real Node child owns cwd, OS-store access, SDK execution and private credentials. */
export function runOpenCodeAction(input: OpenCodeInput, options: RunnerOptions): Promise<ActionResult> {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 1_000_000) throw new ToolingError('INVALID_REQUEST', 'The action input is too large.');
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new ToolingError('CANCELLED', 'The action was cancelled.'));
    const child = spawn(options.nodePath || 'node', [options.runner, '--opencode-runner'], {
      cwd: options.cwd, env: options.env || process.env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pending = '', bytes = 0, result: ActionResult | undefined, protocolError = false, timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform === 'win32') child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); } catch { /* Already exited. */ }
    };
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 3_000); killTimer.unref(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 600_000);
    timer.unref();
    options.signal?.addEventListener('abort', stop, { once: true });
    // Private stderr is drained, never rendered or retained (SDK output can contain secrets).
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maximum) { protocolError = true; stop(); return; }
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(line) as RunnerMessage;
          if (message.type === 'progress' && typeof message.message === 'string') options.progress?.(message.message);
          else if (message.type === 'result' && !result && message.result?.schemaVersion === 1
            && ['success', 'failure', 'cancelled'].includes(message.result.status)) result = message.result;
          else throw new Error('invalid envelope');
        } catch { protocolError = true; stop(); }
      }
    });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new ToolingError('MISSING_PREREQUISITE', 'Node 22+ could not start. Install Node or configure the plugin nodePath.')));
    child.once('close', () => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', stop);
      if (result && !protocolError && !pending.trim()) return resolve(result);
      const code = options.signal?.aborted ? 'CANCELLED' : timedOut ? 'PROCESS_TIMEOUT' : 'PROCESS_FAILED';
      const summary = code === 'CANCELLED' ? 'The action was cancelled.' : code === 'PROCESS_TIMEOUT' ? 'The action timed out.' : 'The Node action runner stopped without a valid result. Check Node 22+ and the plugin installation.';
      // Abrupt termination cannot prove that a mutation did not happen.
      resolve({ schemaVersion: 1, action: 'command' in input ? input.command.split(/\s/)[0] : input.request.action,
        status: code === 'CANCELLED' ? 'cancelled' : 'failure', summary, error: { code, message: summary },
        effects: { state: 'partial-or-uncertain', message: 'The runner stopped before reporting completion. Inspect local and remote changes before retrying.' } });
    });
    child.stdin.end(serialized);
  });
}
