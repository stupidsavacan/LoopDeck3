import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expectVisibleOn, swipeOn, tapOn } from './actions.js';
import { assertSerial } from './adb.js';
import { APP_PACKAGE, DEFAULT_SESSION_ROOT, TIMEOUTS, resolveLdevHome } from './constants.js';
import { DeviceCliError, withTimeout } from './errors.js';
import { withDeviceSession, type DeviceSessionApi } from './fixture.js';
import { Journal } from './journal.js';
import {
  installDebugApk,
  inspectApk,
  judgeProvenance,
  readApkFile,
  readInstalledApk,
  type InstalledApk,
  type ProvenanceStatus
} from './apk.js';
import { applySetting, parseSettingRequest } from './deviceSettings.js';
import { lifecycle, rotate } from './lifecycle.js';
import { clearAndRelaunch, leftoverError, verifyFreshState } from './reset.js';
import { LogcatSession, type LogcatSummary } from './logcat.js';
import { errorScreenPresent, navigateHash, readDiagnostics, throwInPage, type DiagnosticsRead } from './pageScripts.js';
import type { Deps } from './runtime.js';
import { parseScenario, type Scenario, type Step } from './scenario.js';
import { SessionHandle, atomicWriteFile, sessionPaths } from './session.js';
import { captureStateInPage, compareStates, defaultCaptureArg, summarizeCapture, type StateSummary } from './state.js';
import { waitFor } from './ui.js';
import { computeVerdict, type Final } from './verdict.js';
import { openWebView, probe, type OpenWebView, type PageEvent } from './webview.js';

export interface RunOptions {
  serial: string;
  scenarioPath: string;
  outDir?: string;
  /** The APK the phone is expected to have; checked, never installed. */
  apkPath?: string;
}

type ChannelStatus = 'ok' | 'unavailable' | 'interrupted';
type CheckStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

export interface RunSummary {
  schema: 1;
  runId: string;
  scenarioId: string;
  testClass: Scenario['testClass'];
  final: Final;
  reasons: string[];
  checks: { id: string; status: CheckStatus }[];
  /** Kinds and counts only: event bodies stay in events.ndjson. */
  anomalies: { kind: string; allowed: boolean; count: number }[];
  channels: (
    { id: 'js' | 'diag'; status: ChannelStatus } | ({ id: 'logcat'; status: ChannelStatus; detail: string | null } & LogcatCounts)
  )[];
  steps: { total: number; done: number };
  package: string;
  versionName: string | null;
  versionCode: string | null;
  apk: ApkSummary;
  git: { revision: string | null; dirty: boolean | null };
  startedAt: string;
  finishedAt: string;
  runDir: string;
}

/** Where the tested build came from. `provenance.status` is `unverified` when nothing told the run which APK to expect. */
export interface ApkSummary {
  applicationId: string;
  versionName: string | null;
  versionCode: string | null;
  lastUpdateTime: string | null;
  sha256: string | null;
  apkFileCount: number | null;
  webView: { package: string; version: string } | null;
  provenance: { status: ProvenanceStatus; reason: string | null; expected: { sha256: string; source: 'run --apk' | 'installApk' } | null };
}

/** Counts only; the lines themselves stay in logcat-stream.log under the run directory. */
type LogcatCounts = Pick<LogcatSummary, 'lines' | 'appLines' | 'writtenLines' | 'droppedLines' | 'pidsSeen'>;

export interface RunResult {
  runDir: string;
  summary: RunSummary;
}

interface Anomaly {
  kind: string;
  allowed: boolean;
}

const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string => (error instanceof DeviceCliError ? error.code : 'INTERNAL');

function createRunDir(parent: string, id: string, now: Date): string {
  mkdirSync(parent, { recursive: true });
  const base = join(parent, `${stamp(now)}-${id}`);
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 99) throw error;
    }
  }
}

async function gitInfo(deps: Deps): Promise<RunSummary['git']> {
  try {
    const head = await deps.runner('git', ['rev-parse', 'HEAD'], { timeoutMs: 10_000, maxBytes: 4096, cwd: deps.cwd });
    const revision = head.stdout.toString('utf8').trim();
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(revision)) return { revision: null, dirty: null };
    const status = await deps.runner('git', ['status', '--porcelain'], { timeoutMs: 10_000, maxBytes: 1024 * 1024, cwd: deps.cwd });
    return { revision, dirty: status.code !== 0 || status.stdout.length > 0 };
  } catch {
    return { revision: null, dirty: null };
  }
}

/**
 * One process, one CDP connection held for the whole run: prepare, execute the scenario while
 * observing JS errors / diagnostics / the error screen, decide PASS | FAIL | INCONCLUSIVE | ERROR,
 * capture failure evidence over the same connection, then finish. Raw evidence goes to the run
 * directory (outside the repository by default); summary.json carries kinds and counts only.
 */
export async function runScenario(deps: Deps, options: RunOptions): Promise<RunResult> {
  assertSerial(options.serial);
  let source: string;
  try {
    source = readFileSync(resolve(deps.cwd, options.scenarioPath), 'utf8');
  } catch {
    throw new DeviceCliError('USAGE', `Cannot read scenario file ${options.scenarioPath}`);
  }
  const scenario = parseScenario(source);

  // Everything about the APKs that can be known without the phone is checked before it is touched.
  const installSteps = scenario.steps.filter(
    (step): step is Extract<Step, { do: 'installApk' }> => 'do' in step && step.do === 'installApk'
  );
  for (const step of installSteps) await inspectApk(deps, step.file);
  const explicitExpected = options.apkPath === undefined ? null : readApkFile(deps, options.apkPath).file.sha256;

  // A DIRTY default CLI session holds rotation originals that this run would otherwise not see.
  const existing = SessionHandle.read(sessionPaths(undefined, deps.cwd), deps.now);
  if (existing && existing.record.status === 'DIRTY') {
    throw new DeviceCliError(
      'USAGE',
      `The default CLI session at ${DEFAULT_SESSION_ROOT} is DIRTY. Run "ldev finish" before "ldev run" so rotation originals are not mixed up.`
    );
  }

  const startedAt = deps.now();
  const parent = options.outDir ? resolve(deps.cwd, options.outDir) : join(resolveLdevHome(deps.env, process.platform, homedir()), 'runs');
  const runDir = createRunDir(parent, scenario.id, startedAt);
  writeFileSync(join(runDir, 'scenario.json'), source);
  const journal = new Journal(join(runDir, 'events.ndjson'), () => deps.clock.now());
  journal.append('runner', 'start', { scenarioId: scenario.id, testClass: scenario.testClass, serialGiven: true });

  const allow = scenario.allowConsoleErrors.map((entry) => new RegExp(entry.pattern));
  const checks = new Map<string, CheckStatus>(scenario.steps.filter((step) => 'check' in step).map((step) => [step.id, 'NOT_EVALUATED']));
  const anomalies: Anomaly[] = [];
  const channels: Record<'js' | 'diag' | 'logcat', ChannelStatus> = { js: 'ok', diag: 'ok', logcat: 'unavailable' };
  let logcatDetail: string | null = 'not started';
  let logcat: LogcatSession | null = null;
  const snapshots = new Map<string, StateSummary>();
  let stateIncompleteForCheck = false;
  let infraError: string | null = null;
  let stepsDone = 0;
  let versionName: string | null = null;
  let versionCode: string | null = null;
  let captured = false;
  let installedApk = null as InstalledApk | null;
  let lastInstalledSha: string | null = null;
  let provenanceAtStart: ProvenanceStatus = 'unverified';

  const degrade = (channel: 'js' | 'diag' | 'logcat', status: ChannelStatus, why: string, stepId?: string): void => {
    if (channels[channel] !== 'ok') return;
    channels[channel] = status;
    journal.append('runner', 'channel', { channel, status, why }, stepId);
  };

  /** Moves what the logcat stream has seen so far into the journal and the anomaly list. */
  const drainLogcat = (stepId?: string): void => {
    if (!logcat) return;
    for (const event of logcat.takeEvents()) {
      journal.append('logcat', event.type, event.data, stepId);
      if (event.anomaly) anomalies.push({ kind: event.anomaly, allowed: false });
    }
    const health = logcat.health;
    if (health.status !== 'ok') {
      channels.logcat = health.status;
      logcatDetail = health.detail;
    }
  };

  const channelList = (): RunSummary['channels'] => {
    const seen = logcat?.summary();
    return [
      { id: 'js', status: channels.js },
      { id: 'diag', status: channels.diag },
      {
        id: 'logcat',
        status: channels.logcat,
        detail: channels.logcat === 'ok' ? null : logcatDetail,
        lines: seen?.lines ?? 0,
        appLines: seen?.appLines ?? 0,
        writtenLines: seen?.writtenLines ?? 0,
        droppedLines: seen?.droppedLines ?? 0,
        pidsSeen: seen?.pidsSeen ?? 0
      }
    ];
  };

  const expectedSha = (): { sha256: string; source: 'run --apk' | 'installApk' } | null =>
    explicitExpected !== null
      ? { sha256: explicitExpected, source: 'run --apk' }
      : lastInstalledSha !== null
        ? { sha256: lastInstalledSha, source: 'installApk' }
        : null;
  function provenanceNow() {
    return judgeProvenance(installedApk, expectedSha()?.sha256 ?? null);
  }

  const evaluateVerdict = () =>
    computeVerdict({
      checks: [...checks].map(([id, status]) => ({ id, status })),
      anomalies,
      infraError,
      channels: channelList().map((channel) => ({
        id: channel.id,
        status: channel.status,
        detail: 'detail' in channel ? (channel.detail ?? undefined) : undefined
      })),
      stateIncompleteForCheck,
      provenanceProblem: provenanceNow().reason
    });

  const script = async (api: DeviceSessionApi): Promise<void> => {
    const { run } = api;
    const clock = deps.clock;
    let connection: OpenWebView | null = null;
    let unsubscribe: (() => void) | null = null;
    let baseline: Set<string> | null = null;
    let pending: PageEvent[] = [];
    let currentStep: string | undefined;

    const evaluate = <R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
      if (!connection) throw new DeviceCliError('WEBVIEW', 'No WebView connection; a "launch" step must come first');
      return withTimeout(connection.page.evaluate(fn, arg), TIMEOUTS.cdpEvaluateMs, 'page evaluation');
    };
    const page = () => {
      if (!connection) throw new DeviceCliError('WEBVIEW', 'No WebView connection; a "launch" step must come first');
      return connection.page;
    };

    const connect = async (): Promise<void> => {
      connection = await openWebView(run);
      try {
        unsubscribe = connection.page.onEvent((event) => void pending.push(event));
      } catch (error) {
        degrade('js', 'unavailable', `subscribe failed: ${codeOf(error)}`, currentStep);
      }
      try {
        const read = await evaluate(readDiagnostics, undefined);
        if (!read.ok) degrade('diag', 'unavailable', 'diagnostics unreadable', currentStep);
        else baseline ??= new Set(read.entries.map((entry) => entry.id)); // kept across reconnects so errors logged while the app restarted are still seen
      } catch (error) {
        degrade('diag', 'unavailable', `diagnostics read failed: ${codeOf(error)}`, currentStep);
      }
    };

    const disconnect = async (): Promise<void> => {
      unsubscribe?.();
      unsubscribe = null;
      const old = connection;
      connection = null;
      await old?.close();
    };

    /** After a configuration change the WebView page can be briefly absent; a few bounded retries, then the real error. */
    const connectWithRetry = async (): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        try {
          await connect();
          return;
        } catch (error) {
          if (attempt >= 4 || !(error instanceof DeviceCliError && error.code === 'WEBVIEW')) throw error;
          await clock.sleep(500);
        }
      }
    };

    const readInstalled = async (): Promise<void> => {
      try {
        installedApk = await readInstalledApk(run.device);
        versionName = installedApk.versionName;
        versionCode = installedApk.versionCode;
      } catch {
        installedApk = null; // reported as unreadable when an APK was expected
      }
    };

    /** Turns queued page events, new error diagnostics and the error screen into anomalies. */
    const observe = async (): Promise<void> => {
      drainLogcat(currentStep);
      const events = pending;
      pending = [];
      for (const event of events) {
        journal.append('js', event.type, event, currentStep);
        if (event.type === 'pageerror') anomalies.push({ kind: 'jsException', allowed: false });
        else if (event.type === 'crash') {
          anomalies.push({ kind: 'rendererCrash', allowed: false });
          degrade('js', 'interrupted', 'renderer crashed', currentStep);
        } else if (event.type === 'close') degrade('js', 'interrupted', 'page closed', currentStep);
        else if (event.level === 'error') {
          anomalies.push({ kind: 'consoleError', allowed: allow.some((pattern) => pattern.test(event.text)) });
        }
      }
      if (!connection) return;
      if (channels.diag === 'ok' && baseline) {
        try {
          const read: DiagnosticsRead = await evaluate(readDiagnostics, undefined);
          if (!read.ok) degrade('diag', 'unavailable', 'diagnostics unreadable', currentStep);
          for (const entry of read.entries) {
            if (baseline.has(entry.id)) continue;
            baseline.add(entry.id);
            if (entry.level === 'error') {
              anomalies.push({ kind: 'diagError', allowed: false });
              journal.append('diag', 'error', { id: entry.id, code: entry.code, area: entry.area }, currentStep);
            }
          }
        } catch (error) {
          degrade('diag', 'unavailable', `diagnostics read failed: ${codeOf(error)}`, currentStep);
        }
      }
      try {
        if (await evaluate(errorScreenPresent, undefined)) {
          if (!anomalies.some((anomaly) => anomaly.kind === 'errorScreen')) {
            journal.append('screen', 'errorScreen', {}, currentStep);
            anomalies.push({ kind: 'errorScreen', allowed: false });
          }
        }
      } catch {
        // an unreadable page is reported through the step or channel state, not as an anomaly
      }
    };

    const reattach = async (action: () => Promise<unknown>): Promise<void> => {
      await disconnect();
      await action();
      await connect();
    };

    const capture = async (name: string, work: () => Promise<void>, report: Record<string, string>): Promise<void> => {
      try {
        await work();
        report[name] = 'ok';
      } catch (error) {
        report[name] = `failed: ${codeOf(error)}`;
      }
    };

    const captureFailure = async (): Promise<void> => {
      captured = true;
      const dir = join(runDir, 'failure');
      mkdirSync(dir, { recursive: true });
      const report: Record<string, string> = {};
      await capture('screenshot', async () => atomicWriteFile(join(dir, 'screenshot.png'), await run.device.screencap()), report);
      await capture(
        'dom',
        async () => {
          const result = await withTimeout(probe(page(), { mode: 'snapshot', max: 400 }), TIMEOUTS.cdpEvaluateMs, 'DOM snapshot');
          atomicWriteFile(join(dir, 'dom.json'), `${JSON.stringify(result, null, 2)}\n`);
        },
        report
      );
      await capture(
        'state',
        async () => {
          const result = await withTimeout(
            page().evaluate(captureStateInPage, defaultCaptureArg()),
            TIMEOUTS.stateCaptureMs,
            'state capture'
          );
          atomicWriteFile(join(dir, 'state.json'), `${JSON.stringify(summarizeCapture(result), null, 2)}\n`);
        },
        report
      );
      await capture(
        'diagnostics',
        async () =>
          atomicWriteFile(join(dir, 'diagnostics.json'), `${JSON.stringify(await evaluate(readDiagnostics, undefined), null, 2)}\n`),
        report
      );
      await capture(
        'logcat',
        async () => {
          const pids = await run.device.pids();
          if (pids.length !== 1) throw new DeviceCliError('WEBVIEW', 'app pid is not unique');
          atomicWriteFile(join(dir, 'logcat.txt'), (await run.device.logcat(pids[0])).text);
        },
        report
      );
      atomicWriteFile(join(dir, 'capture.json'), `${JSON.stringify(report, null, 2)}\n`);
    };

    const setCheck = (step: Step, status: CheckStatus, data: unknown): void => {
      checks.set(step.id, status);
      journal.append('check', status, data, step.id);
    };

    const snapshot = async (): Promise<StateSummary> =>
      summarizeCapture(
        await withTimeout(page().evaluate(captureStateInPage, defaultCaptureArg()), TIMEOUTS.stateCaptureMs, 'state capture')
      );

    const execute = async (step: Step): Promise<void> => {
      if ('check' in step) {
        switch (step.check) {
          case 'expectVisible': {
            const locator = step.target;
            let passed: boolean;
            if (locator && 'role' in locator) {
              try {
                await waitFor(
                  clock,
                  async () => (await page().locate(locator, { scroll: false })).visible,
                  (visible) => visible > 0,
                  'expected element',
                  step.timeoutMs,
                  TIMEOUTS.uiPollMs
                );
                passed = true;
              } catch (error) {
                if (!(error instanceof DeviceCliError && error.code === 'TIMEOUT')) throw error;
                passed = false;
              }
            } else {
              const target = locator ? { css: locator.css } : { text: step.text as string };
              passed = (await expectVisibleOn(run, page(), target, step.timeoutMs)).passed;
            }
            setCheck(step, passed ? 'PASS' : 'FAIL', { passed });
            return;
          }
          case 'expectNoErrorScreen': {
            const present = await evaluate(errorScreenPresent, undefined);
            setCheck(step, present ? 'FAIL' : 'PASS', { errorScreen: present });
            return;
          }
          case 'expectStateSame': {
            const a = snapshots.get(step.a);
            const b = step.b === 'now' ? await snapshot() : snapshots.get(step.b);
            const outcome = compareStates(a, b);
            if (outcome.verdict === 'incomplete') stateIncompleteForCheck = true;
            setCheck(step, outcome.verdict === 'same' ? 'PASS' : outcome.verdict === 'different' ? 'FAIL' : 'NOT_EVALUATED', {
              verdict: outcome.verdict,
              reasons: outcome.reasons
            });
            return;
          }
        }
      }
      switch (step.do) {
        case 'launch':
          await reattach(() => lifecycle(run, 'resume'));
          return;
        case 'lifecycle':
          // Relaunch and kill stop the app on purpose: its death must not read as a crash.
          if (step.action === 'kill') {
            logcat?.expectExit(await run.device.pids());
            await disconnect(); // no page after this step until a later "launch"
            await lifecycle(run, 'kill');
            return;
          }
          if (step.action === 'relaunch') logcat?.expectExit(await run.device.pids());
          await reattach(() => lifecycle(run, step.action));
          return;
        case 'reset': {
          await disconnect(); // the old CDP connection dies with the process
          const clear = await clearAndRelaunch(run, (pids) => logcat?.expectExit(pids));
          // The storage was wiped: diagnostics read from now on are new, even if ids repeat old ones.
          baseline = new Set();
          await connectWithRetry();
          const fresh = await verifyFreshState(run, page());
          journal.append(
            'step',
            'reset',
            { fresh: fresh.fresh, userStores: fresh.userStores, appMetadata: fresh.appMetadata, processRestarted: clear.processRestarted },
            step.id
          );
          if (!fresh.fresh) throw leftoverError(fresh, clear);
          return;
        }
        case 'setting': {
          const wasConnected = connection !== null;
          await disconnect(); // a night-mode or font-scale change can recreate the activity and its page
          const report = await applySetting(run, parseSettingRequest(step.key, step.value));
          journal.append('step', 'setting', report, step.id);
          if (wasConnected) await connectWithRetry();
          return;
        }
        case 'installApk': {
          const report = await installDebugApk(run, step.file.startsWith('/') ? step.file : resolve(deps.cwd, step.file), {
            replaceIncompatible: step.replaceIncompatible,
            // Replacing the package kills the app: only now, after the APK was accepted, drop the page and expect the death.
            beforeProcessStops: async () => {
              logcat?.expectExit(await run.device.pids());
              await disconnect();
            }
          });
          lastInstalledSha = report.sha256;
          journal.append(
            'step',
            'install',
            { versionName: report.versionName, versionCode: report.versionCode, sha256: report.sha256, replaced: report.replaced },
            step.id
          );
          return;
        }
        case 'navigate':
          await evaluate(navigateHash, step.route);
          return;
        case 'tap':
          await tapOn(run, page(), step.target, step.native);
          return;
        case 'swipe':
          await swipeOn(run, page(), step.target, step.direction, step.distance, step.durationMs);
          return;
        case 'type':
          await page().fill(step.target, step.text);
          return;
        case 'key':
          await run.device.key(step.key);
          return;
        case 'rotate':
          await rotate(run, step.to);
          return;
        case 'wait':
          await clock.sleep(step.ms);
          return;
        case 'snapshotState': {
          const summary = await snapshot();
          snapshots.set(step.label, summary);
          journal.append('step', 'state', { label: step.label, complete: summary.complete, totalCount: summary.totalCount }, step.id);
          return;
        }
        case 'injectError':
          await evaluate(throwInPage, step.message);
          await clock.sleep(200); // let the timer fire and the pageerror arrive
          return;
      }
    };

    try {
      // Subscribe before anything touches the app so its first lines (and its death) are covered.
      logcat = await LogcatSession.start(run, { rawPath: join(runDir, 'logcat-stream.log') });
      channels.logcat = logcat.health.status;
      logcatDetail = logcat.health.detail;
      journal.append('logcat', 'start', { status: logcat.health.status });
      await readInstalled();
      provenanceAtStart = provenanceNow().status;
      journal.append('runner', 'provenance', { status: provenanceAtStart, expected: expectedSha()?.source ?? null });
      // Running against the wrong build proves nothing, and a reset step would wipe its data for no reason.
      const wrongBuild = (provenanceAtStart === 'mismatch' || provenanceAtStart === 'unreadable') && installSteps.length === 0;

      for (const step of wrongBuild ? [] : scenario.steps) {
        currentStep = step.id;
        journal.append('step', 'start', step, step.id);
        let stepError: unknown = null;
        try {
          await execute(step);
        } catch (error) {
          stepError = error;
        }
        if (stepError === null) stepsDone++;
        else infraError = `${step.id}: [${codeOf(stepError)}] ${messageOf(stepError)}`;
        journal.append('step', 'end', { ok: stepError === null, error: stepError === null ? undefined : codeOf(stepError) }, step.id);
        await observe();
        if (infraError !== null || evaluateVerdict().final === 'FAIL') break;
      }

      // Late events: let anything still in flight arrive before judging.
      currentStep = undefined;
      await clock.sleep(300);
      await logcat.stop(); // flushes what the child had already written
      await observe();
      await readInstalled(); // the final build, after any installApk step

      if (evaluateVerdict().final !== 'PASS' && !captured) await captureFailure();
    } finally {
      try {
        await logcat?.stop();
        drainLogcat();
      } catch (error) {
        journal.append('runner', 'logcat-stop-failed', { code: codeOf(error) });
      }
      try {
        await disconnect();
      } catch (error) {
        journal.append('runner', 'disconnect-failed', { code: codeOf(error) });
      }
    }
  };

  try {
    await withDeviceSession(
      { serial: options.serial, session: join(runDir, 'session'), deps, allowMissingApp: installSteps.length > 0 },
      script
    );
  } catch (error) {
    infraError ??= `[${codeOf(error)}] ${messageOf(error)}`;
  }

  const verdict = evaluateVerdict();
  journal.append('runner', 'verdict', { final: verdict.final, reasons: verdict.reasons });
  const counts = new Map<string, { kind: string; allowed: boolean; count: number }>();
  for (const anomaly of anomalies) {
    const key = `${anomaly.kind}:${anomaly.allowed}`;
    const entry = counts.get(key) ?? { kind: anomaly.kind, allowed: anomaly.allowed, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const summary: RunSummary = {
    schema: 1,
    runId: basename(runDir),
    scenarioId: scenario.id,
    testClass: scenario.testClass,
    final: verdict.final,
    reasons: verdict.reasons,
    checks: [...checks].map(([id, status]) => ({ id, status })),
    anomalies: [...counts.values()],
    channels: channelList(),
    steps: { total: scenario.steps.length, done: stepsDone },
    package: APP_PACKAGE,
    versionName,
    versionCode,
    apk: {
      applicationId: APP_PACKAGE,
      versionName: installedApk?.versionName ?? null,
      versionCode: installedApk?.versionCode ?? null,
      lastUpdateTime: installedApk?.lastUpdateTime ?? null,
      sha256: installedApk?.sha256 ?? null,
      apkFileCount: installedApk?.apkFileCount ?? null,
      webView: installedApk?.webView ?? null,
      provenance: { ...provenanceNow(), expected: expectedSha() }
    },
    git: await gitInfo(deps),
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    runDir
  };
  atomicWriteFile(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { runDir, summary };
}
