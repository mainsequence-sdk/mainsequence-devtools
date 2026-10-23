import * as os from 'node:os';
import * as path from 'node:path';

/** The one place that knows where shared MainSequence CLI state lives: the SDKs' configuration,
 * the saved MCP connections and the project tool catalog (ADR 0004). */
export function mainSequenceStateDirectory(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'MainSequenceCLI')
    : process.platform === 'win32' ? path.join(env.APPDATA || home, 'MainSequenceCLI') : path.join(home, '.config', 'mainsequence');
}
