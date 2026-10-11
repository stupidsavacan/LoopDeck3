import { appendFileSync, writeFileSync } from 'node:fs';
import { APP_PACKAGE } from './constants.js';
import type { StreamExit, StreamHandle } from './exec.js';
import type { DeviceRun } from './runtime.js';

/** Caps on what one run keeps. Hitting either makes the channel INCONCLUSIVE rather than silently partial. */
export const LOGCAT_LIMITS = {
  maxLineChars: 8 * 1024,
  maxRawBytes: 8 * 1024 * 1024,
  maxJournalLines: 2_000,
  readyWaitMs: 3_000,
  readyPollMs: 50
} as const;

export interface LogcatLine {
  epochMs: number;
  uid: string;
  pid: number;
  tid: number;
  priority: string;
  tag: string;
  message: string;
}

// `adb logcat -v epoch,uid` prints: <sec>.<ms> <uid> <pid> <tid> <prio> <tag>: <message>
const LINE = /^\s*(\d+)\.(\d{3})\s+(\S+)\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(\S.*?)\s*: ?(.*)$/;

/** Returns null for buffer banners ("--------- beginning of main") and anything that is not a log line. */
export function parseLogcatLine(line: string): LogcatLine | null {
  const match = LINE.exec(line);
  if (!match) return null;
  return {
    epochMs: Number.parseInt(match[1], 10) * 1000 + Number.parseInt(match[2], 10),
    uid: match[3],
    pid: Number.parseInt(match[4], 10),
    tid: Number.parseInt(match[5], 10),
    priority: match[6],
    tag: match[7],
    message: match[8]
  };
}

/** Fields of an event-log message such as `[0,1234,com.pkg,200,12]`; trailing free text may contain commas. */
export function parseEventFields(message: string): string[] | null {
  const match = /^\[(.*)\]\s*$/.exec(message);
  return match ? match[1].split(',') : null;
}

/** The package's own process names: the main process and any `pkg:suffix` process, never a longer package. */
export function isAppProcess(name: string): boolean {
  return name === APP_PACKAGE || name.startsWith(`${APP_PACKAGE}:`);
}

export type LogcatAnomalyKind = 'androidFatalException' | 'androidCrash' | 'androidAnr' | 'androidProcessDied';

export interface LogcatEvent {
  /** Journal record type. */
  type: string;
  /** Present when this event is an anomaly that must be judged. */
  anomaly: LogcatAnomalyKind | null;
  data: Record<string, unknown>;
}

export type LogcatStatus = 'ok' | 'unavailable' | 'interrupted';

export interface LogcatSummary {
  status: LogcatStatus;
  detail: string | null;
  lines: number;
  appLines: number;
  writtenLines: number;
  droppedLines: number;
  pidsSeen: number;
  limitReached: boolean;
}

/** True when `text` names the app as a whole token: not as a prefix of a longer package (`<pkg>.other`, `<pkg>x`). */
export function mentionsApp(text: string): boolean {
  for (let from = text.indexOf(APP_PACKAGE); from !== -1; from = text.indexOf(APP_PACKAGE, from + 1)) {
    const before = text[from - 1] ?? '';
    const after = text[from + APP_PACKAGE.length] ?? '';
    const afterNext = text[from + APP_PACKAGE.length + 1] ?? '';
    const tokenChar = /[A-Za-z0-9_.]/;
    if (tokenChar.test(before)) continue;
    if (/[A-Za-z0-9_]/.test(after) || (after === '.' && /[A-Za-z0-9_]/.test(afterNext))) continue;
    return true;
  }
  return false;
}

/** Tags of helper processes that run under the app's uid while it is crashing. */
const HELPER_TAGS: ReadonlySet<string> = new Set(['crash_dump64', 'crash_dump32', 'DEBUG', 'tombstoned']);

/** Event-log lines carry `[a,b,c]` fields under a snake_case tag such as `wm_finish_activity`. */
const EVENT_TAG = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** A field of an event-log line names the app exactly: `pkg`, `pkg:proc` or a component `pkg/Class`. */
function eventNamesApp(fields: readonly string[]): boolean {
  return fields.some((field) => isAppProcess(field.split('/')[0]));
}

/** System components (root, system, shell, uid < 10000) may talk about the app; other apps' lines never count. */
function isSystemUid(uid: string): boolean {
  if (!/^[0-9]+$/.test(uid)) return true;
  return Number.parseInt(uid, 10) < 10_000;
}

/**
 * Consumes parsed log lines and decides what is evidence about the debug app. A line counts as the
 * app's when its uid is the app's, when its pid was seen as the app's process (pids are kept after the
 * process dies, but only lines of the app's own uid or of system components follow them, so a reused
 * pid of another app does not leak in), or when a system component or an event-log field names the
 * package exactly. Process deaths are accounted per pid.
 */
export class LogcatAnalyzer {
  private appUid: string | null;
  private readonly pids = new Set<number>();
  /** Pids of app processes seen starting (am_proc_start) and not yet dead, oldest first. */
  private readonly alive = new Set<number>();
  /** Weaker: pids that merely logged under the app's uid (e.g. a process that started before the stream did). */
  private readonly sighted = new Set<number>();
  /** Pids whose death was asked for (relaunch); each entry is consumed by that pid's death. */
  private readonly expectedExits = new Set<number>();
  /** Pids whose death a crash/ANR/fatal exception already accounts for. */
  private readonly explainedExits = new Set<number>();
  private readonly pendingFatal = new Set<number>();
  /** Pids that died and have not been started again; late lines of theirs must not revive them. */
  private readonly exitedPids = new Set<number>();
  private readonly flaggedFatal = new Set<number>();
  readonly events: LogcatEvent[] = [];

  constructor(appUid: string | null) {
    this.appUid = appUid;
  }

  get pidsSeen(): number {
    return this.pids.size;
  }

  /** Pids that are about to be stopped on purpose (relaunch); their death is not an anomaly. */
  expectExit(pids: readonly number[]): void {
    for (const pid of pids) this.expectedExits.add(pid);
  }

  /** True when the line is evidence about the app. Also feeds the anomaly detectors. */
  consume(line: LogcatLine): boolean {
    const ownUid = this.appUid !== null && line.uid === this.appUid;
    if (ownUid) this.seen(line, line.tag);
    const fields = EVENT_TAG.test(line.tag) ? parseEventFields(line.message) : null;
    const pidMatch = this.pids.has(line.pid) && (this.appUid === null || ownUid || isSystemUid(line.uid));
    let relevant = ownUid || pidMatch;
    if (fields) relevant = eventNamesApp(fields) || relevant;
    else if (isSystemUid(line.uid) && mentionsApp(line.message)) relevant = true;

    if (line.tag === 'AndroidRuntime') relevant = this.androidRuntime(line, ownUid || pidMatch) || relevant;
    else if (fields && line.tag.startsWith('am_')) relevant = this.eventLog(line, fields) || relevant;
    return relevant;
  }

  private seen(line: LogcatLine, tag: string): void {
    this.pids.add(line.pid);
    // Crash dumpers and their forks run under the app's uid in their own single-threaded pid: they are
    // evidence, but never "the app process". A real app process logs from threads other than its main one.
    const helper = HELPER_TAGS.has(tag) || line.tid === line.pid;
    if (!this.exitedPids.has(line.pid) && !helper) this.sighted.add(line.pid);
  }

  private started(pid: number): void {
    this.pids.add(pid);
    this.exitedPids.delete(pid);
    // A new process under this pid: nothing said about the previous owner of the pid applies to it.
    this.expectedExits.delete(pid);
    this.explainedExits.delete(pid);
    this.flaggedFatal.delete(pid);
    this.sighted.delete(pid);
    this.alive.delete(pid);
    this.alive.add(pid);
  }

  /** The crashed process of an `am_crash`: its own pid when known, else (native crash, reported by system_server) the newest running one. */
  private crashedPid(reported: number): number | null {
    if (this.pids.has(reported)) return reported;
    // A crash dumper also logs under the app's uid, so a process seen starting beats one merely seen logging.
    const running = this.alive.size > 0 ? [...this.alive] : [...this.sighted];
    return running.length > 0 ? running[running.length - 1] : null;
  }

  private emit(type: string, anomaly: LogcatAnomalyKind | null, line: LogcatLine, extra: Record<string, unknown> = {}): void {
    this.events.push({ type, anomaly, data: { pid: line.pid, uid: line.uid, deviceEpochMs: line.epochMs, ...extra } });
  }

  private androidRuntime(line: LogcatLine, ownProcess: boolean): boolean {
    if (line.message.startsWith('FATAL EXCEPTION')) {
      if (ownProcess) return this.fatal(line);
      this.pendingFatal.add(line.pid); // the next "Process:" line names the process
      return false;
    }
    if (!this.pendingFatal.has(line.pid)) return false;
    const process = /^Process: ([^,\s]+)/.exec(line.message)?.[1];
    if (process === undefined) return false;
    this.pendingFatal.delete(line.pid);
    if (!isAppProcess(process)) return false;
    this.seen(line, line.tag);
    return this.fatal(line);
  }

  private fatal(line: LogcatLine): boolean {
    if (!this.flaggedFatal.has(line.pid)) {
      this.flaggedFatal.add(line.pid);
      this.explainedExits.add(line.pid);
      this.emit('fatalException', 'androidFatalException', line);
    }
    return true;
  }

  private eventLog(line: LogcatLine, fields: readonly string[]): boolean {
    switch (line.tag) {
      case 'am_proc_start': {
        // [user, pid, uid, processName, hostingType, hostingName]
        if (!isAppProcess(fields[3] ?? '')) return false;
        const pid = Number.parseInt(fields[1], 10);
        if (Number.isInteger(pid)) this.started(pid);
        if (this.appUid === null && /^[0-9]+$/.test(fields[2] ?? '')) this.appUid = fields[2];
        this.emit('processStart', null, line, { appPid: pid });
        return true;
      }
      case 'am_crash': {
        // [pid, user, processName, flags, exceptionClass, message, file, line]
        if (!isAppProcess(fields[2] ?? '')) return false;
        const pid = this.crashedPid(Number.parseInt(fields[0], 10));
        if (pid !== null) this.explainedExits.add(pid);
        this.emit('amCrash', 'androidCrash', line, { exception: fields[4] ?? null, appPid: pid });
        return true;
      }
      case 'am_anr': {
        // [user, pid, processName, flags, reason]
        if (!isAppProcess(fields[2] ?? '')) return false;
        const pid = Number.parseInt(fields[1], 10);
        if (Number.isInteger(pid)) this.explainedExits.add(pid);
        this.emit('amAnr', 'androidAnr', line, { appPid: pid });
        return true;
      }
      case 'am_proc_died': {
        // [user, pid, processName, oomAdj, procState]
        if (!isAppProcess(fields[2] ?? '')) return false;
        const pid = Number.parseInt(fields[1], 10);
        const expected = this.expectedExits.delete(pid);
        const explained = this.explainedExits.delete(pid);
        this.alive.delete(pid);
        this.sighted.delete(pid);
        this.exitedPids.add(pid);
        this.flaggedFatal.delete(pid);
        if (expected) this.emit('expectedExit', null, line, { appPid: pid });
        else if (explained) this.emit('processDied', null, line, { appPid: pid, explainedBy: 'crash-or-anr' });
        else this.emit('processDied', 'androidProcessDied', line, { appPid: pid });
        return true;
      }
      default:
        return false; // other event-log lines are evidence only when a field names the app (decided in consume)
    }
  }
}

export interface LogcatSessionOptions {
  /** Raw attributed log lines go here; it must be inside the run directory (LDEV_HOME by default). */
  rawPath: string;
}

/**
 * One logcat stream for the whole run. Never filtered with `--pid`; starts before the app does and
 * keeps running across pid changes. All state is judged by `LogcatAnalyzer`; this class owns the
 * process, the raw file and the health of the stream.
 */
export class LogcatSession {
  private readonly analyzer: LogcatAnalyzer;
  private handle: StreamHandle | null = null;
  private status: LogcatStatus = 'ok';
  private detail: string | null = null;
  private lines = 0;
  private appLines = 0;
  private writtenLines = 0;
  private droppedLines = 0;
  private rawBytes = 0;
  private journalLines = 0;
  private limitReached = false;
  private stopRequested = false;
  private stopped: Promise<void> | null = null;
  private pending: LogcatEvent[] = [];
  private readonly onSignalHandlers: ['SIGINT' | 'SIGTERM', () => void][] = [];

  private constructor(
    private readonly run: DeviceRun,
    private readonly options: LogcatSessionOptions,
    appUid: string | null
  ) {
    this.analyzer = new LogcatAnalyzer(appUid);
  }

  /** Starts streaming. Never throws: a stream that cannot start is reported as status "unavailable". */
  static async start(run: DeviceRun, options: LogcatSessionOptions): Promise<LogcatSession> {
    let appUid: string | null = null;
    let since: number | null = null;
    try {
      writeFileSync(options.rawPath, '');
      since = await run.device.deviceEpochSeconds();
      appUid = await run.device.appUid();
    } catch {
      // the clock and uid are optimisations: pid and package matching still work without them
    }
    const session = new LogcatSession(run, options, appUid);
    try {
      session.handle = await run.device.openLogcatStream(run.deps.spawnStream, since, {
        maxLineChars: LOGCAT_LIMITS.maxLineChars,
        onLine: (line, truncated) => session.onLine(line, truncated)
      });
    } catch (error) {
      session.fail('unavailable', `logcat could not start: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
      return session;
    }
    session.watch(session.handle);
    session.installSignalHandlers();
    await session.waitUntilReady();
    return session;
  }

  private watch(handle: StreamHandle): void {
    void handle.exited.then((exit) => this.onExit(exit));
  }

  private onExit(exit: StreamExit): void {
    this.removeSignalHandlers();
    if (this.stopRequested || this.status !== 'ok') return;
    const how = exit.error ?? (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`);
    if (this.lines === 0) this.fail('unavailable', `logcat ended before producing output (${how})`);
    else this.fail('interrupted', `logcat stream ended unexpectedly (${how})`);
  }

  private fail(status: Exclude<LogcatStatus, 'ok'>, detail: string): void {
    if (this.status !== 'ok') return;
    this.status = status;
    this.detail = detail;
    this.queue({ type: 'channel', anomaly: null, data: { status, detail } });
  }

  /** Stamps the host arrival time: the journal is written later, per step, so its own clock would lie. */
  private queue(event: LogcatEvent): void {
    this.pending.push({ ...event, data: { ...event.data, hostMs: this.run.deps.clock.now() } });
  }

  private async waitUntilReady(): Promise<void> {
    const { clock } = this.run.deps;
    for (
      let waited = 0;
      waited < LOGCAT_LIMITS.readyWaitMs && this.lines === 0 && this.status === 'ok';
      waited += LOGCAT_LIMITS.readyPollMs
    ) {
      await clock.sleep(LOGCAT_LIMITS.readyPollMs);
    }
  }

  private onLine(raw: string, truncated: boolean): void {
    this.lines++;
    const parsed = parseLogcatLine(raw);
    if (!parsed) return;
    const before = this.analyzer.events.length;
    const relevant = this.analyzer.consume(parsed);
    for (const event of this.analyzer.events.splice(before)) this.queue(event);
    if (!relevant) return;
    this.appLines++;
    const text = `${raw}${truncated ? ' …[line truncated]' : ''}\n`;
    const bytes = Buffer.byteLength(text);
    if (this.rawBytes + bytes > LOGCAT_LIMITS.maxRawBytes) {
      this.droppedLines++;
      if (!this.limitReached) {
        this.limitReached = true;
        this.fail('interrupted', `log size limit of ${LOGCAT_LIMITS.maxRawBytes} bytes reached; later lines were not recorded`);
      }
      return;
    }
    try {
      appendFileSync(this.options.rawPath, text);
      this.rawBytes += bytes;
      this.writtenLines++;
    } catch {
      this.droppedLines++;
      this.fail('interrupted', 'raw log could not be written');
      return;
    }
    if ('WEF'.includes(parsed.priority) && this.journalLines < LOGCAT_LIMITS.maxJournalLines) {
      this.journalLines++;
      this.queue({
        type: 'line',
        anomaly: null,
        data: { deviceEpochMs: parsed.epochMs, pid: parsed.pid, priority: parsed.priority, tag: parsed.tag, message: parsed.message }
      });
    }
  }

  /** Marks these pids as intentionally stopped (relaunch) so their death is not reported as a crash. */
  expectExit(pids: readonly number[]): void {
    this.analyzer.expectExit(pids);
  }

  /** Hands over everything seen since the last call, in arrival order. */
  takeEvents(): LogcatEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }

  get health(): { status: LogcatStatus; detail: string | null } {
    return { status: this.status, detail: this.detail };
  }

  summary(): LogcatSummary {
    return {
      status: this.status,
      detail: this.detail,
      lines: this.lines,
      appLines: this.appLines,
      writtenLines: this.writtenLines,
      droppedLines: this.droppedLines,
      pidsSeen: this.analyzer.pidsSeen,
      limitReached: this.limitReached
    };
  }

  /** Ends the child process and delivers everything it already wrote. Idempotent. */
  stop(): Promise<void> {
    this.stopRequested = true;
    this.removeSignalHandlers();
    this.stopped ??= (this.handle?.stop() ?? Promise.resolve(undefined)).then(() => undefined);
    return this.stopped;
  }

  private installSignalHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      // The record stays DIRTY on purpose (see main.ts); only the child must not outlive us.
      const handler = (): void => {
        this.stopRequested = true;
        this.handle?.kill();
        this.removeSignalHandlers();
        this.run.deps.signals.reraise(signal);
      };
      this.run.deps.signals.on(signal, handler);
      this.onSignalHandlers.push([signal, handler]);
    }
  }

  private removeSignalHandlers(): void {
    for (const [signal, handler] of this.onSignalHandlers.splice(0)) this.run.deps.signals.off(signal, handler);
  }
}
