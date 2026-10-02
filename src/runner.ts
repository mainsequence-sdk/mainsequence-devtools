#!/usr/bin/env node
import { createDevTools } from './shared/actions';
import { createNodeHost } from './shared/process';
import { ActionResult, ToolingError } from './shared/models';
import { parseArguments, HELP } from './shared/arguments';
import { createCodexHost, handleCodexPrompt } from './hosts/codex';

async function main() {
  const argv = process.argv.slice(2);
  const hook = argv.length === 1 && argv[0] === '--codex-hook';
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Finish a handled prompt before Codex's 600-second hook limit.
  const timer = hook ? setTimeout(stop, 550_000) : undefined;
  const tooling = createDevTools({ host: hook ? createCodexHost() : createNodeHost(argv.includes('--json') ? undefined : message => process.stderr.write(message + '\n')), signal: controller.signal });
  try {
    if (hook) {
      let stdin = '';
      for await (const chunk of process.stdin) {
        stdin += chunk;
        if (stdin.length > 1_000_000) throw new ToolingError('INVALID_REQUEST', 'Hook input is too large.');
      }
      let input: unknown;
      try { input = JSON.parse(stdin); } catch { return; }
      const output = await handleCodexPrompt(input, tooling.dispatch);
      if (output) process.stdout.write(JSON.stringify(output) + '\n');
      return;
    }
    let result: ActionResult;
    try {
      const parsed = parseArguments(argv);
      if (parsed.help) { process.stdout.write(HELP); return; }
      result = await tooling.dispatch(parsed.request!);
    } catch (error) {
      const message = error instanceof ToolingError ? error.message : 'The command could not be parsed.';
      result = { schemaVersion: 1, action: 'invalid', status: 'failure', summary: message, error: { code: 'INVALID_REQUEST', message } };
    }
    process.stdout.write(argv.includes('--json') ? JSON.stringify(result) + '\n' : result.summary + '\n' + (result.data === undefined ? '' : JSON.stringify(result.data, null, 2) + '\n'));
    process.exitCode = result.status === 'success' ? 0 : result.status === 'cancelled' ? 130 : 1;
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
void main().catch(() => {
  // A handled-hook failure must block, never pass through to model inference.
  if (process.argv.includes('--codex-hook')) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Developer action runner failed.' }) + '\n');
  else { process.stderr.write('Developer action runner failed.\n'); process.exitCode = 1; }
});
