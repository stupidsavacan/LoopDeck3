import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { runCli } from '../tools/device/cli';
import type { CaptureResult } from '../tools/device/state';
import { FakeAdb, FakeCdp, fakeDeps, tempDir } from './helpers/deviceFakes';

function harness() {
  const dir = tempDir();
  const adb = new FakeAdb();
  const cdp = new FakeCdp();
  const deps = fakeDeps(adb, cdp, dir);
  const session = join(dir, 'session');
  const run = async (...args: string[]) => {
    const result = await runCli(args, deps);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1); // exactly one JSON envelope on stdout
    return {
      ...result,
      json: JSON.parse(lines[0]) as {
        ok: boolean;
        exitCode: number;
        command: string;
        data?: Record<string, any>;
        error?: { code: string; message: string; details?: any };
      }
    };
  };
  return { dir, adb, cdp, deps, session, run };
}

const capture = (count: number, sha = 'ab'.repeat(32), complete = true): CaptureResult => ({
  ok: true,
  complete,
  version: 1,
  stores: [{ name: 'packs', count, sha256: sha, keyPath: 'id', autoIncrement: false, indexes: [], complete }],
  reasons: complete ? [] : ['bounds reached in store packs']
});

const snapshot = {
  mode: 'snapshot',
  items: [{ role: 'button', name: 'OK', tag: 'button', visible: true, rect: { x: 0, y: 0, w: 1, h: 1 } }],
  truncated: false,
  viewport: {},
  href: ''
};

describe('strict argument handling', () => {
  const refusals: [string, string[]][] = [
    ['unknown command', ['wipe']],
    ['unknown option', ['inspect', '--bogus']],
    ['unknown option for a no-option command', ['devices', '--serial', 'T1']],
    ['option valid elsewhere', ['finish', '--dom']],
    ['missing serial', ['prepare']],
    ['unsafe serial', ['prepare', '--serial', 'T1;reboot']],
    ['name without role', ['tap', '--name', 'OK']],
    ['role and css together', ['tap', '--role', 'button', '--name', 'OK', '--locator', '.x']],
    ['disallowed key', ['key', 'HOME']],
    ['power key', ['key', 'POWER']],
    ['bad rotation', ['rotate', 'sideways']],
    ['bad lifecycle action', ['lifecycle', 'uninstall']],
    ['bad swipe direction', ['swipe', '--locator', '.x', '--direction', 'diagonal']],
    ['non-numeric distance', ['swipe', '--locator', '.x', '--direction', 'up', '--distance', '12px']],
    ['expect without target', ['expect']],
    ['expect with both targets', ['expect', '--text', 'a', '--locator', '.b']],
    ['picker inspect with a target', ['picker', 'inspect', '--text', 'x']],
    ['picker select without target', ['picker', 'select']],
    ['extra positional', ['state', 'extra']],
    ['raw shell passthrough', ['shell', 'rm', '-rf', '/']]
  ];

  it.each(refusals)('refuses %s before any process starts or file is created', async (_label, args) => {
    const { adb, dir, run } = harness();
    const result = await run(...args);
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ ok: false, exitCode: 2, error: { code: 'USAGE' } });
    expect(adb.spawns).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses device commands without a session, creating nothing', async () => {
    const { adb, dir, session, run } = harness();
    const result = await run('inspect', '--session', session);
    expect(result.json.error?.code).toBe('SESSION');
    expect(result.exitCode).toBe(3);
    expect(adb.spawns).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('prints help as one JSON envelope', async () => {
    const { run } = harness();
    const result = await run('help');
    expect(result.json.ok).toBe(true);
    expect(Object.keys(result.json.data!.commands)).toEqual(
      expect.arrayContaining([
        'prepare',
        'attach',
        'inspect',
        'state',
        'tap',
        'swipe',
        'picker',
        'key',
        'lifecycle',
        'rotate',
        'expect',
        'collect',
        'compare',
        'artifacts',
        'finish',
        'devices',
        'install',
        'reset',
        'setting',
        'shell'
      ])
    );
    // Still no host-level escape hatches: only the typed commands above reach the device.
    expect(Object.keys(result.json.data!.commands)).not.toContain('adb');
  });
});

describe('session commands end to end (fake adb/CDP)', () => {
  it('prepares, refuses a second session, and finishes CLEAN, releasing the lock each time', async () => {
    const { adb, session, run } = harness();
    const prepared = await run('prepare', '--serial', 'T1', '--session', session);
    expect(prepared.exitCode).toBe(0);
    expect(prepared.json.data).toMatchObject({ status: 'DIRTY', package: 'com.loopdeck3.app.debug' });
    expect(existsSync(join(session, 'session.lock'))).toBe(false);
    expect((await run('prepare', '--serial', 'T1', '--session', session)).json.error?.code).toBe('SESSION');
    const finished = await run('finish', '--session', session);
    expect(finished.exitCode).toBe(0);
    expect(finished.json.data).toMatchObject({ status: 'CLEAN' });
    expect((await run('inspect', '--ui', '--session', session)).json.error?.code).toBe('SESSION'); // finished sessions are inert
    expect(adb.mutations()).toEqual([]);
  });

  it('refuses a held lock instead of stealing it', async () => {
    const { session, run } = harness();
    await run('prepare', '--serial', 'T1', '--session', session);
    writeFileSync(join(session, 'session.lock'), JSON.stringify({ token: 'x', pid: 1, command: 'other', startedAt: 'then' }));
    const result = await run('state', '--session', session);
    expect(result.json.error?.code).toBe('LOCK');
    expect(readFileSync(join(session, 'session.lock'), 'utf8')).toContain('"token":"x"');
  });

  it('reports state as count + digest and exits 5 when the capture is incomplete', async () => {
    const { cdp, session, run } = harness();
    await run('prepare', '--serial', 'T1', '--session', session);
    cdp.pages[0].evaluate = () => capture(2);
    const ok = await run('state', '--session', session);
    expect(ok.json.data!.state).toMatchObject({ complete: true, totalCount: 2 });
    cdp.pages[0].evaluate = () => capture(2, 'cd'.repeat(32), false);
    const partial = await run('state', '--session', session);
    expect(partial.exitCode).toBe(5);
    expect(partial.json.error?.code).toBe('INCOMPLETE');
    expect(partial.json.error?.details.result.state.sha256).toBeNull();
  });

  it('exits 1 when an expectation is not met', async () => {
    const { cdp, session, run } = harness();
    await run('prepare', '--serial', 'T1', '--session', session);
    cdp.pages[0].countVisible = () => 0;
    const result = await run('expect', '--text', '3 / 8', '--timeout-ms', '500', '--session', session);
    expect(result.exitCode).toBe(1);
    expect(result.json.error?.code).toBe('CHECK_FAILED');
  });
});

describe('collect and compare', () => {
  async function prepared() {
    const h = harness();
    await h.run('prepare', '--serial', 'T1', '--session', h.session);
    h.cdp.pages[0].evaluate = (arg: any) => ('mode' in arg ? snapshot : capture(2));
    return h;
  }

  it('writes raw artifacts but a summary free of identity, device text and logs', async () => {
    const { session, run } = await prepared();
    const result = await run('collect', 'before', '--session', session);
    expect(result.exitCode).toBe(0);
    const dir = join(session, 'artifacts', 'before');
    expect(readdirSync(dir).sort()).toEqual(['dom.json', 'logcat.txt', 'screenshot.png', 'summary.json', 'ui.xml']);
    const summaryText = readFileSync(join(dir, 'summary.json'), 'utf8');
    for (const secret of ['PHYS1', '"T1"', 'hello', 'OK']) expect(summaryText).not.toContain(secret);
    const summary = JSON.parse(summaryText);
    expect(summary).toMatchObject({
      overall: 'PASS',
      state: { status: 'ok', complete: true, totalCount: 2 },
      app: { versionName: '0.3.1-debug' }
    });
    expect(summary.repo.revision).toHaveLength(40);
  });

  it('never overwrites a label', async () => {
    const { session, run } = await prepared();
    await run('collect', 'once', '--session', session);
    expect((await run('collect', 'once', '--session', session)).json.error?.code).toBe('USAGE');
    expect((await run('collect', '../escape', '--session', session)).json.error?.code).toBe('USAGE');
  });

  it('--expect-same passes for equal state and exits 1 for changed state', async () => {
    const { cdp, session, run } = await prepared();
    await run('collect', 'a', '--session', session);
    const same = await run('collect', 'b', '--compare-to', join(session, 'artifacts', 'a'), '--expect-same', '--session', session);
    expect(same.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(session, 'artifacts', 'b', 'summary.json'), 'utf8')).comparison.verdict).toBe('same');
    cdp.pages[0].evaluate = (arg: any) => ('mode' in arg ? snapshot : capture(3, 'ef'.repeat(32)));
    const different = await run(
      'collect',
      'c',
      '--compare-to',
      join(session, 'artifacts', 'a', 'summary.json'),
      '--expect-same',
      '--session',
      session
    );
    expect(different.exitCode).toBe(1);
    expect(different.json.error?.code).toBe('CHECK_FAILED');
  });

  it('marks partial evidence INCOMPLETE (exit 5) and never passes it', async () => {
    const { adb, session, run } = await prepared();
    adb.failures.push((args) => args.includes('exec-out'));
    const result = await run('collect', 'partial', '--session', session);
    expect(result.exitCode).toBe(5);
    const summary = JSON.parse(readFileSync(join(session, 'artifacts', 'partial', 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ overall: 'INCOMPLETE', screenshot: { status: 'failed', error: 'ADB' }, state: { status: 'ok' } });
  });

  it('an incomplete baseline can never satisfy --expect-same', async () => {
    const { cdp, session, run } = await prepared();
    cdp.pages[0].evaluate = (arg: any) => ('mode' in arg ? snapshot : capture(2, 'ab'.repeat(32), false));
    await run('collect', 'bad', '--session', session);
    cdp.pages[0].evaluate = (arg: any) => ('mode' in arg ? snapshot : capture(2));
    const result = await run('collect', 'next', '--compare-to', join(session, 'artifacts', 'bad'), '--expect-same', '--session', session);
    expect(result.exitCode).toBe(5);
  });

  it('compares offline: no process, no device, nothing created', async () => {
    const { adb, dir, session, run } = await prepared();
    await run('collect', 'x', '--session', session);
    const spawnsBefore = adb.spawns.length;
    const filesBefore = JSON.stringify(readdirSync(join(session, 'artifacts', 'x')));
    const a = join(session, 'artifacts', 'x');
    const same = await run('compare', a, join(a, 'summary.json'));
    expect(same.exitCode).toBe(0);
    expect(same.json.data).toMatchObject({ verdict: 'same' });
    const other = join(dir, 'other.json');
    const doc = JSON.parse(readFileSync(join(a, 'summary.json'), 'utf8'));
    doc.state.sha256 = 'f'.repeat(64);
    writeFileSync(other, JSON.stringify(doc));
    expect((await run('compare', a, other)).exitCode).toBe(1);
    doc.state = { status: 'failed', error: 'WEBVIEW' };
    writeFileSync(other, JSON.stringify(doc));
    expect((await run('compare', a, other)).exitCode).toBe(5);
    expect((await run('compare', a, join(dir, 'missing.json'))).exitCode).toBe(2);
    expect(adb.spawns.length).toBe(spawnsBefore);
    expect(JSON.stringify(readdirSync(join(session, 'artifacts', 'x')))).toBe(filesBefore);
  });
});

describe('devices and artifacts', () => {
  it('lists transports using host discovery only', async () => {
    const { adb, run } = harness();
    const result = await run('devices');
    expect(result.json.data!.devices).toEqual([{ transport: 'T1', state: 'device', model: 'Moto' }]);
    expect(adb.calls).toEqual([['devices', '-l']]);
  });

  it('verifies that the APK embeds exactly the supplied HTML (mismatch exits 1)', async () => {
    const { dir, run } = harness();
    const html = '<!doctype html><p>build</p>';
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.html'), html);
    writeFileSync(join(dir, 'b.html'), `${html}!`);
    writeFileSync(join(dir, 'app.apk'), await new JSZip().file('assets/loopdeck/index.html', html).generateAsync({ type: 'nodebuffer' }));
    const same = await run('artifacts', '--apk', 'app.apk', '--html', 'a.html');
    expect(same.exitCode).toBe(0);
    expect(same.json.data).toMatchObject({ matches: true });
    const different = await run('artifacts', '--apk', 'app.apk', '--html', 'b.html');
    expect(different.exitCode).toBe(1);
    expect(different.json.error?.code).toBe('CHECK_FAILED');
    expect((await run('artifacts', '--apk', 'app.apk')).exitCode).toBe(2);
    expect((await run('artifacts', '--apk', 'nope.apk', '--html', 'a.html')).exitCode).toBe(2);
  });
});
