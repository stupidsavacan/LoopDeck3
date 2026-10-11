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

/**
 * Consumes parsed log lines and decides what is evidence about the debug app. A line counts as the
 * app's when its uid is the app's, when its pid was ever seen as the app's (pids are kept after the
 * process dies), or when it names the package. Crashes of other apps never match: package names are
 * compared exactly.
 */
export class LogcatAnalyzer {
  private appUid: string | null;
  private readonly pids = new Set<number>();
  private readonly expectedExits = new Set<number>();
  private readonly pendingFatal = new Set<number>();
  private readonly flaggedFatal = new Set<number>();
  /** A crash/ANR was reported and its process death has not been seen yet. */
  private deathExplained = false;
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
    if (ownUid) this.pids.add(line.pid);
    let relevant = ownUid || this.pids.has(line.pid) || line.message.includes(APP_PACKAGE);

    if (line.tag === 'AndroidRuntime') relevant = this.androidRuntime(line, ownUid) || relevant;
    else if (line.tag.startsWith('am_')) relevant = this.eventLog(line) || relevant;
    return relevant;
  }

  private emit(type: string, anomaly: LogcatAnomalyKind | null, line: LogcatLine, extra: Record<string, unknown> = {}): void {
    this.events.push({ type, anomaly, data: { pid: line.pid, uid: line.uid, deviceEpochMs: line.epochMs, ...extra } });
  }

  private androidRuntime(line: LogcatLine, ownUid: boolean): boolean {
    if (line.message.startsWith('FATAL EXCEPTION')) {
      if (ownUid || this.pids.has(line.pid)) return this.fatal(line);
      this.pendingFatal.add(line.pid); // the next "Process:" line names the process
      return false;
    }
    if (!this.pendingFatal.has(line.pid)) return false;
    const process = /^Process: ([^,\s]+)/.exec(line.message)?.[1];
    if (process === undefined) return false;
    this.pendingFatal.delete(line.pid);
    if (!isAppProcess(process)) return false;
    this.pids.add(line.pid);
    return this.fatal(line);
  }

  private fatal(line: LogcatLine): boolean {
    if (!this.flaggedFatal.has(line.pid)) {
      this.flaggedFatal.add(line.pid);
      this.deathExplained = true;
      this.emit('fatalException', 'androidFatalException', line);
    }
    return true;
  }

  private eventLog(line: LogcatLine): boolean {
    const fields = parseEventFields(line.message);
    if (!fields) return false;
    switch (line.tag) {
      case 'am_proc_start': {
        // [user, pid, uid, processName, hostingType, hostingName]
        if (!isAppProcess(fields[3] ?? '')) return false;
        const pid = Number.parseInt(fields[1], 10);
        if (Number.isInteger(pid)) this.pids.add(pid);
        if (this.appUid === null && /^\d+$/.test(fields[2] ?? '')) this.appUid = fields[2];
        this.deathExplained = false;
        this.emit('processStart', null, line, { appPid: pid });
        return true;
      }
      case 'am_crash': // [pid, user, processName, flags, exceptionClass, message, file, line]
        if (!isAppProcess(fields[2] ?? '')) return false;
        this.deathExplained = true;
        this.emit('amCrash', 'androidCrash', line, { exception: fields[4] ?? null });
        return true;
      case 'am_anr': // [user, pid, processName, flags, reason]
        if (!isAppProcess(fields[2] ?? '')) return false;
        this.deathExplained = true;
        this.emit('amAnr', 'androidAnr', line, { appPid: Number.parseInt(fields[1], 10) });
        return true;
      case 'am_proc_died': {
        // [user, pid, processName, oomAdj, procState]
        if (!isAppProcess(fields[2] ?? '')) return false;
        const pid = Number.parseInt(fields[1], 10);
        const expected = this.expectedExits.has(pid);
        const explained = this.deathExplained;
        this.deathExplained = false;
        if (expected) this.emit('expectedExit', null, line, { appPid: pid });
        else if (explained) this.emit('processDied', null, line, { appPid: pid, explainedBy: 'crash-or-anr' });
        else this.emit('processDied', 'androidProcessDied', line, { appPid: pid });
        return true;
      }
      default:
        return false;
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
