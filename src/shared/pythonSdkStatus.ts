// Metadata-only status adapted from VS Code's pythonSdkStatus.ts.
// main is the stable source; analyzing development never opts projects into prereleases.
export const PYTHON_SDK_PROJECT_URL = 'https://raw.githubusercontent.com/mainsequence-sdk/mainsequence-sdk/main/pyproject.toml';
export async function readPythonSdkStatus(installed: string | null, fetchProject: typeof fetch = fetch, signal?: AbortSignal) {
  const base = { package: 'mainsequence', installed, dependencyPolicy: 'project-declared', releaseChannel: 'project-declared', sourceUrl: PYTHON_SDK_PROJECT_URL };
  try {
    const response = await fetchProject(PYTHON_SDK_PROJECT_URL, { headers: { Accept: 'text/plain' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('unavailable');
    const text = await response.text();
    const project = text.split(/^\s*\[project\]\s*(?:#.*)?$/m)[1]?.split(/^\s*\[/m)[0];
    const version = project?.match(/^\s*version\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
    if (!version) throw new Error('invalid source');
    return { ...base, latestSourceVersion: version, registryPublicationVerified: false,
      hint: 'This compares installed metadata with the stable source tree. SDK updates preserve the project dependency policy; no prerelease channel is selected.' };
  } catch {
    signal?.throwIfAborted();
    return { ...base, sourceStatus: 'unavailable', hint: 'Installed metadata is available; the stable source version could not be read.' };
  }
}
