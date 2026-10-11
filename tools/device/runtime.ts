import { setTimeout as delay } from 'node:timers/promises';
import { AdbDevice, HostAdb } from './adb.js';
import { nodeRunner, nodeSpawnStream, type Runner, type StreamSpawner } from './exec.js';
import { playwrightConnector } from './playwrightConnector.js';
import { SessionHandle } from './session.js';
import type { Clock } from './ui.js';
import type { CdpConnector } from './webview.js';

/** Process termination signals, injectable so tests never signal the test runner itself. */
export interface SignalHost {
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  off(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  /** Re-delivers the signal with default behavior once cleanup is done. */
  reraise(signal: 'SIGINT' | 'SIGTERM'): void;
}

export const processSignals: SignalHost = {
  on: (signal, handler) => void process.on(signal, handler),
  off: (signal, handler) => void process.off(signal, handler),
  reraise: (signal) => void process.kill(process.pid, signal)
};

/** Everything with side effects reaches the outside world through here, so tests can fake it. */
export interface Deps {
  runner: Runner;
  /** Long-running processes (logcat). Same rules as `runner`: argv only, no host shell. */
  spawnStream: StreamSpawner;
  signals: SignalHost;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => Date;
  clock: Clock;
  cdp: CdpConnector;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  return {
    runner: nodeRunner,
    spawnStream: nodeSpawnStream,
    signals: processSignals,
    env,
    cwd: process.cwd(),
    now: () => new Date(),
    clock: { now: () => Date.now(), sleep: (ms) => delay(ms) },
    cdp: playwrightConnector
  };
}

export function hostAdb(deps: Deps): HostAdb {
  return new HostAdb({ runner: deps.runner, env: deps.env });
}

/** A device bound to a session: the transport is re-verified against the pinned physical identity on every operation. */
export interface DeviceRun {
  device: AdbDevice;
  session: SessionHandle;
  deps: Deps;
}

export function openPinnedDevice(deps: Deps, session: SessionHandle): DeviceRun {
  const { transport, identity } = session.record;
  return { device: hostAdb(deps).device(transport, identity), session, deps };
}
