import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../tools/device/cli';
import { USER_DATA_STORES as SRC_USER_DATA_STORES } from '../src/storage/indexedDb';
import { APP_LOCAL_STORAGE_KEYS, USER_DATA_STORES } from '../tools/device/constants';
import { isUserLocalStorageKey } from '../tools/device/reset';
import { readdirSync, statSync } from 'node:fs';
import { runScenario } from '../tools/device/runner';
import { parseScenario } from '../tools/device/scenario';
import { SessionHandle, sessionPaths } from '../tools/device/session';
import { checkShellArgv } from '../tools/device/shellPolicy';
import { computeVerdict } from '../tools/device/verdict';
import { APP, FakeAdb, FakeCdp, fakeDeps, tempDir, writeFakeApk, type FakePageSpec } from './helpers/deviceFakes';

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const REL = 'com.loopdeck3.app';
const CLOCKY = 'com.stupidsavacan.clocky';

/** In-memory stand-in for the app's IndexedDB + localStorage. */
class FakeApp {
  data: Record<string, number> = { attempts: 2, bookmarks: 1, packs: 1, packAssets: 3, reviewCards: 5, reviewLogs: 4, contentMetadata: 1 };
  local = ['loopdeck3.diagnostics', 'loopdeck3.session.x', 'loopdeck3.preferences.y', 'loopdeck3.library.last-module'];
  /** Simulates Android Auto Backup putting data back after the wipe. */
  restoreAfterWipe = false;
  wipe(): void {
    if (this.restoreAfterWipe) return;
    for (const key of Object.keys(this.data)) this.data[key] = key === 'contentMetadata' ? 1 : 0;
    // What the real app writes by itself while starting (seen on the phone).
    this.local = ['loopdeck3.diagnostics', 'loopdeck3.library.in-player'];
  }
  capture() {
    return {
      ok: true,
      complete: true,
      version: 2,
      reasons: [],
      stores: Object.entries(this.data).map(([name, count]) => ({
        name,
        count,
        sha256: 'f'.repeat(64),
        keyPath: 'id',
        autoIncrement: false,
        indexes: [],
        complete: true
      }))
    };
  }
}

function setup() {
  const dir = tempDir();
  const adb = new FakeAdb();
  adb.dynamicProcesses = true;
  adb.settings.font_scale = '1.0';
  const app = new FakeApp();
  adb.onDataCleared = () => app.wipe();
  const cdp = new FakeCdp();
  const spec: FakePageSpec = {
    url: 'https://appassets.androidplatform.net/assets/loopdeck/index.html#home',
    countVisible: () => 1,
    locate: () => ({ total: 1, visible: 1 }),
    evaluate: (_arg, fn) => {
      switch (fn.name) {
        case 'readDiagnostics':
          return { ok: true, entries: [] };
        case 'errorScreenPresent':
          return false;
        case 'captureStateInPage':
          return app.capture();
        case 'readLocalStorageKeys':
          return { ok: true, keys: app.local };
        default:
          return undefined;
      }
    }
  };
  cdp.pages = [spec];
  const base = fakeDeps(adb, cdp, dir);
  const deps = { ...base, env: { LDEV_AAPT2: 'aapt2' } };
  const cli = (...argv: string[]) => runCli(argv, deps);
  const json = async (...argv: string[]) => {
    const result = await cli(...argv);
    return {
      ...result,
      json: JSON.parse(result.stdout) as {
        ok: boolean;
        exitCode: number;
        data?: Record<string, any>;
        error?: { code: string; message: string; details?: Record<string, any> };
      }
    };
  };
  const session = () => JSON.parse(readFileSync(sessionPaths(undefined, dir).file, 'utf8'));
  return { dir, adb, app, cdp, spec, deps, cli, json, session };
}

const adbCallsFor = (adb: FakeAdb, word: string) => adb.calls.filter((args) => args.includes(word));

describe('ldev install', () => {
  it('installs the debug APK with adb install -r, hashes it, and records the expectation in the session', async () => {
    const t = setup();
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--serial', 'T1');
    expect(out.json.ok).toBe(true);
    expect(out.json.data).toMatchObject({ package: APP, versionName: '0.3.1-debug', versionCode: '31', sha256: sha(apk), replaced: false });
    expect(t.adb.installs).toEqual([apk]);
    expect(t.adb.calls.some((args) => args.includes('install') && args.includes('-r'))).toBe(true);
    expect(t.adb.uninstalls).toEqual([]);
    expect(t.session().expectedApk).toMatchObject({ sha256: sha(apk), source: 'install' });
    expect(t.session().status).toBe('DIRTY');
  });

  it('works from an uninstalled state (the serial is still pinned and re-verified)', async () => {
    const t = setup();
    t.adb.installed = false;
    t.adb.pids = [];
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--serial', 'T1');
    expect(out.json.ok).toBe(true);
    expect(t.adb.installed).toBe(true);
    expect(t.session()).toMatchObject({ transport: 'T1', identity: 'PHYS1' });
    expect(t.adb.calls.filter((args) => args.includes('ro.serialno')).length).toBeGreaterThan(1);
  });

  it('the other commands still insist on an installed app', async () => {
    const t = setup();
    t.adb.installed = false;
    const out = await t.json('reset', '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.message).toMatch(/not installed/);
  });

  it.each([
    ['release package', REL],
    ['another app', CLOCKY]
  ])('refuses an APK of %s before touching the phone', async (_name, applicationId) => {
    const t = setup();
    t.adb.badging = `package: name='${applicationId}' versionCode='1' versionName='1'\napplication-debuggable\n`;
    const apk = await writeFakeApk(t.dir, 'other.apk');
    const out = await t.json('install', '--apk', apk, '--serial', 'T1');
    expect(out.json.error?.code).toBe('UNSAFE');
    expect(t.adb.installs).toEqual([]);
    expect(t.adb.calls).toEqual([]); // not even a session was started
    expect(existsSync(sessionPaths(undefined, t.dir).file)).toBe(false);
  });

  it('refuses a missing file, a non-ZIP and a non-debuggable APK', async () => {
    const t = setup();
    expect((await t.json('install', '--apk', join(t.dir, 'nope.apk'), '--serial', 'T1')).json.error?.code).toBe('USAGE');
    const junk = join(t.dir, 'junk.apk');
    writeFileSync(junk, 'not a zip at all');
    expect((await t.json('install', '--apk', junk, '--serial', 'T1')).json.error?.code).toBe('USAGE');
    t.adb.badging = "package: name='com.loopdeck3.app.debug' versionCode='1' versionName='1'\n";
    const apk = await writeFakeApk(t.dir, 'release-like.apk');
    expect((await t.json('install', '--apk', apk, '--serial', 'T1')).json.error?.code).toBe('UNSAFE');
    expect(t.adb.installs).toEqual([]);
  });

  it('does not skip the package check when aapt2 is unavailable', async () => {
    const t = setup();
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const deps = { ...t.deps, env: { ANDROID_HOME: join(t.dir, 'no-sdk'), LOCALAPPDATA: join(t.dir, 'none') } };
    const result = await runCli(['install', '--apk', apk, '--serial', 'T1'], deps);
    const body = JSON.parse(result.stdout);
    expect(body.error.code).toBe('UNSAFE');
    expect(body.error.message).toMatch(/aapt2/);
    expect(t.adb.installs).toEqual([]);
  });

  it('on a signature mismatch it reports and does NOT uninstall without --replace-incompatible', async () => {
    const t = setup();
    t.adb.installFailures = ['INSTALL_FAILED_UPDATE_INCOMPATIBLE'];
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.message).toMatch(/--replace-incompatible/);
    expect(out.json.error?.details).toMatchObject({ failureCode: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE', replaceable: true });
    expect(t.adb.uninstalls).toEqual([]);
    expect(t.adb.installed).toBe(true);
  });

  it('on a signature mismatch with --replace-incompatible it uninstalls only the debug package and installs again', async () => {
    const t = setup();
    t.adb.installFailures = ['INSTALL_FAILED_UPDATE_INCOMPATIBLE'];
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--replace-incompatible', '--serial', 'T1');
    expect(out.json.ok).toBe(true);
    expect(out.json.data).toMatchObject({ replaced: true, replacedBecause: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' });
    expect(t.adb.uninstalls).toEqual([APP]);
    expect(t.adb.installs).toHaveLength(2);
  });

  it('never uninstalls for a failure that is not a signature or downgrade problem, even with the flag', async () => {
    const t = setup();
    t.adb.installFailures = ['INSTALL_FAILED_INSUFFICIENT_STORAGE'];
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--replace-incompatible', '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.code).toBe('ADB');
    expect(t.adb.uninstalls).toEqual([]);
  });

  it('reports an error (not success) when the reinstall after the uninstall fails', async () => {
    const t = setup();
    t.adb.installFailures = ['INSTALL_FAILED_UPDATE_INCOMPATIBLE', 'INSTALL_FAILED_INSUFFICIENT_STORAGE'];
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--replace-incompatible', '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.message).toMatch(/NOT installed/);
  });

  it('explains an install that hangs behind a Google Play Protect dialog, and does not uninstall', async () => {
    const t = setup();
    t.adb.installHangs = true;
    t.adb.focusedWindow =
      'Window{7ae968e u0 com.android.vending/com.google.android.finsky.protectdialogs.activity.PlayProtectDialogsActivity}';
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--replace-incompatible', '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.message).toMatch(/Play Protect/);
    expect(t.adb.uninstalls).toEqual([]);
  });

  it('reports a plain timeout when nothing explains the hang', async () => {
    const t = setup();
    t.adb.installHangs = true;
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--serial', 'T1');
    expect(out.json.error?.code).toBe('TIMEOUT');
  });

  it('fails when the installed base.apk is not the supplied file', async () => {
    const t = setup();
    t.adb.reportShaOverride = 'd'.repeat(64);
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const out = await t.json('install', '--apk', apk, '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.message).toMatch(/SHA-256 mismatch/);
    expect(t.session().expectedApk ?? null).toBeNull();
  });
});

describe('serial safety', () => {
  it('refuses a serial that is not the active session device, before sending anything', async () => {
    const t = setup();
    await t.json('prepare', '--serial', 'T1');
    t.adb.devices.OTHER = 'PHYS2';
    const before = t.adb.calls.length;
    for (const argv of [
      ['reset', '--serial', 'OTHER'],
      ['setting', 'uimode', 'yes', '--serial', 'OTHER'],
      ['shell', '--serial', 'OTHER', '--', 'getprop', 'ro.serialno'],
      ['lifecycle', 'kill', '--serial', 'OTHER']
    ]) {
      const out = await t.json(...argv);
      expect(out.json.error?.code).toBe('IDENTITY');
    }
    expect(t.adb.calls.length).toBe(before);
  });

  it('takes the serial from LDEV_SERIAL and applies the same check', async () => {
    const t = setup();
    const deps = { ...t.deps, env: { ...t.deps.env, LDEV_SERIAL: 'T1' } };
    const ok = JSON.parse((await runCli(['shell', '--', 'getprop', 'ro.serialno'], deps)).stdout);
    expect(ok.ok).toBe(true);
    t.adb.devices.OTHER = 'PHYS2';
    const wrong = JSON.parse(
      (await runCli(['shell', '--', 'getprop', 'ro.serialno'], { ...t.deps, env: { ...t.deps.env, LDEV_SERIAL: 'OTHER' } })).stdout
    );
    expect(wrong.error.code).toBe('IDENTITY');
    expect(adbCallsFor(t.adb, 'OTHER')).toEqual([]);
  });

  it('refuses when there is no session and no serial at all (never guesses a device)', async () => {
    const t = setup();
    const out = await t.json('shell', '--', 'getprop', 'ro.serialno');
    expect(out.json.error?.code).toBe('SESSION');
    expect(t.adb.calls).toEqual([]);
  });

  it('notices a transport that now answers for another physical phone', async () => {
    const t = setup();
    await t.json('prepare', '--serial', 'T1');
    t.adb.devices.T1 = 'SWAPPED';
    const before = t.adb.shellCalls.length;
    const out = await t.json('shell', '--', 'input', 'tap', '1', '2');
    expect(out.json.error?.code).toBe('IDENTITY');
    expect(t.adb.shellCalls.slice(before).filter((words) => words[0] !== 'getprop')).toEqual([]);
  });
});

describe('ldev reset', () => {
  it('clears the app data, relaunches, and verifies the learner stores are empty', async () => {
    const t = setup();
    const out = await t.json('reset', '--serial', 'T1');
    expect(out.json.ok).toBe(true);
    expect(t.adb.clears).toBe(1);
    expect(out.json.data?.processRestarted).toBe(true);
    expect(out.json.data?.fresh.userStores).toEqual(USER_DATA_STORES.map((name) => ({ name, count: 0 })));
    // The app's own metadata is reported separately and is not a failure.
    expect(out.json.data?.fresh.appMetadata.stores).toEqual([{ name: 'contentMetadata', count: 1 }]);
    expect(out.json.data?.fresh.appMetadata.localStorageKeys).toEqual(['loopdeck3.diagnostics', 'loopdeck3.library.in-player']);
    expect(t.adb.otherPackagesCleared).toEqual([]);
    expect(t.cdp.closed).toBe(1);
    expect(t.adb.forwards).toEqual([]);
  });

  it('is ERROR (exit 4) when learner data is still there afterwards, naming Auto Backup as a possible cause', async () => {
    const t = setup();
    t.app.restoreAfterWipe = true;
    const out = await t.json('reset', '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.exitCode).toBe(4);
    expect(out.json.error?.code).toBe('RUN_ERROR');
    expect(out.json.error?.details?.leftover.stores).toContain('attempts=2');
    expect(out.json.error?.details?.leftover.localStorageKeys).toContain('loopdeck3.session.x');
    expect(out.json.error?.details?.possibleCauses.join(' ')).toMatch(/ALLOW_BACKUP/);
    expect(t.adb.forwards).toEqual([]);
  });

  it('flags a leftover in localStorage alone', async () => {
    const t = setup();
    t.adb.onDataCleared = () => {
      t.app.wipe();
      t.app.local.push('loopdeck3.library.folders.v1');
    };
    const out = await t.json('reset', '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.details?.leftover).toEqual({ stores: [], localStorageKeys: ['loopdeck3.library.folders.v1'] });
  });

  it('fails (never passes) when the database is missing a learner store', async () => {
    const t = setup();
    delete t.app.data.reviewLogs;
    const out = await t.json('reset', '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.message).toMatch(/reviewLogs is missing/);
  });

  it('keeps the learner store list in step with the app', () => {
    expect([...USER_DATA_STORES]).toEqual([...SRC_USER_DATA_STORES]);
  });

  it('classifies every loopdeck3.* localStorage key the app source mentions', () => {
    const literals = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name))
          for (const m of readFileSync(path, 'utf8').matchAll(/['"`](loopdeck3\.[A-Za-z0-9._-]*)/g)) literals.add(m[1]);
      }
    };
    walk(join(process.cwd(), 'src'));
    // 'loopdeck3.session' / 'loopdeck3.backup' are file-format ids, not storage keys.
    const formatIds = new Set(['loopdeck3.session', 'loopdeck3.backup']);
    const unclassified = [...literals].filter(
      (key) => !formatIds.has(key) && !APP_LOCAL_STORAGE_KEYS.includes(key) && !isUserLocalStorageKey(key)
    );
    expect(unclassified).toEqual([]);
  });
});

describe('ldev setting and finish', () => {
  it('records the original value before changing it, and finish restores both settings', async () => {
    const t = setup();
    expect((await t.json('setting', 'uimode', 'yes', '--serial', 'T1')).json.data).toMatchObject({
      setting: 'uimode',
      original: 'no',
      actual: 'yes'
    });
    expect((await t.json('setting', 'font-scale', '1.25', '--serial', 'T1')).json.data).toMatchObject({
      setting: 'font_scale',
      original: '1.0',
      actual: '1.25'
    });
    expect(t.session().changedSettings).toEqual({ uimode: { original: 'no' }, font_scale: { original: '1.0' } });
    expect(t.adb.nightMode).toBe('yes');
    expect(t.adb.settings.font_scale).toBe('1.25');

    // A second change keeps the FIRST original.
    await t.json('setting', 'uimode', 'auto');
    expect(t.session().changedSettings.uimode).toEqual({ original: 'no' });

    const finished = await t.json('finish');
    expect(finished.json.ok).toBe(true);
    expect(t.adb.nightMode).toBe('no');
    expect(t.adb.settings.font_scale).toBe('1.0');
    expect(t.session().status).toBe('CLEAN');
    expect(t.session().changedSettings).toEqual({});
  });

  it('restores an originally unset font_scale by deleting it', async () => {
    const t = setup();
    t.adb.settings.font_scale = null;
    await t.json('setting', 'font-scale', '1.5', '--serial', 'T1');
    expect(t.session().changedSettings.font_scale).toEqual({ original: null });
    expect((await t.json('finish')).json.ok).toBe(true);
    expect(t.adb.settings.font_scale).toBeNull();
  });

  it('never reports CLEAN when a setting cannot be restored', async () => {
    const t = setup();
    await t.json('setting', 'uimode', 'yes', '--serial', 'T1');
    t.adb.failures.push((args) => args.includes('uimode') && args.includes('no'));
    const finished = await t.json('finish');
    expect(finished.json.ok).toBe(false);
    expect(finished.json.error?.code).toBe('CLEANUP_FAILED');
    expect(t.session().status).toBe('DIRTY');
    expect(t.session().changedSettings.uimode).toEqual({ original: 'no' });
    // Once the device cooperates, a second finish completes the restore.
    t.adb.failures.length = 0;
    expect((await t.json('finish')).json.ok).toBe(true);
    expect(t.adb.nightMode).toBe('no');
    expect(t.session().status).toBe('CLEAN');
  });

  it('stays DIRTY when the device reports a different value than the original after the restore', async () => {
    const t = setup();
    await t.json('setting', 'font-scale', '1.5', '--serial', 'T1');
    t.adb.ignoreSettingWrites.add('font_scale'); // the phone silently ignores writes to it
    const finished = await t.json('finish');
    expect(finished.json.ok).toBe(false);
    expect(t.session().status).toBe('DIRTY');
  });

  it('rejects values outside the supported range and unknown settings', async () => {
    const t = setup();
    for (const argv of [
      ['setting', 'uimode', 'maybe'],
      ['setting', 'font-scale', '9'],
      ['setting', 'font-scale', '1.234'],
      ['setting', 'brightness', '5']
    ]) {
      expect((await t.json(...argv, '--serial', 'T1')).json.error?.code).toBe('USAGE');
    }
    expect(t.adb.calls).toEqual([]);
  });

  it('still reads a session file written before PR3 (no changedSettings / expectedApk) and restores rotation', async () => {
    const t = setup();
    await t.json('prepare', '--serial', 'T1');
    const paths = sessionPaths(undefined, t.dir);
    const old = JSON.parse(readFileSync(paths.file, 'utf8'));
    delete old.changedSettings;
    delete old.expectedApk;
    writeFileSync(paths.file, JSON.stringify(old));
    expect(SessionHandle.read(paths, t.deps.now)?.record.changedSettings).toBeUndefined();
    await t.json('rotate', 'landscape');
    expect(t.adb.settings.user_rotation).toBe('1');
    expect((await t.json('finish')).json.ok).toBe(true);
    expect(t.adb.settings.user_rotation).toBeNull();
    expect(t.session().status).toBe('CLEAN');
  });
});

describe('ldev lifecycle kill', () => {
  it('force-stops the debug app, confirms by pid, and does not restart it', async () => {
    const t = setup();
    const out = await t.json('lifecycle', 'kill', '--serial', 'T1');
    expect(out.json.ok).toBe(true);
    expect(t.adb.pids).toEqual([]);
    expect(out.json.data).toMatchObject({ action: 'kill', pid: null, pidChanged: true });
    const words = t.adb.shellCalls;
    expect(words.some((w) => w[0] === 'am' && w[1] === 'force-stop' && w[2] === APP)).toBe(true);
    expect(words.some((w) => w[0] === 'am' && w[1] === 'start')).toBe(false);
  });

  it('fails when the process is still alive afterwards', async () => {
    const t = setup();
    t.adb.dynamicProcesses = false; // force-stop does nothing, as if the app were respawned
    const out = await t.json('lifecycle', 'kill', '--serial', 'T1');
    expect(out.json.ok).toBe(false);
    expect(out.json.error?.code).toBe('TIMEOUT');
  });
});

describe('ldev shell', () => {
  it.each([
    [['pm', 'clear', REL]],
    [['pm', 'clear', CLOCKY]],
    [['pm', 'uninstall', CLOCKY]],
    [['pm', 'uninstall', '--user', '0', REL]],
    [['pm', 'clear']],
    [['pm', 'clear', APP, CLOCKY]],
    [['pm', 'install', '/sdcard/x.apk']],
    [['cmd', 'package', 'uninstall', REL]],
    [['am', 'force-stop', REL]],
    [['am', 'force-stop', CLOCKY]],
    [['am', 'kill', CLOCKY]],
    [['am', 'crash', REL]],
    [['am', 'force-stop']],
    [['rm', '-rf', `/data/data/${REL}`]],
    [['rm', '-rf', `/data/data/${CLOCKY}`]],
    [['rm', '-rf', '/sdcard/Download/ldev/../../Documents']],
    [['mv', '/sdcard/Download/ldev/a', '/sdcard/Documents/a']],
    [['reboot']],
    [['reboot', 'recovery']],
    [['am', 'broadcast', '-a', 'android.intent.action.MASTER_CLEAR']],
    [['sh', '-c', 'reboot']],
    [['su', '0', 'id']],
    [['run-as', REL, 'ls']],
    [['svc', 'power', 'shutdown']],
    [['setprop', 'sys.powerctl', 'reboot']],
    [['settings', 'put', 'system', 'font_scale', '2.0']],
    [['cmd', 'uimode', 'night', 'yes']],
    [['wm', 'size', '100x100']],
    [['fastboot', 'oem', 'unlock']],
    [['dumpsys', 'battery', 'set', 'level', '1']],
    [[]]
  ])('refuses %j without calling adb', async (argv) => {
    expect(() => checkShellArgv(argv)).toThrowError(/refused|no command/);
    if (argv.length === 0) return;
    const t = setup();
    await t.json('prepare', '--serial', 'T1');
    const before = t.adb.calls.length;
    const out = await t.json('shell', '--', ...argv);
    expect(out.json.error?.code).toBe('UNSAFE');
    expect(out.json.exitCode).toBe(3);
    expect(t.adb.calls.length).toBe(before);
    // Refusals are journaled too.
    const lines = readFileSync(join(sessionPaths(undefined, t.dir).root, 'shell.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ src: 'shell', type: 'refused' });
  });

  it.each([
    [['am', 'force-stop', APP]],
    [['am', 'crash', APP]],
    [['pm', 'clear', APP]],
    [['pm', 'list', 'packages', '-U']],
    [['pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS']],
    [['getprop', 'ro.serialno']],
    [['dumpsys', 'package', APP]],
    [['input', 'tap', '10', '20']],
    [['settings', 'get', 'system', 'font_scale']],
    [['cmd', 'uimode', 'night']],
    [['rm', '/sdcard/Download/ldev/pack.json']],
    [['ls', '/sdcard/Download']]
  ])('allows %j', (argv) => {
    expect(() => checkShellArgv(argv)).not.toThrow();
  });

  it('passes arguments one by one, so shell metacharacters stay literal text', async () => {
    const t = setup();
    await t.json('prepare', '--serial', 'T1');
    await t.json('shell', '--', 'echo', 'a; touch x', '$(id)', 'b | c > d');
    expect(t.adb.shellCalls.at(-1)).toEqual(['echo', 'a; touch x', '$(id)', 'b | c > d']);
    expect(t.adb.shellCalls.some((words) => words[0] === 'touch' || words[0] === 'id')).toBe(false);
  });

  it('returns exit code, stdout and stderr, and journals the command and its result', async () => {
    const t = setup();
    await t.json('prepare', '--serial', 'T1');
    const ok = await t.json('shell', '--', 'getprop', 'ro.serialno');
    expect(ok.json.ok).toBe(true);
    expect(ok.json.data).toMatchObject({ argv: ['getprop', 'ro.serialno'], exitCode: 0, stdout: 'PHYS1\n', stderr: '' });

    t.adb.failures.push((args) => args.includes('crash'));
    const failed = await t.json('shell', '--', 'am', 'crash', APP);
    expect(failed.json.ok).toBe(false);
    expect(failed.json.error?.code).toBe('RUN_ERROR');
    expect(failed.json.error?.details?.result).toMatchObject({ exitCode: 1, stderr: 'injected failure' });

    const lines = readFileSync(join(sessionPaths(undefined, t.dir).root, 'shell.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => `${l.src}:${l.type}`)).toEqual(['shell:command', 'shell:result', 'shell:command', 'shell:result']);
    expect(lines[1].data).toMatchObject({ exitCode: 0, stdout: 'PHYS1\n' });
    expect(lines[3].data).toMatchObject({ argv: ['am', 'crash', APP], exitCode: 1, stderr: 'injected failure' });
  });
});

describe('scenario parsing of the new steps', () => {
  const parse = (steps: unknown[]) => parseScenario(JSON.stringify({ schema: 1, id: 'x', title: 't', steps }));
  it('accepts reset, setting, installApk and lifecycle kill', () => {
    const scenario = parse([
      { do: 'reset' },
      { do: 'setting', key: 'uimode', value: 'yes' },
      { do: 'setting', key: 'font-scale', value: 1.25 },
      { do: 'installApk', file: 'a.apk', replaceIncompatible: true },
      { do: 'lifecycle', action: 'kill' }
    ]);
    expect(scenario.steps.map((step) => ('do' in step ? step.do : step.check))).toEqual([
      'reset',
      'setting',
      'setting',
      'installApk',
      'lifecycle'
    ]);
    expect(scenario.steps[2]).toMatchObject({ value: '1.25' });
    expect(scenario.testClass).toBe('app');
  });
  it.each([
    [{ do: 'reset', hard: true }],
    [{ do: 'setting', key: 'uimode', value: 'maybe' }],
    [{ do: 'setting', key: 'font-scale', value: 5 }],
    [{ do: 'setting', key: 'brightness', value: 1 }],
    [{ do: 'setting', key: 'uimode', value: 'yes', extra: 1 }],
    [{ do: 'installApk' }],
    [{ do: 'installApk', file: 'a.apk', replaceIncompatible: 'yes' }],
    [{ do: 'installApk', file: 'a.apk', package: 'x' }],
    [{ do: 'lifecycle', action: 'reboot' }]
  ])('rejects %j', (step) => {
    expect(() => parse([step])).toThrowError(/steps\[0\]/);
  });
});

describe('ldev run: reset / install / setting / kill inside a scenario', () => {
  async function runWith(t: ReturnType<typeof setup>, steps: unknown[], extra: { apk?: string } = {}) {
    const scenarioPath = join(t.dir, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify({ schema: 1, id: 'mgmt', title: 'management', steps }));
    return runScenario(t.deps, { serial: 'T1', scenarioPath, outDir: join(t.dir, 'out'), apkPath: extra.apk });
  }
  const visible = { check: 'expectVisible', target: { css: '.home-screen' } };

  it('reset reconnects, verifies fresh state, and later checks run on the new page', async () => {
    const t = setup();
    const { summary, runDir } = await runWith(t, [{ do: 'launch' }, { do: 'reset' }, visible]);
    expect(summary.final).toBe('PASS');
    expect(t.cdp.endpoints).toHaveLength(2); // before and after the wipe
    expect(t.adb.clears).toBe(1);
    expect(t.adb.forwards).toEqual([]);
    const events = readFileSync(join(runDir, 'events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const reset = events.find((e) => e.src === 'step' && e.type === 'reset');
    expect(reset.data.fresh).toBe(true);
    // The app being stopped on purpose is not a crash.
    expect(summary.anomalies).toEqual([]);
  });

  it('reset leftovers make the run ERROR and the later check is not evaluated', async () => {
    const t = setup();
    t.app.restoreAfterWipe = true;
    const { summary } = await runWith(t, [{ do: 'launch' }, { do: 'reset' }, visible]);
    expect(summary.final).toBe('ERROR');
    expect(summary.reasons.join(' ')).toMatch(/learner data remains/);
    expect(summary.checks).toEqual([{ id: 's2', status: 'NOT_EVALUATED' }]);
  });

  it('does not judge pre-reset diagnostics as post-reset state: ids that repeat after the wipe count as new errors', async () => {
    const t = setup();
    let wiped = false;
    t.adb.onDataCleared = () => {
      t.app.wipe();
      wiped = true;
    };
    const original = t.spec.evaluate!;
    t.spec.evaluate = (arg, fn) => {
      if (fn.name === 'readDiagnostics') {
        // Same id before and after the wipe; the post-wipe one is an error.
        return wiped
          ? { ok: true, entries: [{ id: 'd1', level: 'error', code: 'APP-STARTUP', area: 'boot' }] }
          : { ok: true, entries: [{ id: 'd1', level: 'info', code: null, area: 'boot' }] };
      }
      return original(arg, fn);
    };
    const { summary } = await runWith(t, [{ do: 'launch' }, { do: 'reset' }, visible]);
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies).toEqual([{ kind: 'diagError', allowed: false, count: 1 }]);
  });

  it('installApk from an uninstalled phone, then launch, check and PASS with the APK verified', async () => {
    const t = setup();
    t.adb.installed = false;
    t.adb.pids = [];
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const { summary } = await runWith(t, [{ do: 'installApk', file: apk }, { do: 'launch' }, visible]);
    expect(summary.final).toBe('PASS');
    expect(t.adb.installs).toEqual([apk]);
    expect(summary.apk).toMatchObject({
      applicationId: APP,
      versionName: '0.3.1-debug',
      versionCode: '31',
      lastUpdateTime: '2026-10-11 19:01:09',
      sha256: sha(apk),
      webView: { package: 'com.google.android.webview', version: '153.0.8010.36' },
      provenance: { status: 'verified', expected: { sha256: sha(apk), source: 'installApk' } }
    });
  });

  it('installApk while connected drops the page, expects the app to die, and reconnects on the next launch', async () => {
    const t = setup();
    const apk = await writeFakeApk(t.dir, 'debug.apk');
    const { summary } = await runWith(t, [{ do: 'launch' }, { do: 'installApk', file: apk }, { do: 'launch' }, visible]);
    expect(summary.final).toBe('PASS');
    expect(t.cdp.endpoints).toHaveLength(2);
    expect(summary.anomalies).toEqual([]);
    expect(t.adb.forwards).toEqual([]);
  });

  it('a wrong-package APK in a scenario is refused before the device is touched', async () => {
    const t = setup();
    t.adb.badging = `package: name='${REL}' versionCode='1'\napplication-debuggable\n`;
    const apk = await writeFakeApk(t.dir, 'rel.apk');
    await expect(runWith(t, [{ do: 'installApk', file: apk }, visible])).rejects.toMatchObject({ code: 'UNSAFE' });
    expect(t.adb.calls).toEqual([]);
  });

  it('setting is restored by finish at the end of the run, and the run still observes after the change', async () => {
    const t = setup();
    const { summary } = await runWith(t, [
      { do: 'launch' },
      { do: 'setting', key: 'uimode', value: 'yes' },
      { do: 'setting', key: 'font-scale', value: 1.3 },
      visible
    ]);
    expect(summary.final).toBe('PASS');
    expect(t.cdp.endpoints).toHaveLength(3);
    expect(t.adb.nightMode).toBe('no');
    expect(t.adb.settings.font_scale).toBe('1.0');
  });

  it('a setting that cannot be restored at the end turns the run into ERROR', async () => {
    const t = setup();
    t.adb.failures.push((args) => args.includes('uimode') && args.includes('no'));
    const { summary } = await runWith(t, [{ do: 'launch' }, { do: 'setting', key: 'uimode', value: 'yes' }, visible]);
    expect(summary.final).toBe('ERROR');
    expect(summary.reasons.join(' ')).toMatch(/CLEANUP_FAILED/);
  });

  it('lifecycle kill stops the app without restarting it; a check right after has no page and cannot pass', async () => {
    const t = setup();
    const { summary } = await runWith(t, [{ do: 'launch' }, { do: 'lifecycle', action: 'kill' }, visible]);
    expect(t.adb.pids).toEqual([]);
    expect(summary.final).toBe('ERROR');
    expect(summary.checks).toEqual([{ id: 's2', status: 'NOT_EVALUATED' }]);
    expect(summary.anomalies.find((a) => a.kind === 'androidProcessDied')).toBeUndefined();
  });

  it('kill, then launch, reconnects and passes', async () => {
    const t = setup();
    const { summary } = await runWith(t, [{ do: 'launch' }, { do: 'lifecycle', action: 'kill' }, { do: 'launch' }, visible]);
    expect(summary.final).toBe('PASS');
    expect(t.cdp.endpoints).toHaveLength(2);
  });
});

describe('APK provenance in ldev run', () => {
  async function run(t: ReturnType<typeof setup>, steps: unknown[], apk?: string) {
    const scenarioPath = join(t.dir, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify({ schema: 1, id: 'prov', title: 'prov', steps }));
    return runScenario(t.deps, { serial: 'T1', scenarioPath, outDir: join(t.dir, 'out'), apkPath: apk });
  }
  const steps = [{ do: 'launch' }, { check: 'expectVisible', target: { css: '.home-screen' } }];

  it('without an expected APK the provenance is "unverified" and does not stop a PASS', async () => {
    const t = setup();
    const { summary } = await run(t, steps);
    expect(summary.final).toBe('PASS');
    expect(summary.apk.provenance).toEqual({ status: 'unverified', reason: null, expected: null });
    expect(summary.apk.sha256).toBe('c'.repeat(64));
  });

  it('--apk matching the installed base.apk is verified, and never installs anything', async () => {
    const t = setup();
    const apk = await writeFakeApk(t.dir, 'expected.apk');
    t.adb.installedSha = sha(apk);
    const { summary } = await run(t, steps, apk);
    expect(summary.final).toBe('PASS');
    expect(summary.apk.provenance).toMatchObject({ status: 'verified', expected: { source: 'run --apk' } });
    expect(t.adb.installs).toEqual([]);
  });

  it('a different APK on the phone is INCONCLUSIVE and no step runs (so a reset cannot wipe a wrongly built app)', async () => {
    const t = setup();
    const apk = await writeFakeApk(t.dir, 'expected.apk');
    const { summary } = await run(t, [{ do: 'reset' }, ...steps], apk);
    expect(summary.final).toBe('INCONCLUSIVE');
    expect(summary.reasons.join(' ')).toMatch(/APK provenance: installed APK differs/);
    expect(summary.apk.provenance.status).toBe('mismatch');
    expect(summary.steps.done).toBe(0);
    expect(t.adb.clears).toBe(0);
    expect(summary.checks.every((check) => check.status === 'NOT_EVALUATED')).toBe(true);
  });

  it('an unreadable installed hash with an expectation is INCONCLUSIVE, not PASS', async () => {
    const t = setup();
    const apk = await writeFakeApk(t.dir, 'expected.apk');
    t.adb.failures.push((args) => args.includes('sha256sum'));
    const { summary } = await run(t, steps, apk);
    expect(summary.final).toBe('INCONCLUSIVE');
    expect(summary.apk.provenance.status).toBe('unreadable');
  });

  it('--apk with an installApk step of another file is judged on what ends up installed', async () => {
    const t = setup();
    const expected = await writeFakeApk(t.dir, 'expected.apk', 'a');
    const other = await writeFakeApk(t.dir, 'other.apk', 'b');
    t.adb.installedSha = sha(expected);
    const { summary } = await run(t, [{ do: 'installApk', file: other }, ...steps], expected);
    expect(summary.final).toBe('INCONCLUSIVE');
    expect(summary.apk.provenance.status).toBe('mismatch');
  });

  it('verdict: a FAIL still wins over a provenance problem', () => {
    const base = {
      checks: [{ id: 's0', status: 'FAIL' as const }],
      anomalies: [],
      infraError: null,
      channels: [],
      stateIncompleteForCheck: false
    };
    expect(computeVerdict({ ...base, provenanceProblem: 'x' }).final).toBe('FAIL');
    expect(computeVerdict({ ...base, checks: [{ id: 's0', status: 'PASS' }], provenanceProblem: 'x' }).final).toBe('INCONCLUSIVE');
    expect(computeVerdict({ ...base, checks: [{ id: 's0', status: 'PASS' }], provenanceProblem: null }).final).toBe('PASS');
  });
});
