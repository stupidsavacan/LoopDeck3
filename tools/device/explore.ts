import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveLdevHome } from './constants.js';
import { DeviceCliError } from './errors.js';
import { acquireLock } from './lock.js';
import type { Deps } from './runtime.js';
import { SessionHandle, atomicWriteFile, type SessionPaths } from './session.js';

/**
 * Exploration recording. `prepare --record` creates a directory under $LDEV_HOME/explore/ and points the
 * session record at it; from then on every session-bound command is written to `ops.ndjson` as a
 * `begin` line before it runs and an `end` line after, by one wrapper in cli.ts. Observations
 * (`ldev observe`) add one line each to `observations.ndjson`. `finish` condenses both into
 * `summary.json`, which holds names and counts only. Raw files may contain device text and stay in
 * LDEV_HOME.
 */

export const OPS_FILE = 'ops.ndjson';
export const OBSERVATIONS_FILE = 'observations.ndjson';
export const SUMMARY_FILE = 'summary.json';

const MAX_PARAM_CHARS = 200;
const MAX_SUMMARY_STEPS = 200;
const MAX_SUMMARY_ANOMALIES = 20;

export interface OpBegin {
  seq: number;
  phase: 'begin';
  sessionId: string;
  at: string;
  atMs: number;
  command: string;
  params: Record<string, unknown>;
}

export interface OpEnd {
  seq: number;
  phase: 'end';
  sessionId: string;
  at: string;
  atMs: number;
  durationMs: number;
  command: string;
  ok: boolean;
  /** Error code of a thrown error or of a failed check (CHECK_FAILED, INCOMPLETE, ...). */
  errorCode: string | null;
  observationId?: number;
  /** Anomaly kinds an observation found (observe only). */
  anomalies?: string[];
}

export type OpRecord = OpBegin | OpEnd;

/** One compact line per observation; the full observation is a separate file. */
export interface ObservationIndex {
  id: number;
  at: string;
  afterSeq: number | null;
  afterCommand: string | null;
  status: 'COMPLETE' | 'INCONCLUSIVE';
  connected: boolean;
  anomalies: string[];
  newJsErrors: number;
  crashes: number;
  anrs: number;
  processDied: number;
  errorScreen: boolean;
  gaps: string[];
  state: { added: number; removed: number; updated: number; localStorageChanged: number } | null;
  screenChanged: boolean | null;
}

export interface ExplorationSummary {
  schema: 1;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  /** CLEAN only once `finish` verified the restoration; DIRTY when it could not. */
  sessionStatus: 'CLEAN' | 'DIRTY';
  app: { package: string; versionName: string | null; versionCode: string | null };
  device: { idDigest: string };
  operations: { total: number; failed: number; interrupted: number; byCommand: Record<string, number> };
  observations: { total: number; inconclusive: number; withStateComparison: number };
  errors: { newJsErrors: number; androidCrashes: number; androidAnrs: number; processDied: number; errorScreens: number };
  stateChanges: { observationsWithChange: number; recordsAdded: number; recordsRemoved: number; recordsUpdated: number; localStorageKeysChanged: number };
  firstAnomaly: AnomalyReport | null;
  anomalies: AnomalyReport[];
  unobserved: { observationsWithGaps: { observationId: number; afterSeq: number | null; gaps: string[] }[]; actionsAfterLastObservation: number };
  steps: { seq: number; command: string; params: string; ok: boolean | null; errorCode: string | null }[];
  stepsTruncated: boolean;
}

export interface AnomalyReport {
  observationId: number;
  afterSeq: number | null;
  afterCommand: string | null;
  kinds: string[];
}

export interface ActionRef {
  seq: number;
  command: string;
  params: string;
  ok: boolean | null;
}

const clip = (value: string, max = MAX_PARAM_CHARS): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Only the options that describe the operation; never the session path, the serial or a file's content. */
export function recordParams(
  values: Record<string, string | boolean | undefined>,
  positionals: readonly string[]
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false || key === 'session' || key === 'serial' || key === 'out') continue;
    params[key] = typeof value === 'string' ? clip(key === 'apk' ? basename(value) : value) : value;
  }
  if (positionals.length > 0) params.args = positionals.slice(0, 32).map((arg) => clip(arg));
  return params;
}

/** One short line such as `tap role=button name="Start"`; used by summaries and reproduction notes. */
export function describeParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  const args = params.args;
  if (Array.isArray(args)) parts.push(args.map(String).join(' '));
  for (const [key, value] of Object.entries(params)) {
    if (key === 'args') continue;
    parts.push(value === true ? `--${key}` : `--${key}=${JSON.stringify(value)}`);
  }
  return clip(parts.join(' '), 120);
}

function readLines<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // a torn last line (process killed mid-write) is ignored; earlier lines stay valid
    }
  }
  return records;
}

export class Recorder {
  private constructor(
    readonly dir: string,
    readonly sessionId: string,
    private readonly deps: Pick<Deps, 'now' | 'clock'>
  ) {}

  /** Creates the exploration directory and links it from the (already persisted, DIRTY) session record. */
  static create(
    deps: Deps,
    session: SessionHandle,
    info: { serial: string; versionName: string | null; versionCode: string | null; startDeviceEpochMs: number | null }
  ): Recorder {
    const startedAt = deps.now();
    const root = join(resolveLdevHome(deps.env, process.platform, homedir()), 'explore');
    mkdirSync(root, { recursive: true });
    let dir = '';
    for (let attempt = 1; attempt < 100; attempt++) {
      const candidate = join(root, `${stamp(startedAt)}-${session.record.id}${attempt === 1 ? '' : `-${attempt}`}`);
      try {
        mkdirSync(candidate);
        dir = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!dir) throw new DeviceCliError('SESSION', 'Could not create an exploration directory');
    atomicWriteFile(
      join(dir, 'meta.json'),
      `${JSON.stringify({
        schema: 1,
        sessionId: session.record.id,
        transport: info.serial,
        identity: session.record.identity,
        package: session.record.package,
        versionName: info.versionName,
        versionCode: info.versionCode,
        startedAt: startedAt.toISOString(),
        startDeviceEpochMs: info.startDeviceEpochMs
      })}\n`
    );
    session.commit((draft) => {
      draft.exploration = { dir, startedAt: startedAt.toISOString(), startDeviceEpochMs: info.startDeviceEpochMs };
    });
    return new Recorder(dir, session.record.id, deps);
  }

  /** The recorder of an active (DIRTY) recorded session, or null. Never throws: recording must not break a command. */
  static open(deps: Pick<Deps, 'now' | 'clock'>, paths: SessionPaths): Recorder | null {
    try {
      const handle = SessionHandle.read(paths, deps.now);
      const exploration = handle?.record.exploration;
      if (!handle || handle.record.status !== 'DIRTY' || !exploration) return null;
      const meta = JSON.parse(readFileSync(join(exploration.dir, 'meta.json'), 'utf8')) as { sessionId?: string };
      // A directory that belongs to another session is never written to.
      return meta.sessionId === handle.record.id ? new Recorder(exploration.dir, handle.record.id, deps) : null;
    } catch {
      return null;
    }
  }

  get opsPath(): string {
    return join(this.dir, OPS_FILE);
  }

  private async nextSeq(): Promise<number> {
    const lockPath = join(this.dir, 'seq.lock');
    for (let attempt = 0; ; attempt++) {
      try {
        const lock = acquireLock(lockPath, 'seq', this.deps.now);
        try {
          const file = join(this.dir, 'seq');
          const last = existsSync(file) ? Number.parseInt(readFileSync(file, 'utf8'), 10) : 0;
          const seq = (Number.isInteger(last) ? last : 0) + 1;
          atomicWriteFile(file, String(seq));
          return seq;
        } finally {
          lock.release();
        }
      } catch (error) {
        if (!(error instanceof DeviceCliError) || error.code !== 'LOCK' || attempt >= 40) throw error;
        await this.deps.clock.sleep(25);
      }
    }
  }

  async begin(command: string, params: Record<string, unknown>): Promise<OpScope> {
    const seq = await this.nextSeq();
    const atMs = this.deps.clock.now();
    const record: OpBegin = { seq, phase: 'begin', sessionId: this.sessionId, at: this.deps.now().toISOString(), atMs, command, params };
    appendFileSync(this.opsPath, `${JSON.stringify(record)}\n`);
    return new OpScope(this, seq, command, atMs);
  }

  append(record: OpRecord): void {
    appendFileSync(this.opsPath, `${JSON.stringify(record)}\n`);
  }

  appendObservation(index: ObservationIndex): void {
    appendFileSync(join(this.dir, OBSERVATIONS_FILE), `${JSON.stringify(index)}\n`);
  }

  now(): { iso: string; ms: number } {
    return { iso: this.deps.now().toISOString(), ms: this.deps.clock.now() };
  }

  records(): OpRecord[] {
    return readLines<OpRecord>(this.opsPath);
  }

  /** The most recent operation before `seq` that changed or probed the app (not an `observe`). */
  previousAction(seq: number): ActionRef | null {
    const records = this.records();
    let found: OpBegin | null = null;
    for (const record of records) {
      if (record.phase === 'begin' && record.seq < seq && record.command !== 'observe') found = record;
    }
    if (!found) return null;
    const end = records.find((record): record is OpEnd => record.phase === 'end' && record.seq === found?.seq);
    return { seq: found.seq, command: found.command, params: describeParams(found.params), ok: end ? end.ok : null };
  }

  /** Host-time windows in which the app process was stopped on purpose (relaunch, kill, reset, install). */
  expectedExitWindows(): { seq: number; command: string; fromMs: number; toMs: number }[] {
    const records = this.records();
    const windows: { seq: number; command: string; fromMs: number; toMs: number }[] = [];
    for (const begin of records) {
      if (begin.phase !== 'begin') continue;
      const action = Array.isArray(begin.params.args) ? String(begin.params.args[0]) : '';
      const stops =
        begin.command === 'reset' || begin.command === 'install' || (begin.command === 'lifecycle' && (action === 'relaunch' || action === 'kill'));
      if (!stops) continue;
      const end = records.find((record): record is OpEnd => record.phase === 'end' && record.seq === begin.seq);
      windows.push({ seq: begin.seq, command: begin.command, fromMs: begin.atMs, toMs: end ? end.atMs : Number.MAX_SAFE_INTEGER });
    }
    return windows;
  }

  /** Condenses ops.ndjson and observations.ndjson into summary.json. Safe to call again (finish may be retried). */
  writeSummary(status: 'CLEAN' | 'DIRTY'): ExplorationSummary {
    const meta = JSON.parse(readFileSync(join(this.dir, 'meta.json'), 'utf8')) as {
      identity: string;
      package: string;
      versionName: string | null;
      versionCode: string | null;
      startedAt: string;
    };
    const summary = buildSummary({
      sessionId: this.sessionId,
      status,
      startedAt: meta.startedAt,
      finishedAt: this.deps.now().toISOString(),
      app: { package: meta.package, versionName: meta.versionName, versionCode: meta.versionCode },
      idDigest: createHash('sha256').update(meta.identity).digest('hex').slice(0, 12),
      ops: this.records(),
      observations: readLines<ObservationIndex>(join(this.dir, OBSERVATIONS_FILE))
    });
    atomicWriteFile(join(this.dir, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
}

/** The running operation: one per recorded CLI invocation. */
export class OpScope {
  private extra: { observationId?: number; anomalies?: string[] } = {};
  private ended = false;

  constructor(
    readonly recorder: Recorder,
    readonly seq: number,
    private readonly command: string,
    private readonly startMs: number
  ) {}

  get dir(): string {
    return this.recorder.dir;
  }

  /** Links this operation to the observation it produced. */
  attachObservation(id: number, anomalies: string[]): void {
    this.extra = { observationId: id, anomalies };
  }

  end(outcome: { ok: boolean; errorCode: string | null }): void {
    if (this.ended) return;
    this.ended = true;
    const { iso, ms } = this.recorder.now();
    try {
      this.recorder.append({
        seq: this.seq,
        phase: 'end',
        sessionId: this.recorder.sessionId,
        at: iso,
        atMs: ms,
        durationMs: Math.max(0, ms - this.startMs),
        command: this.command,
        ok: outcome.ok,
        errorCode: outcome.errorCode,
        ...this.extra
      });
    } catch {
      // the operation's own result must survive a full disk
    }
  }
}

interface SummaryInput {
  sessionId: string;
  status: 'CLEAN' | 'DIRTY';
  startedAt: string;
  finishedAt: string;
  app: ExplorationSummary['app'];
  idDigest: string;
  ops: OpRecord[];
  observations: ObservationIndex[];
}

/** Pure: counts, kinds and short step descriptions only. No DOM, no log text, no record content. */
export function buildSummary(input: SummaryInput): ExplorationSummary {
  const begins = new Map<number, OpBegin>();
  const ends = new Map<number, OpEnd>();
  for (const record of input.ops) {
    if (record.phase === 'begin') begins.set(record.seq, record);
    else ends.set(record.seq, record);
  }
  const seqs = [...begins.keys()].sort((a, b) => a - b);
  const byCommand: Record<string, number> = {};
  let failed = 0;
  let interrupted = 0;
  for (const seq of seqs) {
    const begin = begins.get(seq) as OpBegin;
    byCommand[begin.command] = (byCommand[begin.command] ?? 0) + 1;
    const end = ends.get(seq);
    if (!end) interrupted++;
    else if (!end.ok) failed++;
  }
  const refOf = (seq: number | null): string | null => (seq === null ? null : (begins.get(seq)?.command ?? null));

  const anomalies: AnomalyReport[] = input.observations
    .filter((observation) => observation.anomalies.length > 0)
    .map((observation) => ({
      observationId: observation.id,
      afterSeq: observation.afterSeq,
      afterCommand: observation.afterCommand ?? refOf(observation.afterSeq),
      kinds: observation.anomalies
    }));
  const sum = (pick: (o: ObservationIndex) => number): number => input.observations.reduce((total, o) => total + pick(o), 0);
  const withState = input.observations.filter((o) => o.state !== null);
  const lastObservedSeq = input.observations.reduce((max, o) => Math.max(max, o.afterSeq ?? 0), 0);
  const lastObservationOp = seqs.filter((seq) => begins.get(seq)?.command === 'observe').pop() ?? 0;
  const actionsAfter = seqs.filter(
    (seq) => seq > Math.max(lastObservationOp, lastObservedSeq) && !['observe', 'finish'].includes(begins.get(seq)?.command ?? '')
  ).length;

  return {
    schema: 1,
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    sessionStatus: input.status,
    app: input.app,
    device: { idDigest: input.idDigest },
    operations: { total: seqs.length, failed, interrupted, byCommand },
    observations: {
      total: input.observations.length,
      inconclusive: input.observations.filter((o) => o.status === 'INCONCLUSIVE').length,
      withStateComparison: withState.length
    },
    errors: {
      newJsErrors: sum((o) => o.newJsErrors),
      androidCrashes: sum((o) => o.crashes),
      androidAnrs: sum((o) => o.anrs),
      processDied: sum((o) => o.processDied),
      errorScreens: input.observations.filter((o) => o.errorScreen).length
    },
    stateChanges: {
      observationsWithChange: withState.filter((o) => (o.state?.added ?? 0) + (o.state?.removed ?? 0) + (o.state?.updated ?? 0) + (o.state?.localStorageChanged ?? 0) > 0).length,
      recordsAdded: withState.reduce((total, o) => total + (o.state?.added ?? 0), 0),
      recordsRemoved: withState.reduce((total, o) => total + (o.state?.removed ?? 0), 0),
      recordsUpdated: withState.reduce((total, o) => total + (o.state?.updated ?? 0), 0),
      localStorageKeysChanged: withState.reduce((total, o) => total + (o.state?.localStorageChanged ?? 0), 0)
    },
    firstAnomaly: anomalies[0] ?? null,
    anomalies: anomalies.slice(0, MAX_SUMMARY_ANOMALIES),
    unobserved: {
      observationsWithGaps: input.observations
        .filter((o) => o.gaps.length > 0)
        .map((o) => ({ observationId: o.id, afterSeq: o.afterSeq, gaps: o.gaps })),
      actionsAfterLastObservation: actionsAfter
    },
    steps: seqs.slice(0, MAX_SUMMARY_STEPS).map((seq) => {
      const begin = begins.get(seq) as OpBegin;
      const end = ends.get(seq);
      return { seq, command: begin.command, params: describeParams(begin.params), ok: end ? end.ok : null, errorCode: end?.errorCode ?? null };
    }),
    stepsTruncated: seqs.length > MAX_SUMMARY_STEPS
  };
}
