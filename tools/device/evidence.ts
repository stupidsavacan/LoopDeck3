import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureUi, type UiSnapshot } from './ui.js';
import { APP_PACKAGE, TIMEOUTS } from './constants.js';
import { DeviceCliError, withTimeout, type ErrorCode } from './errors.js';
import type { ProbeResult } from './pageScripts.js';
import type { DeviceRun } from './runtime.js';
import { atomicWriteFile } from './session.js';
import { captureStateInPage, compareStates, defaultCaptureArg, summarizeCapture, type CompareOutcome, type StateSummary } from './state.js';
import { probe, withWebView } from './webview.js';

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertLabel(label: string): string {
  if (!LABEL_PATTERN.test(label)) throw new DeviceCliError('USAGE', 'LABEL must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  return label;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Capture status only carries an error CODE, never the message: messages can echo device text. */
type Capture<T = object> = ({ status: 'ok' } & T) | { status: 'failed'; error: string };

export interface EvidenceSummary {
  schema: 1;
  label: string;
  createdAt: string;
  overall: 'PASS' | 'INCOMPLETE';
  repo: Capture<{ revision: string; dirty: boolean }>;
  app: Capture<{ package: string; versionName: string | null; versionCode: string | null }>;
  screenshot: Capture<{ bytes: number; sha256: string }>;
  ui: Capture<{ nodes: number; sha256: string }>;
  dom: Capture<{ items: number; truncated: boolean }>;
  state: (StateSummary & { status: 'ok' }) | { status: 'failed'; error: string };
  logs: Capture<{ lines: number; truncated: boolean; sha256: string }>;
  comparison?: { against: 'previous-summary'; verdict: CompareOutcome['verdict']; reasons: string[] };
}

const failure = (error: unknown): { status: 'failed'; error: string } => ({
  status: 'failed',
  error: error instanceof DeviceCliError ? error.code : 'INTERNAL'
});

async function guarded<T extends object>(work: () => Promise<T>): Promise<Capture<T>> {
  try {
    return { status: 'ok', ...(await work()) };
  } catch (error) {
    return failure(error);
  }
}

/** Reads a summary from a collect directory or a summary.json path. */
export function loadSummary(path: string, cwd: string): EvidenceSummary {
  const target = resolve(cwd, path);
  const file = existsSync(target) && statSync(target).isDirectory() ? join(target, 'summary.json') : target;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new DeviceCliError('USAGE', `Cannot read evidence summary at ${path}`);
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { schema?: unknown }).schema !== 1) {
    throw new DeviceCliError('USAGE', `${path} is not an ldev evidence summary`);
  }
  return parsed as EvidenceSummary;
}

function stateOf(summary: EvidenceSummary): StateSummary | null {
  const state = summary.state;
  return state && state.status === 'ok' ? state : null;
}

/** Offline: reads two summaries and compares state count + canonical digest only. Touches no device and creates nothing. */
export function compareSummaries(a: EvidenceSummary, b: EvidenceSummary): CompareOutcome {
  return compareStates(stateOf(a), stateOf(b));
}

export interface CollectOptions {
  label: string;
  compareTo?: string;
  expectSame: boolean;
}

export interface CollectResult {
  directory: string;
  summary: EvidenceSummary;
}

export async function collect(run: DeviceRun, options: CollectOptions): Promise<CollectResult> {
  const { device, deps } = run;
  const label = assertLabel(options.label);
  if (options.expectSame && !options.compareTo) throw new DeviceCliError('USAGE', '--expect-same requires --compare-to');
  const baseline = options.compareTo ? loadSummary(options.compareTo, deps.cwd) : null;

  mkdirSync(run.session.paths.artifacts, { recursive: true });
  const directory = join(run.session.paths.artifacts, label);
  try {
    mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new DeviceCliError('USAGE', `Evidence "${label}" already exists; labels are never overwritten`);
    throw error;
  }

  const repo = await guarded(async () => {
    const run1 = await deps.runner('git', ['rev-parse', 'HEAD'], { timeoutMs: 10_000, maxBytes: 4096, cwd: deps.cwd });
    const revision = run1.stdout.toString('utf8').trim();
    if (run1.code !== 0 || !/^[0-9a-f]{40}$/.test(revision)) throw new DeviceCliError('INTERNAL', 'git revision unavailable');
    const status = await deps.runner('git', ['status', '--porcelain'], { timeoutMs: 10_000, maxBytes: 1024 * 1024, cwd: deps.cwd });
    return { revision, dirty: status.code !== 0 || status.stdout.length > 0 };
  });

  const app = await guarded(async () => {
    const info = await device.packageInfo();
    if (!info.installed) throw new DeviceCliError('ADB', 'not installed');
    return { package: APP_PACKAGE, versionName: info.versionName, versionCode: info.versionCode };
  });

  const screenshot = await guarded(async () => {
    const png = await device.screencap();
    atomicWriteFile(join(directory, 'screenshot.png'), png);
    return { bytes: png.length, sha256: sha256(png) };
  });

  const ui = await guarded(async () => {
    let raw = '';
    const snapshot: UiSnapshot = await captureUi(async () => (raw = await device.uiDumpRaw()), deps.clock);
    const xml = raw.slice(raw.indexOf('<?xml'), raw.lastIndexOf('</hierarchy>') + '</hierarchy>'.length);
    atomicWriteFile(join(directory, 'ui.xml'), xml);
    return { nodes: snapshot.nodes.length, sha256: sha256(xml) };
  });

  // DOM and state share one attach so a single forward covers both.
  const web: { dom: EvidenceSummary['dom']; state: EvidenceSummary['state'] } = {
    dom: { status: 'failed', error: 'WEBVIEW' },
    state: { status: 'failed', error: 'WEBVIEW' }
  };
  try {
    await withWebView(run, async ({ page }) => {
      web.dom = await guarded(async () => {
        const result = (await probe(page, { mode: 'snapshot', max: 400 })) as Extract<ProbeResult, { mode: 'snapshot' }>;
        atomicWriteFile(join(directory, 'dom.json'), `${JSON.stringify(result.items, null, 2)}\n`);
        return { items: result.items.length, truncated: result.truncated };
      });
      try {
        const captured = await withTimeout(
          page.evaluate(captureStateInPage, defaultCaptureArg()),
          TIMEOUTS.stateCaptureMs,
          'state capture'
        );
        web.state = { status: 'ok', ...summarizeCapture(captured) };
      } catch (error) {
        web.state = failure(error);
      }
    });
  } catch (error) {
    web.dom = failure(error);
    web.state = failure(error);
  }
  const { dom, state } = web;

  const logs = await guarded(async () => {
    const pids = await device.pids();
    if (pids.length !== 1) throw new DeviceCliError('WEBVIEW', 'app pid is not unique');
    const log = await device.logcat(pids[0]);
    atomicWriteFile(join(directory, 'logcat.txt'), log.text);
    return { lines: log.text.split('\n').length - 1, truncated: log.truncated, sha256: sha256(log.text) };
  });

  const parts = [repo, app, screenshot, ui, dom, state, logs];
  const stateComplete = state.status === 'ok' && state.complete;
  const summary: EvidenceSummary = {
    schema: 1,
    label,
    createdAt: deps.now().toISOString(),
    overall: parts.every((part) => part.status === 'ok') && stateComplete ? 'PASS' : 'INCOMPLETE',
    repo,
    app,
    screenshot,
    ui,
    dom,
    state,
    logs
  };
  if (baseline) {
    const outcome = compareStates(stateOf(baseline), stateOf(summary));
    summary.comparison = { against: 'previous-summary', verdict: outcome.verdict, reasons: outcome.reasons };
  }
  atomicWriteFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { directory, summary };
}

/** Maps a finished summary to the error (if any) the command must report; partial evidence is never a pass. */
export function collectFailure(result: CollectResult, expectSame: boolean): { code: ErrorCode; message: string } | null {
  const { summary } = result;
  if (summary.overall !== 'PASS')
    return { code: 'INCOMPLETE', message: 'Evidence is incomplete: one or more captures failed or the state capture was not complete' };
  if (expectSame && summary.comparison && summary.comparison.verdict !== 'same') {
    return {
      code: summary.comparison.verdict === 'incomplete' ? 'INCOMPLETE' : 'CHECK_FAILED',
      message: `State is not the same as the baseline: ${summary.comparison.reasons.join('; ')}`
    };
  }
  return null;
}
