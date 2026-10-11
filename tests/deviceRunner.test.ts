import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeviceCliError } from '../tools/device/errors';
import { prepareSession } from '../tools/device/lifecycle';
import { runScenario } from '../tools/device/runner';
import { sessionPaths } from '../tools/device/session';
import { FakeAdb, FakeCdp, fakeDeps, tempDir, type FakePageSpec } from './helpers/deviceFakes';

interface PageState {
  diag: { ok: boolean; entries: { id: string; level: string; code: string | null; area: string }[] };
  errorScreen: boolean;
}

function setup(scenario?: unknown) {
  const dir = tempDir();
  const adb = new FakeAdb();
  const cdp = new FakeCdp();
  const deps = fakeDeps(adb, cdp, dir);
  const state: PageState = { diag: { ok: true, entries: [] }, errorScreen: false };
  const spec: FakePageSpec = {
    url: 'https://appassets.androidplatform.net/assets/loopdeck/index.html#home',
    countVisible: () => 1,
    locate: () => ({ total: 1, visible: 1 }),
    evaluate: (_arg, fn) => {
      switch (fn.name) {
        case 'readDiagnostics':
          return state.diag;
        case 'errorScreenPresent':
          return state.errorScreen;
        case 'domProbe':
          return { mode: 'snapshot', items: [], truncated: false, viewport: {}, href: '' };
        case 'captureStateInPage':
          return { ok: true, complete: true, version: 1, stores: [], reasons: [] };
        default:
          return undefined;
      }
    }
  };
  cdp.pages = [spec];
  let scenarioPath = resolve('qa/scenarios/launch-home.json');
  if (scenario !== undefined) {
    scenarioPath = join(dir, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(scenario));
  }
  const outDir = join(dir, 'out');
  const run = () => runScenario(deps, { serial: 'T1', scenarioPath, outDir });
  return { dir, adb, cdp, deps, state, spec, run, outDir };
}

const visibleCheck = { check: 'expectVisible', target: { css: '.home-screen' } };
const read = (path: string) => readFileSync(path, 'utf8');

describe('runScenario', () => {
  it('runs the sample scenario to PASS with every step journaled', async () => {
    const { run } = setup();
    const { runDir, summary } = await run();
    expect(summary.final).toBe('PASS');
    expect(JSON.parse(read(join(runDir, 'summary.json'))).final).toBe('PASS');
    const events = read(join(runDir, 'events.ndjson'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const id of ['s0', 's1', 's2', 's3']) {
      expect(events.some((e) => e.src === 'step' && e.type === 'start' && e.stepId === id)).toBe(true);
      expect(events.some((e) => e.src === 'step' && e.type === 'end' && e.stepId === id)).toBe(true);
    }
    expect(existsSync(join(runDir, 'failure'))).toBe(false);
    expect(existsSync(join(runDir, 'scenario.json'))).toBe(true);
  });

  it('FAILs on a pageerror during a step and captures failure evidence', async () => {
    const { run, spec, cdp } = setup(scenarioOf0([{ do: 'launch' }, visibleCheck]));
    spec.countVisible = () => {
      cdp.emit({ type: 'pageerror', message: 'boom' });
      return 1;
    };
    const { runDir, summary } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies).toEqual([{ kind: 'jsException', allowed: false, count: 1 }]);
    for (const file of ['screenshot.png', 'dom.json', 'state.json', 'diagnostics.json', 'logcat.txt', 'capture.json'])
      expect(existsSync(join(runDir, 'failure', file)), file).toBe(true);
  });

  it('keeps PASS for a console.error allowed by the scenario', async () => {
    const { run, spec, cdp } = setup(
      scenarioOf0([{ do: 'launch' }, visibleCheck], { allowConsoleErrors: [{ pattern: 'known noise', reason: 'third-party' }] })
    );
    spec.countVisible = () => {
      cdp.emit({ type: 'console', level: 'error', text: 'some known noise here' });
      return 1;
    };
    const { summary } = await run();
    expect(summary.final).toBe('PASS');
    expect(summary.anomalies).toEqual([{ kind: 'consoleError', allowed: true, count: 1 }]);
  });

  it('FAILs on a new error-level diagnostics entry', async () => {
    const { run, spec, state } = setup(scenarioOf0([{ do: 'launch' }, visibleCheck]));
    spec.countVisible = () => {
      state.diag = { ok: true, entries: [{ id: 'd1', level: 'error', code: 'E_X', area: 'db' }] };
      return 1;
    };
    const { summary } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies[0]).toMatchObject({ kind: 'diagError', count: 1 });
  });

  it('ignores diagnostics errors that already existed at launch', async () => {
    const { run, state } = setup(scenarioOf0([{ do: 'launch' }, visibleCheck]));
    state.diag = { ok: true, entries: [{ id: 'old', level: 'error', code: null, area: 'db' }] };
    expect((await run()).summary.final).toBe('PASS');
  });

  it('FAILs when the error screen is present', async () => {
    const { run, state } = setup();
    state.errorScreen = true;
    const { summary } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.checks.find((c) => c.id === 's3')?.status).toBe('NOT_EVALUATED');
  });

  it('is ERROR when the WebView cannot be connected', async () => {
    const { run, cdp } = setup();
    cdp.connectError = new Error('refused');
    const { summary, runDir } = await run();
    expect(summary.final).toBe('ERROR');
    expect(JSON.parse(read(join(runDir, 'session', 'session.json'))).status).toBe('CLEAN');
  });

  it('is INCONCLUSIVE for a scenario with no checks', async () => {
    const { run } = setup(scenarioOf0([{ do: 'launch' }]));
    const { summary } = await run();
    expect(summary.final).toBe('INCONCLUSIVE');
    expect(summary.reasons).toContain('no check passed');
  });

  it('reconnects after lifecycle relaunch with a new pid and still passes', async () => {
    const { run, adb, cdp } = setup(scenarioOf0([{ do: 'launch' }, { do: 'lifecycle', action: 'relaunch' }, visibleCheck]));
    adb.failures.push((args) => {
      if (args.includes('force-stop')) adb.pids = [5555];
      return false;
    });
    cdp.beforeClose = () => cdp.emit({ type: 'close' }); // closing our own connection is not an interruption
    const { summary } = await run();
    expect(summary.final).toBe('PASS');
    expect(summary.channels).toEqual([
      { id: 'js', status: 'ok' },
      { id: 'diag', status: 'ok' }
    ]);
    expect(cdp.endpoints).toHaveLength(2);
    expect(adb.calls.filter((args) => args.includes('tcp:0'))).toHaveLength(2);
    expect(adb.forwards).toEqual([]);
  });

  it('is INCONCLUSIVE when the page closes outside a lifecycle step', async () => {
    const { run, spec, cdp } = setup(scenarioOf0([{ do: 'launch' }, visibleCheck]));
    spec.countVisible = () => {
      cdp.emit({ type: 'close' });
      return 1;
    };
    const { summary } = await run();
    expect(summary.final).toBe('INCONCLUSIVE');
    expect(summary.channels[0]).toEqual({ id: 'js', status: 'interrupted' });
  });

  it('opens exactly one forward, removes it, and leaves the session CLEAN', async () => {
    const { run, adb } = setup();
    const { runDir } = await run();
    expect(adb.calls.filter((args) => args.includes('tcp:0'))).toHaveLength(1);
    expect(adb.forwards).toEqual([]);
    expect(JSON.parse(read(join(runDir, 'session', 'session.json'))).status).toBe('CLEAN');
  });

  it('refuses before any adb call when the default CLI session is DIRTY', async () => {
    const { run, adb, deps, dir } = setup();
    await prepareSession(deps, sessionPaths(undefined, dir), 'T1', false);
    const before = adb.calls.length;
    await expect(run()).rejects.toMatchObject({ code: 'USAGE' });
    await expect(run()).rejects.toBeInstanceOf(DeviceCliError);
    expect(adb.calls.length).toBe(before);
  });

  it('keeps console text out of summary.json but in events.ndjson', async () => {
    const { run, spec, cdp } = setup(scenarioOf0([{ do: 'launch' }, visibleCheck]));
    spec.countVisible = () => {
      cdp.emit({ type: 'console', level: 'error', text: 'SECRET-DEVICE-TEXT' });
      return 1;
    };
    const { runDir } = await run();
    expect(read(join(runDir, 'summary.json'))).not.toContain('SECRET-DEVICE-TEXT');
    expect(read(join(runDir, 'events.ndjson'))).toContain('SECRET-DEVICE-TEXT');
  });
});

function scenarioOf0(steps: unknown[], extra: Record<string, unknown> = {}) {
  return { schema: 1, id: 't', title: 'T', steps, ...extra };
}
