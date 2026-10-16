import { ToolingError } from './models';

/** All runtime-access responses remain private. Only fixed, credential-free copy escapes. */
export async function waitForAgentReadiness(options: {
  resolve(deadline: number): Promise<unknown>;
  signal?: AbortSignal;
  progress?: (message: string) => void;
  timeoutMs?: number;
}): Promise<void> {
  const budget = options.timeoutMs ?? 630000;
  if (!Number.isFinite(budget) || budget < 1 || budget > 630000) {
    throw new ToolingError('INVALID_REQUEST', 'Agent readiness timeout must be between 1 and 630000 milliseconds.');
  }
  let deadline = performance.now() + budget;
  let lastProgress = '';
  const progress = (message: string) => {
    if (message !== lastProgress) { lastProgress = message; options.progress?.(message); }
  };
  const timedOut = () => new ToolingError('PROCESS_TIMEOUT', 'The agent did not become ready in time. No message was sent. Try again.');
  progress('Checking agent…');
  while (true) {
    options.signal?.throwIfAborted();
    if (performance.now() >= deadline) throw timedOut();
    const access = await options.resolve(deadline) as any;
    options.signal?.throwIfAborted();
    if (performance.now() >= deadline) throw timedOut();
    const interaction = access?.runtime_interaction;
    if (!interaction || typeof interaction.can_submit !== 'boolean' || typeof interaction.state !== 'string') {
      throw new ToolingError('API_ERROR', 'The platform did not provide a valid agent readiness decision. No message was sent.');
    }
    if (interaction.can_submit) {
      if (!['ready', 'warning'].includes(interaction.state) || access.mode !== 'token'
        || typeof access.token !== 'string' || !access.token || typeof access.rpc_url !== 'string' || !access.rpc_url) {
        throw new ToolingError('API_ERROR', 'The platform returned an incomplete agent readiness decision. No message was sent.');
      }
      progress('Agent ready');
      return;
    }
    if (!['checking', 'starting', 'waking', 'updating'].includes(interaction.state)) {
      const message = ({ update_required: 'The agent needs an update before it can accept messages.',
        update_failed: 'The agent update failed.', unavailable: 'The agent is unavailable.' } as Record<string, string>)[interaction.state]
        ?? 'The agent cannot accept messages right now.';
      throw new ToolingError('API_ERROR', `${message} No message was sent. Try again when it is available.`);
    }
    const retry = interaction.retry_after_ms;
    if (typeof retry !== 'number' || !Number.isFinite(retry) || retry < 0) {
      throw new ToolingError('API_ERROR', 'The platform did not provide a valid readiness retry interval. No message was sent.');
    }
    const wakeDeadline = access.runtime_presence?.wake?.deadline_at;
    if (typeof wakeDeadline === 'string' && Number.isFinite(Date.parse(wakeDeadline))) {
      deadline = Math.min(deadline, performance.now() + Math.max(0, Date.parse(wakeDeadline) + 30000 - Date.now()));
    }
    progress(interaction.state === 'updating' ? 'Agent update in progress…'
      : interaction.state === 'checking' ? 'Checking agent…' : 'Starting agent…');
    const delay = Math.max(100, retry), remaining = deadline - performance.now();
    if (remaining <= 0) throw timedOut();
    await new Promise<void>((resolve, reject) => {
      const finish = () => { options.signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, Math.min(delay, remaining));
      const abort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(new ToolingError('CANCELLED', 'Agent preparation cancelled. No message was sent.')); };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    if (delay >= remaining) throw timedOut();
  }
}
