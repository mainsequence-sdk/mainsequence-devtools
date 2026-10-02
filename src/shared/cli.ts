import * as fs from 'fs';
import * as path from 'path';
import { ProjectType as CodeRepositoryType } from './models';

/**
 * `freezeEnv` is deprecated and builds no invocation: the SDKs removed `code-repository freeze-env`, and
 * `sync` now writes the locked requirements.txt. The name stays so that existing callers compile.
 */
export type CodeRepositoryCliAction = 'sdkStatus' | 'updateSdk' | 'sync' | 'skills' | 'freezeEnv';

export type CodeRepositoryCli = {
  codeRepositoryType: CodeRepositoryType;
  commandName: 'mainsequence' | 'command-center-sdk';
  packageName: 'mainsequence' | '@dev-mainsequence/command-center-sdk';
  executable: string;
  prefixArgs: string[];
  available: boolean;
  bootstrapAction: 'buildLocalVenv' | 'installDependencies';
  bootstrapLabel: string;
  missingMessage: string;
};

export type CodeRepositoryCliInvocation = {
  executable: string;
  args: string[];
  display: string;
};

export function resolveCodeRepositoryCli(codeRepositoryRoot: string, codeRepositoryType: CodeRepositoryType): CodeRepositoryCli {
  if (codeRepositoryType === 'python') {
    const executable = process.platform === 'win32'
      ? path.join(codeRepositoryRoot, '.venv', 'Scripts', 'mainsequence.exe')
      : path.join(codeRepositoryRoot, '.venv', 'bin', 'mainsequence');
    return {
      codeRepositoryType,
      commandName: 'mainsequence',
      packageName: 'mainsequence',
      executable,
      prefixArgs: [],
      available: isFile(executable),
      bootstrapAction: 'buildLocalVenv',
      bootstrapLabel: 'Build Local .venv',
      missingMessage: 'The CodeRepository-local mainsequence CLI was not found. Build the local .venv or run uv sync.'
    };
  }

  const packageRoot = path.join(codeRepositoryRoot, 'node_modules', '@dev-mainsequence', 'command-center-sdk');
  const entrypoint = path.join(packageRoot, 'cli', 'command-center-sdk.mjs');
  return {
    codeRepositoryType,
    commandName: 'command-center-sdk',
    packageName: '@dev-mainsequence/command-center-sdk',
    // The installed entry point has a Node shebang on POSIX. Windows needs the
    // system Node executable because .mjs files are not directly executable.
    executable: process.execPath,
    prefixArgs: [entrypoint],
    available: isFile(entrypoint),
    bootstrapAction: 'installDependencies',
    bootstrapLabel: 'Install Dependencies',
    missingMessage: 'The CodeRepository-local command-center-sdk CLI was not found. Run npm ci in the repository root.'
  };
}

export function buildCodeRepositoryCliInvocations(
  cli: CodeRepositoryCli,
  action: CodeRepositoryCliAction,
  /** @deprecated `commitMessage` is ignored: sync takes no commit message. */
  _options: { commitMessage?: string } = {}
): CodeRepositoryCliInvocation[] {
  if (!cli.available) return [];
  const args: string[][] = [];
  if (action === 'sdkStatus' && cli.codeRepositoryType === 'vite_react') {
    args.push(['application', 'sdk-status', '--path', '.', '--json']);
  }
  if (action === 'updateSdk') {
    args.push(cli.codeRepositoryType === 'python'
      ? ['code-repository', 'update-sdk', '--path', '.']
      : ['application', 'update-sdk', '--path', '.']);
  }
  if (action === 'sync') {
    // Python: uv lock, uv sync and the locked requirements.txt export. Node: package-lock.json and npm ci.
    // No commit message, Git command or backend request; the person commits and pushes.
    args.push(['code-repository', 'sync', '--path', '.']);
  }
  if (action === 'skills') {
    if (cli.codeRepositoryType === 'python') {
      args.push(
        ['code-repository', 'update-agent-skills', '--path', '.'],
        ['code-repository', 'update', 'AGENTS.md', '--path', '.']
      );
    } else {
      args.push(['skills', 'sync', '--path', '.']);
    }
  }
  return args.map((commandArgs) => ({
    executable: cli.executable,
    args: [...cli.prefixArgs, ...commandArgs],
    display: formatDisplayCommand(cli.commandName, commandArgs)
  }));
}

export function codeRepositoryActionPreview(
  codeRepositoryType: CodeRepositoryType,
  action: CodeRepositoryCliAction,
  /** @deprecated Ignored: sync takes no commit message. */
  _commitMessage?: string
): string[] {
  const commandName = codeRepositoryType === 'python' ? 'mainsequence' : 'command-center-sdk';
  const fakeCli: CodeRepositoryCli = {
    codeRepositoryType,
    commandName,
    packageName: codeRepositoryType === 'python' ? 'mainsequence' : '@dev-mainsequence/command-center-sdk',
    executable: commandName,
    prefixArgs: [],
    available: true,
    bootstrapAction: codeRepositoryType === 'python' ? 'buildLocalVenv' : 'installDependencies',
    bootstrapLabel: codeRepositoryType === 'python' ? 'Build Local .venv' : 'Install Dependencies',
    missingMessage: ''
  };
  return buildCodeRepositoryCliInvocations(fakeCli, action).map(item => item.display);
}

/** @deprecated Sync takes no commit message. Kept for existing callers; nothing in this package uses it. */
export function sanitizeCommitMessage(message?: string): string {
  return String(message || '').replace(/[\r\n]+/g, ' ').trim();
}

function formatDisplayCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteDisplayArgument).join(' ');
}

function quoteDisplayArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function isFile(value: string): boolean {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}
