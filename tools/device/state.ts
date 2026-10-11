import { createHash } from 'node:crypto';
import { DB_NAME, LIMITS } from './constants.js';

export interface CaptureArg {
  dbName: string;
  maxRecords: number;
  maxBytes: number;
}

export interface StoreCapture {
  name: string;
  count: number;
  sha256: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  complete: boolean;
}

export interface CaptureResult {
  ok: boolean;
  complete: boolean;
  version: number | null;
  stores: StoreCapture[];
  reasons: string[];
}

/**
 * Read-only IndexedDB capture, serialized into the page (self-contained on purpose).
 *
 * - Lists databases first and requires exactly one database with the exact name, so
 *   `indexedDB.open` can never create it; an `upgradeneeded` event aborts the open anyway.
 * - Reads every store (descriptors and raw records) in ONE `readonly` transaction, so the
 *   snapshot is consistent. Digests are computed after it completes, because awaiting
 *   crypto inside a transaction would let it auto-commit.
 * - Every record is encoded as `key | value` with explicit type tags, length prefixes, sorted
 *   object keys, and content digests for Blob/ArrayBuffer/typed arrays. Unsupported or cyclic
 *   values fail the capture; they are never dropped. Hitting a bound marks the capture
 *   incomplete.
 */
export async function captureStateInPage(arg: CaptureArg): Promise<CaptureResult> {
  const reasons: string[] = [];
  const fail = (reason: string): CaptureResult => ({
    ok: false,
    complete: false,
    version: null,
    stores: [],
    reasons: [...reasons, reason]
  });
  const encoder = new TextEncoder();
  const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const sha = async (data: string | Uint8Array): Promise<string> =>
    hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : (data as unknown as ArrayBuffer)));
  let bytes = 0;

  const enc = async (value: unknown, stack: unknown[]): Promise<string> => {
    if (value === undefined) return 'u';
    if (value === null) return 'z';
    if (typeof value === 'boolean') return value ? 'b1' : 'b0';
    if (typeof value === 'number') return Object.is(value, -0) ? 'n-0' : `n${String(value)}`;
    if (typeof value === 'bigint') return `i${value.toString()}`;
    if (typeof value === 'string') return `s${value.length}:${value}`;
    if (typeof value !== 'object') throw new Error(`unsupported value type ${typeof value}`);
    if (stack.includes(value)) throw new Error('cyclic value');
    if (value instanceof Date) return `D${Number.isNaN(value.getTime()) ? 'invalid' : value.getTime()}`;
    if (value instanceof RegExp) return `R${value.flags}:${value.source.length}:${value.source}`;
    if (value instanceof ArrayBuffer) {
      bytes += value.byteLength;
      return `A${value.byteLength}:${await sha(new Uint8Array(value))}`;
    }
    if (ArrayBuffer.isView(value)) {
      const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      bytes += view.byteLength;
      const tag = value instanceof DataView ? 'DataView' : (value as { constructor: { name: string } }).constructor.name;
      return `T${tag}:${value.byteLength}:${await sha(view)}`;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      bytes += value.size;
      const file = typeof File !== 'undefined' && value instanceof File ? `${value.name.length}:${value.name}:${value.lastModified}` : '';
      return `B${value.type.length}:${value.type}:${value.size}:${file}:${await sha(new Uint8Array(await value.arrayBuffer()))}`;
    }
    const next = [...stack, value];
    if (value instanceof Map) {
      const entries = await Promise.all(Array.from(value.entries()).map(async ([k, v]) => `${await enc(k, next)}=>${await enc(v, next)}`));
      return `M${entries.length}{${entries.sort().join(',')}}`;
    }
    if (value instanceof Set) {
      const entries = await Promise.all(Array.from(value.values()).map((v) => enc(v, next)));
      return `S${entries.length}{${entries.sort().join(',')}}`;
    }
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let index = 0; index < value.length; index++) parts.push(index in value ? await enc(value[index], next) : 'h');
      return `a${value.length}[${parts.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`unsupported object type ${(value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) parts.push(`${key.length}:${key}=${await enc(record[key], next)}`);
    return `o${keys.length}{${parts.join(',')}}`;
  };

  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return fail('indexedDB.databases() is unavailable');
  const listed = (await indexedDB.databases()).filter((entry) => entry.name === arg.dbName);
  if (listed.length !== 1) return fail(`expected exactly one existing database named ${arg.dbName}, found ${listed.length}`);

  let database: IDBDatabase;
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(arg.dbName);
      let upgrading = false;
      request.onupgradeneeded = () => {
        upgrading = true;
        request.transaction?.abort(); // never create or migrate anything
      };
      request.onsuccess = () => {
        if (upgrading) {
          request.result.close();
          reject(new Error('database did not exist; open was aborted'));
        } else {
          resolve(request.result);
        }
      };
      request.onerror = () =>
        reject(upgrading ? new Error('database did not exist; open was aborted') : (request.error ?? new Error('open failed')));
      request.onblocked = () => reject(new Error('open was blocked'));
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'open failed');
  }

  const stores: StoreCapture[] = [];
  let complete = true;
  try {
    const names = Array.from(database.objectStoreNames).sort();
    const meta = new Map<string, Omit<StoreCapture, 'name' | 'count' | 'sha256' | 'complete'>>();
    // Rough size of a value, used only to enforce the byte bound while reading.
    const approxSize = (value: unknown, seen: Set<unknown>): number => {
      if (typeof value === 'string') return encoder.encode(value).byteLength;
      if (value === null || typeof value !== 'object') return 8;
      if (seen.has(value)) return 0;
      seen.add(value);
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
      let total = 16;
      if (value instanceof Map) value.forEach((v, k) => void (total += approxSize(k, seen) + approxSize(v, seen)));
      else if (value instanceof Set) value.forEach((v) => void (total += approxSize(v, seen)));
      else
        for (const key of Object.keys(value))
          total += encoder.encode(key).byteLength + approxSize((value as Record<string, unknown>)[key], seen);
      return total;
    };

    // ONE readonly transaction over every store gives a consistent snapshot. Only raw data is
    // collected inside it (async digests would let it auto-commit); hashing happens afterwards.
    const raw = new Map<string, { entries: { key: IDBValidKey; value: unknown }[]; complete: boolean }>();
    let records = 0;
    bytes = 0;
    if (names.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(names, 'readonly');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        for (const name of names) {
          const entry = { entries: [] as { key: IDBValidKey; value: unknown }[], complete: true };
          raw.set(name, entry);
          const store = tx.objectStore(name);
          meta.set(name, {
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: Array.from(store.indexNames)
              .sort()
              .map((indexName) => {
                const index = store.index(indexName);
                return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
              })
          });
          const cursorRequest = store.openCursor();
          cursorRequest.onerror = () => reject(cursorRequest.error);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            // The bound is checked BEFORE accepting this record, so an over-cap final record is incomplete too.
            const nextBytes = bytes + approxSize(cursor.value, new Set()) + approxSize(cursor.key, new Set());
            if (records + 1 > arg.maxRecords || nextBytes > arg.maxBytes) {
              entry.complete = false;
              reasons.push(`bounds reached in store ${name}`);
              return; // stop continuing this cursor
            }
            bytes = nextBytes;
            records++;
            entry.entries.push({ key: cursor.key, value: cursor.value });
            cursor.continue();
          };
        }
      });
    }

    let encodedBytes = 0;
    for (const name of names) {
      const { entries } = raw.get(name)!;
      let storeComplete = raw.get(name)!.complete;
      const descriptor = meta.get(name)!;
      let chain = await sha(`store:${name.length}:${name}|${JSON.stringify(descriptor)}`);
      for (const { key, value } of entries) {
        const body = `k${await enc(key, [])}|v${await enc(value, [])}`;
        encodedBytes += encoder.encode(body).byteLength;
        if (encodedBytes > arg.maxBytes) {
          storeComplete = false;
          reasons.push(`encoded byte bound reached in store ${name}`);
        }
        chain = await sha(`${chain}|${await sha(body)}`);
      }
      if (!storeComplete) complete = false;
      stores.push({ name, count: entries.length, sha256: chain, complete: storeComplete, ...descriptor });
    }
    const version = database.version;
    database.close();
    return { ok: true, complete, version, stores, reasons };
  } catch (error) {
    database.close();
    return fail(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- host side ---------------------------------------------------------------

export interface StateSummary {
  schema: 1;
  database: string;
  version: number | null;
  /** False for any failure, bound hit, or missing capture: such a summary can never compare "same". */
  complete: boolean;
  totalCount: number;
  /** Canonical digest over store names, descriptors, counts and per-store digests; null unless complete. */
  sha256: string | null;
  stores: { name: string; count: number; sha256: string; complete: boolean }[];
  reasons: string[];
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function summarizeCapture(result: CaptureResult, database: string = DB_NAME): StateSummary {
  const complete = result.ok && result.complete && result.stores.every((store) => store.complete);
  const totalCount = result.stores.reduce((sum, store) => sum + store.count, 0);
  const sha256 = complete
    ? createHash('sha256')
        .update(
          canonicalJson({
            database,
            version: result.version,
            stores: result.stores.map(({ name, count, sha256: digest, keyPath, autoIncrement, indexes }) => ({
              name,
              count,
              sha256: digest,
              keyPath,
              autoIncrement,
              indexes
            }))
          })
        )
        .digest('hex')
    : null;
  return {
    schema: 1,
    database,
    version: result.version,
    complete,
    totalCount,
    sha256,
    stores: result.stores.map(({ name, count, sha256: digest, complete: storeComplete }) => ({
      name,
      count,
      sha256: digest,
      complete: storeComplete
    })),
    reasons: result.reasons
  };
}

export const defaultCaptureArg = (): CaptureArg => ({
  dbName: DB_NAME,
  maxRecords: LIMITS.stateMaxRecords,
  maxBytes: LIMITS.stateMaxBytes
});

export type CompareVerdict = 'same' | 'different' | 'incomplete';

export interface CompareOutcome {
  verdict: CompareVerdict;
  reasons: string[];
  a: { totalCount: number | null; sha256: string | null };
  b: { totalCount: number | null; sha256: string | null };
}

/** Compares only count and canonical digest. Anything not fully captured is "incomplete", never "same". */
export function compareStates(a: StateSummary | null | undefined, b: StateSummary | null | undefined): CompareOutcome {
  const view = (s: StateSummary | null | undefined) => ({ totalCount: s ? s.totalCount : null, sha256: s?.sha256 ?? null });
  const reasons: string[] = [];
  if (!a || a.schema !== 1) reasons.push('first side has no state capture');
  else if (!validSummary(a)) reasons.push('first side state capture is incomplete or malformed');
  if (!b || b.schema !== 1) reasons.push('second side has no state capture');
  else if (!validSummary(b)) reasons.push('second side state capture is incomplete or malformed');
  if (reasons.length > 0) return { verdict: 'incomplete', reasons, a: view(a), b: view(b) };
  const left = a as StateSummary;
  const right = b as StateSummary;
  if (left.totalCount !== right.totalCount) reasons.push(`record count differs (${left.totalCount} vs ${right.totalCount})`);
  if (left.sha256 !== right.sha256) reasons.push('canonical digest differs');
  return { verdict: reasons.length === 0 ? 'same' : 'different', reasons, a: view(left), b: view(right) };
}

function validSummary(summary: StateSummary): boolean {
  return (
    summary.complete === true &&
    typeof summary.database === 'string' &&
    Number.isSafeInteger(summary.version) &&
    (summary.version ?? 0) > 0 &&
    Number.isSafeInteger(summary.totalCount) &&
    summary.totalCount >= 0 &&
    typeof summary.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(summary.sha256) &&
    Array.isArray(summary.stores) &&
    summary.stores.every(
      (store) =>
        typeof store.name === 'string' &&
        store.complete === true &&
        Number.isSafeInteger(store.count) &&
        store.count >= 0 &&
        typeof store.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(store.sha256)
    ) &&
    summary.stores.reduce((total, store) => total + store.count, 0) === summary.totalCount
  );
}
