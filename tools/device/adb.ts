import {
  ALLOWED_KEYS,
  APP_COMPONENT,
  APP_PACKAGE,
  LIMITS,
  NIGHT_MODES,
  SYSTEM_SETTINGS,
  TIMEOUTS,
  type NightMode,
  type SystemSetting
} from './constants.js';
import { DeviceCliError } from './errors.js';
import type { ExecResult, Runner, StreamHandle, StreamOptions, StreamSpawner } from './exec.js';
import { randomBytes } from 'node:crypto';

const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHELL_SAFE = /^[A-Za-z0-9_.:/=@%+,-]+$/;

export function assertSerial(serial: string): string {
  if (!SERIAL_PATTERN.test(serial)) throw new DeviceCliError('USAGE', 'Serial must match [A-Za-z0-9][A-Za-z0-9._:-]{0,63}');
  return serial;
}

/** adb joins shell arguments with spaces and hands them to the device shell, so every value is quoted for it. */
export function shellQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new DeviceCliError('UNSAFE', 'Refusing shell value with control characters');
  if (value !== '' && SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface DeviceListing {
  transport: string;
  state: string;
  model: string | null;
}

export function parseDevices(text: string): DeviceListing[] {
  const devices: DeviceListing[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|offline|unauthorized|authorizing|recovery|sideload|bootloader|no permissions)\b(.*)$/.exec(line);
    if (!match) continue;
    devices.push({ transport: match[1], state: match[2], model: /\bmodel:(\S+)/.exec(match[3])?.[1] ?? null });
  }
  return devices;
}

export interface ForwardEntry {
  serial: string;
  local: string;
  remote: string;
}

export function parseForwardList(text: string): ForwardEntry[] {
  const entries: ForwardEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 3) entries.push({ serial: parts[0], local: parts[1], remote: parts[2] });
  }
  return entries;
}

export interface UnixSocket {
  name: string;
  inode: string;
  listening: boolean;
}

/** /proc/net/unix rows: Num RefCount Protocol Flags Type St Inode Path */
export function parseProcNetUnix(text: string): UnixSocket[] {
  const sockets: UnixSocket[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\S+:\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const flags = Number.parseInt(match[1], 16);
    sockets.push({ name: match[3].replace(/^@/, ''), inode: match[2], listening: Number.isFinite(flags) && (flags & 0x10000) !== 0 });
  }
  return sockets;
}

export interface AdbOptions {
  runner: Runner;
  adbPath?: string;
  env?: NodeJS.ProcessEnv;
}

interface RunOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export class HostAdb {
  readonly adbPath: string;

  get environment(): NodeJS.ProcessEnv | undefined {
    return this.options.env;
  }

  constructor(private readonly options: AdbOptions) {
    this.adbPath = options.adbPath ?? 'adb';
  }

  async exec(args: readonly string[], run: RunOptions = {}): Promise<ExecResult> {
    const result = await this.options.runner(this.adbPath, args, {
      timeoutMs: run.timeoutMs ?? TIMEOUTS.adbMs,
      maxBytes: run.maxBytes ?? LIMITS.maxStdoutBytes,
      env: this.options.env
    });
    if (result.timedOut) throw new DeviceCliError('TIMEOUT', `adb ${args[2] ?? args[0]} timed out`);
    return result;
  }

  /** Host-side discovery only; reads no device state. */
  async listDevices(): Promise<DeviceListing[]> {
    const result = await this.exec(['devices', '-l']);
    if (result.code !== 0) throw new DeviceCliError('ADB', 'adb devices failed');
    return parseDevices(result.stdout.toString('utf8'));
  }

  device(transport: string, identity: string | null = null): AdbDevice {
    return new AdbDevice(this, assertSerial(transport), identity);
  }
}

function text(result: ExecResult): string {
  return result.stdout.toString('utf8');
}

function expectInt(value: number, min: number, max: number, what: string): string {
  if (!Number.isInteger(value) || value < min || value > max) throw new DeviceCliError('UNSAFE', `${what} out of range`);
  return String(value);
}

const APK_PATH = /^\/data\/app\/[A-Za-z0-9_=+.\/~-]+\.apk$/;

export interface PackageInfo {
  installed: boolean;
  versionName: string | null;
  versionCode: string | null;
  lastUpdateTime: string | null;
  /** From the package flags; null when the package is not installed. */
  allowBackup: boolean | null;
}

export class AdbDevice {
  constructor(
    private readonly host: HostAdb,
    readonly transport: string,
    private identity: string | null
  ) {}

  get pinnedIdentity(): string | null {
    return this.identity;
  }

  private async rawShell(args: readonly string[], run: RunOptions = {}): Promise<ExecResult> {
    return this.host.exec(['-s', this.transport, 'shell', ...args.map(shellQuote)], run);
  }

  /** Reads the physical identity (ro.serialno) without trusting the transport name. */
  async readIdentity(): Promise<string> {
    const state = await this.host.exec(['-s', this.transport, 'get-state']);
    if (state.code !== 0 || text(state).trim() !== 'device') throw new DeviceCliError('ADB', 'Device is not in the "device" state');
    const result = await this.rawShell(['getprop', 'ro.serialno']);
    const identity = text(result).trim();
    if (result.code !== 0 || !identity) throw new DeviceCliError('IDENTITY', 'Could not read ro.serialno');
    return identity;
  }

  pin(identity: string): void {
    if (this.identity !== null && this.identity !== identity) throw new DeviceCliError('IDENTITY', 'Device identity is already pinned');
    this.identity = identity;
  }

  /** Re-verifies the pinned physical identity. Run before every device operation. */
  async verifyIdentity(): Promise<void> {
    if (this.identity === null) throw new DeviceCliError('IDENTITY', 'Device identity is not pinned');
    const state = await this.host.exec(['-s', this.transport, 'get-state']);
    if (state.code !== 0 || text(state).trim() !== 'device') throw new DeviceCliError('ADB', 'Device is not in the "device" state');
    const actual = text(await this.rawShell(['getprop', 'ro.serialno'])).trim();
    if (actual !== this.identity) {
      throw new DeviceCliError('IDENTITY', 'Transport now answers for a different physical device than the pinned session identity');
    }
  }

  private async shell(args: readonly string[], run: RunOptions = {}): Promise<ExecResult> {
    await this.verifyIdentity();
    return this.rawShell(args, run);
  }

  private async shellOk(args: readonly string[], run: RunOptions = {}): Promise<string> {
    const result = await this.shell(args, run);
    if (result.code !== 0) throw new DeviceCliError('ADB', `Device command "${args[0]}" failed (exit ${result.code})`);
    return text(result);
  }

  // --- settings (rotation, font scale, night mode) ----------------------------

  async getSetting(key: SystemSetting): Promise<string | null> {
    this.assertSetting(key);
    const value = (await this.shellOk(['settings', 'get', 'system', key])).trim();
    return value === 'null' || value === '' ? null : value;
  }

  async putSetting(key: SystemSetting, value: string): Promise<void> {
    this.assertSetting(key);
    const pattern = key === 'font_scale' ? /^[0-9](\.[0-9]{1,7})?$/ : /^[0-9]{1,2}$/;
    if (!pattern.test(value)) throw new DeviceCliError('UNSAFE', `Value for ${key} is not in the expected numeric form`);
    await this.shellOk(['settings', 'put', 'system', key, value]);
  }

  async deleteSetting(key: SystemSetting): Promise<void> {
    this.assertSetting(key);
    await this.shellOk(['settings', 'delete', 'system', key]);
  }

  private assertSetting(key: string): void {
    if (!(SYSTEM_SETTINGS as readonly string[]).includes(key))
      throw new DeviceCliError('UNSAFE', 'Only rotation and font_scale settings may be changed');
  }

  /** `cmd uimode night` prints "Night mode: <yes|no|auto|custom_*>" (Android 14). */
  async getNightMode(): Promise<NightMode> {
    const body = await this.shellOk(['cmd', 'uimode', 'night']);
    const value = /Night mode:\s*(\w+)/.exec(body)?.[1];
    if (!value || !(NIGHT_MODES as readonly string[]).includes(value))
      throw new DeviceCliError('ADB', 'Could not read the night mode from "cmd uimode night"');
    return value as NightMode;
  }

  async setNightMode(mode: NightMode): Promise<void> {
    if (!(NIGHT_MODES as readonly string[]).includes(mode)) throw new DeviceCliError('UNSAFE', 'Unknown night mode');
    await this.shellOk(['cmd', 'uimode', 'night', mode]);
  }

  // --- app / process --------------------------------------------------------

  async packageInfo(): Promise<PackageInfo> {
    const result = await this.shell(['dumpsys', 'package', APP_PACKAGE], { maxBytes: 4 * 1024 * 1024 });
    const body = text(result);
    const versionName = /versionName=(\S+)/.exec(body)?.[1] ?? null;
    return {
      installed: result.code === 0 && versionName !== null,
      versionName,
      versionCode: /versionCode=(\d+)/.exec(body)?.[1] ?? null,
      lastUpdateTime: /lastUpdateTime=([^\r\n]+)/.exec(body)?.[1]?.trim() ?? null,
      allowBackup: versionName === null ? null : /pkgFlags=\[[^\]]*\bALLOW_BACKUP\b/.test(body)
    };
  }

  /** `pm path`: the installed APK files of the debug package (base.apk plus any splits). */
  async apkPaths(): Promise<string[]> {
    const result = await this.shell(['pm', 'path', APP_PACKAGE]);
    if (result.code !== 0) return [];
    return text(result)
      .split(/\r?\n/)
      .map((line) => /^package:(\/\S+\.apk)$/.exec(line.trim())?.[1])
      .filter((path): path is string => path !== undefined && APK_PATH.test(path));
  }

  /** SHA-256 of an installed APK, computed on the device (the path must come from apkPaths()). */
  async remoteSha256(path: string): Promise<string> {
    if (!APK_PATH.test(path)) throw new DeviceCliError('UNSAFE', 'Refusing to hash a path outside /data/app');
    const body = await this.shellOk(['sha256sum', path], { maxBytes: 4096 });
    const digest = /^([0-9a-f]{64})\s/.exec(body.trim())?.[1];
    if (!digest) throw new DeviceCliError('ADB', 'sha256sum did not return a digest');
    return digest;
  }

  /** WebView implementation package and version, or null when `dumpsys webviewupdate` cannot say. */
  async webViewVersion(): Promise<{ package: string; version: string } | null> {
    const result = await this.shell(['dumpsys', 'webviewupdate'], { maxBytes: 1024 * 1024 });
    const match = /Current WebView package \(name, version\): \(([^,()]+), ([^()]+)\)/.exec(text(result));
    return result.code === 0 && match ? { package: match[1].trim(), version: match[2].trim() } : null;
  }

  /**
   * `adb install -r <apk>` (identity re-checked first). Never uninstalls. The caller decides what a
   * failure means; the Android failure code (INSTALL_FAILED_*) is parsed out for that.
   */
  async installApk(apkPath: string): Promise<{ ok: boolean; failureCode: string | null; detail: string }> {
    await this.verifyIdentity();
    const result = await this.host.exec(['-s', this.transport, 'install', '-r', apkPath], { timeoutMs: TIMEOUTS.installMs });
    const output = `${text(result)}\n${result.stderr}`.trim();
    if (result.code === 0 && /^Success\s*$/m.test(text(result))) return { ok: true, failureCode: null, detail: 'Success' };
    return { ok: false, failureCode: /Failure \[([A-Z0-9_]+)/.exec(output)?.[1] ?? null, detail: output.slice(0, 400) };
  }

  /** The window that has input focus, e.g. `Window{... com.android.vending/...PlayProtectDialogsActivity}`; null when unknown. */
  async focusedWindow(): Promise<string | null> {
    const result = await this.shell(['dumpsys', 'window'], { maxBytes: 8 * 1024 * 1024 });
    return /mCurrentFocus=(.+)/.exec(text(result))?.[1]?.trim() ?? null;
  }

  /** Removes the debug package and its data. The package is the fixed constant; nothing else can be passed. */
  async uninstallApp(): Promise<void> {
    await this.verifyIdentity();
    const result = await this.host.exec(['-s', this.transport, 'uninstall', APP_PACKAGE]);
    if (result.code !== 0 || !/^Success\s*$/m.test(text(result))) throw new DeviceCliError('ADB', `adb uninstall ${APP_PACKAGE} failed`);
  }

  /** `pm clear` on the debug package only: deletes its data, keeps the install. */
  async clearAppData(): Promise<void> {
    const result = await this.shell(['pm', 'clear', APP_PACKAGE], { timeoutMs: TIMEOUTS.pmClearMs });
    if (result.code !== 0 || !/^Success\s*$/m.test(text(result)))
      throw new DeviceCliError('ADB', `pm clear ${APP_PACKAGE} did not report Success`);
  }

  /** Arbitrary argv on the device, after the identity check. The caller must have applied the shell policy. */
  async runShell(argv: readonly string[], run: RunOptions = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const result = await this.shell(argv, run);
    return { code: result.code, stdout: text(result), stderr: result.stderr };
  }

  async pids(): Promise<number[]> {
    const result = await this.shell(['pidof', APP_PACKAGE]);
    if (result.code !== 0) return [];
    return text(result)
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  async procNetUnix(): Promise<UnixSocket[]> {
    return parseProcNetUnix(await this.shellOk(['cat', '/proc/net/unix'], { maxBytes: 2 * 1024 * 1024 }));
  }

  async startApp(): Promise<void> {
    // Match a launcher tap: reuse the existing task rather than adding another
    // MainActivity (and another same-URL WebView) on every resume.
    await this.shellOk([
      'am',
      'start',
      '-n',
      APP_COMPONENT,
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-f',
      '0x10200000'
    ]);
  }

  /** Debug package only (fixed constant). */
  async forceStopApp(): Promise<void> {
    await this.shellOk(['am', 'force-stop', APP_PACKAGE]);
  }

  async goHome(): Promise<void> {
    await this.shellOk(['input', 'keyevent', 'KEYCODE_HOME']);
  }

  async key(name: string): Promise<void> {
    if (!ALLOWED_KEYS.includes(name)) throw new DeviceCliError('USAGE', `Key must be one of: ${ALLOWED_KEYS.join(', ')}`);
    await this.shellOk(['input', 'keyevent', `KEYCODE_${name}`]);
  }

  async tap(x: number, y: number): Promise<void> {
    await this.shellOk(['input', 'tap', expectInt(x, 0, 20_000, 'x'), expectInt(y, 0, 20_000, 'y')]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.shellOk([
      'input',
      'swipe',
      expectInt(x1, 0, 20_000, 'x1'),
      expectInt(y1, 0, 20_000, 'y1'),
      expectInt(x2, 0, 20_000, 'x2'),
      expectInt(y2, 0, 20_000, 'y2'),
      expectInt(durationMs, 50, 5_000, 'duration')
    ]);
  }

  // --- observation ----------------------------------------------------------

  /** Raw uiautomator output (XML or an error banner); parsing and retry live in ui.ts. */
  async uiDumpRaw(): Promise<string> {
    // /dev/tty reports success without emitting XML on noninteractive ADB
    // shells (observed on moto g13). Use a private, uniquely owned temp file.
    const path = `/data/local/tmp/ldev-ui-${randomBytes(12).toString('hex')}.xml`;
    try {
      const result = await this.shell(['uiautomator', 'dump', path], { maxBytes: 8 * 1024 * 1024 });
      const banner = `${text(result)}\n${result.stderr}`;
      if (result.code !== 0 || /ERROR/.test(banner)) return banner; // e.g. "null root node": parseUiDump retries
      return await this.shellOk(['cat', path], { maxBytes: 8 * 1024 * 1024 });
    } finally {
      // Best-effort removal of our own temp file; must not mask the dump result.
      await this.shell(['rm', '-f', '--', path]).catch(() => undefined);
    }
  }

  async screencap(): Promise<Buffer> {
    await this.verifyIdentity();
    const result = await this.host.exec(['-s', this.transport, 'exec-out', 'screencap', '-p'], {
      timeoutMs: TIMEOUTS.screencapMs,
      maxBytes: LIMITS.maxScreenshotBytes
    });
    const png = result.stdout;
    if (result.code !== 0 || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47)
      throw new DeviceCliError('ADB', 'screencap did not return a PNG');
    return png;
  }

  /** Bounded, app-PID-scoped log tail. */
  async logcat(pid: number): Promise<{ text: string; truncated: boolean }> {
    const raw = await this.shellOk(['logcat', '-d', `--pid=${expectInt(pid, 1, 4_194_304, 'pid')}`, '-t', String(LIMITS.maxLogLines)], {
      maxBytes: 4 * 1024 * 1024
    });
    const truncated = Buffer.byteLength(raw) > LIMITS.maxLogBytes;
    return { text: truncated ? Buffer.from(raw).subarray(-LIMITS.maxLogBytes).toString('utf8') : raw, truncated };
  }

  /** Device wall clock in whole epoch seconds, or null when it cannot be read. Anchors `logcat -T`. */
  async deviceEpochSeconds(): Promise<number | null> {
    const result = await this.shell(['date', '+%s']);
    const seconds = Number.parseInt(text(result).trim(), 10);
    return result.code === 0 && Number.isInteger(seconds) && seconds > 0 ? seconds : null;
  }

  /** Linux uid of the debug package, or null when it cannot be read. */
  async appUid(): Promise<string | null> {
    const result = await this.shell(['pm', 'list', 'packages', '-U', APP_PACKAGE]);
    if (result.code !== 0) return null;
    for (const line of text(result).split(/\r?\n/)) {
      const match = /^package:(\S+)\s+uid:(\d+)$/.exec(line.trim());
      if (match && match[1] === APP_PACKAGE) return match[2];
    }
    return null;
  }

  /**
   * Streams the device log for the whole run. Deliberately not `--pid`-scoped: the process can die
   * and come back with another pid, and the lines around its death are the evidence. `events`
   * carries am_crash / am_anr / am_proc_died, which are not in the other buffers.
   */
  async openLogcatStream(spawn: StreamSpawner, startEpochSeconds: number | null, options: StreamOptions): Promise<StreamHandle> {
    await this.verifyIdentity();
    const since = startEpochSeconds === null ? '1' : `${expectInt(startEpochSeconds, 1, 4_102_444_800, 'epoch')}.000`;
    return spawn(this.host.adbPath, ['-s', this.transport, 'logcat', '-v', 'epoch,uid', '-b', 'main,system,crash,events', '-T', since], {
      ...options,
      env: options.env ?? this.host.environment
    });
  }

  // --- port forwards (host side of the adb server) ---------------------------

  async forwardList(): Promise<ForwardEntry[]> {
    await this.verifyIdentity();
    const result = await this.host.exec(['forward', '--list']);
    if (result.code !== 0) throw new DeviceCliError('ADB', 'adb forward --list failed');
    return parseForwardList(text(result)).filter((entry) => entry.serial === this.transport);
  }

  /** Allocates a free host port with tcp:0 and returns it. */
  async forwardCreate(remote: string): Promise<number> {
    if (!/^localabstract:webview_devtools_remote_[0-9]+$/.test(remote))
      throw new DeviceCliError('UNSAFE', 'Only WebView devtools sockets may be forwarded');
    await this.verifyIdentity();
    const result = await this.host.exec(['-s', this.transport, 'forward', 'tcp:0', remote]);
    const port = Number.parseInt(text(result).trim(), 10);
    if (result.code !== 0 || !Number.isInteger(port) || port < 1 || port > 65_535)
      throw new DeviceCliError('ADB', 'adb forward tcp:0 did not return a port');
    return port;
  }

  /** Removes exactly one forward; callers must have matched it in forwardList() first. */
  async forwardRemove(port: number): Promise<void> {
    await this.verifyIdentity();
    const result = await this.host.exec(['-s', this.transport, 'forward', '--remove', `tcp:${expectInt(port, 1, 65_535, 'port')}`]);
    if (result.code !== 0) throw new DeviceCliError('ADB', 'adb forward --remove failed');
  }
}
