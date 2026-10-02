import { ActionResult, HostServices, ToolingError } from '../shared/models';
import { parseArguments, tokenizeCommand } from '../shared/arguments';
import { createDevTools } from '../shared/actions';
import { codexHelp, displayCodexResult } from './codexPresentation';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createNodeHost } from '../shared/process';

/** The SDK retries unavailable backends; fail before entering that long workflow. */
export function createCodexHost(fetcher: typeof fetch = fetch): HostServices {
  return {
    ...createNodeHost(),
    async prepareProjectAction(context, action, signal) {
      if (action !== 'sync') return;
      signal?.throwIfAborted();
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, 5000);
      try {
        // No credentials, response content or redirects enter this check.
        const response = await fetcher(`${context.backend}/api/v1/`, {
          method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: controller.signal
        });
        await response.body?.cancel();
        if (response.status >= 500) throw new Error('Backend unavailable');
      } catch {
        if (signal?.aborted) throw new ToolingError('CANCELLED', 'The action was cancelled.');
        throw new ToolingError('BACKEND_UNREACHABLE', `Cannot connect to ${context.backend}. Start the backend or select a reachable backend with --backend URL.`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    }
  };
}

/** The desktop slash menu serializes the selected entry as a linked skill mention. */
function commandArguments(prompt: string): string | undefined {
  const literal = /^[ \t]*\/ms(?=\s|$)/.exec(prompt);
  if (literal) return prompt.slice(literal[0].length);
  const mention = /^[ \t]*\[\$(?:mainsequence-devtools:)?ms(?:\?[^\]\r\n]*)?\]\(([^\r\n]+?\/skills\/ms\/SKILL\.md)\)(?=\s|$)/.exec(prompt);
  if (!mention) return;
  // Only our installed skill may trigger our runner, including when other plugins
  // register an entry named ms. The path is data and is never executed.
  const ownSkill = path.resolve(__dirname, '../../skills/ms/SKILL.md');
  try {
    if (realpathSync(mention[1]) !== realpathSync(ownSkill)) return;
  } catch { return; }
  return prompt.slice(mention[0].length);
}

export type CodexHookOutput = { decision: 'block'; reason: string };

export async function handleCodexPrompt(input: unknown, dispatch: ReturnType<typeof createDevTools>['dispatch']): Promise<CodexHookOutput | undefined> {
  if (!input || typeof input !== 'object') return;
  const event = input as { hook_event_name?: string; prompt?: string; cwd?: string };
  if (event.hook_event_name && event.hook_event_name !== 'UserPromptSubmit') return;
  if (typeof event.prompt !== 'string') return;
  // The desktop composer terminates submitted text with a newline. Remove only
  // trailing layout whitespace; embedded newlines still fail command validation.
  const args = commandArguments(event.prompt.replace(/[ \t\r\n]+$/, ''));
  if (args === undefined) return;
  let result: ActionResult;
  let json = false;
  try {
    const argv = tokenizeCommand(args);
    json = argv.includes('--json');
    const parsed = parseArguments(argv, event.cwd || process.cwd());
    json = parsed.json;
    result = parsed.help
      ? { schemaVersion: 1, action: 'help', status: 'success', summary: codexHelp(argv) }
      : await dispatch(parsed.request!);
  } catch (error) {
    const message = error instanceof ToolingError ? error.message : 'The explicit developer action could not be parsed.';
    result = { schemaVersion: 1, action: 'invalid', status: 'failure', summary: message, error: { code: 'INVALID_REQUEST', message } };
  }
  // Block on successes AND failures. Never feed a handled action back as model context.
  const message = json ? JSON.stringify(result) : displayCodexResult(result);
  return { decision: 'block', reason: message };
}
