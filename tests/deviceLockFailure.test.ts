import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { acquireLock } from '../tools/device/lock';

const fault = vi.hoisted(() => ({ write: false }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeSync: (fd: number, data: string) => {
      if (fault.write) throw new Error('simulated disk full');
      return actual.writeSync(fd, data);
    }
  };
});

it('removes an incompletely written lock and permits a later invocation', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ldev-lock-failure-')), 'session.lock');
  fault.write = true;
  try {
    expect(() => acquireLock(path, 'prepare')).toThrow('simulated disk full');
  } finally {
    fault.write = false;
  }
  expect(existsSync(path)).toBe(false);
  const lock = acquireLock(path, 'prepare');
  expect(existsSync(path)).toBe(true);
  lock.release();
  expect(existsSync(path)).toBe(false);
});
