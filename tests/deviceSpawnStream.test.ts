import { describe, expect, it } from 'vitest';
import { nodeSpawnStream } from '../tools/device/exec';

const node = process.execPath;

function collect() {
  const lines: [string, boolean][] = [];
  return { lines, onLine: (line: string, truncated: boolean) => void lines.push([line, truncated]) };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('nodeSpawnStream (real child process)', () => {
  it('delivers lines in arrival order across chunk boundaries and reports a clean exit', async () => {
    const { lines, onLine } = collect();
    const script =
      "process.stdout.write('ab'); setTimeout(() => process.stdout.write('c\\r\\nd\\ne'), 40); setTimeout(() => process.exit(0), 120);";
    const handle = nodeSpawnStream(node, ['-e', script], { maxLineChars: 100, onLine });
    const exit = await handle.exited;
    expect(lines.map(([line]) => line)).toEqual(['abc', 'd', 'e']);
    expect(exit).toMatchObject({ code: 0, error: null, stopped: false });
  });

  it('reports a failed start instead of throwing', async () => {
    const { onLine } = collect();
    const handle = nodeSpawnStream('ldev-definitely-not-an-executable', [], { maxLineChars: 100, onLine });
    const exit = await handle.exited;
    expect(exit.error).toContain('not found');
    expect(exit.code).toBeNull();
  });

  it('reports a nonzero exit and keeps stderr as diagnostics only', async () => {
    const { lines, onLine } = collect();
    const handle = nodeSpawnStream(node, ['-e', "console.error('device offline'); process.exit(3)"], { maxLineChars: 100, onLine });
    const exit = await handle.exited;
    expect(exit.code).toBe(3);
    expect(exit.stderr).toContain('device offline');
    expect(lines).toEqual([]);
  });

  it('stop() ends a child that would run forever and leaves no process behind', async () => {
    const { lines, onLine } = collect();
    const handle = nodeSpawnStream(node, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000);'], { maxLineChars: 100, onLine });
    while (lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    const pid = Number.parseInt(lines[0][0], 10);
    expect(alive(pid)).toBe(true);
    const exit = await handle.stop();
    expect(exit.stopped).toBe(true);
    expect(alive(pid)).toBe(false);
    await expect(handle.stop()).resolves.toBe(exit); // idempotent
  });

  it('an AbortSignal stops the child too', async () => {
    const { lines, onLine } = collect();
    const controller = new AbortController();
    const handle = nodeSpawnStream(node, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000);'], {
      maxLineChars: 100,
      onLine,
      signal: controller.signal
    });
    while (lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    const pid = Number.parseInt(lines[0][0], 10);
    controller.abort();
    const exit = await handle.exited;
    expect(exit.stopped).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it('cuts over-long lines instead of buffering them without bound', async () => {
    const { lines, onLine } = collect();
    const handle = nodeSpawnStream(node, ['-e', "process.stdout.write('x'.repeat(5000) + '\\nok\\n')"], { maxLineChars: 50, onLine });
    await handle.exited;
    expect(lines).toEqual([
      ['x'.repeat(50), true],
      ['ok', false]
    ]);
  });
});
