import * as actions from './actions.js';
import { assertSerial } from './adb.js';
import { collect, type CollectOptions } from './evidence.js';
import type { Locator } from './pageScripts.js';
import { acquireLock } from './lock.js';
import { finishSession, lifecycle, prepareSession, rotate, type LifecycleAction } from './lifecycle.js';
import { defaultDeps, type Deps, type DeviceRun } from './runtime.js';
import { sessionPaths } from './session.js';
import { withWebView, type WebViewHandle } from './webview.js';

/** Typed operations for finite QA scripts. Each call is the same code path the CLI uses. */
export interface DeviceSessionApi {
  run: DeviceRun;
  webView<T>(work: (handle: WebViewHandle) => Promise<T>): Promise<T>;
  tap(locator: Locator, options?: { native?: boolean }): Promise<actions.TapReport>;
  swipe(
    locator: Locator,
    direction: 'up' | 'down' | 'left' | 'right',
    options?: { distance?: number; durationMs?: number }
  ): Promise<actions.SwipeReport>;
  expectVisible(target: { text: string } | { css: string }, timeoutMs?: number): Promise<actions.ExpectReport>;
  rotate(orientation: 'portrait' | 'landscape'): Promise<{ orientation: string; rotation: number | null }>;
  lifecycle(action: LifecycleAction): ReturnType<typeof lifecycle>;
  collect(options: CollectOptions): ReturnType<typeof collect>;
}

export interface WithDeviceSessionOptions {
  serial: string;
  /** Session directory; defaults to qa-results/android. */
  session?: string;
  launch?: boolean;
  /** Let the session start on a phone that does not have the debug app yet (a run that begins with installApk). */
  allowMissingApp?: boolean;
  deps?: Partial<Deps>;
}

/**
 * prepare -> your script -> finish, with finish in `finally`. If the script throws, the
 * original error wins and a failed finish is attached as `cause` details. If the process is
 * killed, the DIRTY session record stays on disk for `ldev finish`.
 *
 * Holds the session's host lock for the whole script, so ldev CLI calls against the same
 * session directory are refused while it runs. This is a local file lock, not device arbitration.
 */
export async function withDeviceSession<T>(options: WithDeviceSessionOptions, script: (api: DeviceSessionApi) => Promise<T>): Promise<T> {
  assertSerial(options.serial);
  const deps: Deps = { ...defaultDeps(), ...options.deps };
  const paths = sessionPaths(options.session, deps.cwd);
  const lock = acquireLock(paths.lock, 'withDeviceSession', deps.now);
  try {
    const { run } = await prepareSession(deps, paths, options.serial, false, { allowMissingApp: options.allowMissingApp });
    let failure: unknown;
    let value!: T;
    try {
      if (options.launch) await lifecycle(run, 'resume');
      value = await script({
        run,
        webView: (work) => withWebView(run, work),
        tap: (locator, opts) => actions.tap(run, locator, opts?.native ?? false),
        swipe: (locator, direction, opts) => actions.swipe(run, locator, direction, opts?.distance ?? 120, opts?.durationMs ?? 350),
        expectVisible: (target, timeoutMs = 5_000) => actions.expectVisible(run, target, timeoutMs),
        rotate: (orientation) => rotate(run, orientation),
        lifecycle: (action) => lifecycle(run, action),
        collect: (collectOptions) => collect(run, collectOptions)
      });
    } catch (error) {
      failure = error;
    }
    try {
      await finishSession(run, { acceptUnownedForward: false });
    } catch (finishError) {
      if (failure === undefined) throw finishError;
      if (failure instanceof Error) (failure as Error & { finishError?: unknown }).finishError = finishError;
    }
    if (failure !== undefined) throw failure;
    return value;
  } finally {
    lock.release();
  }
}
