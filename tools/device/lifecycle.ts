import { uiSnapshot } from './actions.js';
import { APP_PACKAGE, ROTATION_SETTINGS } from './constants.js';
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
export async function prepareSession(
  deps: Deps,
  paths: SessionPaths,
  serial: string,
  launch: boolean
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
  if (!info.installed) throw new DeviceCliError('ADB', `${APP_PACKAGE} is not installed on the device`);
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

async function launchAndWait(run: DeviceRun): Promise<void> {
  await run.device.startApp();
  await waitFor(run.deps.clock, () => uiSnapshot(run), isAppReady, 'the debug app UI to become ready');
}

export type LifecycleAction = 'background' | 'resume' | 'relaunch';

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
    if (failed.length === 0 && draft.forwards.length === 0 && draft.pendingForward === null && !draft.rotationMutated)
      draft.status = 'CLEAN';
  });
  if (failed.length > 0 || run.session.record.status !== 'CLEAN') {
    throw new DeviceCliError('CLEANUP_FAILED', `Session stays DIRTY: ${failed.map((step) => step.step).join(', ') || 'unverified state'}`, {
      steps
    });
  }
  return { steps };
}
