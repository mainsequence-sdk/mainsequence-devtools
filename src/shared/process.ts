import { spawn } from 'child_process';
import { HostServices, ProcessResult, ProcessSpec } from './models';

/** Never prints arguments, environment, or child output. Consumers receive private captured data. */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  if (spec.signal?.aborted) return Promise.resolve({ exitCode: null, stdout: '', stderr: '', cancelled: true });
  return new Promise(resolve => {
    let stdout = '', stderr = '', cancelled = false, timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd, env: spec.env ?? process.env,
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    });
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* exited */ }
    };
    const stop = () => {
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 1500);
    };
    const abort = () => { cancelled = true; stop(); };
    spec.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, spec.timeoutMs ?? 600_000);
    const finish = (exitCode: number | null, unavailable = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      spec.signal?.removeEventListener('abort', abort);
      resolve({ exitCode, stdout, stderr, cancelled, timedOut, unavailable });
    };
    // Bounded private buffers; stdout never goes to hooks, progress, or ordinary logs.
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-2_000_000); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2_000_000); });
    child.once('error', () => finish(null, true));
    child.once('close', code => finish(code));
  });
}

export function createNodeHost(progress?: (message: string) => void): HostServices {
  return {
    runProcess, progress,
    async openBrowser(url) {
      const program = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
      const result = await runProcess({ executable: program, args, cwd: process.cwd(), timeoutMs: 15_000 });
      return result.exitCode === 0;
    }
  };
}
