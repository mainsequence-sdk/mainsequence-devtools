import { ActionRequest, ActionResult, ToolingError } from '../shared/models';
import { parseArguments, tokenizeCommand } from '../shared/arguments';
import { openCodeHelp } from './opencodePresentation';

/** stdin is private IPC, not a shell or agent prompt. Only MCP requests accept structured arguments. */
export async function executeOpenCodeInput(input: unknown, dispatch: (request: ActionRequest) => Promise<ActionResult>, cwd: string): Promise<ActionResult> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolingError('INVALID_REQUEST', 'Invalid action input.');
    const value = input as any;
    if (Object.keys(value).length !== 1) throw new ToolingError('INVALID_REQUEST', 'Choose a command or an MCP request.');
    if (typeof value.command === 'string') {
      const command = value.command.replace(/^\/ms(?:\s+|$)/, '');
      const argv = tokenizeCommand(command);
      const parsed = parseArguments(argv, cwd);
      if (parsed.help) return { schemaVersion: 1, action: 'help', status: 'success', summary: openCodeHelp(argv) };
      return await dispatch(parsed.request!);
    }
    if (!value.request || typeof value.request.action !== 'string' || !value.request.action.startsWith('mcp-')) throw new ToolingError('INVALID_REQUEST', 'Invalid MCP action input.');
    return await dispatch(value.request);
  } catch (error) {
    const failure = error instanceof ToolingError ? error : new ToolingError('INVALID_REQUEST', 'The command could not be parsed.');
    return { schemaVersion: 1, action: 'invalid', status: 'failure', summary: failure.message, error: { code: failure.code, message: failure.message } };
  }
}
