import {
  APP_METADATA_STORES,
  APP_PACKAGE,
  TIMEOUTS,
  USER_DATA_STORES,
  USER_LOCAL_STORAGE_KEYS,
  USER_LOCAL_STORAGE_PREFIXES
} from './constants.js';
import { DeviceCliError, withTimeout } from './errors.js';
import { waitAppReady } from './lifecycle.js';
import { readLocalStorageKeys, type LocalStorageKeys } from './pageScripts.js';
import type { DeviceRun } from './runtime.js';
import { captureStateInPage, defaultCaptureArg, type CaptureResult } from './state.js';
import { withWebView, type CdpPage } from './webview.js';

export interface FreshReport {
  fresh: boolean;
  /** One entry per learner-data store, in the order of USER_DATA_STORES. `count` is null when the store is missing from the capture. */
  userStores: { name: string; count: number | null }[];
  /** What the app wrote by itself after the wipe; informational, never a failure. */
  appMetadata: { stores: { name: string; count: number | null }[]; localStorageKeys: string[] };
  leftover: { stores: string[]; localStorageKeys: string[] };
  problems: string[];
}

/** localStorage key names that are learner data (see constants.ts); everything else is app metadata. */
export const isUserLocalStorageKey = (key: string): boolean =>
  USER_LOCAL_STORAGE_KEYS.includes(key) || USER_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));

/** Pure judgement over one IndexedDB capture and one localStorage key listing. */
export function judgeFreshState(capture: CaptureResult, local: LocalStorageKeys): FreshReport {
  const problems: string[] = [];
  if (!capture.ok || !capture.complete) problems.push(`IndexedDB capture incomplete: ${capture.reasons.join('; ') || 'unknown'}`);
  const countOf = (name: string): number | null => capture.stores.find((store) => store.name === name)?.count ?? null;
  const userStores = USER_DATA_STORES.map((name) => ({ name, count: countOf(name) }));
  const leftoverStores = userStores
    .filter((store) => store.count !== null && store.count > 0)
    .map((store) => `${store.name}=${store.count}`);
  for (const store of userStores) if (store.count === null && capture.ok) problems.push(`store ${store.name} is missing from the database`);
  if (!local.ok) problems.push('localStorage is unreadable');
  const leftoverKeys = local.keys.filter(isUserLocalStorageKey);
  if (leftoverStores.length > 0) problems.push(`learner data remains in IndexedDB: ${leftoverStores.join(', ')}`);
  if (leftoverKeys.length > 0) problems.push(`learner data remains in localStorage: ${leftoverKeys.length} key(s)`);
  return {
    fresh: problems.length === 0,
    userStores,
    appMetadata: {
      stores: APP_METADATA_STORES.map((name) => ({ name, count: countOf(name) })),
      localStorageKeys: local.keys.filter((key) => !isUserLocalStorageKey(key))
    },
    leftover: { stores: leftoverStores, localStorageKeys: leftoverKeys },
    problems
  };
}

/**
 * Reads the page until the app has created its database (it does so while starting), then judges.
 * A page that never produces a readable database is a failure to verify, not a pass.
 */
export async function verifyFreshState(run: DeviceRun, page: CdpPage): Promise<FreshReport> {
  const { clock } = run.deps;
  const deadline = clock.now() + TIMEOUTS.resetVerifyMs;
  let report: FreshReport;
  for (;;) {
    const capture = await withTimeout(page.evaluate(captureStateInPage, defaultCaptureArg()), TIMEOUTS.stateCaptureMs, 'state capture');
    const local = await withTimeout(page.evaluate(readLocalStorageKeys, undefined), TIMEOUTS.cdpEvaluateMs, 'localStorage read');
    report = judgeFreshState(capture, local);
    // A leftover is a leftover at once; only an unreadable or not-yet-created database is worth waiting for.
    if (report.leftover.stores.length > 0 || report.leftover.localStorageKeys.length > 0) return report;
    if (report.fresh || clock.now() >= deadline) return report;
    await clock.sleep(TIMEOUTS.uiPollMs * 2);
  }
}

export interface ClearReport {
  pidsBefore: number[];
  pidsAfter: number[];
  processRestarted: boolean;
  allowBackup: boolean | null;
}

/** `pm clear` on the debug package, then start it again. Does not look at the data; verifyFreshState does. */
export async function clearAndRelaunch(run: DeviceRun, beforeStop?: (pids: number[]) => void): Promise<ClearReport> {
  const { device } = run;
  const info = await device.packageInfo();
  if (!info.installed) throw new DeviceCliError('ADB', `${APP_PACKAGE} is not installed; install it first`);
  const pidsBefore = await device.pids();
  beforeStop?.(pidsBefore);
  await device.clearAppData();
  await device.startApp();
  await waitAppReady(run, TIMEOUTS.freshStartMs);
  const pidsAfter = await device.pids();
  return {
    pidsBefore,
    pidsAfter,
    processRestarted: pidsAfter.length > 0 && pidsAfter.every((pid) => !pidsBefore.includes(pid)),
    allowBackup: info.allowBackup
  };
}

/** Failure for leftovers, with everything known about why. */
export function leftoverError(report: FreshReport, clear: ClearReport): DeviceCliError {
  const causes: string[] = [];
  if (!clear.processRestarted)
    causes.push('the app process was not restarted after pm clear (its in-memory data may have been written back)');
  if (clear.allowBackup) {
    causes.push('the app allows backup (ALLOW_BACKUP): Android Auto Backup may restore data after pm clear or when the app starts');
  }
  if (causes.length === 0) causes.push('the cause is unknown: the app restarted and still holds learner data');
  return new DeviceCliError('RUN_ERROR', `Reset failed: ${report.problems.join('; ')}`, {
    leftover: report.leftover,
    possibleCauses: causes,
    allowBackup: clear.allowBackup,
    processRestarted: clear.processRestarted
  });
}

export interface ResetReport extends ClearReport {
  fresh: FreshReport;
}

/** CLI form: clear, relaunch, attach once, verify, detach. */
export async function resetApp(run: DeviceRun): Promise<ResetReport> {
  const clear = await clearAndRelaunch(run);
  const fresh = await withWebView(run, ({ page }) => verifyFreshState(run, page));
  if (!fresh.fresh) throw leftoverError(fresh, clear);
  return { ...clear, fresh };
}
