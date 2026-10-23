import { ToolingError } from './models';

/** Only consult the working directory for actions that actually need a project. */
export function currentDirectory(): string {
  try { return process.cwd(); }
  catch {
    throw new ToolingError('CURRENT_DIRECTORY_UNAVAILABLE', 'The working directory is no longer available. Change to an existing directory or reload the plugin host; for MCP actions, pass an explicit backend.');
  }
}
