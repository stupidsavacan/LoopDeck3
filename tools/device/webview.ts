import type { AdbDevice } from './adb.js';
import type { Page } from '@playwright/test';
import { APP_PAGE_URL, TIMEOUTS } from './constants.js';
import { DeviceCliError, withTimeout } from './errors.js';
import type { DeviceRun } from './runtime.js';
import type { Point } from './geometry.js';
import type { ElementMeasure, Locator, ProbeArg, ProbeResult } from './pageScripts.js';
import { domProbe } from './pageScripts.js';
import type { OwnedForward } from './session.js';

export interface LocateResult {
  /** Elements matching, and how many of those are visible (Playwright semantics). */
  total: number;
  visible: number;
  /** Set unless exactly one visible element resolved. */
  error?: string;
  measure?: ElementMeasure;
}

export type ExpectTarget = { text: string } | { css: string };

export interface CdpPage {
  /** Verified Android page for repository Playwright fixtures; absent in host fakes. */
  playwrightPage?: Page;
  url(): string;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** Strict Playwright resolution (getByRole exact name, or CSS); measures the single visible match. */
  locate(locator: Locator, options: { scroll: boolean; points?: Point[] }): Promise<LocateResult>;
  /** Visible matches of Playwright getByText(exact) or CSS; -1 when the CSS selector is invalid. */
  countVisible(target: ExpectTarget): Promise<number>;
  /** Real mouse input at layout-viewport CSS coordinates (not Android input). */
  mouseClick(x: number, y: number): Promise<void>;
}

export interface CdpBrowser {
  pages(): CdpPage[];
  /** Disconnects only. Must never close or kill the Android app. */
  close(): Promise<void>;
}

export interface CdpConnector {
  connect(endpoint: string, timeoutMs: number): Promise<CdpBrowser>;
}

export interface WebViewHandle {
  page: CdpPage;
  pid: number;
  port: number;
  previousPid: number | null;
}

const pageKey = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
};

export async function selectAppPid(device: AdbDevice): Promise<number> {
  const pids = await device.pids();
  if (pids.length === 0) throw new DeviceCliError('WEBVIEW', 'The debug app is not running');
  if (pids.length > 1) throw new DeviceCliError('WEBVIEW', `Ambiguous app processes (${pids.length}); refusing to guess`);
  return pids[0];
}

/** The devtools socket must be named for exactly this PID and listen exactly once. */
export async function requireDevtoolsSocket(device: AdbDevice, pid: number): Promise<string> {
  const name = `webview_devtools_remote_${pid}`;
  const listening = new Set(
    (await device.procNetUnix()).filter((socket) => socket.name === name && socket.listening).map((socket) => socket.inode)
  );
  if (listening.size === 0) throw new DeviceCliError('WEBVIEW', `No WebView devtools socket for pid ${pid}`);
  if (listening.size > 1) throw new DeviceCliError('WEBVIEW', `Ambiguous WebView devtools sockets for pid ${pid}`);
  return `localabstract:${name}`;
}

export function selectAppPage(pages: CdpPage[]): CdpPage {
  const appPages = pages.filter((page) => pageKey(page.url()) === APP_PAGE_URL);
  if (pages.length !== 1 || appPages.length !== 1) {
    throw new DeviceCliError(
      'WEBVIEW',
      `Expected exactly one DevTools page at the app origin/path; found ${pages.length} page(s), ${appPages.length} matching`
    );
  }
  return appPages[0];
}

type ReleaseOutcome = 'removed' | 'absent' | 'foreign';

/** Removes a forward this session owns, but only after confirming it is still the same mapping. */
export async function releaseForward(run: DeviceRun, forward: OwnedForward): Promise<ReleaseOutcome> {
  const { device, session } = run;
  const local = `tcp:${forward.port}`;
  const entry = (await device.forwardList()).find((candidate) => candidate.local === local);
  let outcome: ReleaseOutcome;
  if (!entry) {
    outcome = 'absent';
  } else if (entry.remote !== forward.remote) {
    outcome = 'foreign'; // the port was reused by someone else's mapping: never touch it
  } else {
    await device.forwardRemove(forward.port);
    if ((await device.forwardList()).some((candidate) => candidate.local === local)) {
      throw new DeviceCliError('ADB', `Forward tcp:${forward.port} is still present after removal`);
    }
    outcome = 'removed';
  }
  session.commit((draft) => {
    draft.forwards = draft.forwards.filter((owned) => owned.port !== forward.port);
    if (outcome === 'foreign') draft.notes.push(`Port ${forward.port} was reassigned to a foreign forward; left untouched`);
  });
  return outcome;
}

/**
 * Attach for one finite unit of work: pick the single app PID, forward its devtools socket
 * to a free host port, persist ownership BEFORE connecting, connect over CDP, run `work`,
 * then disconnect and remove only that forward. Re-attaches transparently after PID changes.
 */
export async function withWebView<T>(run: DeviceRun, work: (handle: WebViewHandle) => Promise<T>): Promise<T> {
  const { device, session, deps } = run;
  const pid = await selectAppPid(device);
  const remote = await requireDevtoolsSocket(device, pid);
  const previousPid = session.record.lastPid;
  session.commit((draft) => {
    draft.pendingForward = { remote, since: deps.now().toISOString() };
  });

  // If allocation fails or is interrupted, ownership cannot be proven: the pending marker stays
  // and a reviewed `finish` decides. Nothing is adopted or removed by guesswork here.
  const port = await device.forwardCreate(remote);
  const owned: OwnedForward = { port, remote, pid, createdAt: deps.now().toISOString() };
  session.commit((draft) => {
    draft.pendingForward = null;
    draft.forwards.push(owned);
    draft.lastPid = pid;
  });

  let browser: CdpBrowser | null = null;
  let primary: unknown = null;
  let result!: T;
  try {
    browser = await withTimeout(
      deps.cdp.connect(`http://127.0.0.1:${port}`, TIMEOUTS.cdpConnectMs),
      TIMEOUTS.cdpConnectMs + 1_000,
      'CDP connect'
    );
    const page = selectAppPage(browser.pages());
    result = await work({ page, pid, port, previousPid });
  } catch (error) {
    primary = error;
  }
  // Cleanup always runs, in this order, and never masks the primary failure.
  if (browser) await withTimeout(browser.close(), 5_000, 'CDP disconnect').catch(() => undefined);
  try {
    await releaseForward(run, owned);
  } catch (error) {
    if (!primary) primary = error;
  }
  if (primary) throw primary;
  return result;
}

/** Runs the in-page probe with a bounded evaluation time. */
export function probe(page: CdpPage, arg: ProbeArg): Promise<ProbeResult> {
  return withTimeout(page.evaluate(domProbe, arg), TIMEOUTS.cdpEvaluateMs, 'DOM probe');
}
