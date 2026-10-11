import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult, Runner } from '../../tools/device/exec';
import type { Deps } from '../../tools/device/runtime';
import type { CdpBrowser, CdpConnector, CdpPage, LocateResult } from '../../tools/device/webview';

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

  /** Argument vectors of every call, e.g. to prove nothing ran. */
  get shellCalls(): string[][] {
    return this.calls.filter((args) => args.includes('shell')).map((args) => shellSplit(args.slice(args.indexOf('shell') + 1).join(' ')));
  }

  /** Every process start (file + argv), including git; `calls` holds adb argv only. */
  spawns: string[] = [];
  gitRevision = 'a'.repeat(40);

  runner: Runner = async (file, args) => {
    this.spawns.push(file);
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
    if (rest[0] === 'exec-out') return result(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    if (rest[0] !== 'shell') return result('', 1, 'unexpected');
    return this.shell(transport, shellSplit(rest.slice(1).join(' ')));
  };

  private shell(transport: string, words: string[]): ExecResult {
    const [cmd, ...a] = words;
    if (cmd === 'getprop') return result(`${this.devices[transport]}\n`);
    if (cmd === 'settings') {
      if (a[0] === 'get') return result(`${this.settings[a[2]] ?? 'null'}\n`);
      if (a[0] === 'put') this.settings[a[2]] = a[3];
      if (a[0] === 'delete') this.settings[a[2]] = null;
      return result('');
    }
    if (cmd === 'dumpsys') return result(`Package [${APP}]\n    versionCode=31 minSdk=24\n    versionName=${this.versionName}\n`);
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
    if (cmd === 'logcat') return result('I/app: hello\n');
    return result(''); // input, am, ...
  }

  /** Any `input` / `am` / `settings put` style mutation issued so far. */
  mutations(): string[][] {
    return this.shellCalls.filter((words) => ['input', 'am'].includes(words[0]) || (words[0] === 'settings' && words[1] !== 'get'));
  }
}

export function tempDir(prefix = 'ldev-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface FakePageSpec {
  url?: string;
  locate?: (locator: unknown, options: { scroll: boolean; points?: { x: number; y: number }[] }) => LocateResult;
  countVisible?: (target: unknown) => number;
  evaluate?: (arg: unknown) => unknown;
}

export class FakeCdp implements CdpConnector {
  endpoints: string[] = [];
  closed = 0;
  clicks: { x: number; y: number }[] = [];
  pages: FakePageSpec[] = [{ url: 'https://appassets.androidplatform.net/assets/loopdeck/index.html#home' }];
  connectError: Error | null = null;
  beforeClose: (() => void) | null = null;

  async connect(endpoint: string): Promise<CdpBrowser> {
    this.endpoints.push(endpoint);
    if (this.connectError) throw this.connectError;
    return {
      pages: () =>
        this.pages.map((spec): CdpPage => ({
          url: () => spec.url ?? 'about:blank',
          evaluate: (async (_fn: unknown, arg: unknown) => spec.evaluate?.(arg)) as CdpPage['evaluate'],
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

export function fakeDeps(adb: FakeAdb, cdp: FakeCdp, cwd: string): Deps {
  let now = 1_700_000_000_000;
  return {
    runner: adb.runner,
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
