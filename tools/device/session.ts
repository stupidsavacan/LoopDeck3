import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_PACKAGE, DEFAULT_SESSION_ROOT, ROTATION_SETTINGS, type RotationSetting, type TrackedSettingKey } from './constants.js';
import { DeviceCliError } from './errors.js';

export interface OwnedForward {
  port: number;
  remote: string;
  pid: number;
  createdAt: string;
}

/** The APK this session installed, or was told to expect: the only thing provenance is checked against. */
export interface ExpectedApk {
  sha256: string;
  versionName: string | null;
  versionCode: string | null;
  source: 'install' | 'run';
  recordedAt: string;
}

export interface SessionRecord {
  schema: 1;
  id: string;
  /** DIRTY from the first persisted mutation intent until a verified `finish`. */
  status: 'DIRTY' | 'CLEAN';
  createdAt: string;
  updatedAt: string;
  transport: string;
  identity: string;
  package: string;
  originals: Record<RotationSetting, string | null>;
  rotationMutated: boolean;
  forwards: OwnedForward[];
  /** Written before `adb forward` runs so an interrupted attach is visible to finish. */
  pendingForward: { remote: string; since: string } | null;
  lastPid: number | null;
  notes: string[];
  /**
   * Original value of every device setting this session changed beyond rotation (`uimode`,
   * `font_scale`), written BEFORE the change and removed only once `finish` re-read the restored
   * value. Absent in sessions written before PR3, which means "nothing to restore".
   */
  changedSettings?: Partial<Record<TrackedSettingKey, { original: string | null }>>;
  expectedApk?: ExpectedApk | null;
  /** Present when `prepare --record` started an exploration: where its operation log and observations live. */
  exploration?: { dir: string; startedAt: string; startDeviceEpochMs: number | null };
}

export interface SessionPaths {
  root: string;
  file: string;
  lock: string;
  artifacts: string;
}

export function sessionPaths(sessionDir: string | undefined, cwd: string): SessionPaths {
  const root = resolve(cwd, sessionDir ?? DEFAULT_SESSION_ROOT);
  return { root, file: join(root, 'session.json'), lock: join(root, 'session.lock'), artifacts: join(root, 'artifacts') };
}

/** Atomic replace: write a sibling temp file, fsync, rename over the target. */
export function atomicWriteFile(path: string, data: string | Buffer): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // best effort
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validate(raw: unknown): SessionRecord {
  const bad = (what: string) => new DeviceCliError('SESSION', `Session file is invalid (${what}); it was not modified`);
  if (!isRecord(raw) || raw.schema !== 1) throw bad('schema');
  if (raw.status !== 'DIRTY' && raw.status !== 'CLEAN') throw bad('status');
  for (const key of ['id', 'createdAt', 'updatedAt', 'transport', 'identity', 'package']) {
    if (typeof raw[key] !== 'string' || !raw[key]) throw bad(key);
  }
  if (raw.package !== APP_PACKAGE) throw bad('package');
  if (!isRecord(raw.originals)) throw bad('originals');
  for (const key of ROTATION_SETTINGS) {
    const value = raw.originals[key];
    if (value !== null && typeof value !== 'string') throw bad(`originals.${key}`);
  }
  if (typeof raw.rotationMutated !== 'boolean') throw bad('rotationMutated');
  if (!Array.isArray(raw.forwards) || !raw.forwards.every((f) => isRecord(f) && Number.isInteger(f.port) && typeof f.remote === 'string'))
    throw bad('forwards');
  if (raw.pendingForward !== null && !isRecord(raw.pendingForward)) throw bad('pendingForward');
  if (!Array.isArray(raw.notes)) throw bad('notes');
  if (raw.changedSettings !== undefined) {
    if (!isRecord(raw.changedSettings)) throw bad('changedSettings');
    for (const [key, entry] of Object.entries(raw.changedSettings)) {
      if (key !== 'uimode' && key !== 'font_scale') throw bad(`changedSettings.${key}`);
      if (!isRecord(entry) || (entry.original !== null && typeof entry.original !== 'string')) throw bad(`changedSettings.${key}`);
    }
  }
  if (raw.expectedApk !== undefined && raw.expectedApk !== null) {
    const apk = raw.expectedApk;
    if (!isRecord(apk) || typeof apk.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(apk.sha256)) throw bad('expectedApk');
  }
  if (raw.exploration !== undefined) {
    const exploration = raw.exploration;
    if (!isRecord(exploration) || typeof exploration.dir !== 'string' || !exploration.dir || typeof exploration.startedAt !== 'string')
      throw bad('exploration');
    if (exploration.startDeviceEpochMs !== null && typeof exploration.startDeviceEpochMs !== 'number') throw bad('exploration');
  }
  return raw as unknown as SessionRecord;
}

export class SessionHandle {
  private constructor(
    readonly paths: SessionPaths,
    private current: SessionRecord,
    private readonly now: () => Date
  ) {}

  get record(): Readonly<SessionRecord> {
    return this.current;
  }

  static read(paths: SessionPaths, now: () => Date): SessionHandle | null {
    let text: string;
    try {
      text = readFileSync(paths.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DeviceCliError('SESSION', 'Session file is not valid JSON; it was not modified');
    }
    return new SessionHandle(paths, validate(parsed), now);
  }

  /** Requires a session that has not been verified clean. */
  static requireActive(paths: SessionPaths, now: () => Date): SessionHandle {
    const handle = SessionHandle.read(paths, now);
    if (!handle) throw new DeviceCliError('SESSION', `No session at ${paths.root}. Run "ldev prepare --serial <serial>" first.`);
    if (handle.record.status !== 'DIRTY')
      throw new DeviceCliError('SESSION', 'Session is already finished (CLEAN). Run "ldev prepare" for a new one.');
    return handle;
  }

  /** Creates the first record, persisted before any device mutation. */
  static create(paths: SessionPaths, init: Pick<SessionRecord, 'transport' | 'identity' | 'originals'>, now: () => Date): SessionHandle {
    mkdirSync(paths.root, { recursive: true });
    const stamp = now().toISOString();
    const record: SessionRecord = {
      schema: 1,
      id: randomBytes(8).toString('hex'),
      status: 'DIRTY',
      createdAt: stamp,
      updatedAt: stamp,
      package: APP_PACKAGE,
      rotationMutated: false,
      forwards: [],
      pendingForward: null,
      lastPid: null,
      notes: [],
      ...init
    };
    atomicWriteFile(paths.file, `${JSON.stringify(record, null, 2)}\n`);
    return new SessionHandle(paths, record, now);
  }

  /** Applies a change and persists it atomically before returning, i.e. before the caller acts on it. */
  commit(change: (draft: SessionRecord) => void): SessionRecord {
    const draft = JSON.parse(JSON.stringify(this.current)) as SessionRecord;
    change(draft);
    draft.updatedAt = this.now().toISOString();
    atomicWriteFile(this.paths.file, `${JSON.stringify(draft, null, 2)}\n`);
    this.current = draft;
    return draft;
  }
}
