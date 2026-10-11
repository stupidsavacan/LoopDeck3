import { uiSnapshot } from './actions.js';
import { APP_PACKAGE, ROTATION_SETTINGS, TIMEOUTS, type TrackedSettingKey } from './constants.js';
import { restoreSetting } from './deviceSettings.js';
import { DeviceCliError } from './errors.js';
import { hostAdb, openPinnedDevice, type Deps, type DeviceRun } from './runtime.js';
import { SessionHandle, type SessionPaths } from './session.js';
import { isAppReady, isLandscape, topLevelPackages, waitFor } from './ui.js';
import { releaseForward } from './webview.js';

export interface PrepareReport {
  sessionId: string;
  package: string;
  versionName: string | null;
  versionCode: string | null;
  originalsRecorded: boolean;
}

/** Pins the physical identity and persists the DIRTY record (with original rotation settings) before any mutation. */
export interface PrepareOptions {
  /**
   * Allow a device where the debug app is not installed yet (`install`, a scenario that starts with
   * `installApk`). The serial is still pinned and its physical identity re-read, exactly as usual.
   */
  allowMissingApp?: boolean;
}

export async function prepareSession(
  deps: Deps,
  paths: SessionPaths,
  serial: string,
  launch: boolean,
  options: PrepareOptions = {}
): Promise<{ run: DeviceRun; report: PrepareReport }> {
  const existing = SessionHandle.read(paths, deps.now);
  if (existing && existing.record.status === 'DIRTY') {
    throw new DeviceCliError(
      'SESSION',
      `An active session already exists at ${paths.root}. Run "ldev finish" (it stays DIRTY until restoration is verified) before preparing another.`
    );
  }
  const device = hostAdb(deps).device(serial);
  const identity = await device.readIdentity();
  device.pin(identity);
  const info = await device.packageInfo();
  if (!info.installed && !options.allowMissingApp) throw new DeviceCliError('ADB', `${APP_PACKAGE} is not installed on the device`);
  if (launch && !info.installed) throw new DeviceCliError('ADB', `${APP_PACKAGE} is not installed on the device`);
  const originals = {
    accelerometer_rotation: await device.getSetting('accelerometer_rotation'),
    user_rotation: await device.getSetting('user_rotation')
  };
  const session = SessionHandle.create(paths, { transport: serial, identity, originals }, deps.now);
  const run = openPinnedDevice(deps, session);
  if (launch) await launchAndWait(run);
  return {
    run,
    report: {
      sessionId: session.record.id,
      package: APP_PACKAGE,
      versionName: info.versionName,
      versionCode: info.versionCode,
      originalsRecorded: true
    }
  };
}

export async function waitAppReady(run: DeviceRun, timeoutMs: number = TIMEOUTS.uiReadyMs): Promise<void> {
  await waitFor(run.deps.clock, () => uiSnapshot(run), isAppReady, 'the debug app UI to become ready', timeoutMs);
}

async function launchAndWait(run: DeviceRun): Promise<void> {
  await run.device.startApp();
  await waitAppReady(run);
}

export type LifecycleAction = 'background' | 'resume' | 'relaunch' | 'kill';

export async function lifecycle(
  run: DeviceRun,
  action: LifecycleAction
): Promise<{ action: LifecycleAction; pid: number | null; pidChanged: boolean }> {
  const before = await run.device.pids();
  if (action === 'background') {
    await run.device.goHome();
    await waitFor(
      run.deps.clock,
      () => uiSnapshot(run),
      (snapshot) => !topLevelPackages(snapshot).includes(APP_PACKAGE),
      'the app to leave the foreground'
    );
  } else if (action === 'resume') {
    await launchAndWait(run);
  } else if (action === 'kill') {
    // Stops the process and does NOT start it again; the pid list must really be empty afterwards.
    await run.device.forceStopApp();
    await waitFor(
      run.deps.clock,
      () => run.device.pids(),
      (pids) => pids.length === 0,
      'the app process to exit',
      TIMEOUTS.processStopMs
    );
  } else {
    await run.device.forceStopApp(); // debug package only; never clears data
    await launchAndWait(run);
  }
  const after = await run.device.pids();
  return { action, pid: after.length === 1 ? after[0] : null, pidChanged: before.join() !== after.join() };
}

export async function rotate(
  run: DeviceRun,
  orientation: 'portrait' | 'landscape'
): Promise<{ orientation: string; rotation: number | null }> {
  // Persist intent first: from here on `finish` must restore the originals.
  run.session.commit((draft) => {
    draft.rotationMutated = true;
  });
  await run.device.putSetting('accelerometer_rotation', '0');
  await run.device.putSetting('user_rotation', orientation === 'landscape' ? '1' : '0');
  const snapshot = await waitFor(
    run.deps.clock,
    () => uiSnapshot(run),
    (candidate) => isLandscape(candidate) === (orientation === 'landscape'),
    `${orientation} display orientation`
  );
  return { orientation, rotation: snapshot.rotation };
}

export interface FinishStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface FinishOptions {
  /** Clear an unattributed pending-forward marker without removing anything. */
  acceptUnownedForward: boolean;
}

/**
 * Restores exactly what this session recorded and verifies it. Anything that cannot be
 * verified leaves the record DIRTY and is reported; user data is never cleaned up.
 */
export async function finishSession(run: DeviceRun, options: FinishOptions): Promise<{ steps: FinishStep[] }> {
  const { device, session } = run;
  const steps: FinishStep[] = [];
  const attempt = async (step: string, work: () => Promise<string | void>): Promise<boolean> => {
    try {
      steps.push({ step, ok: true, detail: (await work()) || undefined });
      return true;
    } catch (error) {
      steps.push({ step, ok: false, detail: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  if (!(await attempt('verify-identity', () => device.verifyIdentity()))) return conclude(run, steps);

  if (session.record.rotationMutated) {
    let restored = true;
    for (const key of ROTATION_SETTINGS) {
      const original = session.record.originals[key];
      restored =
        (await attempt(`restore-${key}`, async () => {
          if (original === null) await device.deleteSetting(key);
          else await device.putSetting(key, original);
          const actual = await device.getSetting(key);
          if (actual !== original)
            throw new Error(
              `verification failed: expected ${original === null ? 'unset' : original}, found ${actual === null ? 'unset' : actual}`
            );
        })) && restored;
    }
    if (restored) session.commit((draft) => void (draft.rotationMutated = false));
  }

  for (const key of Object.keys(session.record.changedSettings ?? {}) as TrackedSettingKey[]) {
    const original = session.record.changedSettings?.[key]?.original ?? null;
    const restored = await attempt(`restore-${key}`, () => restoreSetting(device, key, original));
    if (restored) {
      session.commit((draft) => {
        const { [key]: _done, ...rest } = draft.changedSettings ?? {};
        draft.changedSettings = rest;
      });
    }
  }

  for (const forward of [...session.record.forwards]) {
    await attempt(`remove-forward-${forward.port}`, async () => `forward ${await releaseForward(run, forward)}`);
  }

  const pending = session.record.pendingForward;
  if (pending) {
    await attempt('resolve-pending-forward', async () => {
      const unowned = (await device.forwardList()).filter((entry) => entry.remote === pending.remote);
      if (unowned.length > 0 && !options.acceptUnownedForward) {
        throw new Error(
          `an interrupted attach may have left forward(s) ${unowned.map((entry) => entry.local).join(', ')}; they are not provably owned and were not removed. Remove them manually or re-run finish with --accept-unowned-forward.`
        );
      }
      session.commit((draft) => void (draft.pendingForward = null));
      return unowned.length > 0 ? 'left in place by request' : 'none present';
    });
  }
  return conclude(run, steps);
}

function conclude(run: DeviceRun, steps: FinishStep[]): { steps: FinishStep[] } {
  const failed = steps.filter((step) => !step.ok);
  run.session.commit((draft) => {
    draft.notes = failed.map((step) => `finish: ${step.step}: ${step.detail}`).slice(0, 20);
    const unrestored = Object.keys(draft.changedSettings ?? {}).length > 0;
    if (failed.length === 0 && draft.forwards.length === 0 && draft.pendingForward === null && !draft.rotationMutated && !unrestored)
      draft.status = 'CLEAN';
  });
  if (failed.length > 0 || run.session.record.status !== 'CLEAN') {
    throw new DeviceCliError('CLEANUP_FAILED', `Session stays DIRTY: ${failed.map((step) => step.step).join(', ') || 'unverified state'}`, {
      steps
    });
  }
  return { steps };
}
