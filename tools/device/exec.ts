import { execFile } from 'node:child_process';
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
