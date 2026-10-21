#!/usr/bin/env node
import { createDevTools } from './shared/actions';
import { createNodeHost } from './shared/process';
import { ActionResult, ToolingError } from './shared/models';
import { parseArguments, HELP } from './shared/arguments';

async function main() {
  const argv = process.argv.slice(2);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const tooling = createDevTools({ host: createNodeHost(argv.includes('--json') ? undefined : message => process.stderr.write(message + '\n')), signal: controller.signal });
  try {
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
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
void main().catch(() => {
  process.stderr.write('Developer action runner failed.\n');
  process.exitCode = 1;
});
