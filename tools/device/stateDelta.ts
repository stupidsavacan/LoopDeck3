import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveLdevHome } from './constants.js';
import { DeviceCliError } from './errors.js';
import { summarizeCapture, type CaptureResult, type LocalStorageCapture, type StateSummary, type StoreCapture } from './state.js';

/**
 * Record-level state snapshot. It holds digests only: per record `[sha256(key), sha256(value)]`,
 * per localStorage entry `[key, sha256(value)]`. No raw learner data is ever stored.
 */
export interface SnapshotStore {
  name: string;
  keyPath: StoreCapture['keyPath'];
  autoIncrement: boolean;
  indexes: StoreCapture['indexes'];
  count: number;
  /** null for snapshots in the legacy (summary-only) format: counts are known, records are not. */
  records: [string, string][] | null;
}

export interface StateSnapshot {
  schema: 2;
  summary: StateSummary;
  stores: SnapshotStore[];
  localStorage: LocalStorageCapture;
  legacy?: true;
}

export function buildSnapshot(result: CaptureResult, localStorage: LocalStorageCapture | undefined): StateSnapshot {
  return {
    schema: 2,
    summary: summarizeCapture(result),
    stores: result.stores.map((store) => ({
      name: store.name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: store.indexes,
      count: store.count,
      records: store.records ?? []
    })),
    localStorage: localStorage && localStorage.ok ? localStorage : { ok: false, entries: [] }
  };
}

const HEX = /^[0-9a-f]{64}$/;
const isPairs = (value: unknown, second: (v: unknown) => boolean): value is [string, string][] =>
  Array.isArray(value) &&
  value.every((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && second(item[1]));

/** Validates a snapshot file's content. Schema-1 state summaries are accepted as legacy (counts only). */
export function parseSnapshot(raw: unknown, where: string): StateSnapshot {
  const bad = (why: string): DeviceCliError => new DeviceCliError('USAGE', `${where}: ${why}`);
  if (typeof raw !== 'object' || raw === null) throw bad('not a state snapshot');
  const o = raw as Record<string, unknown>;
  if (o.schema === 1 && Array.isArray(o.stores)) {
    const summary = o as unknown as StateSummary;
    return {
      schema: 2,
      legacy: true,
      summary,
      stores: summary.stores.map((store) => ({
        name: String(store.name),
        keyPath: null,
        autoIncrement: false,
        indexes: [],
        count: Number(store.count),
        records: null
      })),
      localStorage: { ok: false, entries: [] }
    };
  }
  if (o.schema !== 2 || typeof o.summary !== 'object' || o.summary === null || !Array.isArray(o.stores)) throw bad('not a state snapshot');
  for (const store of o.stores as Record<string, unknown>[]) {
    if (typeof store !== 'object' || store === null || typeof store.name !== 'string' || !Number.isSafeInteger(store.count))
      throw bad('malformed store entry');
    if (!isPairs(store.records, (v) => typeof v === 'string' && HEX.test(v))) throw bad('malformed record digests');
  }
  const ls = o.localStorage as Record<string, unknown> | undefined;
  if (!ls || typeof ls.ok !== 'boolean' || !isPairs(ls.entries, (v) => typeof v === 'string' && HEX.test(v))) throw bad('malformed localStorage section');
  return raw as StateSnapshot;
}

// --- diff ----------------------------------------------------------------------

export interface StoreDelta {
  name: string;
  presence: 'both' | 'added' | 'removed';
  before: number | null;
  after: number | null;
  /** null when a side has no record digests (legacy snapshot). */
  added: number | null;
  removed: number | null;
  updated: number | null;
  unchanged: number | null;
}

export interface LocalStorageDelta {
  /** False unless both snapshots captured localStorage. */
  available: boolean;
  added: string[];
  removed: string[];
  updated: string[];
  unchanged: number;
  /** Every pattern that was left out of the comparison and how many keys it hid. */
  excluded: { pattern: string; keys: number }[];
  truncated: boolean;
}

export interface StateDelta {
  /** `incomplete` when either side was not fully captured or lacks record detail: no judgement is possible. */
  verdict: 'ok' | 'incomplete';
  reasons: string[];
  /** Database version, store set and key/index structure differences. */
  schemaChanges: string[];
  stores: StoreDelta[];
  localStorage: LocalStorageDelta;
}

const MAX_LISTED_KEYS = 100;

const matcher = (pattern: string): ((key: string) => boolean) =>
  pattern.endsWith('*') ? (key) => key.startsWith(pattern.slice(0, -1)) : (key) => key === pattern;

function diffLocalStorage(a: StateSnapshot, b: StateSnapshot, ignore: readonly string[]): LocalStorageDelta {
  const excluded = ignore.map((pattern) => ({ pattern, keys: 0 }));
  const empty: LocalStorageDelta = { available: false, added: [], removed: [], updated: [], unchanged: 0, excluded, truncated: false };
  if (!a.localStorage.ok || !b.localStorage.ok) return empty;
  const left = new Map(a.localStorage.entries);
  const right = new Map(b.localStorage.entries);
  const tests = ignore.map(matcher);
  const hidden = (key: string): boolean => {
    let any = false;
    tests.forEach((test, index) => {
      if (test(key)) {
        excluded[index].keys++;
        any = true;
      }
    });
    return any;
  };
  const delta: LocalStorageDelta = { ...empty, available: true };
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    if (hidden(key)) continue;
    if (!left.has(key)) delta.added.push(key);
    else if (!right.has(key)) delta.removed.push(key);
    else if (left.get(key) !== right.get(key)) delta.updated.push(key);
    else delta.unchanged++;
  }
  for (const list of ['added', 'removed', 'updated'] as const) {
    if (delta[list].length > MAX_LISTED_KEYS) {
      delta[list] = delta[list].slice(0, MAX_LISTED_KEYS);
      delta.truncated = true;
    }
  }
  return delta;
}

const descriptor = (store: SnapshotStore): string => JSON.stringify([store.keyPath, store.autoIncrement, store.indexes]);

export function diffSnapshots(a: StateSnapshot, b: StateSnapshot, options: { ignoreLocalStorage?: readonly string[] } = {}): StateDelta {
  const ignore = options.ignoreLocalStorage ?? [];
  const reasons: string[] = [];
  for (const [side, snapshot] of [
    ['first', a],
    ['second', b]
  ] as const) {
    if (!snapshot.summary.complete || snapshot.stores.length !== snapshot.summary.stores.length)
      reasons.push(`${side} snapshot is incomplete: ${snapshot.summary.reasons?.join('; ') || 'IndexedDB capture did not finish'}`);
    if (snapshot.legacy) reasons.push(`${side} snapshot uses the legacy format (counts only, no record digests)`);
  }
  const localStorage = diffLocalStorage(a, b, ignore);
  if (reasons.length > 0 && !a.legacy && !b.legacy) {
    return { verdict: 'incomplete', reasons, schemaChanges: [], stores: [], localStorage };
  }

  const schemaChanges: string[] = [];
  if (a.summary.version !== b.summary.version) schemaChanges.push(`database version ${a.summary.version} -> ${b.summary.version}`);
  const left = new Map(a.stores.map((store) => [store.name, store]));
  const right = new Map(b.stores.map((store) => [store.name, store]));
  const stores: StoreDelta[] = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const before = left.get(name);
    const after = right.get(name);
    if (!before) schemaChanges.push(`store ${name} added`);
    else if (!after) schemaChanges.push(`store ${name} removed`);
    else if (!a.legacy && !b.legacy && descriptor(before) !== descriptor(after)) schemaChanges.push(`store ${name} structure changed`);

    const beforeRecords = before ? before.records : [];
    const afterRecords = after ? after.records : [];
    const entry: StoreDelta = {
      name,
      presence: before && after ? 'both' : after ? 'added' : 'removed',
      before: before ? before.count : null,
      after: after ? after.count : null,
      added: null,
      removed: null,
      updated: null,
      unchanged: null
    };
    if (beforeRecords && afterRecords) {
      const old = new Map(beforeRecords);
      const now = new Map(afterRecords);
      entry.added = entry.removed = entry.updated = entry.unchanged = 0;
      for (const [key, value] of now) {
        if (!old.has(key)) entry.added++;
        else if (old.get(key) !== value) entry.updated++;
        else entry.unchanged++;
      }
      for (const key of old.keys()) if (!now.has(key)) entry.removed++;
    }
    stores.push(entry);
  }
  return { verdict: reasons.length > 0 ? 'incomplete' : 'ok', reasons, schemaChanges, stores, localStorage };
}

// --- expectations ---------------------------------------------------------------

export interface DeltaExpectation {
  /** Net record-count change per store (added - removed). */
  counts: Record<string, number>;
  /** Exact number of in-place value changes per store; stores not listed here are not restricted. */
  updated: Record<string, number>;
  /** `unchanged` forbids any record or structure change in stores that `counts`/`updated` do not name. */
  otherStores: 'unchanged' | 'any';
  localStorage: 'unchanged' | 'any';
}

export interface DeltaJudgement {
  verdict: 'pass' | 'fail' | 'incomplete';
  reasons: string[];
}

export function judgeDelta(delta: StateDelta, expectation: DeltaExpectation): DeltaJudgement {
  if (delta.verdict === 'incomplete') return { verdict: 'incomplete', reasons: delta.reasons };
  if (expectation.localStorage === 'unchanged' && !delta.localStorage.available)
    return { verdict: 'incomplete', reasons: ['localStorage could not be captured on both sides'] };

  const reasons: string[] = [];
  const byName = new Map(delta.stores.map((store) => [store.name, store]));
  const named = new Set([...Object.keys(expectation.counts), ...Object.keys(expectation.updated)]);
  for (const [name, expected] of Object.entries(expectation.counts)) {
    const store = byName.get(name);
    if (!store) {
      reasons.push(`store ${name} exists in neither snapshot`);
      continue;
    }
    const net = (store.added ?? 0) - (store.removed ?? 0);
    if (net !== expected) reasons.push(`store ${name}: expected net change ${expected}, got ${net} (+${store.added} -${store.removed})`);
  }
  for (const [name, expected] of Object.entries(expectation.updated)) {
    const store = byName.get(name);
    if (!store) reasons.push(`store ${name} exists in neither snapshot`);
    else if (store.updated !== expected) reasons.push(`store ${name}: expected ${expected} updated record(s), got ${store.updated}`);
  }
  if (expectation.otherStores === 'unchanged') {
    for (const store of delta.stores) {
      if (named.has(store.name)) continue;
      if (store.presence !== 'both') reasons.push(`store ${store.name} was ${store.presence}`);
      else if (store.added || store.removed || store.updated)
        reasons.push(`store ${store.name} changed unexpectedly (+${store.added} -${store.removed} ~${store.updated})`);
    }
    for (const change of delta.schemaChanges) reasons.push(`schema change: ${change}`);
  }
  if (expectation.localStorage === 'unchanged') {
    const { added, removed, updated } = delta.localStorage;
    if (added.length + removed.length + updated.length > 0)
      reasons.push(`localStorage changed (+${added.length} -${removed.length} ~${updated.length})`);
  }
  return { verdict: reasons.length > 0 ? 'fail' : 'pass', reasons };
}

// --- run snapshots on disk -------------------------------------------------------

export const SNAPSHOT_DIR = 'snapshots';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `runRef:label`, split at the LAST colon so `C:\runs\x:before` keeps its drive letter.
 * The label is a plain name, so a path remainder (or a bare `C:\runs\x`) is rejected, not guessed.
 */
export function parseSnapshotRef(ref: string): { run: string; label: string } {
  const split = ref.lastIndexOf(':');
  const run = split > 0 ? ref.slice(0, split) : '';
  const label = split > 0 ? ref.slice(split + 1) : '';
  if (!run || !LABEL.test(label) || /^[A-Za-z]$/.test(run))
    throw new DeviceCliError('USAGE', `"${ref}" is not <run>:<label> (label must match [A-Za-z0-9][A-Za-z0-9._-]{0,63})`);
  return { run, label };
}

/** A run directory path (absolute or relative), or a run id under $LDEV_HOME/runs. */
export function resolveRunDir(run: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const direct = resolve(cwd, run);
  if (existsSync(direct) && statSync(direct).isDirectory()) return direct;
  if (/[\\/]/.test(run) || run === '.' || run === '..') throw new DeviceCliError('USAGE', `Run directory not found: ${run}`);
  const underHome = join(resolveLdevHome(env, process.platform, homedir()), 'runs', run);
  if (existsSync(underHome) && statSync(underHome).isDirectory()) return underHome;
  throw new DeviceCliError('USAGE', `Run not found: ${run}`);
}

export function loadRunSnapshot(ref: string, cwd: string, env: NodeJS.ProcessEnv): { snapshot: StateSnapshot; file: string } {
  const { run, label } = parseSnapshotRef(ref);
  const file = join(resolveRunDir(run, cwd, env), SNAPSHOT_DIR, `${label}.json`);
  if (!existsSync(file)) throw new DeviceCliError('USAGE', `Snapshot "${label}" not found in run ${run} (expected ${file})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new DeviceCliError('USAGE', `Snapshot file is unreadable or not JSON: ${file}`);
  }
  return { snapshot: parseSnapshot(parsed, file), file };
}
