import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { ActionResult, HostServices, ToolingError } from './models';
import { git, safeSlug } from './repositories';
import { withProjectLock } from './projects';
import { updateDevcontainerJsonc } from './devcontainerJsonc';

type LocalSelection = { root: string; baseDir: string; organization: string };
export type ProjectOperationRequest =
  | { action: 'local-repositories'; baseDir: string; organization: string; repositories?: { uid: string; name?: string }[] }
  | ({ action: 'delete-local-preview' } & LocalSelection)
  | ({ action: 'delete-local'; confirmation: string } & LocalSelection)
  | { action: 'docker-preview' | 'docker-build'; root: string; image?: string; platform?: string }
  | { action: 'devcontainer-preview'; root: string; image: string }
  | { action: 'devcontainer-write'; root: string; image: string; expectedDigest: string }
;

export const PROJECT_OPERATION_ACTIONS = new Set([
  'local-repositories', 'delete-local-preview', 'delete-local',
  'docker-preview', 'docker-build', 'devcontainer-preview', 'devcontainer-write'
]);
export type ProjectOperationOptions = {
  host: HostServices;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  sanitize?: (text: string) => string;
};

const absolute = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new ToolingError('INVALID_REQUEST', `${label} must be an absolute local path.`);
  return path.resolve(value);
};
const digest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export function validateDockerImage(value: unknown): string {
  // Build tags accept a repository and optional tag, never shell text or immutable digests.
  if (typeof value !== 'string' || value.length > 255 || !/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/.test(value)) {
    throw new ToolingError('INVALID_REQUEST', 'Use a valid Docker repository and optional tag, for example mainsequence-app:latest.');
  }
  return value;
}
export function validateDockerPlatform(value: unknown): string {
  if (value === undefined) return 'linux/amd64';
  if (typeof value !== 'string' || !/^linux\/(?:amd64|arm64(?:\/v8)?|arm\/v[5-8]|386|ppc64le|s390x|riscv64)$/.test(value)) {
    throw new ToolingError('INVALID_REQUEST', 'Select one supported Linux Docker platform, such as linux/amd64 or linux/arm64.');
  }
  return value;
}

export function createProjectOperations(options: ProjectOperationOptions) {
  const { host, signal } = options;
  async function realDirectory(input: unknown, label = 'Project root') {
    const requested = absolute(input, label);
    try {
      const root = await fs.realpath(requested);
      if (!(await fs.stat(root)).isDirectory()) throw new Error('not a directory');
      return root;
    } catch { throw new ToolingError('PROJECT_NOT_FOUND', `${label} does not name an accessible directory.`); }
  }
  async function repository(root: string) {
    const realRoot = await realDirectory(root);
    const top = await fs.realpath(await git(host, realRoot, ['rev-parse', '--show-toplevel'], signal));
    if (top !== realRoot) throw new ToolingError('INVALID_GIT_CONTEXT', 'Select the repository root rather than a nested directory.');
    const common = await git(host, realRoot, ['rev-parse', '--git-common-dir'], signal);
    return { root: realRoot, commonDir: await fs.realpath(path.resolve(realRoot, common)) };
  }
  function organization(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new ToolingError('INVALID_REQUEST', 'Select the repository organization.');
    return safeSlug(value);
  }
  async function localContext(request: LocalSelection) {
    const base = await realDirectory(request.baseDir, 'Repositories base folder');
    const org = organization(request.organization);
    const parent = path.join(base, org, 'projects');
    const requested = absolute(request.root, 'Local repository');
    const item = await fs.lstat(requested).catch(() => { throw new ToolingError('PROJECT_NOT_FOUND', 'The local repository was not found.'); });
    if (!item.isDirectory() || item.isSymbolicLink()) throw new ToolingError('INVALID_REQUEST', 'Only a real local repository directory can be deleted.');
    const real = await fs.realpath(requested);
    if (path.dirname(real) !== parent || await fs.realpath(parent) !== parent) throw new ToolingError('INVALID_REQUEST', 'The repository must be a direct child of the selected organization projects folder, with no redirected parent.');
    const marker = await fs.lstat(path.join(real, '.git')).catch(() => undefined);
    if (!marker?.isDirectory() || marker.isSymbolicLink()) throw new ToolingError('UNSUPPORTED_ACTION', 'Only standalone local Git repositories can be deleted here. Linked worktrees and submodules must be removed through their owning Git workspace.');
    const context = await repository(real);
    if (context.commonDir !== path.join(real, '.git')) throw new ToolingError('INVALID_GIT_CONTEXT', 'The repository Git data is outside the selected local copy.');
    const status = await git(host, real, ['status', '--porcelain=v1', '--untracked-files=all'], signal);
    const head = await git(host, real, ['rev-parse', '--verify', 'HEAD'], signal);
    return { ...context, confirmation: digest({ root: real, base, org, dev: item.dev, ino: item.ino, birthtime: item.birthtimeMs, head, status }),
      warning: 'Permanently deletes this local repository, including uncommitted and untracked files. The repository on the platform is retained.', hasLocalChanges: Boolean(status) };
  }
  async function dockerPlan(request: { root: string; image?: string; platform?: string }) {
    const context = await repository(request.root);
    const file = path.join(context.root, 'Dockerfile');
    const fileInfo = await fs.lstat(file).catch(() => undefined);
    if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) throw new ToolingError('MISSING_PREREQUISITE', 'A regular Dockerfile is required in the repository root.');
    const image = validateDockerImage(request.image ?? `${safeSlug(path.basename(context.root))}-img:latest`);
    const platform = validateDockerPlatform(request.platform);
    return { ...context, image, platform, executable: 'docker', args: ['buildx', 'build', '--platform', platform, '--load', '-t', image, '-f', 'Dockerfile', '.'] };
  }
  async function devcontainerPlan(request: { root: string; image: string }) {
    const context = await repository(request.root);
    const image = validateDockerImage(request.image);
    const directory = path.join(context.root, '.devcontainer');
    const directoryInfo = await fs.lstat(directory).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())) throw new ToolingError('INVALID_REQUEST', 'The .devcontainer path must be a real directory inside the repository.');
    const target = path.join(directory, 'devcontainer.json');
    const info = await fs.lstat(target).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000)) throw new ToolingError('INVALID_REQUEST', 'The devcontainer configuration must be a regular JSONC file under 2 MB.');
    const before = info ? await fs.readFile(target, 'utf8') : '';
    const after = updateDevcontainerJsonc(before, image);
    return { ...context, path: target, before, after, expectedDigest: digest({ root: context.root, image, exists: Boolean(info), before }), changed: before !== after };
  }
  async function dispatch(request: ProjectOperationRequest): Promise<ActionResult> {
    const action = request?.action || 'unknown';
    let mutationStarted = false;
    try {
      if (!PROJECT_OPERATION_ACTIONS.has(action)) throw new ToolingError('INVALID_REQUEST', 'Unknown project operation.');
      signal?.throwIfAborted();
      let data: unknown;
      if (request.action === 'local-repositories') {
        const requestedBase = absolute(request.baseDir, 'Repositories base folder');
        const baseExists = await fs.stat(requestedBase).then(() => true).catch(error => { if (isMissing(error)) return false; throw error; });
        const base = baseExists ? await realDirectory(requestedBase, 'Repositories base folder') : requestedBase;
        const org = organization(request.organization), organizationRoot = path.join(base, org, 'projects');
        if (request.repositories !== undefined && (!Array.isArray(request.repositories) || request.repositories.some(item => !item || typeof item.uid !== 'string' || !/^[A-Za-z0-9._-]+$/.test(item.uid)))) {
          throw new ToolingError('INVALID_REQUEST', 'Local discovery repository identities must be a list of valid UIDs.');
        }
        const parentInfo = await fs.lstat(organizationRoot).catch(error => { if (isMissing(error)) return undefined; throw error; });
        if (parentInfo && (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await fs.realpath(organizationRoot) !== organizationRoot)) throw new ToolingError('INVALID_REQUEST', 'The organization projects folder is redirected outside its canonical location.');
        const entries = await fs.readdir(organizationRoot, { withFileTypes: true }).catch(error => { if (isMissing(error)) return []; throw error; });
        const items = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
          const root = path.join(organizationRoot, entry.name);
          const match = request.repositories?.filter(item => entry.name.endsWith(`-${item.uid}`)).sort((a, b) => b.uid.length - a.uid.length)[0];
          items.push({ name: match?.name ?? entry.name, path: root, ...(match ? { repositoryUid: match.uid } : {}), isGitRepository: await fs.lstat(path.join(root, '.git')).then(() => true).catch(() => false) });
        }
        data = { baseDir: base, organization: org, organizationRoot, items };
      } else if (request.action === 'delete-local-preview' || request.action === 'delete-local') {
        const preview = await localContext(request);
        if (request.action === 'delete-local-preview') data = preview;
        else {
          if (typeof request.confirmation !== 'string' || request.confirmation !== preview.confirmation) throw new ToolingError('INVALID_REQUEST', 'The local repository changed or deletion was not previewed. Review a fresh deletion preview.');
          let deleted = false;
          try {
            await withProjectLock(preview.commonDir, async () => {
              const current = await localContext(request);
              if (current.confirmation !== request.confirmation) throw new ToolingError('INVALID_REQUEST', 'The local repository changed after preview. Review it again before deleting.');
              signal?.throwIfAborted(); mutationStarted = true;
              await fs.rm(current.root, { recursive: true, force: false }); deleted = true;
            });
          } catch (error) {
            // This action intentionally removes .git and its shared lock together.
            if (!deleted || !isMissing(error) || await fs.lstat(preview.root).then(() => true).catch(() => false)) throw error;
          }
          data = { root: preview.root, deleted: true, remoteRepositoryRetained: true };
        }
      } else if (request.action === 'docker-preview' || request.action === 'docker-build') {
        const plan = await dockerPlan(request);
        if (request.action === 'docker-build') {
          await withProjectLock(plan.commonDir, async () => {
            const current = await dockerPlan(request);
            if (current.root !== plan.root || current.commonDir !== plan.commonDir) throw new ToolingError('INVALID_GIT_CONTEXT', 'The selected repository changed before Docker execution.');
            signal?.throwIfAborted(); mutationStarted = true;
            host.progress?.(`Building ${plan.image} for ${plan.platform}.`);
            const result = await host.runProcess({ executable: plan.executable, args: plan.args, cwd: plan.root, env: options.env, signal, timeoutMs: 1_800_000 });
            if (result.cancelled || signal?.aborted) throw new ToolingError('CANCELLED', 'Docker build was cancelled. Partial build cache may remain.');
            if (result.timedOut) throw new ToolingError('PROCESS_TIMEOUT', 'Docker build timed out. Partial build cache may remain.');
            if (result.unavailable) throw new ToolingError('MISSING_PREREQUISITE', 'Docker could not be started. Install and start Docker before building.');
            if (result.exitCode !== 0) throw new ToolingError('PROCESS_FAILED', `Docker build failed (exit ${result.exitCode ?? 'unknown'}). No container was started.`);
            host.progress?.('Docker image build completed.');
          });
        }
        const { commonDir: _commonDir, ...publicPlan } = plan;
        data = { ...publicPlan, built: request.action === 'docker-build' };
      } else if (request.action === 'devcontainer-preview' || request.action === 'devcontainer-write') {
        const plan = await devcontainerPlan(request);
        if (request.action === 'devcontainer-preview') {
          const { commonDir: _commonDir, ...publicPlan } = plan; data = publicPlan;
        } else {
          if (request.expectedDigest !== plan.expectedDigest) throw new ToolingError('INVALID_REQUEST', 'The devcontainer configuration changed or was not previewed. Review a fresh preview before saving.');
          await withProjectLock(plan.commonDir, async () => {
            const current = await devcontainerPlan(request);
            if (current.expectedDigest !== request.expectedDigest) throw new ToolingError('INVALID_REQUEST', 'The devcontainer configuration changed after preview. No file was changed.');
            if (!current.changed) return;
            signal?.throwIfAborted(); mutationStarted = true;
            await fs.mkdir(path.dirname(current.path), { recursive: true });
            const temporary = `${current.path}.${crypto.randomUUID()}.tmp`;
            try {
              await fs.writeFile(temporary, current.after, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
              signal?.throwIfAborted();
              await fs.rename(temporary, current.path);
            } finally { await fs.unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
          });
          data = { path: plan.path, changed: plan.changed };
        }
      }
      return sanitized({ schemaVersion: 1, action, status: 'success', summary: `${action} completed.`, data });
    } catch (error) {
      const failure = signal?.aborted ? new ToolingError('CANCELLED', 'The project operation was cancelled.') : error instanceof ToolingError ? error : new ToolingError('INTERNAL_ERROR', 'The project operation could not complete. Check the selected paths and local tool permissions.');
      return sanitized({ schemaVersion: 1, action, status: failure.code === 'CANCELLED' ? 'cancelled' : 'failure', summary: failure.message, error: { code: failure.code, message: failure.message, ...(failure.reason ? { reason: failure.reason } : {}) },
        ...(mutationStarted ? { effects: { state: 'partial-or-uncertain' as const, message: 'Local files or Docker state may have changed. Inspect the project before retrying.' } } : {}) });
    }
  }
  function sanitized(result: ActionResult): ActionResult {
    const walk = (value: unknown): unknown => typeof value === 'string' ? options.sanitize?.(value) ?? value : Array.isArray(value) ? value.map(walk) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)])) : value;
    return walk(result) as ActionResult;
  }
  return { dispatch };
}
