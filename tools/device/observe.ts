import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uiSnapshot } from './actions.js';
import { TIMEOUTS } from './constants.js';
import { DeviceCliError, withTimeout } from './errors.js';
import type { OpScope, ObservationIndex } from './explore.js';
import { LogcatAnalyzer, parseLogcatLine, type LogcatLine } from './logcat.js';
import {
  errorScreenPresent,
  observeProbe,
  readDiagnostics,
  type DiagnosticsRead,
  type ObservedDomElement,
  type ObserveProbeResult
} from './pageScripts.js';
import type { DeviceRun } from './runtime.js';
import { atomicWriteFile } from './session.js';
import { captureLocalStorageInPage, captureStateInPage, defaultCaptureArg } from './state.js';
import { SNAPSHOT_DIR, buildSnapshot, diffSnapshots, parseSnapshot, type StateDelta, type StateSnapshot } from './stateDelta.js';
import { topLevelPackages } from './ui.js';
import { withWebView } from './webview.js';

/**
 * `ldev observe`: one look at the phone and the app. It reports what was seen and, separately, what
 * could not be seen. It never declares a test passed: a quiet screen is not evidence that nothing went wrong
 * between two CLI invocations, because JS events are not streamed across processes.
 */

export interface ObserveOptions {
  state: boolean;
  screenshot: boolean;
}

export interface Gap {
  kind: string;
  detail: string;
}

export interface AndroidElement {
  class: string;
  resourceId: string;
  text: string;
  contentDesc: string;
  clickable: boolean;
  enabled: boolean;
  bounds: [number, number, number, number] | null;
}

export interface ScreenChange {
  since: number;
  routeChanged: boolean;
  domAdded: number;
  domRemoved: number;
  androidAdded: number;
  androidRemoved: number;
  sampleAdded: string[];
  sampleRemoved: string[];
}

export interface StoreDeltaView {
  name: string;
  before: number | null;
  after: number | null;
  added: number | null;
  removed: number | null;
  updated: number | null;
}

export interface Observation {
  schema: 1;
  id: number;
  at: string;
  /** The last operation before this look (not counting observations), or null outside a recorded session. */
  after: { seq: number; command: string; params: string; ok: boolean | null } | null;
  screen: {
    connected: boolean;
    reason: { code: string; message: string } | null;
    pid: number | null;
    previousPid: number | null;
    pidChanged: boolean;
    url: string | null;
    route: string | null;
    title: string | null;
    errorScreen: boolean | null;
    elements: ObservedDomElement[];
    hiddenElements: number;
    elementsNotListed: number;
    android: { available: boolean; foreground: string[]; appInForeground: boolean | null; elements: AndroidElement[]; truncated: boolean };
    changedSincePrevious: ScreenChange | null;
    screenshot: string | null;
  };
  diagnostics: {
    available: boolean;
    baseline: 'known' | 'established-now';
    newErrors: number | null;
    newErrorEntries: { id: string; code: string | null; area: string }[];
    existingErrors: number | null;
  };
  android: {
    coverage: 'full' | 'partial' | 'none';
    crashes: number;
    anrs: number;
    fatalExceptions: number;
    processDied: number;
    expectedExits: number;
    events: { kind: string; deviceEpochMs: number; pid: unknown; exception?: unknown }[];
    logcat: { read: boolean; window: { fromDeviceMs: number | null; toDeviceMs: number | null }; linesScanned: number; newLines: number };
  };
  state: {
    available: boolean;
    reason: string | null;
    snapshot: string | null;
    complete: boolean | null;
    stores: { name: string; count: number }[];
    localStorageKeys: number | null;
    delta: {
      comparedTo: number;
      spansOperations: { afterSeq: number | null; throughSeq: number | null };
      verdict: StateDelta['verdict'];
      reasons: string[];
      schemaChanges: string[];
      stores: StoreDeltaView[];
      localStorage: { available: boolean; added: string[]; removed: string[]; updated: string[] };
      changed: boolean;
    } | null;
  };
  channels: Record<'dom' | 'diagnostics' | 'androidUi' | 'logcat' | 'state', 'observed' | 'unobserved' | 'not-requested'>;
  gaps: Gap[];
  limitations: string[];
  assessment: { status: 'COMPLETE' | 'INCONCLUSIVE'; anomalies: string[]; note: string };
}

/** Always true, so always said: these are not gaps of one observation but properties of the tool. */
export const LIMITATIONS: readonly string[] = [
  'JavaScript pageerror/console.error events between ldev invocations are not streamed; only the persisted diagnostics log and this look are read.',
  'DOM roles and names are read approximately; the locators listed were checked against the page, but tap/swipe resolve them again with Playwright.'
];

const NOTE = 'observe reports observed facts and gaps; it is not a test verdict and never means PASS.';
const MAX_DOM = 150;
const MAX_ANDROID = 60;
const SLACK_MS = 2_000;
const CLOCK_JUMP_MS = 5_000;

interface ObserveState {
  schema: 1;
  sessionId: string;
  nextObsId: number;
  /** Every diagnostics entry id seen so far; null until the first successful read. */
  diagIds: string[] | null;
  screen: { route: string | null; dom: string[]; android: string[]; obsId: number } | null;
  logcat: { cursorMs: number; keys: string[]; lastDeviceNowMs: number | null; skewMs: number | null } | null;
  /** The observation whose snapshot is in observe-snapshot.json. */
  stateObsId: number | null;
}

const stateFile = (root: string): string => join(root, 'observe-state.json');
const snapshotFile = (root: string): string => join(root, 'observe-snapshot.json');

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string => (error instanceof DeviceCliError ? error.code : 'INTERNAL');

function freshState(sessionId: string): ObserveState {
  return { schema: 1, sessionId, nextObsId: 1, diagIds: null, screen: null, logcat: null, stateObsId: null };
}

/** State of another session (an earlier `prepare` in the same directory) is never reused. */
function loadState(root: string, sessionId: string): ObserveState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(root), 'utf8')) as ObserveState;
    if (parsed.schema === 1 && parsed.sessionId === sessionId) return parsed;
  } catch {
    // none yet, or unreadable: start over (the first look then has no baseline, and says so)
  }
  return freshState(sessionId);
}

/** After `reset` the app's diagnostics start empty, so everything it writes from now on is new. */
export function resetDiagnosticsBaseline(root: string, sessionId: string): void {
  const state = loadState(root, sessionId);
  state.diagIds = [];
  atomicWriteFile(stateFile(root), JSON.stringify(state));
}

const digest = (value: string): string => createHash('sha1').update(value).digest('hex').slice(0, 16);
const lineKey = (line: LogcatLine): string =>
  digest(`${line.epochMs}|${line.uid}|${line.pid}|${line.tid}|${line.priority}|${line.tag}|${line.message}`);

// --- web part ---------------------------------------------------------------------

interface WebPart {
  connected: boolean;
  reason: { code: string; message: string } | null;
  pid: number | null;
  previousPid: number | null;
  probe: ObserveProbeResult | null;
  diag: DiagnosticsRead | null;
  errorScreen: boolean | null;
  snapshot: StateSnapshot | null;
  stateReason: string | null;
  problems: Gap[];
}

async function observeWeb(run: DeviceRun, wantState: boolean): Promise<WebPart> {
  const part: WebPart = {
    connected: false,
    reason: null,
    pid: null,
    previousPid: null,
    probe: null,
    diag: null,
    errorScreen: null,
    snapshot: null,
    stateReason: wantState ? null : 'not requested',
    problems: []
  };
  try {
    await withWebView(run, async ({ page, pid, previousPid }) => {
      part.connected = true;
      part.pid = pid;
      part.previousPid = previousPid;
      const attempt = async <T>(kind: string, work: () => Promise<T>): Promise<T | null> => {
        try {
          return await work();
        } catch (error) {
          part.problems.push({ kind, detail: `${codeOf(error)}: ${clip(messageOf(error), 120)}` });
          return null;
        }
      };
      part.probe = await attempt('dom-unreadable', () =>
        withTimeout(page.evaluate(observeProbe, { max: MAX_DOM }), TIMEOUTS.cdpEvaluateMs, 'observe probe')
      );
      const diag = await attempt('diagnostics-unreadable', () => withTimeout(page.evaluate(readDiagnostics, undefined), TIMEOUTS.cdpEvaluateMs, 'diagnostics'));
      part.diag = diag && diag.ok ? diag : null;
      if (diag && !diag.ok) part.problems.push({ kind: 'diagnostics-unreadable', detail: 'the diagnostics log could not be parsed' });
      part.errorScreen = await attempt('error-screen-unreadable', () =>
        withTimeout(page.evaluate(errorScreenPresent, undefined), TIMEOUTS.cdpEvaluateMs, 'error screen')
      );
      if (wantState) {
        const result = await attempt('state-unreadable', () =>
          withTimeout(page.evaluate(captureStateInPage, defaultCaptureArg()), TIMEOUTS.stateCaptureMs, 'state capture')
        );
        if (result) {
          let localStorage;
          try {
            localStorage = await withTimeout(page.evaluate(captureLocalStorageInPage, undefined), TIMEOUTS.stateCaptureMs, 'localStorage capture');
          } catch {
            localStorage = undefined; // recorded as unavailable below
          }
          part.snapshot = buildSnapshot(result, localStorage);
        } else part.stateReason = 'IndexedDB capture failed';
      }
    });
  } catch (error) {
    if (!part.connected) {
      part.reason = { code: codeOf(error), message: clip(messageOf(error), 200) };
    } else {
      // the page was read, then the disconnect failed: keep what was read, and say so
      part.problems.push({ kind: 'webview-disconnect-failed', detail: `${codeOf(error)}: ${clip(messageOf(error), 120)}` });
    }
  }
  return part;
}

// --- logcat part ------------------------------------------------------------------

const BUSY_BUFFERS = ['main', 'system', 'events'];

interface LogcatPart {
  read: boolean;
  coverage: Observation['android']['coverage'];
  crashes: number;
  anrs: number;
  fatalExceptions: number;
  processDied: number;
  expectedExits: number;
  events: Observation['android']['events'];
  linesScanned: number;
  newLines: number;
  window: { fromDeviceMs: number | null; toDeviceMs: number | null };
  next: ObserveState['logcat'];
  gaps: Gap[];
}

async function observeLogcat(
  run: DeviceRun,
  prev: ObserveState['logcat'],
  startMs: number | null,
  windows: { fromMs: number; toMs: number }[]
): Promise<LogcatPart> {
  const gaps: Gap[] = [];
  const part: LogcatPart = {
    read: false,
    coverage: 'none',
    crashes: 0,
    anrs: 0,
    fatalExceptions: 0,
    processDied: 0,
    expectedExits: 0,
    events: [],
    linesScanned: 0,
    newLines: 0,
    window: { fromDeviceMs: null, toDeviceMs: null },
    next: prev,
    gaps
  };
  const { clock } = run.deps;
  let deviceNowMs: number | null = null;
  const hostBefore = clock.now();
  try {
    const seconds = await run.device.deviceEpochSeconds();
    deviceNowMs = seconds === null ? null : seconds * 1000;
  } catch {
    deviceNowMs = null;
  }
  let appUid: string | null = null;
  try {
    appUid = await run.device.appUid();
  } catch {
    appUid = null; // pid and package matching still work without it
  }
  let dump: string;
  try {
    dump = await run.device.logcatDump();
  } catch (error) {
    gaps.push({ kind: 'logcat-unavailable', detail: `${codeOf(error)}: ${clip(messageOf(error), 120)}` });
    return part;
  }
  part.read = true;

  // Parse, remembering which buffer each line came from: a buffer that no longer reaches back to the
  // previous look may have lost lines.
  const lines: LogcatLine[] = [];
  const oldestByBuffer = new Map<string, number>();
  let current = 'unknown';
  let bannerSeen = false;
  for (const raw of dump.split(/\r?\n/)) {
    const banner = /^-+ beginning of (\w+)/.exec(raw);
    if (banner) {
      current = banner[1];
      bannerSeen = true;
      continue;
    }
    const parsed = parseLogcatLine(raw);
    if (!parsed) continue;
    lines.push(parsed);
    oldestByBuffer.set(current, Math.min(oldestByBuffer.get(current) ?? Number.MAX_SAFE_INTEGER, parsed.epochMs));
  }
  part.linesScanned = lines.length;

  const cursor = prev?.cursorMs ?? startMs;
  const skewMs = deviceNowMs === null ? null : deviceNowMs - hostBefore;
  part.window = { fromDeviceMs: cursor, toDeviceMs: deviceNowMs };

  if (cursor === null) {
    gaps.push({ kind: 'logcat-no-baseline', detail: 'no earlier look or session start time: the window is the whole buffer and may predate this session' });
  } else {
    const checked = bannerSeen ? BUSY_BUFFERS : ['unknown'];
    const overrun = checked.filter((name) => {
      const oldest = bannerSeen ? oldestByBuffer.get(name) : Math.min(...oldestByBuffer.values());
      return oldest === undefined || oldest === Number.MAX_SAFE_INTEGER || oldest > cursor + SLACK_MS;
    });
    if (overrun.length > 0)
      gaps.push({
        kind: 'logcat-ring-overrun',
        detail: `buffer(s) ${overrun.join(', ')} do not reach back to the previous look; older lines may have been overwritten`
      });
  }
  if (deviceNowMs === null) gaps.push({ kind: 'device-clock-unreadable', detail: 'the device time could not be read, so the next window cannot be anchored' });
  if (prev?.lastDeviceNowMs != null && deviceNowMs !== null && deviceNowMs < prev.lastDeviceNowMs - 1_000)
    gaps.push({ kind: 'device-clock-went-backwards', detail: 'the device time is earlier than at the previous look; log timestamps cannot be ordered against it' });
  if (prev?.skewMs != null && skewMs !== null && Math.abs(skewMs - prev.skewMs) > CLOCK_JUMP_MS)
    gaps.push({ kind: 'device-clock-jump', detail: 'the offset between device and host time changed; the window may be misplaced' });

  const known = new Set(prev?.keys ?? []);
  const fresh = lines
    .filter((line) => cursor === null || (line.epochMs >= cursor - SLACK_MS && !known.has(lineKey(line))))
    .sort((a, b) => a.epochMs - b.epochMs);
  part.newLines = fresh.length;

  const analyzer = new LogcatAnalyzer(appUid);
  for (const line of fresh) analyzer.consume(line);
  const crashed = new Set<unknown>();
  const offset = skewMs ?? prev?.skewMs ?? 0;
  for (const event of analyzer.events) {
    const deviceEpochMs = Number(event.data.deviceEpochMs);
    const brief = { kind: event.anomaly ?? event.type, deviceEpochMs, pid: event.data.pid, exception: event.data.exception };
    if (event.anomaly === 'androidFatalException' || event.anomaly === 'androidCrash') {
      if (event.anomaly === 'androidFatalException') part.fatalExceptions++;
      crashed.add(event.data.appPid ?? event.data.pid);
      part.events.push(brief);
    } else if (event.anomaly === 'androidAnr') {
      part.anrs++;
      part.events.push(brief);
    } else if (event.anomaly === 'androidProcessDied') {
      const hostMs = deviceEpochMs - offset;
      if (windows.some((w) => hostMs >= w.fromMs - CLOCK_JUMP_MS && hostMs <= w.toMs + CLOCK_JUMP_MS)) part.expectedExits++;
      else {
        part.processDied++;
        part.events.push(brief);
      }
    }
  }
  part.crashes = crashed.size;

  const anchor = deviceNowMs ?? (lines.length > 0 ? Math.max(...lines.map((line) => line.epochMs)) : (prev?.cursorMs ?? startMs));
  if (anchor !== null) {
    part.next = {
      cursorMs: anchor,
      keys: lines.filter((line) => line.epochMs >= anchor - SLACK_MS).map(lineKey),
      lastDeviceNowMs: deviceNowMs,
      skewMs
    };
  }
  part.coverage = gaps.length === 0 ? 'full' : 'partial';
  return part;
}

// --- screen helpers -----------------------------------------------------------------

const domKey = (element: ObservedDomElement): string => `${element.role ?? element.tag}|${element.name}`;
const androidKey = (element: AndroidElement): string => `${element.class}|${element.resourceId}|${element.text}`;

function difference(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const a = new Set(before);
  const b = new Set(after);
  return { added: after.filter((key) => !a.has(key)), removed: before.filter((key) => !b.has(key)) };
}

function routeOf(hash: string): string | null {
  return hash ? hash : null;
}

function viewOfDelta(delta: StateDelta): NonNullable<Observation['state']['delta']>['stores'] {
  return delta.stores.map((store) => ({
    name: store.name,
    before: store.before,
    after: store.after,
    added: store.added,
    removed: store.removed,
    updated: store.updated
  }));
}

export function deltaChanged(delta: StateDelta): boolean {
  return (
    delta.schemaChanges.length > 0 ||
    delta.stores.some((store) => store.presence !== 'both' || Boolean(store.added || store.removed || store.updated)) ||
    delta.localStorage.added.length + delta.localStorage.removed.length + delta.localStorage.updated.length > 0
  );
}

// --- the observation --------------------------------------------------------------------

export async function observe(run: DeviceRun, options: ObserveOptions, scope: OpScope | null): Promise<Observation> {
  const root = run.session.paths.root;
  const sessionId = run.session.record.id;
  const exploration = run.session.record.exploration;
  const recorder = scope?.recorder ?? null;
  const state = loadState(root, sessionId);
  const id = state.nextObsId;
  const gaps: Gap[] = [];
  const at = run.deps.now().toISOString();
  const previousAction = recorder && scope ? recorder.previousAction(scope.seq) : null;

  // 1. the app's page: elements, route, diagnostics, error screen, saved data
  const web = await observeWeb(run, options.state);
  gaps.push(...web.problems);
  if (!web.connected) gaps.push({ kind: 'webview-unreachable', detail: `${web.reason?.code ?? 'unknown'}: ${web.reason?.message ?? ''}` });

  // 2. the Android UI (independent of the WebView)
  let ui: Observation['screen']['android'] = { available: false, foreground: [], appInForeground: null, elements: [], truncated: false };
  try {
    const snapshot = await uiSnapshot(run);
    const foreground = topLevelPackages(snapshot);
    const nodes = snapshot.nodes.filter(
      (node) => (node.resourceId || node.clickable || node.contentDesc || node.text) && !(node.cls === 'android.view.View' && !node.resourceId && !node.clickable)
    );
    ui = {
      available: true,
      foreground,
      appInForeground: foreground.includes(run.session.record.package),
      elements: nodes.slice(0, MAX_ANDROID).map((node) => ({
        class: node.cls.split('.').pop() ?? node.cls,
        resourceId: node.resourceId,
        text: clip(node.text, 80),
        contentDesc: clip(node.contentDesc, 80),
        clickable: node.clickable,
        enabled: node.enabled,
        bounds: node.bounds ? [node.bounds.left, node.bounds.top, node.bounds.right, node.bounds.bottom] : null
      })),
      truncated: nodes.length > MAX_ANDROID
    };
  } catch (error) {
    gaps.push({ kind: 'android-ui-unavailable', detail: `${codeOf(error)}: ${clip(messageOf(error), 120)}` });
  }

  // 3. Android crashes / ANRs from the log buffers since the previous look
  const logcat = await observeLogcat(run, state.logcat, exploration?.startDeviceEpochMs ?? null, recorder ? recorder.expectedExitWindows() : []);
  gaps.push(...logcat.gaps);

  // 4. diagnostics against what the previous look saw
  const entries = web.diag?.entries ?? [];
  const errors = entries.filter((entry) => entry.level === 'error');
  const prevIds = state.diagIds;
  let newErrors: number | null = null;
  let newErrorEntries: Observation['diagnostics']['newErrorEntries'] = [];
  let existingErrors: number | null = null;
  if (web.diag) {
    if (prevIds === null) {
      existingErrors = errors.length;
      if (previousAction && previousAction.command !== 'prepare')
        gaps.push({ kind: 'diagnostics-no-baseline', detail: 'operations ran before the first look, so errors logged since then cannot be told apart from older ones' });
    } else {
      const known = new Set(prevIds);
      const added = errors.filter((entry) => !known.has(entry.id));
      newErrors = added.length;
      newErrorEntries = added.slice(0, 20).map((entry) => ({ id: entry.id, code: entry.code, area: entry.area }));
      existingErrors = errors.length - added.length;
      if (prevIds.length > 0 && entries.length >= 200 && !entries.some((entry) => known.has(entry.id)))
        gaps.push({ kind: 'diagnostics-ring-overflow', detail: 'the diagnostics log is full and holds none of the previously seen entries; some may have been dropped' });
    }
  }

  // 5. what changed on screen
  const domKeys = (web.probe?.elements ?? []).map(domKey);
  const androidKeys = ui.elements.map(androidKey);
  const route = web.probe ? routeOf(web.probe.hash) : null;
  let changed: ScreenChange | null = null;
  if (state.screen && (web.probe || ui.available)) {
    const dom = web.probe ? difference(state.screen.dom, domKeys) : { added: [], removed: [] };
    const android = ui.available ? difference(state.screen.android, androidKeys) : { added: [], removed: [] };
    changed = {
      since: state.screen.obsId,
      routeChanged: web.probe ? state.screen.route !== route : false,
      domAdded: dom.added.length,
      domRemoved: dom.removed.length,
      androidAdded: android.added.length,
      androidRemoved: android.removed.length,
      sampleAdded: [...dom.added, ...android.added].slice(0, 10).map((key) => clip(key, 80)),
      sampleRemoved: [...dom.removed, ...android.removed].slice(0, 10).map((key) => clip(key, 80))
    };
  }

  // 6. saved data and its difference from the previous state-bearing look
  const stateView: Observation['state'] = {
    available: false,
    reason: web.snapshot ? null : (web.stateReason ?? (web.connected ? 'IndexedDB capture failed' : 'WebView unreachable')),
    snapshot: null,
    complete: null,
    stores: [],
    localStorageKeys: null,
    delta: null
  };
  let nextStateObsId = state.stateObsId;
  if (options.state && !web.snapshot) gaps.push({ kind: 'state-unavailable', detail: stateView.reason ?? 'unknown' });
  if (web.snapshot) {
    const snapshot = web.snapshot;
    stateView.available = true;
    stateView.complete = snapshot.summary.complete;
    stateView.stores = snapshot.stores.map((store) => ({ name: store.name, count: store.count }));
    stateView.localStorageKeys = snapshot.localStorage.ok ? snapshot.localStorage.entries.length : null;
    if (!snapshot.summary.complete) gaps.push({ kind: 'state-incomplete', detail: clip(snapshot.summary.reasons.join('; ') || 'IndexedDB capture did not finish', 160) });
    if (!snapshot.localStorage.ok) gaps.push({ kind: 'localstorage-unavailable', detail: 'localStorage could not be captured' });
    let previous: { obsId: number; afterSeq: number | null; snapshot: StateSnapshot } | null = null;
    if (state.stateObsId !== null) {
      try {
        const raw = JSON.parse(readFileSync(snapshotFile(root), 'utf8')) as { obsId: number; afterSeq: number | null; snapshot: unknown };
        if (raw.obsId === state.stateObsId) previous = { obsId: raw.obsId, afterSeq: raw.afterSeq, snapshot: parseSnapshot(raw.snapshot, 'observe-snapshot.json') };
      } catch {
        gaps.push({ kind: 'state-baseline-unreadable', detail: 'the previous state snapshot could not be read; no comparison was made' });
      }
    }
    if (previous) {
      const delta = diffSnapshots(previous.snapshot, snapshot);
      if (delta.verdict === 'incomplete') gaps.push({ kind: 'state-delta-incomplete', detail: clip(delta.reasons.join('; '), 160) });
      stateView.delta = {
        comparedTo: previous.obsId,
        spansOperations: { afterSeq: previous.afterSeq, throughSeq: previousAction?.seq ?? null },
        verdict: delta.verdict,
        reasons: delta.reasons,
        schemaChanges: delta.schemaChanges,
        stores: viewOfDelta(delta),
        localStorage: { available: delta.localStorage.available, added: delta.localStorage.added, removed: delta.localStorage.removed, updated: delta.localStorage.updated },
        changed: delta.verdict === 'ok' && deltaChanged(delta)
      };
    }
    const label = `obs-${id}`;
    atomicWriteFile(snapshotFile(root), JSON.stringify({ obsId: id, afterSeq: previousAction?.seq ?? null, snapshot }));
    if (exploration) {
      mkdirSync(join(exploration.dir, SNAPSHOT_DIR), { recursive: true });
      atomicWriteFile(join(exploration.dir, SNAPSHOT_DIR, `${label}.json`), `${JSON.stringify(snapshot)}\n`);
      stateView.snapshot = label;
    }
    nextStateObsId = id;
  }

  // 7. optional screenshot
  let screenshot: string | null = null;
  if (options.screenshot) {
    try {
      const dir = exploration ? join(exploration.dir, 'screens') : join(root, 'observe');
      mkdirSync(dir, { recursive: true });
      screenshot = join(dir, `obs-${id}.png`);
      atomicWriteFile(screenshot, await run.device.screencap());
    } catch (error) {
      screenshot = null;
      gaps.push({ kind: 'screenshot-failed', detail: `${codeOf(error)}: ${clip(messageOf(error), 120)}` });
    }
  }

  const anomalies: string[] = [];
  if ((newErrors ?? 0) > 0) anomalies.push('jsDiagError');
  if (web.errorScreen === true) anomalies.push('errorScreen');
  if (logcat.crashes > 0) anomalies.push('androidCrash');
  if (logcat.anrs > 0) anomalies.push('androidAnr');
  if (logcat.processDied > 0) anomalies.push('androidProcessDied');

  const observation: Observation = {
    schema: 1,
    id,
    at,
    after: previousAction,
    screen: {
      connected: web.connected,
      reason: web.reason,
      pid: web.pid,
      previousPid: web.previousPid,
      pidChanged: web.pid !== null && web.previousPid !== null && web.pid !== web.previousPid,
      url: web.probe ? web.probe.href.split('#')[0] : null,
      route,
      title: web.probe?.title ?? null,
      errorScreen: web.errorScreen,
      elements: web.probe?.elements ?? [],
      hiddenElements: web.probe?.hidden ?? 0,
      elementsNotListed: web.probe?.truncated ?? 0,
      android: ui,
      changedSincePrevious: changed,
      screenshot
    },
    diagnostics: {
      available: web.diag !== null,
      baseline: prevIds === null ? 'established-now' : 'known',
      newErrors,
      newErrorEntries,
      existingErrors
    },
    android: {
      coverage: logcat.coverage,
      crashes: logcat.crashes,
      anrs: logcat.anrs,
      fatalExceptions: logcat.fatalExceptions,
      processDied: logcat.processDied,
      expectedExits: logcat.expectedExits,
      events: logcat.events,
      logcat: { read: logcat.read, window: logcat.window, linesScanned: logcat.linesScanned, newLines: logcat.newLines }
    },
    state: stateView,
    channels: {
      dom: web.probe ? 'observed' : 'unobserved',
      diagnostics: web.diag ? 'observed' : 'unobserved',
      androidUi: ui.available ? 'observed' : 'unobserved',
      logcat: logcat.read && logcat.coverage === 'full' ? 'observed' : 'unobserved',
      state: !options.state ? 'not-requested' : web.snapshot ? 'observed' : 'unobserved'
    },
    gaps,
    limitations: [...LIMITATIONS],
    assessment: { status: gaps.length > 0 ? 'INCONCLUSIVE' : 'COMPLETE', anomalies, note: NOTE }
  };

  // persist: the baseline for the next look, then the record of this one
  const next: ObserveState = {
    schema: 1,
    sessionId,
    nextObsId: id + 1,
    diagIds: web.diag ? entries.map((entry) => entry.id) : state.diagIds,
    screen: web.probe || ui.available ? { route, dom: web.probe ? domKeys : (state.screen?.dom ?? []), android: ui.available ? androidKeys : (state.screen?.android ?? []), obsId: id } : state.screen,
    logcat: logcat.next,
    stateObsId: nextStateObsId
  };
  atomicWriteFile(stateFile(root), JSON.stringify(next));

  if (exploration && recorder && scope) {
    const dir = join(exploration.dir, 'observations');
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(join(dir, `${String(id).padStart(3, '0')}.json`), `${JSON.stringify(observation)}\n`);
    const delta = observation.state.delta;
    const index: ObservationIndex = {
      id,
      at,
      afterSeq: previousAction?.seq ?? null,
      afterCommand: previousAction?.command ?? null,
      status: observation.assessment.status,
      connected: web.connected,
      anomalies,
      newJsErrors: newErrors ?? 0,
      crashes: logcat.crashes,
      anrs: logcat.anrs,
      processDied: logcat.processDied,
      errorScreen: web.errorScreen === true,
      gaps: [...new Set(gaps.map((gap) => gap.kind))],
      state: delta
        ? {
            added: delta.stores.reduce((total, store) => total + (store.added ?? 0), 0),
            removed: delta.stores.reduce((total, store) => total + (store.removed ?? 0), 0),
            updated: delta.stores.reduce((total, store) => total + (store.updated ?? 0), 0),
            localStorageChanged: delta.localStorage.added.length + delta.localStorage.removed.length + delta.localStorage.updated.length
          }
        : null,
      screenChanged: changed ? changed.routeChanged || changed.domAdded + changed.domRemoved + changed.androidAdded + changed.androidRemoved > 0 : null
    };
    recorder.appendObservation(index);
    scope.attachObservation(id, anomalies);
  } else {
    atomicWriteFile(join(root, 'observe-last.json'), `${JSON.stringify(observation)}\n`);
  }
  return observation;
}
