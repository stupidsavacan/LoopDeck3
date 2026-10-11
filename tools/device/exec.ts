import { execFile, spawn } from 'node:child_process';
import { LineSplitter } from './lineSplitter.js';
import { DeviceCliError } from './errors.js';

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  /** Exit status, or null when the process was killed (timeout). */
  code: number | null;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs: number;
  maxBytes: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** The only way this CLI starts processes: an argv vector, never a host shell. */
export type Runner = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export const nodeRunner: Runner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'buffer',
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        windowsHide: true,
        shell: false,
        env: options.env,
        cwd: options.cwd
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (failure && failure.code === 'ENOENT') return reject(new DeviceCliError('ADB', `Executable not found: ${file}`));
        if (failure && failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(new DeviceCliError('ADB', `Output of ${file} exceeded ${options.maxBytes} bytes`));
        }
        const timedOut = Boolean(failure?.killed);
        const code = failure ? (typeof failure.code === 'number' ? failure.code : null) : 0;
        resolve({ stdout, stderr: stderr.toString('utf8'), code: timedOut ? null : code, timedOut });
      }
    );
  });

// --- streaming -----------------------------------------------------------------

export interface StreamExit {
  /** Exit status; null when killed by a signal or when the process never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started (e.g. ENOENT) or the pipe failed. */
  error: string | null;
  /** True when the exit followed stop(), kill() or an abort. */
  stopped: boolean;
  /** Bounded tail of stderr; diagnostic only, never copied into summaries. */
  stderr: string;
}

export interface StreamOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Lines longer than this are cut (and reported as truncated) instead of buffered without bound. */
  maxLineChars: number;
  onLine: (line: string, truncated: boolean) => void;
  signal?: AbortSignal;
}

export interface StreamHandle {
  /** Resolves (never rejects) once the process has exited and every received line was delivered. */
  readonly exited: Promise<StreamExit>;
  /** Asks the process to end and waits until it has. Safe to call repeatedly. */
  stop(): Promise<StreamExit>;
  /** Synchronous best-effort kill, for signal handlers. */
  kill(): void;
}

/** The only way this CLI starts a long-running process: argv vector, never a host shell. */
export type StreamSpawner = (file: string, args: readonly string[], options: StreamOptions) => StreamHandle;

const STDERR_TAIL_CHARS = 4096;
const KILL_ESCALATION_MS = 2_000;

export const nodeSpawnStream: StreamSpawner = (file, args, options) => {
  const splitter = new LineSplitter(options.maxLineChars, options.onLine);
  let stopped = false;
  let stderr = '';
  let failure: string | null = null;
  let done = false;
  let escalation: NodeJS.Timeout | undefined;

  const child = spawn(file, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env,
    cwd: options.cwd
  });

  const exited = new Promise<StreamExit>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      clearTimeout(escalation);
      splitter.flush();
      resolve({ code, signal, error: failure, stopped, stderr });
    };
    child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk));
    child.stdout.on('error', (error) => void (failure ??= error.message));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => void (stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)));
    child.stderr.on('error', () => undefined);
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure ??= error.code === 'ENOENT' ? `Executable not found: ${file}` : error.message;
      finish(null, null);
    });
    // 'close' fires after the stdio pipes ended, so every byte the process wrote has been delivered.
    child.on('close', (code, signal) => finish(code, signal));
  });

  const kill = (): void => {
    stopped = true;
    if (done || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    escalation ??= setTimeout(() => child.kill('SIGKILL'), KILL_ESCALATION_MS);
    escalation.unref();
  };
  if (options.signal) {
    if (options.signal.aborted) kill();
    else options.signal.addEventListener('abort', kill, { once: true });
  }
  return {
    exited,
    kill,
    stop: () => {
      kill();
      return exited;
    }
  };
};
