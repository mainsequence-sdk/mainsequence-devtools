import * as fs from 'fs';
import * as path from 'path';

export const PYTHON_SDK_PROJECT_URL = 'https://raw.githubusercontent.com/mainsequence-sdk/mainsequence-sdk/main/pyproject.toml';
export type CaptureProcess = (executable: string, args: string[], cwd: string) => Promise<string>;

export function pythonExecutable(root: string): string {
  return process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
}

export function hasPythonProject(root: string): boolean {
  return fs.existsSync(path.join(root, 'pyproject.toml')) && !fs.existsSync(path.join(root, 'package.json'));
}

export function projectVersion(content: string): string {
  let inProject = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inProject = /^\s*\[project\]\s*(?:#.*)?$/.test(line);
    if (!inProject) continue;
    const match = line.match(/^\s*version\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/);
    if (match) return match[1];
  }
  throw new Error('The public SDK pyproject.toml has no project version.');
}

async function publicProject(): Promise<string> {
  const response = await fetch(PYTHON_SDK_PROJECT_URL, { headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('The public SDK version could not be read.');
  return response.text();
}

export async function readPythonSdkStatus(root: string, capture: CaptureProcess, fetchProject = publicProject) {
  const latest = projectVersion(await fetchProject());
  // Import distribution metadata only: do not import the SDK or its auth bootstrap.
  const code = [
    'import importlib.metadata as metadata, json, sys',
    'from packaging.version import Version',
    'try:',
    "    local = metadata.version('mainsequence')",
    'except metadata.PackageNotFoundError:',
    '    local = None',
    'latest = sys.argv[1]',
    "status = 'not_installed' if local is None else ('update_available' if Version(local) < Version(latest) else ('ahead' if Version(local) > Version(latest) else 'current'))",
    "print(json.dumps(dict(latest=latest, installed=local, status=status, updateAvailable=status == 'update_available', updateSupported=False)))"
  ].join('\n');
  return { registryPublicationVerified: false, latestSourceVersion: latest, ...JSON.parse(await capture(pythonExecutable(root), ['-I', '-c', code, latest], root)) };
}
