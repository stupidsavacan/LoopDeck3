import { assertSerial } from './adb.js';
import { inspectApk, installDebugApk } from './apk.js';
import { applySetting, parseSettingRequest } from './deviceSettings.js';
import { Journal } from './journal.js';
import { Recorder, recordParams, type OpScope } from './explore.js';
import { observe, resetDiagnosticsBaseline } from './observe.js';
import { resetApp } from './reset.js';
import { checkShellArgv } from './shellPolicy.js';
import { attachProbe, expectVisible, inspect, pickerInspect, pickerSelect, swipe, tap } from './actions.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyArtifacts } from './artifacts.js';
import { ALLOWED_KEYS, APP_PACKAGE, DEFAULT_SESSION_ROOT, TIMEOUTS } from './constants.js';
import { DeviceCliError, withTimeout } from './errors.js';
import { collect, collectFailure, compareSummaries, loadSummary } from './evidence.js';
import type { Direction } from './geometry.js';
import { acquireLock } from './lock.js';
import { finishSession, lifecycle, prepareSession, rotate, type LifecycleAction } from './lifecycle.js';
import type { Locator } from './pageScripts.js';
import { hostAdb, openPinnedDevice, type Deps, type DeviceRun } from './runtime.js';
import { runScenario } from './runner.js';
import { diffSnapshots, loadRunSnapshot } from './stateDelta.js';
import { SessionHandle, sessionPaths } from './session.js';
import { captureStateInPage, defaultCaptureArg, summarizeCapture } from './state.js';
import { withWebView } from './webview.js';

type OptionSpec = { type: 'string' | 'boolean' };
export type Values = Record<string, string | boolean | undefined>;

export interface CommandContext {
  name: string;
  values: Values;
  positionals: string[];
  deps: Deps;
  /** The running operation of a recorded (`prepare --record`) session; null otherwise. */
  recording?: OpScope | null;
}

export interface CommandOutput {
  data: Record<string, unknown>;
  /** One concise human line for stderr. */
  summary: string;
  /** Set when the command ran but a check did not pass (exit 1) or evidence is incomplete (exit 5). */
  failure?: { code: 'CHECK_FAILED' | 'INCOMPLETE' | 'RUN_ERROR'; message: string };
}

export interface CommandDef {
  summary: string;
  usage: string;
  options: Record<string, OptionSpec>;
  positionals: { min: number; max: number };
  /** False for commands that never start a process or open a device (offline). */
  touchesDevice: boolean;
  run(context: CommandContext): Promise<CommandOutput>;
}

const session: OptionSpec = { type: 'string' };
const flag: OptionSpec = { type: 'boolean' };
const text: OptionSpec = { type: 'string' };

const str = (values: Values, key: string): string | undefined => {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
};
const on = (values: Values, key: string): boolean => values[key] === true;

function intOption(values: Values, key: string, fallback: number, min: number, max: number): number {
  const raw = str(values, key);
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max)
    throw new DeviceCliError('USAGE', `--${key} must be an integer between ${min} and ${max}`);
  return Number(raw);
}

function forbid(values: Values, keys: string[], why: string): void {
  const present = keys.filter((key) => values[key] !== undefined && values[key] !== false);
  if (present.length > 0) throw new DeviceCliError('USAGE', `${present.map((key) => `--${key}`).join(', ')} not valid ${why}`);
}

/** role+exact name, or a CSS --locator; never both, never a lone --name. */
export function locatorFrom(values: Values): Locator {
  const role = str(values, 'role');
  const name = str(values, 'name');
  const css = str(values, 'locator');
  if (css !== undefined) {
    if (role !== undefined || name !== undefined) throw new DeviceCliError('USAGE', 'Use either --locator or --role with --name, not both');
    if (!css.trim()) throw new DeviceCliError('USAGE', '--locator must not be empty');
    return { css };
  }
  if (role === undefined || name === undefined)
    throw new DeviceCliError('USAGE', 'Provide --role with --name (exact accessible name), or --locator <css>');
  if (!/^[a-z]{3,20}$/.test(role)) throw new DeviceCliError('USAGE', '--role must be a lowercase ARIA role such as button');
  return { role, name };
}

// --- session plumbing -----------------------------------------------------------

/** Runs one finite unit under the exclusive host lock for the session directory. */
async function withSession<T>(context: CommandContext, work: (run: DeviceRun) => Promise<T>): Promise<T> {
  const paths = sessionPaths(str(context.values, 'session'), context.deps.cwd);
  // Refuse before creating any file when there is nothing to operate on.
  if (!existsSync(paths.file))
    throw new DeviceCliError('SESSION', `No session at ${paths.root}. Run "ldev prepare --serial <serial>" first.`);
  const lock = acquireLock(paths.lock, context.name, context.deps.now);
  try {
    const handle = SessionHandle.requireActive(paths, context.deps.now);
    return await work(openPinnedDevice(context.deps, handle));
  } finally {
    lock.release();
  }
}

/** The serial named on the command line, else $LDEV_SERIAL. Never guessed from `adb devices`. */
function serialOption(context: CommandContext): string | undefined {
  const serial = str(context.values, 'serial') ?? context.deps.env.LDEV_SERIAL;
  return serial === undefined || serial === '' ? undefined : assertSerial(serial);
}

/**
 * Like withSession, but able to start the session itself: when no active session exists, `--serial`
 * (or $LDEV_SERIAL) pins the phone exactly as `prepare` would, and the session stays DIRTY until
 * `finish`. With an active session the serial, if given, must be that session's device; a different
 * one is refused before anything is sent. `allowMissingApp` is for commands that work without the
 * debug app installed (install, setting, shell).
 */
async function withManagedSession<T>(
  context: CommandContext,
  options: { allowMissingApp?: boolean },
  work: (run: DeviceRun) => Promise<T>
): Promise<T> {
  const { deps } = context;
  const paths = sessionPaths(str(context.values, 'session'), deps.cwd);
  const serial = serialOption(context);
  const lock = acquireLock(paths.lock, context.name, deps.now);
  try {
    const existing = SessionHandle.read(paths, deps.now);
    if (existing && existing.record.status === 'DIRTY') {
      if (serial !== undefined && serial !== existing.record.transport) {
        throw new DeviceCliError('IDENTITY', 'The given serial is not the device of the active session; refusing to send anything');
      }
      return await work(openPinnedDevice(deps, existing));
    }
    if (serial === undefined) {
      throw new DeviceCliError(
        'SESSION',
        `No active session at ${paths.root}. Pass --serial <serial> (or set LDEV_SERIAL), or run "ldev prepare --serial <serial>" first.`
      );
    }
    const { run } = await prepareSession(deps, paths, serial, false, { allowMissingApp: options.allowMissingApp });
    return await work(run);
  } finally {
    lock.release();
  }
}

// --- commands --------------------------------------------------------------------

const COMMAND_TABLE: Record<string, CommandDef> = {
  devices: {
    summary: 'List adb transports (host discovery only; reads no device state)',
    usage: 'devices',
    options: {},
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const devices = await hostAdb(context.deps).listDevices();
      return { data: { devices, containsDeviceIdentifiers: true }, summary: `${devices.length} adb transport(s)` };
    }
  },

  prepare: {
    summary: 'Pin a device by --serial, record original rotation settings, create a DIRTY session',
    usage: 'prepare --serial <adb serial> [--session <dir>] [--launch] [--record]',
    options: { serial: text, session, launch: flag, record: flag },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const serial = str(context.values, 'serial');
      if (!serial) throw new DeviceCliError('USAGE', 'prepare requires an explicit --serial');
      assertSerial(serial);
      const paths = sessionPaths(str(context.values, 'session'), context.deps.cwd);
      const lock = acquireLock(paths.lock, 'prepare', context.deps.now);
      try {
        const { report, run } = await prepareSession(context.deps, paths, serial, on(context.values, 'launch'));
        let recording: Record<string, unknown> | undefined;
        if (on(context.values, 'record')) {
          // --record: operations and observations of this session are logged until finish (see explore.ts)
          let startDeviceEpochMs: number | null = null;
          try {
            const seconds = await run.device.deviceEpochSeconds();
            startDeviceEpochMs = seconds === null ? null : seconds * 1000;
          } catch {
            startDeviceEpochMs = null; // the first observation then has no log baseline and says so
          }
          const recorder = Recorder.create(context.deps, run.session, {
            serial,
            versionName: report.versionName,
            versionCode: report.versionCode,
            startDeviceEpochMs
          });
          const op = await recorder.begin('prepare', recordParams(context.values, []));
          op.end({ ok: true, errorCode: null });
          recording = { dir: recorder.dir, seq: op.seq };
        }
        return {
          data: { ...report, sessionRoot: paths.root, status: 'DIRTY', ...(recording ? { recording } : {}) },
          summary: `session ${report.sessionId} prepared (DIRTY until finish)`
        };
      } finally {
        lock.release();
      }
    }
  },

  attach: {
    summary: 'Capability probe: forward, connect over CDP, read viewport, disconnect',
    usage: 'attach [--session <dir>]',
    options: { session },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const report = await withSession(context, attachProbe);
      return { data: { ...report }, summary: `attached to pid ${report.pid}${report.pidChanged ? ' (changed)' : ''}; disconnected` };
    }
  },

  inspect: {
    summary: 'Show DOM and/or Android UI elements (stdout contains device text)',
    usage: 'inspect [--dom] [--ui] [--compact] [--diff] [--session <dir>]',
    options: { session, dom: flag, ui: flag, compact: flag, diff: flag },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const { values } = context;
      const neither = !on(values, 'dom') && !on(values, 'ui');
      const report = await withSession(context, (run) =>
        inspect(run, {
          dom: on(values, 'dom') || neither,
          ui: on(values, 'ui') || neither,
          compact: on(values, 'compact'),
          diff: on(values, 'diff')
        })
      );
      return {
        data: { ...report, containsDeviceText: true },
        summary: `inspected ${report.dom ? `${report.dom.lines.length} DOM ` : ''}${report.ui ? `${report.ui.lines.length} UI ` : ''}element(s)`
      };
    }
  },

  state: {
    summary: 'Read-only IndexedDB count + canonical digest (no raw data in output)',
    usage: 'state [--session <dir>]',
    options: { session },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const state = await withSession(context, (run) =>
        withWebView(run, async ({ page }) =>
          summarizeCapture(
            await withTimeout(page.evaluate(captureStateInPage, defaultCaptureArg()), TIMEOUTS.stateCaptureMs, 'state capture')
          )
        )
      );
      const output: CommandOutput = {
        data: { state },
        summary: `state ${state.complete ? `${state.totalCount} record(s) sha256:${state.sha256?.slice(0, 12)}` : 'INCOMPLETE'}`
      };
      if (!state.complete)
        output.failure = { code: 'INCOMPLETE', message: `State capture is incomplete: ${state.reasons.join('; ') || 'unknown'}` };
      return output;
    }
  },

  observe: {
    summary: 'Look once at the screen, errors and (with --state) saved data; reports what was seen and what could not be; never a PASS',
    usage: 'observe [--state] [--screenshot] [--require-complete] [--session <dir>]',
    options: { session, state: flag, screenshot: flag, 'require-complete': flag },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const { values } = context;
      const observation = await withSession(context, (run) =>
        observe(run, { state: on(values, 'state'), screenshot: on(values, 'screenshot') }, context.recording ?? null)
      );
      const { status, anomalies } = observation.assessment;
      const output: CommandOutput = {
        data: { observation, containsDeviceText: true },
        summary: `observation ${observation.id} ${status}${anomalies.length ? ` - anomalies: ${anomalies.join(', ')}` : ''}${observation.gaps.length ? ` - ${observation.gaps.length} gap(s)` : ''}`
      };
      if (status === 'INCONCLUSIVE' && on(values, 'require-complete'))
        output.failure = { code: 'INCOMPLETE', message: `Observation is incomplete: ${observation.gaps.map((gap) => gap.kind).join(', ')}` };
      return output;
    }
  },

  tap: {
    summary: 'Tap a DOM element (role+exact name, or CSS --locator); --native uses Android input',
    usage: 'tap (--role <role> --name <exact name> | --locator <css>) [--native] [--session <dir>]',
    options: { session, role: text, name: text, locator: text, native: flag },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const locator = locatorFrom(context.values);
      const report = await withSession(context, (run) => tap(run, locator, on(context.values, 'native')));
      return { data: { ...report }, summary: `tapped (${report.mode})` };
    }
  },

  swipe: {
    summary: 'Native swipe inside a visible element, clipped to the target and viewport',
    usage:
      'swipe (--role <role> --name <exact name> | --locator <css>) --direction up|down|left|right [--distance <css px>] [--duration-ms <n>] [--session <dir>]',
    options: { session, role: text, name: text, locator: text, direction: text, distance: text, 'duration-ms': text },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const { values } = context;
      const locator = locatorFrom(values);
      const direction = str(values, 'direction');
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right')
        throw new DeviceCliError('USAGE', '--direction must be up, down, left or right');
      const distance = intOption(values, 'distance', 120, 8, 2000);
      const duration = intOption(values, 'duration-ms', 350, 50, 5000);
      const report = await withSession(context, (run) => swipe(run, locator, direction as Direction, distance, duration));
      return { data: { ...report }, summary: `swiped ${direction} ${report.cssDistance.toFixed(0)} CSS px` };
    }
  },

  picker: {
    summary: 'Android DocumentsUI only: inspect, or select by exact --text / --resource-id',
    usage: 'picker inspect | picker select (--text <exact> | --resource-id <id>) [--session <dir>]',
    options: { session, text, 'resource-id': text },
    positionals: { min: 1, max: 1 },
    touchesDevice: true,
    async run(context) {
      const [action] = context.positionals;
      if (action === 'inspect') {
        forbid(context.values, ['text', 'resource-id'], 'with picker inspect');
        const report = await withSession(context, pickerInspect);
        return { data: { ...report, containsDeviceText: true }, summary: `${report.elements.length} picker element(s)` };
      }
      if (action !== 'select') throw new DeviceCliError('USAGE', 'picker action must be inspect or select');
      const target = { text: str(context.values, 'text'), resourceId: str(context.values, 'resource-id') };
      if ((target.text === undefined) === (target.resourceId === undefined))
        throw new DeviceCliError('USAGE', 'picker select needs exactly one of --text or --resource-id');
      const point = await withSession(context, (run) => pickerSelect(run, target));
      return { data: { tapped: point }, summary: 'picker element selected' };
    }
  },

  key: {
    summary: `Send one allowlisted key (${ALLOWED_KEYS.join(', ')})`,
    usage: 'key <KEY> [--session <dir>]',
    options: { session },
    positionals: { min: 1, max: 1 },
    touchesDevice: true,
    async run(context) {
      const [key] = context.positionals;
      if (!ALLOWED_KEYS.includes(key)) throw new DeviceCliError('USAGE', `KEY must be one of: ${ALLOWED_KEYS.join(', ')}`);
      await withSession(context, (run) => run.device.key(key));
      return { data: { key }, summary: `sent ${key}` };
    }
  },

  lifecycle: {
    summary: `background | resume | relaunch | kill the debug app (${APP_PACKAGE} only; relaunch = force-stop + start; kill = force-stop, no restart)`,
    usage: 'lifecycle background|resume|relaunch|kill [--serial <adb serial>] [--session <dir>]',
    options: { session, serial: text },
    positionals: { min: 1, max: 1 },
    touchesDevice: true,
    async run(context) {
      const [action] = context.positionals;
      if (action !== 'background' && action !== 'resume' && action !== 'relaunch' && action !== 'kill')
        throw new DeviceCliError('USAGE', 'lifecycle action must be background, resume, relaunch or kill');
      const report = await withManagedSession(context, {}, (run) => lifecycle(run, action as LifecycleAction));
      return {
        data: { ...report },
        summary: action === 'kill' ? 'app process stopped (not restarted)' : `${action} done${report.pidChanged ? ' (new process)' : ''}`
      };
    }
  },

  install: {
    summary: `Install a debug APK (${APP_PACKAGE} only); --replace-incompatible uninstalls the debug package first when Android refuses the update`,
    usage: 'install --apk <file.apk> [--replace-incompatible] [--serial <adb serial>] [--session <dir>]',
    options: { apk: text, 'replace-incompatible': flag, serial: text, session },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const apk = str(context.values, 'apk');
      if (!apk) throw new DeviceCliError('USAGE', 'install requires --apk <file.apk>');
      await inspectApk(context.deps, apk); // refuse a wrong or unreadable APK before any session or device work
      const report = await withManagedSession(context, { allowMissingApp: true }, (run) =>
        installDebugApk(run, apk, { replaceIncompatible: on(context.values, 'replace-incompatible') })
      );
      return {
        data: { ...report },
        summary: `installed ${report.versionName ?? '?'} (${report.versionCode ?? '?'}) sha256:${report.sha256.slice(0, 12)}${report.replaced ? ' [replaced after uninstall]' : ''}`
      };
    }
  },

  reset: {
    summary: `pm clear ${APP_PACKAGE}, relaunch, and verify that no learner data remains (IndexedDB and localStorage)`,
    usage: 'reset [--serial <adb serial>] [--session <dir>]',
    options: { serial: text, session },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const report = await withManagedSession(context, {}, async (run) => {
        const result = await resetApp(run);
        resetDiagnosticsBaseline(run.session.paths.root, run.session.record.id); // the app's log starts empty
        return result;
      });
      return { data: { ...report }, summary: 'app data cleared; no learner data remains' };
    }
  },

  setting: {
    summary: 'Change dark mode (uimode yes|no|auto) or the font scale (font-scale 0.5..2.0); finish restores the original value',
    usage: 'setting uimode <yes|no|auto> | setting font-scale <0.5..2.0> [--serial <adb serial>] [--session <dir>]',
    options: { serial: text, session },
    positionals: { min: 2, max: 2 },
    touchesDevice: true,
    async run(context) {
      const request = parseSettingRequest(context.positionals[0], context.positionals[1]);
      const report = await withManagedSession(context, { allowMissingApp: true }, (run) => applySetting(run, request));
      return {
        data: { ...report },
        summary: `${report.setting} ${report.original ?? 'unset'} -> ${report.actual ?? 'unset'} (original recorded; "ldev finish" restores it)`
      };
    }
  },

  shell: {
    summary: 'Run one command on the pinned phone via adb shell (argv allowlist, every call journaled); not a sandbox',
    usage: 'shell [--serial <adb serial>] [--session <dir>] -- <command> [args...]',
    options: { serial: text, session },
    positionals: { min: 1, max: 64 },
    touchesDevice: true,
    async run(context) {
      const argv = [...context.positionals];
      const { deps } = context;
      const paths = sessionPaths(str(context.values, 'session'), deps.cwd);
      const journal = new Journal(join(paths.root, 'shell.ndjson'), () => deps.clock.now());
      try {
        checkShellArgv(argv); // before any device or session work
      } catch (error) {
        if (existsSync(paths.file)) journal.append('shell', 'refused', { argv, reason: (error as Error).message });
        throw error;
      }
      return await withManagedSession(context, { allowMissingApp: true }, async (run) => {
        journal.append('shell', 'command', { argv });
        const result = await run.device.runShell(argv, { timeoutMs: 60_000, maxBytes: 1024 * 1024 });
        const clip = (value: string): string => (value.length > 16_384 ? value.slice(0, 16_384) : value);
        const truncated = result.stdout.length > 16_384 || result.stderr.length > 16_384;
        const data = {
          argv,
          exitCode: result.code,
          stdout: clip(result.stdout),
          stderr: clip(result.stderr),
          truncated,
          containsDeviceText: true
        };
        journal.append('shell', 'result', { argv, exitCode: result.code, stdout: data.stdout, stderr: data.stderr, truncated });
        const output: CommandOutput = { data, summary: `exit ${result.code}` };
        if (result.code !== 0) output.failure = { code: 'RUN_ERROR', message: `The device command exited with status ${result.code}` };
        return output;
      });
    }
  },

  rotate: {
    summary: 'Set portrait or landscape (originals restored by finish)',
    usage: 'rotate portrait|landscape [--session <dir>]',
    options: { session },
    positionals: { min: 1, max: 1 },
    touchesDevice: true,
    async run(context) {
      const [orientation] = context.positionals;
      if (orientation !== 'portrait' && orientation !== 'landscape')
        throw new DeviceCliError('USAGE', 'orientation must be portrait or landscape');
      const report = await withSession(context, (run) => rotate(run, orientation));
      return { data: { ...report }, summary: `rotated to ${orientation}` };
    }
  },

  expect: {
    summary: 'Assert exact visible text or a visible CSS locator (bounded polling)',
    usage: 'expect (--text <exact visible text> | --locator <css>) [--timeout-ms <n>] [--session <dir>]',
    options: { session, text, locator: text, 'timeout-ms': text },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const { values } = context;
      const wantedText = str(values, 'text');
      const css = str(values, 'locator');
      if ((wantedText === undefined) === (css === undefined))
        throw new DeviceCliError('USAGE', 'expect needs exactly one of --text or --locator');
      const timeout = intOption(values, 'timeout-ms', TIMEOUTS.expectMs, 0, TIMEOUTS.maxExpectMs);
      const report = await withSession(context, (run) =>
        expectVisible(run, wantedText !== undefined ? { text: wantedText } : { css: css as string }, timeout)
      );
      const output: CommandOutput = {
        data: { ...report },
        summary: report.passed ? `expectation met (${report.visible} visible)` : 'expectation NOT met'
      };
      if (!report.passed) output.failure = { code: 'CHECK_FAILED', message: 'Expected element was not visible before the timeout' };
      return output;
    }
  },

  collect: {
    summary: 'Collect evidence under <session>/artifacts/LABEL; summary excludes raw data',
    usage: 'collect <LABEL> [--compare-to <dir|summary.json> [--expect-same]] [--session <dir>]',
    options: { session, 'compare-to': text, 'expect-same': flag },
    positionals: { min: 1, max: 1 },
    touchesDevice: true,
    async run(context) {
      const compareTo = str(context.values, 'compare-to');
      const expectSame = on(context.values, 'expect-same');
      const result = await withSession(context, (run) => collect(run, { label: context.positionals[0], compareTo, expectSame }));
      const failure = collectFailure(result, expectSame);
      const output: CommandOutput = {
        data: { directory: result.directory, summary: result.summary },
        summary: `evidence ${result.summary.overall} -> ${result.directory}`
      };
      if (failure) output.failure = { code: failure.code as 'CHECK_FAILED' | 'INCOMPLETE', message: failure.message };
      return output;
    }
  },

  compare: {
    summary: 'Offline: compare the state section (count + digest) of two evidence summaries',
    usage: 'compare <A> <B>',
    options: {},
    positionals: { min: 2, max: 2 },
    touchesDevice: false,
    async run(context) {
      const [a, b] = context.positionals.map((path) => loadSummary(path, context.deps.cwd));
      const outcome = compareSummaries(a, b);
      const output: CommandOutput = { data: { ...outcome }, summary: `state ${outcome.verdict}` };
      if (outcome.verdict === 'different') output.failure = { code: 'CHECK_FAILED', message: outcome.reasons.join('; ') };
      if (outcome.verdict === 'incomplete') output.failure = { code: 'INCOMPLETE', message: outcome.reasons.join('; ') };
      return output;
    }
  },

  diff: {
    summary: 'Offline: record-level IndexedDB and localStorage differences between two run snapshots (digests only)',
    usage: 'diff <runA:label> <runB:label> [--ignore-local-storage <key|prefix*>[,...]] [--expect-same]   (run = run directory or run id under $LDEV_HOME/runs)',
    options: { 'ignore-local-storage': text, 'expect-same': flag },
    positionals: { min: 2, max: 2 },
    touchesDevice: false,
    async run(context) {
      const [a, b] = context.positionals.map((ref) => loadRunSnapshot(ref, context.deps.cwd, context.deps.env).snapshot);
      const ignore = (str(context.values, 'ignore-local-storage') ?? '').split(',').filter((pattern) => pattern !== '');
      const delta = diffSnapshots(a, b, { ignoreLocalStorage: ignore });
      const changed =
        delta.schemaChanges.length > 0 ||
        delta.stores.some((store) => Boolean(store.added || store.removed || store.updated) || store.before !== store.after) ||
        delta.localStorage.added.length + delta.localStorage.removed.length + delta.localStorage.updated.length > 0;
      const output: CommandOutput = {
        data: { ...delta, changed, localStorageCompared: delta.localStorage.available },
        summary:
          delta.verdict === 'incomplete'
            ? 'INCOMPLETE'
            : changed
              ? 'states differ'
              : delta.localStorage.available
                ? 'no differences'
                : 'no IndexedDB differences (localStorage NOT compared: not captured on both sides)'
      };
      if (delta.verdict === 'incomplete') output.failure = { code: 'INCOMPLETE', message: delta.reasons.join('; ') };
      else if (changed && on(context.values, 'expect-same')) output.failure = { code: 'CHECK_FAILED', message: 'The two snapshots differ' };
      else if (on(context.values, 'expect-same') && !delta.localStorage.available)
        output.failure = { code: 'INCOMPLETE', message: 'localStorage was not captured on both sides, so the snapshots cannot be shown to be the same' };
      return output;
    }
  },

  artifacts: {
    summary: 'Offline: check that an APK embeds exactly the given single-file HTML (bytes and SHA-256)',
    usage: 'artifacts --apk <file.apk> --html <LoopDeck3.html>',
    options: { apk: text, html: text },
    positionals: { min: 0, max: 0 },
    touchesDevice: false,
    async run(context) {
      const apk = str(context.values, 'apk');
      const html = str(context.values, 'html');
      if (!apk || !html) throw new DeviceCliError('USAGE', 'artifacts requires both --apk and --html');
      let result;
      try {
        result = await verifyArtifacts(await readFile(resolve(context.deps.cwd, apk)), await readFile(resolve(context.deps.cwd, html)));
      } catch (error) {
        throw new DeviceCliError('USAGE', `Cannot verify artifacts: ${(error as Error).message}`);
      }
      const output: CommandOutput = {
        data: { ...result },
        summary: result.matches ? 'APK embeds exactly this HTML' : 'APK HTML differs from the given file'
      };
      if (!result.matches) output.failure = { code: 'CHECK_FAILED', message: 'The APK-embedded HTML does not match the supplied HTML' };
      return output;
    }
  },

  run: {
    summary: 'Run a scenario file: prepare, drive the app, observe JS errors, judge PASS|FAIL|INCONCLUSIVE|ERROR, finish',
    usage: 'run <scenario.json> [--serial <adb serial>] [--out <dir>] [--apk <expected.apk>]   (serial falls back to $LDEV_SERIAL)',
    options: { serial: text, out: text, apk: text },
    positionals: { min: 1, max: 1 },
    touchesDevice: true,
    async run(context) {
      const serial = str(context.values, 'serial') ?? context.deps.env.LDEV_SERIAL;
      if (!serial) throw new DeviceCliError('USAGE', 'run requires --serial (or LDEV_SERIAL)');
      const { runDir, summary } = await runScenario(context.deps, {
        serial,
        scenarioPath: context.positionals[0],
        outDir: str(context.values, 'out'),
        apkPath: str(context.values, 'apk')
      });
      const output: CommandOutput = {
        data: { ...summary, runDir },
        summary: `${summary.final} (${summary.steps.done}/${summary.steps.total} steps) -> ${runDir}`
      };
      const why = summary.reasons.join('; ') || summary.final;
      if (summary.final === 'FAIL') output.failure = { code: 'CHECK_FAILED', message: why };
      else if (summary.final === 'ERROR') output.failure = { code: 'RUN_ERROR', message: why };
      else if (summary.final === 'INCONCLUSIVE') output.failure = { code: 'INCOMPLETE', message: why };
      return output;
    }
  },

  finish: {
    summary: 'Restore recorded settings, remove owned forwards, verify; stays DIRTY on any failure',
    usage: 'finish [--accept-unowned-forward] [--session <dir>]',
    options: { session, 'accept-unowned-forward': flag },
    positionals: { min: 0, max: 0 },
    touchesDevice: true,
    async run(context) {
      const { steps } = await withSession(context, (run) =>
        finishSession(run, { acceptUnownedForward: on(context.values, 'accept-unowned-forward') })
      );
      return { data: { status: 'CLEAN', steps }, summary: 'session finished and verified CLEAN' };
    }
  }
};

export const COMMANDS: Readonly<Record<string, CommandDef>> = COMMAND_TABLE;
export const defaultSessionRoot = DEFAULT_SESSION_ROOT;
