import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult, Runner, StreamExit, StreamHandle, StreamOptions, StreamSpawner } from '../../tools/device/exec';
import { LineSplitter } from '../../tools/device/lineSplitter';
import type { Deps, SignalHost } from '../../tools/device/runtime';
import type { CdpBrowser, CdpConnector, CdpPage, LocateResult, PageEvent } from '../../tools/device/webview';

const result = (stdout: string | Buffer, code = 0, stderr = ''): ExecResult => ({
  stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
  stderr,
  code,
  timedOut: false
});

/** Splits a remote-shell command line the way sh would for the quoting adb produces. */
export function shellSplit(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === "'") quoted = false;
      else current += ch;
    } else if (ch === "'") {
      quoted = true;
      started = true;
    } else if (ch === '\\') {
      current += line[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

export const APP = 'com.loopdeck3.app.debug';
export const APP_UID = '10241';

export interface UiBox {
  top?: number;
  width: number;
  height: number;
}

/** uiautomator XML for the app window: a root frame with one WebView below `top` pixels of inset. */
export function appUi({ top = 72, width, height }: UiBox, rotation = 0): string {
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotation}">` +
    `<node class="android.widget.FrameLayout" package="${APP}" text="" resource-id="" content-desc="" clickable="false" enabled="true" bounds="[0,0][${width},${height}]">` +
    `<node class="android.webkit.WebView" package="${APP}" text="" resource-id="" content-desc="" clickable="false" enabled="true" bounds="[0,${top}][${width},${height}]"/>` +
    `</node></hierarchy>`
  );
}

export function pickerUi(): string {
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node class="android.widget.FrameLayout" package="com.google.android.documentsui" text="" resource-id="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">` +
    `<node class="android.widget.TextView" package="com.google.android.documentsui" text="backup.json" resource-id="com.google.android.documentsui:id/title" content-desc="" clickable="true" enabled="true" bounds="[100,200][500,300]"/>` +
    `<node class="android.widget.TextView" package="com.google.android.documentsui" text="other.json" resource-id="com.google.android.documentsui:id/title" content-desc="" clickable="true" enabled="true" bounds="[100,400][500,500]"/>` +
    `</node></hierarchy>`
  );
}

export const NULL_ROOT = 'ERROR: null root node returned by UiTestAutomationBridge.';

export interface FakeForward {
  serial: string;
  local: string;
  remote: string;
}

/** A scripted `adb` binary: parses argv exactly as the real client would receive it. */
export class FakeAdb {
  calls: string[][] = [];
  /** transport -> physical ro.serialno */
  devices: Record<string, string> = { T1: 'PHYS1' };
  settings: Record<string, string | null> = { accelerometer_rotation: '1', user_rotation: null };
  /** Make the next `adb install` hang until the host timeout (as a Play Protect dialog does). */
  installHangs = false;
  /** `mCurrentFocus` window text reported by `dumpsys window`. */
  focusedWindow = 'Window{1 u0 com.loopdeck3.app.debug/com.loopdeck3.app.MainActivity}';
  /** Setting keys whose `settings put` is silently ignored. */
  ignoreSettingWrites = new Set<string>();
  /** `cmd uimode night` state. */
  nightMode = 'no';
  /** Whether the debug package is installed. False: dumpsys/pm path/pidof report nothing. */
  installed = true;
  allowBackup = true;
  /** Fake process model: force-stop / pm clear / uninstall end the process and `am start` spawns a new pid. Off by default. */
  dynamicProcesses = false;
  nextPid = 5000;
  /** INSTALL_FAILED_* codes returned by the next `adb install` calls, in order. */
  installFailures: string[] = [];
  /** SHA-256 the device reports for base.apk; defaults to the hash of whatever file was installed. */
  installedSha: string | null = 'c'.repeat(64);
  /** Overrides what the device reports after an install (to simulate a corrupted copy). */
  reportShaOverride: string | null = null;
  installedVersionCode = '31';
  /** pm clear / uninstall hook so tests can wipe their fake page data. */
  onDataCleared: (() => void) | null = null;
  clears = 0;
  uninstalls: string[] = [];
  installs: string[] = [];
  /** Packages other than the debug app, for refusal tests. */
  otherPackagesCleared: string[] = [];
  pids: number[] = [4321];
  sockets = (pid: number) =>
    `Num RefCount Protocol Flags Type St Inode Path\n0000: 00000002 00000000 00010000 0001 01 777 @webview_devtools_remote_${pid}\n`;
  forwards: FakeForward[] = [];
  nextPort = 40001;
  ui: string[] = [appUi({ width: 1080, height: 2400 })];
  failures: ((args: readonly string[]) => boolean)[] = [];
  lastUiPath: string | null = null;
  /** XML written by the most recent `uiautomator dump`. */
  dumped = '';
  removedUiPaths: string[] = [];
  versionName = '0.3.1-debug';
  deviceEpochMs = 1_700_000_000_000;
  basePath = '/data/app/~~abc==/com.loopdeck3.app.debug-xyz==/base.apk';

  /** Argument vectors of every call, e.g. to prove nothing ran. */
  get shellCalls(): string[][] {
    return this.calls.filter((args) => args.includes('shell')).map((args) => shellSplit(args.slice(args.indexOf('shell') + 1).join(' ')));
  }

  /** Every process start (file + argv), including git; `calls` holds adb argv only. */
  spawns: string[] = [];
  gitRevision = 'a'.repeat(40);

  /** What `aapt2 dump badging` prints for any APK. */
  badging =
    "package: name='com.loopdeck3.app.debug' versionCode='31' versionName='0.3.1-debug' platformBuildVersionName='14'\napplication-debuggable\n";
  badgingCode = 0;
  aapt2Calls: string[][] = [];

  runner: Runner = async (file, args) => {
    this.spawns.push(file);
    if (file === 'aapt2') {
      this.aapt2Calls.push([...args]);
      return result(this.badging, this.badgingCode);
    }
    if (file === 'git') return args[0] === 'rev-parse' ? result(`${this.gitRevision}\n`) : result('');
    this.calls.push([...args]);
    if (this.failures.some((fails) => fails(args))) return result('', 1, 'injected failure');
    if (args[0] === 'devices')
      return result(
        `List of devices attached\n${Object.keys(this.devices)
          .map((t) => `${t}\tdevice usb:1 model:Moto`)
          .join('\n')}\n`
      );
    if (args[0] === 'forward' && args[1] === '--list')
      return result(this.forwards.map((f) => `${f.serial} ${f.local} ${f.remote}`).join('\n'));
    if (args[0] !== '-s') return result('', 1, 'unexpected');
    const transport = args[1];
    if (!(transport in this.devices)) return result('', 1, 'device not found');
    const rest = args.slice(2);
    if (rest[0] === 'get-state') return result('device\n');
    if (rest[0] === 'forward' && rest[1] === 'tcp:0') {
      const port = this.nextPort++;
      this.forwards.push({ serial: transport, local: `tcp:${port}`, remote: rest[2] });
      return result(`${port}\n`);
    }
    if (rest[0] === 'forward' && rest[1] === '--remove') {
      const before = this.forwards.length;
      this.forwards = this.forwards.filter((f) => !(f.serial === transport && f.local === rest[2]));
      return before === this.forwards.length ? result('', 1, 'listener not found') : result('');
    }
    if (rest[0] === 'install') {
      const path = rest[rest.length - 1];
      this.installs.push(path);
      if (this.installHangs) return { stdout: Buffer.from(''), stderr: '', code: null, timedOut: true };
      const failure = this.installFailures.shift();
      if (failure) return result(`Performing Streamed Install\n`, 1, `adb: failed to install ${path}: Failure [${failure}: simulated]`);
      this.installed = true;
      if (this.dynamicProcesses) this.pids = [];
      this.installedSha = this.reportShaOverride ?? createHash('sha256').update(readFileSync(path)).digest('hex');
      return result('Performing Streamed Install\nSuccess\n');
    }
    if (rest[0] === 'uninstall') {
      this.uninstalls.push(rest[1]);
      if (rest[1] !== APP) return result('Failure [DELETE_FAILED_INTERNAL_ERROR]\n', 1);
      this.installed = false;
      this.pids = [];
      this.onDataCleared?.();
      return result('Success\n');
    }
    if (rest[0] === 'exec-out') return result(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    if (rest[0] !== 'shell') return result('', 1, 'unexpected');
    return this.shell(transport, shellSplit(rest.slice(1).join(' ')));
  };

  private shell(transport: string, words: string[]): ExecResult {
    const [cmd, ...a] = words;
    if (cmd === 'getprop') return result(`${this.devices[transport]}\n`);
    if (cmd === 'settings') {
      if (a[0] === 'get') return result(`${this.settings[a[2]] ?? 'null'}\n`);
      if (a[0] === 'put' && !this.ignoreSettingWrites.has(a[2])) this.settings[a[2]] = a[3];
      if (a[0] === 'delete') this.settings[a[2]] = null;
      return result('');
    }
    if (cmd === 'dumpsys' && a[0] === 'window')
      return result(`  mCurrentFocus=${this.focusedWindow}
`);
    if (cmd === 'dumpsys' && a[0] === 'webviewupdate')
      return result('  Current WebView package (name, version): (com.google.android.webview, 153.0.8010.36)\n');
    if (cmd === 'dumpsys') {
      if (!this.installed) return result('');
      return result(
        `Package [${APP}]\n    versionCode=${this.installedVersionCode} minSdk=24\n    versionName=${this.versionName}\n` +
          `    pkgFlags=[ DEBUGGABLE HAS_CODE${this.allowBackup ? ' ALLOW_BACKUP' : ''} ]\n    lastUpdateTime=2026-10-11 19:01:09\n`
      );
    }
    if (cmd === 'pm' && a[0] === 'path') return this.installed ? result(`package:${this.basePath}\n`) : result('', 1);
    if (cmd === 'sha256sum')
      return a[0] === this.basePath && this.installed ? result(`${this.installedSha ?? '0'.repeat(64)}  ${a[0]}\n`) : result('', 1);
    if (cmd === 'pm' && a[0] === 'clear') {
      if (a[1] !== APP) {
        this.otherPackagesCleared.push(a[1]);
        return result('Failure\n', 1);
      }
      this.clears++;
      if (this.dynamicProcesses) this.pids = [];
      this.onDataCleared?.();
      return result('Success\n');
    }
    if (cmd === 'cmd' && a[0] === 'uimode' && a[1] === 'night') {
      if (a[2] !== undefined) this.nightMode = a[2];
      return result(`Night mode: ${this.nightMode}\n`);
    }
    if (cmd === 'am' && a[0] === 'force-stop' && this.dynamicProcesses) {
      this.pids = [];
      return result('');
    }
    if (cmd === 'am' && a[0] === 'start' && this.dynamicProcesses && this.pids.length === 0) {
      this.pids = [this.nextPid++];
      return result('Starting: Intent\n');
    }
    if (cmd === 'pidof' && !this.installed) return result('', 1);
    if (cmd === 'pidof') return this.pids.length ? result(`${this.pids.join(' ')}\n`) : result('', 1);
    if (cmd === 'cat' && a[0] === '/proc/net/unix') return result(this.sockets(this.pids[0] ?? 0));
    if (cmd === 'uiautomator') {
      this.lastUiPath = a[1];
      const next = this.ui.length > 1 ? (this.ui.shift() as string) : this.ui[0];
      this.dumped = next;
      if (next === NULL_ROOT) return result(`${NULL_ROOT}\n`);
      return result(`UI hierchary dumped to: ${a[1]}\n`);
    }
    if (cmd === 'cat' && a[0] === this.lastUiPath) return result(this.dumped);
    if (cmd === 'rm') {
      this.removedUiPaths.push(a[a.length - 1]);
      return result('');
    }
    if (cmd === 'date') return result(`${Math.floor(this.deviceEpochMs / 1000)}\n`);
    if (cmd === 'pm' && a[0] === 'list') return result(`package:${APP} uid:${APP_UID}\n`);
    if (cmd === 'logcat') return result('I/app: hello\n');
    return result(''); // input, am, ...
  }

  /** Any `input` / `am` / `settings put` style mutation issued so far. */
  mutations(): string[][] {
    return this.shellCalls.filter((words) => ['input', 'am'].includes(words[0]) || (words[0] === 'settings' && words[1] !== 'get'));
  }
}

/** A minimal but real ZIP with an AndroidManifest.xml, so the tool's APK checks run on actual bytes. */
export async function writeFakeApk(dir: string, name: string, tag = 'a'): Promise<string> {
  const zip = new JSZip();
  zip.file('AndroidManifest.xml', `manifest-${tag}`);
  zip.file('classes.dex', `dex-${tag}`);
  const path = join(dir, name);
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }));
  return path;
}

export function tempDir(prefix = 'ldev-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface FakePageSpec {
  url?: string;
  locate?: (locator: unknown, options: { scroll: boolean; points?: { x: number; y: number }[] }) => LocateResult;
  countVisible?: (target: unknown) => number;
  evaluate?: (arg: unknown, fn: { name: string }) => unknown;
}

export class FakeCdp implements CdpConnector {
  endpoints: string[] = [];
  closed = 0;
  clicks: { x: number; y: number }[] = [];
  pages: FakePageSpec[] = [{ url: 'https://appassets.androidplatform.net/assets/loopdeck/index.html#home' }];
  connectError: Error | null = null;
  beforeClose: (() => void) | null = null;
  /** Page-event subscribers of every live fake page. */
  listeners = new Set<(event: PageEvent) => void>();
  fills: { locator: unknown; text: string }[] = [];

  /** Fires a page event at every current subscriber (as Playwright would). */
  emit(event: PageEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async connect(endpoint: string): Promise<CdpBrowser> {
    this.endpoints.push(endpoint);
    if (this.connectError) throw this.connectError;
    return {
      pages: () =>
        this.pages.map((spec): CdpPage => ({
          url: () => spec.url ?? 'about:blank',
          evaluate: (async (fn: { name: string }, arg: unknown) => spec.evaluate?.(arg, fn)) as CdpPage['evaluate'],
          onEvent: (handler) => {
            this.listeners.add(handler);
            return () => void this.listeners.delete(handler);
          },
          fill: async (locator, text) => void this.fills.push({ locator, text }),
          mouseClick: async (x, y) => void this.clicks.push({ x, y }),
          locate: async (locator, options) => spec.locate!(locator, options),
          countVisible: async (target) => spec.countVisible!(target)
        })),
      close: async () => {
        this.closed++;
        this.beforeClose?.();
      }
    };
  }
}

/** Builds one logcat line the way `adb logcat -v epoch,uid` prints it. */
export function logLine(fields: {
  t?: number;
  uid?: string | number;
  pid?: number;
  tid?: number;
  prio?: string;
  tag: string;
  msg: string;
}): string {
  const { t = 1_700_000_001.234, uid = APP_UID, pid = 4321, tid = pid, prio = 'I', tag, msg } = fields;
  return `         ${t.toFixed(3)} ${String(uid).padStart(5)} ${String(pid).padStart(5)} ${String(tid).padStart(5)} ${prio} ${tag}: ${msg}\n`;
}

/** A scripted `adb logcat` process: tests push chunks (split anywhere) and decide how it ends. */
export class FakeLogcat {
  spawns: { file: string; args: string[] }[] = [];
  running = 0;
  killed = 0;
  /** Set to make the next spawn fail to start. */
  startError: string | null = null;
  /** Set to make the process exit right after it started, as adb does for an offline device. */
  exitAtOnce: { code: number; stderr: string } | null = null;
  /** Chunks delivered right after spawn. */
  initial: (string | Buffer)[] = [];
  private current: { splitter: LineSplitter; exit: (value: Partial<StreamExit>) => void } | null = null;

  spawnStream: StreamSpawner = (file, args, options: StreamOptions) => {
    this.spawns.push({ file, args: [...args] });
    let resolve!: (value: StreamExit) => void;
    const exited = new Promise<StreamExit>((r) => (resolve = r));
    let ended = false;
    let stopped = false;
    const splitter = new LineSplitter(options.maxLineChars, options.onLine);
    const exit = (value: Partial<StreamExit>): void => {
      if (ended) return;
      ended = true;
      this.running--;
      splitter.flush();
      resolve({ code: 0, signal: null, error: null, stopped, stderr: '', ...value });
    };
    this.running++;
    this.current = { splitter, exit };
    const handle: StreamHandle = {
      exited,
      kill: () => {
        if (ended) return;
        this.killed++;
        stopped = true;
        exit({ code: null, signal: 'SIGTERM', stopped: true });
      },
      stop: () => {
        handle.kill();
        return exited;
      }
    };
    if (this.startError !== null) {
      const error = this.startError;
      this.startError = null;
      queueMicrotask(() => exit({ code: null, error }));
    } else {
      for (const chunk of this.initial) splitter.push(chunk);
      const early = this.exitAtOnce;
      if (early) queueMicrotask(() => exit({ code: early.code, stderr: early.stderr, stopped: false }));
    }
    return handle;
  };

  /** Delivers a raw chunk of stdout; it may end mid-line or mid-character. */
  push(chunk: string | Buffer): void {
    this.current?.splitter.push(chunk);
  }

  /** The process ends by itself (not because we stopped it). */
  end(code: number | null = 1, stderr = ''): void {
    this.current?.exit({ code, stderr, stopped: false });
  }
}

export class FakeSignals implements SignalHost {
  handlers = new Map<string, Set<() => void>>();
  reraised: string[] = [];
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void {
    this.handlers.set(signal, (this.handlers.get(signal) ?? new Set()).add(handler));
  }
  off(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void {
    this.handlers.get(signal)?.delete(handler);
  }
  reraise(signal: 'SIGINT' | 'SIGTERM'): void {
    this.reraised.push(signal);
  }
  emit(signal: 'SIGINT' | 'SIGTERM'): void {
    for (const handler of [...(this.handlers.get(signal) ?? [])]) handler();
  }
  get installed(): number {
    return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

export function fakeDeps(
  adb: FakeAdb,
  cdp: FakeCdp,
  cwd: string,
  logcat: FakeLogcat = new FakeLogcat(),
  signals: SignalHost = new FakeSignals()
): Deps {
  let now = 1_700_000_000_000;
  return {
    runner: adb.runner,
    spawnStream: logcat.spawnStream,
    signals,
    env: {},
    cwd,
    now: () => new Date(now),
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      }
    },
    cdp
  };
}
