import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

const SUPPORTED_GIT_ORIGIN_SCHEMES = new Set(['git', 'git+ssh', 'http', 'https', 'ssh']);
const SSH_GIT_ORIGIN_SCHEMES = new Set(['git+ssh', 'ssh']);
const DEFAULT_GIT_ORIGIN_PORTS: Record<string, string> = {
  http: '80',
  https: '443',
  ssh: '22',
  'git+ssh': '22'
};
const SCP_GIT_ORIGIN_PATTERN = /^(?:[^@/\s]+@)?(?<host>[^:/\s]+):(?<path>.+)$/;

export function repositorySshKeyIdentity(repoUrl: string): { identity: string; usesSsh: boolean } {
  const candidate = String(repoUrl || '').trim().replace(/[?#].*$/, '');
  if (!candidate) throw new Error('Git origin must be non-empty.');
  if (/[\r\n]/.test(candidate)) throw new Error('Git origin must contain one non-empty line.');

  const schemeMatch = candidate.match(/^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (schemeMatch?.groups) {
    const scheme = schemeMatch.groups.scheme.toLowerCase();
    if (!SUPPORTED_GIT_ORIGIN_SCHEMES.has(scheme)) {
      throw new Error(`Unsupported Git origin scheme: ${scheme}.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`Invalid Git origin: ${repoUrl}.`);
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) throw new Error('Git origin must include a hostname.');
    const repositoryPath = cleanGitRepositoryPath(parsed.pathname);
    const port = parsed.port;
    const defaultPort = DEFAULT_GIT_ORIGIN_PORTS[scheme];
    const hostIdentity = !port || port === defaultPort ? host : `${host}:${port}`;
    return {
      identity: `${hostIdentity}/${repositoryPath}`,
      usesSsh: SSH_GIT_ORIGIN_SCHEMES.has(scheme)
    };
  }

  const scpMatch = candidate.match(SCP_GIT_ORIGIN_PATTERN);
  if (!scpMatch?.groups) {
    throw new Error('Git origin must be an SSH, Git, HTTP, or HTTPS repository URL.');
  }
  const host = scpMatch.groups.host.toLowerCase().replace(/\.$/, '');
  const repositoryPath = cleanGitRepositoryPath(scpMatch.groups.path);
  return { identity: `${host}/${repositoryPath}`, usesSsh: true };
}

export function repositorySshKeyName(repoUrl: string): string {
  const { identity } = repositorySshKeyIdentity(repoUrl);
  const repositoryName = identity.split('/').pop() || '';
  const slug = repositoryName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .toLowerCase()
    .slice(0, 48)
    .replace(/[._-]+$/g, '') || 'repository';
  const digest = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
  return `mainsequence-${slug}-${digest}`;
}

export function repositorySshKeyPaths(repoUrl: string): { keyPath: string; pubPath: string } {
  const keyPath = path.join(os.homedir(), '.ssh', repositorySshKeyName(repoUrl));
  return { keyPath, pubPath: `${keyPath}.pub` };
}

function cleanGitRepositoryPath(value: string): string {
  if (value.includes('\\')) throw new Error('Git origin repository paths must use forward slashes.');
  let repositoryPath = value.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (repositoryPath.toLowerCase().endsWith('.git')) repositoryPath = repositoryPath.slice(0, -4);
  repositoryPath = repositoryPath.replace(/\/+$/g, '');
  if (!repositoryPath) throw new Error('Git origin must include a repository path.');
  return repositoryPath;
}
