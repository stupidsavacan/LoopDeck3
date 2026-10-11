import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import type { AdbDevice } from './adb.js';
import { APP_PACKAGE, RELEASE_PACKAGE } from './constants.js';
import { DeviceCliError } from './errors.js';
import type { Deps, DeviceRun } from './runtime.js';

const MAX_APK_BYTES = 512 * 1024 * 1024;

/** Android failures where a different signature or a lower version code blocks `install -r`. */
const REPLACEABLE_FAILURES: ReadonlySet<string> = new Set(['INSTALL_FAILED_UPDATE_INCOMPATIBLE', 'INSTALL_FAILED_VERSION_DOWNGRADE']);

export interface ApkFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ApkIdentity extends ApkFile {
  applicationId: string;
  versionName: string | null;
  versionCode: string | null;
  debuggable: boolean;
}

const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Reads an APK file from the host and checks that it is a ZIP; says nothing about its package. */
export function readApkFile(deps: Pick<Deps, 'cwd'>, apkPath: string): { file: ApkFile; data: Buffer } {
  const path = resolve(deps.cwd, apkPath);
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    throw new DeviceCliError('USAGE', `APK file not found: ${apkPath}`);
  }
  if (size === 0 || size > MAX_APK_BYTES) throw new DeviceCliError('USAGE', `APK size is not plausible (${size} bytes): ${apkPath}`);
  const data = readFileSync(path);
  if (data.readUInt32LE(0) !== 0x04034b50) throw new DeviceCliError('USAGE', `Not an APK (no ZIP signature): ${apkPath}`);
  return { file: { path, bytes: data.length, sha256: sha256Of(data) }, data };
}

function versionParts(name: string): number[] {
  return name.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

/** Highest installed Android SDK build-tools `aapt2`, or LDEV_AAPT2 when set. Null when none can be found. */
export function findAapt2(env: NodeJS.ProcessEnv): string | null {
  if (env.LDEV_AAPT2) return env.LDEV_AAPT2;
  const exe = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const roots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
    join(homedir(), 'Android', 'Sdk'),
    join(homedir(), 'Library', 'Android', 'sdk')
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const tools = join(root, 'build-tools');
    if (!existsSync(tools)) continue;
    const versions = readdirSync(tools).sort((a, b) => {
      const [x, y] = [versionParts(a), versionParts(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    });
    for (const version of versions) if (existsSync(join(tools, version, exe))) return join(tools, version, exe);
  }
  return null;
}

/**
 * Everything that can be known about an APK before it touches the device: it is a ZIP with a
 * manifest, and `aapt2 dump badging` names the package. Anything but the debug package is refused.
 * If aapt2 is missing this fails; the package check is never skipped.
 */
export async function inspectApk(deps: Deps, apkPath: string): Promise<ApkIdentity> {
  const { file, data } = readApkFile(deps, apkPath);
  try {
    const zip = await JSZip.loadAsync(data);
    if (!zip.file('AndroidManifest.xml')) throw new Error('no AndroidManifest.xml');
  } catch (error) {
    throw new DeviceCliError('USAGE', `Not a valid APK (${(error as Error).message}): ${apkPath}`);
  }
  const aapt2 = findAapt2(deps.env);
  if (aapt2 === null) {
    throw new DeviceCliError(
      'UNSAFE',
      'Cannot verify the APK package name: aapt2 was not found. Install Android SDK build-tools, set ANDROID_HOME, or set LDEV_AAPT2. The install was not attempted.'
    );
  }
  const result = await deps.runner(aapt2, ['dump', 'badging', file.path], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 });
  const badging = result.stdout.toString('utf8');
  const header = /package: name='([^']*)'(?: versionCode='([^']*)')?(?: versionName='([^']*)')?/.exec(badging);
  if (result.code !== 0 || !header) throw new DeviceCliError('USAGE', `aapt2 could not read the APK (exit ${result.code}): ${apkPath}`);
  const applicationId = header[1];
  if (applicationId !== APP_PACKAGE) {
    const hint = applicationId === RELEASE_PACKAGE ? ' (that is the release package)' : '';
    throw new DeviceCliError('UNSAFE', `Refusing to install package "${applicationId}"${hint}; only ${APP_PACKAGE} is allowed`);
  }
  return {
    ...file,
    applicationId,
    versionName: header[3] ?? null,
    versionCode: header[2] ?? null,
    debuggable: /^application-debuggable$/m.test(badging)
  };
}

export interface InstalledApk {
  installed: boolean;
  applicationId: string;
  versionName: string | null;
  versionCode: string | null;
  lastUpdateTime: string | null;
  /** SHA-256 of base.apk as stored on the device; null when it could not be read. */
  sha256: string | null;
  apkFileCount: number;
  allowBackup: boolean | null;
  webView: { package: string; version: string } | null;
  /** Fixed-text reason when the hash is missing. */
  hashError: string | null;
}

/** What is installed right now: package facts plus the SHA-256 of the installed base.apk. */
export async function readInstalledApk(device: AdbDevice): Promise<InstalledApk> {
  const info = await device.packageInfo();
  let sha256: string | null = null;
  let hashError: string | null = null;
  let apkFileCount = 0;
  if (info.installed) {
    try {
      const paths = await device.apkPaths();
      apkFileCount = paths.length;
      const base = paths.find((path) => path.endsWith('/base.apk'));
      if (!base) hashError = 'pm path returned no base.apk';
      else sha256 = await device.remoteSha256(base);
    } catch (error) {
      hashError = error instanceof DeviceCliError ? error.message : 'hash failed';
    }
  }
  let webView: InstalledApk['webView'] = null;
  try {
    webView = await device.webViewVersion();
  } catch {
    // informational
  }
  return {
    installed: info.installed,
    applicationId: APP_PACKAGE,
    versionName: info.versionName,
    versionCode: info.versionCode,
    lastUpdateTime: info.lastUpdateTime,
    sha256,
    apkFileCount,
    allowBackup: info.allowBackup,
    webView,
    hashError
  };
}

export type ProvenanceStatus = 'verified' | 'mismatch' | 'unreadable' | 'unverified';

/** Compares the installed base.apk with the expected one. No expectation means `unverified`, which never blocks a PASS. */
export function judgeProvenance(
  installed: InstalledApk | null,
  expectedSha256: string | null
): { status: ProvenanceStatus; reason: string | null } {
  if (expectedSha256 === null) return { status: 'unverified', reason: null };
  if (installed === null || !installed.installed) return { status: 'unreadable', reason: 'the debug app is not installed' };
  if (installed.sha256 === null) return { status: 'unreadable', reason: installed.hashError ?? 'installed APK hash unavailable' };
  if (installed.sha256 !== expectedSha256) return { status: 'mismatch', reason: 'installed APK differs from the expected APK' };
  return { status: 'verified', reason: null };
}

export interface InstallReport {
  package: string;
  versionName: string | null;
  versionCode: string | null;
  lastUpdateTime: string | null;
  sha256: string;
  apkBytes: number;
  debuggable: boolean;
  /** True when the debug package was uninstalled first (only with --replace-incompatible). */
  replaced: boolean;
  replacedBecause: string | null;
  installedApkFiles: number;
}

/**
 * `adb install -r` for the debug package. The APK is checked first (see inspectApk). If Android
 * refuses the update because of the signature or a downgrade, the debug package is uninstalled and
 * installed again only when `replaceIncompatible` is set; every other failure is reported as is and
 * nothing is uninstalled. The installed base.apk is then hashed and compared with the supplied
 * file, and the result is recorded in the session as the expected APK.
 */
export async function installDebugApk(
  run: DeviceRun,
  apkPath: string,
  options: { replaceIncompatible: boolean; beforeProcessStops?: () => Promise<void> }
): Promise<InstallReport> {
  const { device, session, deps } = run;
  const apk = await inspectApk(deps, apkPath);
  if (!apk.debuggable)
    throw new DeviceCliError('UNSAFE', 'The APK is not debuggable, so the WebView cannot be inspected; refusing to install it');

  await options.beforeProcessStops?.();
  const install = async (): Promise<Awaited<ReturnType<AdbDevice['installApk']>>> => {
    try {
      return await device.installApk(apk.path);
    } catch (error) {
      if (!(error instanceof DeviceCliError) || error.code !== 'TIMEOUT') throw error;
      // The usual reason on this phone: a Play Protect "send app for scanning?" dialog waiting for a tap.
      const focus = await device.focusedWindow().catch(() => null);
      if (focus !== null && /PlayProtect|com\.android\.vending/.test(focus)) {
        throw new DeviceCliError(
          'ADB',
          'adb install timed out because the phone is showing a Google Play Protect dialog. Dismiss it on the phone (choosing "do not send" is enough); turning the check off for adb installs is a device security setting that only the owner should change.',
          { blockedBy: 'play-protect' }
        );
      }
      throw error;
    }
  };
  let outcome = await install();
  let replacedBecause: string | null = null;
  if (!outcome.ok) {
    const code = outcome.failureCode;
    if (options.replaceIncompatible && code !== null && REPLACEABLE_FAILURES.has(code)) {
      replacedBecause = code;
      session.commit((draft) => {
        draft.notes.push(`install: ${code}; uninstalling ${APP_PACKAGE} because --replace-incompatible was given`);
        draft.notes = draft.notes.slice(-20);
      });
      await device.uninstallApp();
      outcome = await install();
      if (!outcome.ok) {
        throw new DeviceCliError(
          'ADB',
          `Reinstall after uninstall failed (${outcome.failureCode ?? 'unknown'}); ${APP_PACKAGE} is now NOT installed`,
          { failureCode: outcome.failureCode, uninstalled: true }
        );
      }
    } else {
      const hint =
        code !== null && REPLACEABLE_FAILURES.has(code)
          ? ' Re-run with --replace-incompatible to uninstall the debug package and install again.'
          : '';
      throw new DeviceCliError('ADB', `adb install failed (${code ?? 'unknown'}).${hint}`, {
        failureCode: code,
        replaceable: code !== null && REPLACEABLE_FAILURES.has(code),
        detail: outcome.detail
      });
    }
  }

  const installed = await readInstalledApk(device);
  if (!installed.installed) throw new DeviceCliError('ADB', 'adb reported Success but the debug package is not installed');
  if (installed.sha256 === null)
    throw new DeviceCliError('ADB', `Installed, but the installed APK hash could not be read (${installed.hashError})`);
  if (installed.sha256 !== apk.sha256) {
    throw new DeviceCliError('ADB', 'Installed base.apk differs from the supplied file (SHA-256 mismatch)', {
      suppliedSha256: apk.sha256,
      installedSha256: installed.sha256
    });
  }
  if (apk.versionCode !== null && installed.versionCode !== apk.versionCode) {
    throw new DeviceCliError('ADB', `Installed versionCode ${installed.versionCode} differs from the APK's ${apk.versionCode}`);
  }
  session.commit((draft) => {
    draft.expectedApk = {
      sha256: apk.sha256,
      versionName: installed.versionName,
      versionCode: installed.versionCode,
      source: 'install',
      recordedAt: deps.now().toISOString()
    };
  });
  return {
    package: APP_PACKAGE,
    versionName: installed.versionName,
    versionCode: installed.versionCode,
    lastUpdateTime: installed.lastUpdateTime,
    sha256: apk.sha256,
    apkBytes: apk.bytes,
    debuggable: apk.debuggable,
    replaced: replacedBecause !== null,
    replacedBecause,
    installedApkFiles: installed.apkFileCount
  };
}
