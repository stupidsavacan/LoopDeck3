import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DeviceCliError } from './errors.js';

/**
 * Exclusive per-session host lock. It serializes ldev invocations that share one
 * session directory on this machine. It is NOT device arbitration: another user,
 * session directory, or tool can still talk to the same phone. A held lock is
 * never stolen; a lock left by a killed process must be deleted by the operator.
 */
export interface HostLock {
  readonly path: string;
  release(): void;
}

export function acquireLock(path: string, command: string, now: () => Date = () => new Date()): HostLock {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(12).toString('hex');
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let holder = 'unknown holder';
    try {
      const info = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; command?: string; startedAt?: string };
      holder = `pid ${info.pid} running "${info.command}" since ${info.startedAt}`;
    } catch {
      // unreadable lock file: still refuse
    }
    throw new DeviceCliError(
      'LOCK',
      `Session is locked by another ldev invocation (${holder}). Locks are never stolen; delete ${path} only if that process is gone.`
    );
  }
  try {
    try {
      writeSync(fd, JSON.stringify({ token, pid: process.pid, command, startedAt: now().toISOString() }));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // Creation succeeded, but no caller received a releasable lock. Remove our
    // incomplete file after closing it (Windows cannot unlink an open file).
    try {
      unlinkSync(path);
    } catch {
      /* preserve the original I/O failure */
    }
    throw error;
  }
  const lock: HostLock = {
    path,
    release() {
      try {
        const info = JSON.parse(readFileSync(path, 'utf8')) as { token?: string };
        if (info.token === token) unlinkSync(path);
      } catch {
        // already gone or not ours; never remove a lock we cannot prove is ours
      }
    }
  };
  return lock;
}
