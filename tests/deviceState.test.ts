import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, captureStateInPage, compareStates, summarizeCapture } from '../tools/device/state';

let counter = 0;
const uniqueName = () => `ldev-state-${++counter}`;

type Seed = Record<string, { key?: IDBValidKey; value: unknown }[]>;

async function seed(name: string, stores: Seed): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const store of Object.keys(stores)) {
        const inline = stores[store].every((entry) => entry.key === undefined);
        request.result.createObjectStore(store, inline ? { keyPath: 'id' } : undefined);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(Object.keys(stores), 'readwrite');
    for (const [store, entries] of Object.entries(stores)) {
      for (const entry of entries) {
        if (entry.key === undefined) tx.objectStore(store).put(entry.value);
        else tx.objectStore(store).put(entry.value, entry.key);
      }
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const capture = (dbName: string, maxRecords = 1000, maxBytes = 1_000_000) => captureStateInPage({ dbName, maxRecords, maxBytes });
const digest = async (stores: Seed) => {
  const name = uniqueName();
  await seed(name, stores);
  const result = await capture(name);
  expect(result.ok && result.complete).toBe(true);
  return summarizeCapture(result).sha256;
};

describe('read-only state capture', () => {
  it('is stable across runs and independent of object key order', async () => {
    const a = uniqueName();
    const b = uniqueName();
    await seed(a, { packs: [{ value: { id: 'p', b: 1, a: { y: 2, x: 1 } } }] });
    await seed(b, { packs: [{ value: { a: { x: 1, y: 2 }, id: 'p', b: 1 } }] });
    const first = summarizeCapture(await capture(a));
    expect(summarizeCapture(await capture(a))).toEqual(first);
    expect(summarizeCapture(await capture(b)).sha256).toBe(first.sha256);
    expect(first).toMatchObject({ complete: true, totalCount: 1, database: 'loopdeck3-learning' });
  });

  it('distinguishes value types, binary content and added or removed fields', async () => {
    const hashes = await Promise.all(
      [
        { id: 'k', v: 1 },
        { id: 'k', v: '1' },
        { id: 'k', v: true },
        { id: 'k', v: null },
        { id: 'k', v: new Date(1) },
        { id: 'k', v: new Uint8Array([1, 2]) },
        { id: 'k', v: new Uint8Array([1, 3]) },
        { id: 'k', v: new Uint8Array([1, 2]).buffer },
        { id: 'k', v: [1, 2] },
        { id: 'k', v: { 0: 1, 1: 2 } },
        { id: 'k', v: 1, extra: 2 },
        { id: 'k' },
        { id: 'k', v: new Map([['a', 1]]) },
        { id: 'k', v: new Set(['a']) }
      ].map((value) => digest({ packs: [{ value }] }))
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('includes keys and record counts, and differs when a record is added', async () => {
    const one = await digest({ meta: [{ key: 'a', value: 1 }] });
    const otherKey = await digest({ meta: [{ key: 'b', value: 1 }] });
    const two = await digest({
      meta: [
        { key: 'a', value: 1 },
        { key: 'b', value: 1 }
      ]
    });
    expect(new Set([one, otherKey, two]).size).toBe(3);
  });

  it('fails without creating the database when it does not exist', async () => {
    const name = uniqueName();
    const result = await capture(name);
    expect(result.ok).toBe(false);
    expect(result.complete).toBe(false);
    expect(summarizeCapture(result)).toMatchObject({ complete: false, sha256: null });
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(name);
  });

  it('reads every store in ONE readonly transaction', async () => {
    const name = uniqueName();
    await seed(name, { packs: [{ value: { id: 1 } }], sessions: [{ value: { id: 2 } }] });
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    try {
      await capture(name);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual([['packs', 'sessions'], 'readonly']);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports incomplete at the record bound and never yields a digest', async () => {
    const name = uniqueName();
    await seed(name, { packs: [1, 2, 3].map((id) => ({ value: { id } })) });
    const summary = summarizeCapture(await capture(name, 2));
    expect(summary).toMatchObject({ complete: false, sha256: null, totalCount: 2 });
    expect(summary.reasons.join(' ')).toContain('bounds reached');
  });

  it('reports incomplete when the final record is what exceeds the byte bound', async () => {
    const name = uniqueName();
    await seed(name, { packs: [{ value: { id: 1, text: 'x'.repeat(100) } }, { value: { id: 2, text: 'y'.repeat(100) } }] });
    const summary = summarizeCapture(await capture(name, 1000, 150));
    expect(summary).toMatchObject({ complete: false, sha256: null, totalCount: 1 });
    const single = uniqueName();
    await seed(single, { packs: [{ value: { id: 1, text: 'z'.repeat(1000) } }] });
    expect(summarizeCapture(await capture(single, 1000, 500))).toMatchObject({ complete: false, totalCount: 0 });
  });
});

describe('state comparison', () => {
  const complete = async (stores: Seed) => {
    const name = uniqueName();
    await seed(name, stores);
    return summarizeCapture(await capture(name));
  };

  it('is same only for equal count and digest', async () => {
    const a = await complete({ packs: [{ value: { id: 1 } }] });
    expect(compareStates(a, await complete({ packs: [{ value: { id: 1 } }] })).verdict).toBe('same');
    const different = compareStates(a, await complete({ packs: [{ value: { id: 1, changed: true } }] }));
    expect(different).toMatchObject({ verdict: 'different' });
    expect(different.reasons).toEqual(['canonical digest differs']);
    expect(compareStates(a, await complete({ packs: [{ value: { id: 1 } }, { value: { id: 2 } }] })).reasons).toContain(
      'record count differs (1 vs 2)'
    );
  });

  it('never reports same when either side is missing or incomplete', async () => {
    const a = await complete({ packs: [{ value: { id: 1 } }] });
    const incomplete = summarizeCapture(await capture(uniqueName()));
    expect(compareStates(a, incomplete).verdict).toBe('incomplete');
    expect(compareStates(incomplete, incomplete).verdict).toBe('incomplete');
    expect(compareStates(a, null).verdict).toBe('incomplete');
    expect(compareStates(undefined, undefined).verdict).toBe('incomplete');
  });

  it('canonical JSON sorts keys and keeps every field', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: null }], a: 'x' })).toBe('{"a":"x","b":[2,{"c":null,"d":1}]}');
  });

  it('refuses malformed offline summaries even when both sides match', async () => {
    const good = await complete({ packs: [{ value: { id: 1 } }] });
    for (const bad of [
      { ...good, sha256: 'missing' },
      { ...good, totalCount: -1 },
      { ...good, totalCount: 2 },
      { ...good, version: null },
      { ...good, stores: [{ ...good.stores[0], complete: false }] }
    ])
      expect(compareStates(bad, bad).verdict).toBe('incomplete');
  });
});
