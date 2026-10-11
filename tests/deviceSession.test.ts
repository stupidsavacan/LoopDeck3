import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uiSnapshot } from '../tools/device/actions';
import { DeviceCliError } from '../tools/device/errors';
import { acquireLock } from '../tools/device/lock';
import { finishSession, prepareSession, rotate } from '../tools/device/lifecycle';
import { sessionPaths } from '../tools/device/session';
import { withWebView } from '../tools/device/webview';
import { APP, FakeAdb, FakeCdp, NULL_ROOT, appUi, fakeDeps, tempDir } from './helpers/deviceFakes';

const APP_REMOTE = (pid: number) => `localabstract:webview_devtools_remote_${pid}`;

async function setup() {
  const dir = tempDir();
  const adb = new FakeAdb();
  const cdp = new FakeCdp();
  const deps = fakeDeps(adb, cdp, dir);
  const paths = sessionPaths(undefined, dir);
  const { run, report } = await prepareSession(deps, paths, 'T1', false);
  const file = () => JSON.parse(readFileSync(paths.file, 'utf8'));
  return { dir, adb, cdp, deps, paths, run, report, file };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as DeviceCliError).code;
  }
  return 'NO_ERROR';
};

describe('session pinning and preparation', () => {
  it('pins the physical identity and persists a DIRTY record with the original settings before any mutation', async () => {
    const { adb, file, report } = await setup();
    expect(file()).toMatchObject({
      status: 'DIRTY',
      transport: 'T1',
      identity: 'PHYS1',
      package: APP,
      originals: { accelerometer_rotation: '1', user_rotation: null },
      rotationMutated: false,
      forwards: []
    });
    expect(report.versionName).toBe('0.3.1-debug');
    expect(adb.mutations()).toEqual([]);
  });

  it('refuses a second prepare while a session is active, without issuing any adb command', async () => {
    const { adb, deps, paths } = await setup();
    const before = adb.calls.length;
    expect(await code(prepareSession(deps, paths, 'T1', false))).toBe('SESSION');
    expect(adb.calls.length).toBe(before);
  });

  it('rejects an unsafe serial before spawning anything', async () => {
    const dir = tempDir();
    const adb = new FakeAdb();
    const deps = fakeDeps(adb, new FakeCdp(), dir);
    expect(await code(prepareSession(deps, sessionPaths(undefined, dir), 'T1; rm -rf /', false))).toBe('USAGE');
    expect(adb.calls).toEqual([]);
  });

  it('refuses to operate when the same transport now answers for a different physical device', async () => {
    const { adb, run } = await setup();
    adb.devices.T1 = 'SOMEONE-ELSE';
    expect(await code(run.device.tap(10, 10))).toBe('IDENTITY');
    expect(adb.mutations()).toEqual([]);
  });

  it('serializes invocations with an exclusive lock that is never stolen', async () => {
    const dir = tempDir();
    const path = join(dir, 'session.lock');
    const first = acquireLock(path, 'one');
    expect(() => acquireLock(path, 'two')).toThrowError(/locked by another ldev invocation/);
    first.release();
    acquireLock(path, 'three').release();
  });
});

describe('UI dump', () => {
  it('uses a private temp file, reads it back and removes it', async () => {
    const { adb, run } = await setup();
    await uiSnapshot(run);
    expect(adb.lastUiPath).toMatch(/^\/data\/local\/tmp\/ldev-ui-[0-9a-f]{24}\.xml$/);
    expect(adb.removedUiPaths).toContain(adb.lastUiPath);
    expect(adb.calls.flat().join(' ')).not.toContain('/dev/tty');
  });

  it('retries a null root a bounded number of times and then succeeds', async () => {
    const { adb, run } = await setup();
    adb.ui = [NULL_ROOT, NULL_ROOT, appUi({ width: 1080, height: 2400 })];
    const snapshot = await uiSnapshot(run);
    expect(snapshot.nodes.length).toBe(2);
    expect(adb.calls.filter((args) => args.includes('uiautomator')).length).toBe(3);
  });

  it('gives up after the bound when the root stays null', async () => {
    const { adb, run } = await setup();
    adb.ui = [NULL_ROOT];
    expect(await code(uiSnapshot(run))).toBe('UI');
    expect(adb.calls.filter((args) => args.includes('uiautomator')).length).toBe(6);
  });
});

describe('WebView attach and forward ownership', () => {
  it('records the forward before connecting, then disconnects and removes only that forward', async () => {
    const { adb, cdp, run, paths } = await setup();
    adb.forwards.push({ serial: 'T1', local: 'tcp:55555', remote: 'localabstract:chrome_devtools_remote' });
    let recordedBeforeConnect: number[] = [];
    const connect = cdp.connect.bind(cdp);
    cdp.connect = async (endpoint) => {
      recordedBeforeConnect = JSON.parse(readFileSync(paths.file, 'utf8')).forwards.map((f: { port: number }) => f.port);
      return connect(endpoint);
    };
    const result = await withWebView(run, async ({ port, pid }) => ({ port, pid }));
    expect(result).toEqual({ port: 40001, pid: 4321 });
    expect(recordedBeforeConnect).toEqual([40001]);
    expect(cdp.endpoints).toEqual(['http://127.0.0.1:40001']);
    expect(cdp.closed).toBe(1);
    expect(adb.forwards.map((f) => f.local)).toEqual(['tcp:55555']); // the unrelated forward survives
    expect(run.session.record.forwards).toEqual([]);
  });

  it('cleans up the forward when the work fails and keeps the original error', async () => {
    const { adb, run } = await setup();
    await expect(
      withWebView(run, async () => {
        throw new Error('work exploded');
      })
    ).rejects.toThrow('work exploded');
    expect(adb.forwards).toEqual([]);
    expect(run.session.record.forwards).toEqual([]);
  });

  it('cleans up when the CDP connection fails', async () => {
    const { adb, cdp, run } = await setup();
    cdp.connectError = new Error('refused');
    await expect(withWebView(run, async () => 1)).rejects.toThrow('refused');
    expect(adb.forwards).toEqual([]);
  });

  it('refuses ambiguous app processes before creating any forward', async () => {
    const { adb, run } = await setup();
    adb.pids = [11, 12];
    expect(await code(withWebView(run, async () => 1))).toBe('WEBVIEW');
    expect(adb.calls.some((args) => args.includes('tcp:0'))).toBe(false);
  });

  it('refuses ambiguous devtools sockets for the pid', async () => {
    const { adb, run } = await setup();
    adb.sockets = (pid) =>
      `Num RefCount Protocol Flags Type St Inode Path\n0: 2 0 00010000 0001 01 1 @webview_devtools_remote_${pid}\n0: 2 0 00010000 0001 01 2 @webview_devtools_remote_${pid}\n`;
    expect(await code(withWebView(run, async () => 1))).toBe('WEBVIEW');
  });

  it('ignores a devtools socket that belongs to another pid', async () => {
    const { adb, run } = await setup();
    adb.sockets = () => 'Num RefCount Protocol Flags Type St Inode Path\n0: 2 0 00010000 0001 01 1 @webview_devtools_remote_9999\n';
    expect(await code(withWebView(run, async () => 1))).toBe('WEBVIEW');
  });

  it('refuses unrelated or multiple pages and still cleans up', async () => {
    const { adb, cdp, run } = await setup();
    cdp.pages = [{ url: 'https://example.com/' }];
    expect(await code(withWebView(run, async () => 1))).toBe('WEBVIEW');
    cdp.pages = [{ url: 'https://appassets.androidplatform.net/assets/loopdeck/index.html' }, { url: 'about:blank' }];
    expect(await code(withWebView(run, async () => 1))).toBe('WEBVIEW');
    expect(adb.forwards).toEqual([]);
  });

  it('does not adopt anything when forward allocation fails: the pending marker stays for a reviewed finish', async () => {
    const { adb, run, file } = await setup();
    adb.failures.push((args) => args.includes('tcp:0'));
    adb.forwards.push({ serial: 'T1', local: 'tcp:60000', remote: APP_REMOTE(4321) }); // not ours
    expect(await code(withWebView(run, async () => 1))).toBe('ADB');
    expect(file().pendingForward).toMatchObject({ remote: APP_REMOTE(4321) });
    expect(file().forwards).toEqual([]);
    expect(adb.calls.some((args) => args.includes('--remove'))).toBe(false);
    // finish refuses to guess about the matching foreign forward ...
    expect(await code(finishSession(run, { acceptUnownedForward: false }))).toBe('CLEANUP_FAILED');
    expect(file().status).toBe('DIRTY');
    expect(adb.forwards.map((f) => f.local)).toEqual(['tcp:60000']);
    // ... and only completes when the operator explicitly accepts leaving it in place.
    await finishSession(run, { acceptUnownedForward: true });
    expect(file().status).toBe('CLEAN');
    expect(adb.forwards.map((f) => f.local)).toEqual(['tcp:60000']);
  });
});

describe('rotate and finish', () => {
  it('restores exactly the original values (deleting a setting that was unset) and verifies them', async () => {
    const { adb, run, file } = await setup();
    await rotate(run, 'landscape').catch(() => undefined); // UI never turns landscape in the fake; intent is persisted first
    expect(file().rotationMutated).toBe(true);
    expect(adb.settings).toMatchObject({ accelerometer_rotation: '0', user_rotation: '1' });
    await finishSession(run, { acceptUnownedForward: false });
    expect(adb.settings).toEqual({ accelerometer_rotation: '1', user_rotation: null });
    expect(adb.shellCalls).toContainEqual(['settings', 'delete', 'system', 'user_rotation']);
    expect(file()).toMatchObject({ status: 'CLEAN', rotationMutated: false });
  });

  it('stays DIRTY when a restore cannot be verified, and never removes an unrelated forward', async () => {
    const { adb, run, file } = await setup();
    await rotate(run, 'landscape').catch(() => undefined);
    adb.forwards.push({ serial: 'T1', local: 'tcp:55555', remote: 'localabstract:chrome_devtools_remote' });
    adb.failures.push((args) => args.includes('settings') && args.includes('accelerometer_rotation') && args.includes('put'));
    expect(await code(finishSession(run, { acceptUnownedForward: false }))).toBe('CLEANUP_FAILED');
    expect(file().status).toBe('DIRTY');
    expect(file().rotationMutated).toBe(true);
    expect(file().notes.join(' ')).toContain('restore-accelerometer_rotation');
    expect(adb.forwards.map((f) => f.local)).toEqual(['tcp:55555']);
  });

  it('retains DIRTY without touching the device when the identity no longer matches', async () => {
    const { adb, run, file } = await setup();
    adb.devices.T1 = 'OTHER';
    expect(await code(finishSession(run, { acceptUnownedForward: false }))).toBe('CLEANUP_FAILED');
    expect(file().status).toBe('DIRTY');
    expect(adb.mutations()).toEqual([]);
  });

  it('removes a leftover owned forward at finish, but leaves a reassigned (foreign) port alone', async () => {
    const { adb, run, file } = await setup();
    run.session.commit((draft) => {
      draft.forwards.push({ port: 40001, remote: APP_REMOTE(4321), pid: 4321, createdAt: 'x' });
      draft.forwards.push({ port: 40002, remote: APP_REMOTE(4321), pid: 4321, createdAt: 'x' });
    });
    adb.forwards.push({ serial: 'T1', local: 'tcp:40001', remote: APP_REMOTE(4321) });
    adb.forwards.push({ serial: 'T1', local: 'tcp:40002', remote: 'localabstract:someone_else' });
    await finishSession(run, { acceptUnownedForward: false });
    expect(adb.forwards.map((f) => f.local)).toEqual(['tcp:40002']);
    expect(file().status).toBe('CLEAN');
  });
});
