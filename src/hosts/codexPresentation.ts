import { ActionResult } from '../shared/models';

// Presentation belongs to the host; action models and SDK dispatch stay shared.
export const developerCommands: { action: string; title: string; usage: string; group: string; description?: string }[] = [
  { action: 'login', title: 'Sign in', usage: '/ms login', group: 'Account' },
  { action: 'auth-status', title: 'Check your login', usage: '/ms auth-status', group: 'Account' },
  { action: 'refresh-token', title: 'Renew your login', usage: '/ms refresh-token', group: 'Account' },
  { action: 'logout', title: 'Sign out', usage: '/ms logout', group: 'Account' },
  { action: 'repositories', title: 'List code repositories', usage: '/ms repositories', group: 'Projects' },
  { action: 'status', title: 'Project status', usage: '/ms status', group: 'Projects' },
  { action: 'sync', title: 'Refresh dependency files', usage: '/ms sync', group: 'Projects',
    description: 'Python: updates uv.lock, the project environment and requirements.txt.\nNode: updates package-lock.json, then runs npm ci.\nNothing is committed or pushed: review the changes, then commit and push them yourself.' },
  { action: 'setup', title: 'Set up a project', usage: '/ms setup --uid UID --branch BRANCH --base-dir DIR', group: 'Projects' },
  { action: 'resolve', title: 'Find the backend repository', usage: '/ms resolve', group: 'Projects' },
  { action: 'sdk-status', title: 'SDK status', usage: '/ms sdk-status', group: 'Maintenance' },
  { action: 'install', title: 'Install dependencies', usage: '/ms install', group: 'Maintenance' },
  { action: 'update-sdk', title: 'Update the SDK', usage: '/ms update-sdk', group: 'Maintenance' },
  { action: 'update-agents', title: 'Update agent instructions', usage: '/ms update-agents', group: 'Maintenance' },
  { action: 'install-skills', title: 'Install SDK skills', usage: '/ms install-skills', group: 'Maintenance' },
  { action: 'env-cleanup', title: 'Remove old project credentials', usage: '/ms env-cleanup', group: 'Maintenance' },
];
const commands = developerCommands;

export function codexHelp(argv: string[]): string {
  const command = commands.find(item => item.action === argv[0]);
  if (command) {
    const options = ['--backend URL  Choose a backend', '--json  Export a structured result'];
    if (!['login', 'logout', 'refresh-token', 'auth-status', 'repositories', 'setup'].includes(command.action)) {
      options.unshift('--path DIR  Choose a local project', '--type python|vite_react  Choose the project type');
    }
    if (command.action === 'auth-status') options.unshift('--check  Verify the session with the backend');
    if (['update-sdk', 'install-skills'].includes(command.action)) options.unshift('--dry-run  Preview the operation');
    if (command.action === 'setup') options.unshift('--install  Install dependencies after setup');
    const description = command.description ? `\n\n${command.description}` : '';
    return `MainSequence · ${command.title}\n\n${command.usage}${description}\n\nOptions\n${options.join('\n')}\n\nAll commands: /ms --help --all`;
  }
  if (argv.includes('--all')) {
    return ['MainSequence · All commands', ...['Account', 'Projects', 'Maintenance'].map(group =>
      `${group}\n` + commands.filter(item => item.group === group).map(item => `${item.usage}\n  ${item.title}`).join('\n\n')),
      'For options: /ms COMMAND --help'].join('\n\n');
  }
  const common = ['login', 'repositories', 'status', 'sync', 'refresh-token'];
  return ['MainSequence', 'Get started', ...common.map(action => {
    const command = commands.find(item => item.action === action)!;
    return `${command.title}\n${command.usage}`;
  }), 'All commands: /ms --help --all\nCommand options: /ms COMMAND --help'].join('\n\n');
}

const fieldNames: Record<string, string> = {
  root: 'Folder', projectType: 'Project type', backend: 'Backend', branch: 'Branch', commit: 'Commit', origin: 'Git remote',
  repositoryUid: 'Repository ID', uid: 'ID', code_repository_name: 'Repository', code_repository_type: 'Project type',
  repository_branch: 'Branch', code_repository_uid: 'Repository ID', is_initialized: 'Ready',
  installed: 'Installed version', latestSourceVersion: 'Latest source version', latest: 'Latest version',
  declared: 'Requested version', locked: 'Locked version', wanted: 'Wanted version', package: 'Package',
  dryRun: 'Preview only', endpointOnly: 'Credentials excluded from project files', dependenciesInstalled: 'Dependencies installed',
  updateAvailable: 'Update available', updateSupported: 'Automatic update supported', dependencyType: 'Dependency type',
  registryPublicationVerified: 'Registry publication verified', sourceStatus: 'Source version lookup', hint: 'Note',
};
const hiddenFields = new Set(['gitCommonDir', 'repositoryIdentity', 'ref', 'store', 'sourceUrl', 'dependencyPolicy', 'releaseChannel']);
const values: Record<string, string> = { python: 'Python', vite_react: 'React + Vite', available: 'Available', unavailable: 'Unavailable', unsupported: 'Unsupported', current: 'Up to date', update_available: 'Update available', not_installed: 'Not installed' };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const singleLine = (value: unknown): string => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
const title = (action: string): string => commands.find(item => item.action === action)?.title ?? 'Command';
const label = (key: string): string => fieldNames[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, first => first.toUpperCase());
function scalar(value: unknown): string {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (value == null) return 'None';
  const text = singleLine(value);
  return values[text] ?? text;
}

function fields(value: unknown, indent = ''): string[] {
  const lines: string[] = [];
  for (const [key, item] of Object.entries(record(value))) {
    if (item === undefined || hiddenFields.has(key)) continue;
    if (item !== null && typeof item === 'object') {
      if (Array.isArray(item)) {
        if (item.every(entry => entry === null || typeof entry !== 'object')) lines.push(`${indent}${label(key)}: ${item.length ? item.map(scalar).join(', ') : 'None'}`);
        else {
          lines.push(`${indent}${label(key)}`);
          for (const entry of item) lines.push(...fields(entry, indent + '  '));
        }
      } else lines.push(`${indent}${label(key)}`, ...fields(item, indent + '  '));
    } else lines.push(`${indent}${label(key)}: ${key === 'installed' && item === null ? 'Not installed' : scalar(item)}`);
  }
  return lines;
}

function account(value: unknown): string[] {
  const session = record(value);
  const username = typeof session.username === 'string' && session.username ? ` as ${singleLine(session.username)}` : '';
  const lines = [session.authenticated ? `Signed in${username}` : 'Not signed in'];
  if (session.backend) lines.push(`Backend: ${singleLine(session.backend)}`);
  if (session.source === 'machine') lines.push('Login shared with your SDKs');
  else if (session.source === 'environment') lines.push('Using the login from your environment');
  else if (session.source === 'host') lines.push('Using the editor login');
  if (session.expiresAt) lines.push(`Expires: ${singleLine(session.expiresAt)}`);
  if (session.checked) lines.push('Verified with the backend');
  return lines;
}

function repositories(data: unknown[]): string {
  if (data.length === 0) return 'No code repositories found.';
  const entries = data.map((value, index) => {
    const item = record(value);
    const branches = Array.isArray(item.branches) ? item.branches.map(branch => scalar(record(branch).repository_branch)).join(', ') : '';
    return [`${index + 1}. ${singleLine(item.code_repository_name ?? 'Unnamed repository')}`,
      `   ${scalar(item.code_repository_type)}${branches ? ` · ${branches}` : ' · No branches'}`,
      `   ID: ${singleLine(item.uid ?? 'Unavailable')}`].join('\n');
  });
  return `${data.length} code ${data.length === 1 ? 'repository' : 'repositories'}\n\n${entries.join('\n\n')}`;
}

export function displayCodexResult(result: ActionResult): string {
  if (result.action === 'help') return result.summary;
  const state = result.status === 'success' ? '' : result.status === 'cancelled' ? ' · Cancelled' : ' · Failed';
  const sections = [`MainSequence · ${title(result.action)}${state}`];
  if (result.status !== 'success') {
    sections.push(result.summary);
    const code = result.error?.code;
    if (code === 'INVALID_REQUEST') sections.push('For commands and examples: /ms --help');
    else if (code === 'NOT_AUTHENTICATED' || code === 'AUTH_REJECTED') sections.push('Sign in again: /ms login');
  } else if (result.action === 'repositories' && Array.isArray(result.data)) sections.push(repositories(result.data));
  else if (['login', 'refresh-token', 'auth-status'].includes(result.action)) sections.push(account(result.data).join('\n'));
  else if (result.action === 'status') {
    const data = record(result.data);
    sections.push(fields(data.project).join('\n'), account(data.session).join('\n'));
    if (Array.isArray(data.capabilities)) sections.push('Project actions\n' + data.capabilities.map(value => {
      const item = record(value);
      return `${title(String(item.action))}: ${scalar(item.state)}${item.reason ? ` — ${singleLine(item.reason)}` : ''}`;
    }).join('\n'));
  } else {
    const summary = result.summary === `${result.action} completed.` ? 'Completed successfully.' : result.summary;
    sections.push(summary);
    if (result.data !== undefined) sections.push(fields(result.data).join('\n'));
  }
  if (result.effects) sections.push(`Changes may be incomplete\n${result.effects.message}`);
  return sections.filter(Boolean).join('\n\n');
}
