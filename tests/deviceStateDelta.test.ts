import 'fake-indexeddb/auto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../tools/device/cli';
import { runScenario } from '../tools/device/runner';
import { parseScenario } from '../tools/device/scenario';
import { captureLocalStorageInPage, captureStateInPage, type CaptureResult, type LocalStorageCapture } from '../tools/device/state';
import {
  buildSnapshot,
  diffSnapshots,
  judgeDelta,
  parseSnapshot,
  parseSnapshotRef,
  type DeltaExpectation,
  type StateSnapshot
} from '../tools/device/stateDelta';
import { FakeAdb, FakeCdp, fakeDeps, tempDir, type FakePageSpec } from './helpers/deviceFakes';

// Run scenarios drive the whole runner several times; the default 5 s is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

let counter = 0;
const SECRET = 'SECRET-ANSWER-TEXT';

/** A tiny database: every store has keyPath "id". */
class Db {
  readonly name = `ldev-delta-${++counter}`;
  constructor(stores: Record<string, unknown[]>) {
    this.ready = this.create(stores);
  }
  private ready: Promise<void>;
  private async create(stores: Record<string, unknown[]>): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        for (const store of Object.keys(stores)) request.result.createObjectStore(store, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    await this.apply((tx) => {
      for (const [store, values] of Object.entries(stores)) for (const value of values) tx.objectStore(store).put(value);
    });
  }
  async change(work: (tx: IDBTransaction) => void): Promise<void> {
    await this.ready;
    await this.apply(work);
  }
  private async apply(work: (tx: IDBTransaction) => void): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(Array.from(db.objectStoreNames), 'readwrite');
      work(tx);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async capture(maxRecords = 1000, maxBytes = 1_000_000): Promise<CaptureResult> {
    await this.ready;
    return captureStateInPage({ dbName: this.name, maxRecords, maxBytes });
  }
  async snapshot(ls?: [string, string][]): Promise<StateSnapshot> {
    return buildSnapshot(await this.capture(), ls ? { ok: true, entries: ls } : undefined);
  }
}

const h = (c: string) => c.repeat(64);
const none: DeltaExpectation = { counts: {}, updated: {}, otherStores: 'any', localStorage: 'any' };
const storeOf = (delta: ReturnType<typeof diffSnapshots>, name: string) => delta.stores.find((store) => store.name === name)!;

describe('record-level IndexedDB diff', () => {
  it('detects added, removed and updated records by key', async () => {
    const db = new Db({ attempts: [{ id: 1 }, { id: 2 }, { id: 3 }], packs: [{ id: 'p' }] });
    const before = await db.snapshot();
    await db.change((tx) => {
      tx.objectStore('attempts').put({ id: 4 }); // added
      tx.objectStore('attempts').delete(1); // removed
      tx.objectStore('attempts').put({ id: 2, changed: true }); // updated
    });
    const delta = diffSnapshots(before, await db.snapshot());
    expect(delta.verdict).toBe('ok');
    expect(storeOf(delta, 'attempts')).toMatchObject({ before: 3, after: 3, added: 1, removed: 1, updated: 1, unchanged: 1 });
    expect(storeOf(delta, 'packs')).toMatchObject({ added: 0, removed: 0, updated: 0, unchanged: 1 });
  });

  it('detects a value change with an identical count', async () => {
    const db = new Db({ attempts: [{ id: 1, answer: 'a' }] });
    const before = await db.snapshot();
    await db.change((tx) => tx.objectStore('attempts').put({ id: 1, answer: 'b' }));
    const delta = diffSnapshots(before, await db.snapshot());
    expect(storeOf(delta, 'attempts')).toMatchObject({ before: 1, after: 1, added: 0, removed: 0, updated: 1 });
    expect(judgeDelta(delta, { ...none, otherStores: 'unchanged' }).verdict).toBe('fail');
  });

  it('ignores object property order and sees Blob / ArrayBuffer content changes', async () => {
    const db = new Db({ assets: [{ id: 1, a: 1, b: { y: 2, x: 1 }, data: new Uint8Array([1, 2, 3]).buffer, blob: new Blob(['abc']) }] });
    const before = await db.snapshot();
    await db.change((tx) =>
      tx.objectStore('assets').put({ blob: new Blob(['abc']), data: new Uint8Array([1, 2, 3]).buffer, b: { x: 1, y: 2 }, id: 1, a: 1 })
    );
    expect(storeOf(diffSnapshots(before, await db.snapshot()), 'assets').updated).toBe(0);
    await db.change((tx) =>
      tx.objectStore('assets').put({ id: 1, a: 1, b: { x: 1, y: 2 }, data: new Uint8Array([1, 2, 4]).buffer, blob: new Blob(['abc']) })
    );
    const afterBuffer = await db.snapshot();
    expect(storeOf(diffSnapshots(before, afterBuffer), 'assets').updated).toBe(1);
    await db.change((tx) =>
      tx.objectStore('assets').put({ id: 1, a: 1, b: { x: 1, y: 2 }, data: new Uint8Array([1, 2, 4]).buffer, blob: new Blob(['abd']) })
    );
    expect(storeOf(diffSnapshots(afterBuffer, await db.snapshot()), 'assets').updated).toBe(1);
  });

  it('reports simultaneous changes in several stores', async () => {
    const db = new Db({ attempts: [], reviewCards: [{ id: 'c' }], bookmarks: [{ id: 'b' }] });
    const before = await db.snapshot();
    await db.change((tx) => {
      tx.objectStore('attempts').put({ id: 1 });
      tx.objectStore('reviewCards').put({ id: 'c', due: 1 });
      tx.objectStore('bookmarks').delete('b');
    });
    const delta = diffSnapshots(before, await db.snapshot());
    expect(delta.stores.map((s) => [s.name, s.added, s.removed, s.updated])).toEqual([
      ['attempts', 1, 0, 0],
      ['bookmarks', 0, 1, 0],
      ['reviewCards', 0, 0, 1]
    ]);
  });

  it('is incomplete when the capture hit a bound, and never yields counts to judge', async () => {
    const db = new Db({ attempts: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const full = await db.snapshot();
    const partial = buildSnapshot(await db.capture(2), undefined);
    const delta = diffSnapshots(full, partial);
    expect(delta.verdict).toBe('incomplete');
    expect(delta.reasons.join(' ')).toContain('second snapshot is incomplete');
    expect(judgeDelta(delta, { ...none, counts: { attempts: 0 } }).verdict).toBe('incomplete');
  });

  it('reports schema changes (new store, new version)', async () => {
    const one = await new Db({ attempts: [] }).snapshot();
    const two = await new Db({ attempts: [], extra: [] }).snapshot();
    expect(diffSnapshots(one, two).schemaChanges).toEqual(['store extra added']);
    expect(judgeDelta(diffSnapshots(one, two), { ...none, otherStores: 'unchanged' }).reasons.join(' ')).toContain('store extra was added');
  });
});

describe('expectation judgement', () => {
  it('passes the expected net change and fails a different one', async () => {
    const db = new Db({ attempts: [{ id: 1 }], packs: [{ id: 'p' }] });
    const before = await db.snapshot();
    await db.change((tx) => tx.objectStore('attempts').put({ id: 2 }));
    const delta = diffSnapshots(before, await db.snapshot());
    const expectation: DeltaExpectation = { ...none, counts: { attempts: 1 }, otherStores: 'unchanged' };
    expect(judgeDelta(delta, expectation)).toEqual({ verdict: 'pass', reasons: [] });
    expect(judgeDelta(delta, { ...expectation, counts: { attempts: 2 } }).verdict).toBe('fail');
    expect(judgeDelta(delta, { ...expectation, counts: { nope: 0 } }).reasons[0]).toContain('exists in neither');
  });

  it('forbids changes to other stores, including value-only ones', async () => {
    const db = new Db({ attempts: [], packs: [{ id: 'p', v: 1 }] });
    const before = await db.snapshot();
    await db.change((tx) => {
      tx.objectStore('attempts').put({ id: 1 });
      tx.objectStore('packs').put({ id: 'p', v: 2 });
    });
    const delta = diffSnapshots(before, await db.snapshot());
    const judged = judgeDelta(delta, { ...none, counts: { attempts: 1 }, otherStores: 'unchanged' });
    expect(judged.verdict).toBe('fail');
    expect(judged.reasons.join(' ')).toContain('store packs changed unexpectedly');
    expect(judgeDelta(delta, { ...none, counts: { attempts: 1 } }).verdict).toBe('pass');
    expect(judgeDelta(delta, { ...none, counts: { attempts: 1 }, updated: { packs: 1 }, otherStores: 'unchanged' }).verdict).toBe('pass');
  });
});

describe('localStorage diff', () => {
  const snap = (entries: [string, string][] | null): StateSnapshot => {
    const base = buildSnapshot({ ok: true, complete: true, version: 1, stores: [], reasons: [] }, entries ? { ok: true, entries } : undefined);
    return base;
  };

  it('detects added, removed and updated keys', () => {
    const delta = diffSnapshots(
      snap([
        ['a', h('1')],
        ['b', h('2')],
        ['c', h('3')]
      ]),
      snap([
        ['a', h('1')],
        ['b', h('9')],
        ['d', h('4')]
      ])
    );
    expect(delta.localStorage).toMatchObject({ available: true, added: ['d'], removed: ['c'], updated: ['b'], unchanged: 1 });
  });

  it('records what an exclusion hid and does not hide anything else', () => {
    const before = snap([
      ['loopdeck3.diagnostics', h('1')],
      ['loopdeck3.session.m1', h('1')]
    ]);
    const after = snap([
      ['loopdeck3.diagnostics', h('2')],
      ['loopdeck3.session.m1', h('2')]
    ]);
    const delta = diffSnapshots(before, after, { ignoreLocalStorage: ['loopdeck3.diagnostics', 'nothing.*'] });
    expect(delta.localStorage.updated).toEqual(['loopdeck3.session.m1']);
    expect(delta.localStorage.excluded).toEqual([
      { pattern: 'loopdeck3.diagnostics', keys: 1 },
      { pattern: 'nothing.*', keys: 0 }
    ]);
    expect(diffSnapshots(before, after, { ignoreLocalStorage: ['loopdeck3.*'] }).localStorage.updated).toEqual([]);
  });

  it('is unavailable when either side could not capture, which blocks only a check that needs it', () => {
    const delta = diffSnapshots(snap(null), snap([]));
    expect(delta.localStorage.available).toBe(false);
    expect(judgeDelta(delta, { ...none, localStorage: 'unchanged' }).verdict).toBe('incomplete');
    expect(judgeDelta(delta, none).verdict).toBe('pass');
  });

  it('captures key + value digest in the page and never returns a value', async () => {
    const store = new Map<string, string>([
      ['k1', 'v1'],
      ['k2', SECRET]
    ]);
    const fake = {
      length: store.size,
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      getItem: (key: string) => store.get(key) ?? null
    };
    (globalThis as { window?: unknown }).window = { localStorage: fake };
    try {
      const result = await captureLocalStorageInPage();
      expect(result.ok).toBe(true);
      expect(result.entries.map(([key]) => key)).toEqual(['k1', 'k2']);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.entries[0][1]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe('snapshot files and references', () => {
  it('keeps a Windows drive letter out of the label split', () => {
    expect(parseSnapshotRef('C:\\runs\\20260101-x:before')).toEqual({ run: 'C:\\runs\\20260101-x', label: 'before' });
    expect(parseSnapshotRef('20260101-x:s3.now')).toEqual({ run: '20260101-x', label: 's3.now' });
    for (const bad of ['C:\\runs\\x', 'C:before', 'plain', 'run:', ':label', 'run:bad label'])
      expect(() => parseSnapshotRef(bad), bad).toThrow(/not <run>:<label>/);
  });

  it('treats a schema-1 state summary as legacy: counts only, never a judgement', () => {
    const legacy = parseSnapshot(
      { schema: 1, database: 'd', version: 1, complete: true, totalCount: 2, sha256: h('a'), stores: [{ name: 'attempts', count: 2, sha256: h('b'), complete: true }], reasons: [] },
      'legacy.json'
    );
    const delta = diffSnapshots(legacy, legacy);
    expect(delta.verdict).toBe('incomplete');
    expect(storeOf(delta, 'attempts')).toMatchObject({ before: 2, after: 2, added: null, updated: null });
    expect(delta.reasons.join(' ')).toContain('legacy format');
    expect(() => parseSnapshot({ schema: 3 }, 'x')).toThrow(/not a state snapshot/);
    expect(() => parseSnapshot({ schema: 2, summary: {}, stores: [{ name: 'a', count: 1, records: [['x', 'y']] }] }, 'x')).toThrow(/malformed/);
  });
});

describe('scenario parsing: expectStateDelta', () => {
  const scenario = (steps: unknown[]) => JSON.stringify({ schema: 1, id: 't', title: 't', steps });
  const reject = (steps: unknown[]) => {
    try {
      parseScenario(scenario(steps));
    } catch (error) {
      return (error as Error).message;
    }
    return 'accepted';
  };
  const snap = { do: 'snapshotState', label: 'before' };

  it('accepts the documented shape and defaults the optional fields', () => {
    const parsed = parseScenario(scenario([snap, { check: 'expectStateDelta', a: 'before', b: 'now', counts: { attempts: 1 }, otherStores: 'unchanged' }]));
    expect(parsed.steps[1]).toMatchObject({
      check: 'expectStateDelta',
      counts: { attempts: 1 },
      updated: {},
      otherStores: 'unchanged',
      localStorage: 'any',
      ignoreLocalStorage: []
    });
  });

  it('rejects unknown labels, bad numbers, and checks that assert nothing', () => {
    expect(reject([{ check: 'expectStateDelta', a: 'missing', b: 'now', counts: { x: 1 } }])).toContain('steps[0].a');
    expect(reject([snap, { check: 'expectStateDelta', a: 'before', b: 'later', counts: { x: 1 } }])).toContain('steps[1].b');
    expect(reject([snap, { check: 'expectStateDelta', a: 'before', b: 'now', counts: { x: 1.5 } }])).toContain('counts.x');
    expect(reject([snap, { check: 'expectStateDelta', a: 'before', b: 'now', counts: { 'bad name': 1 } }])).toContain('store name');
    expect(reject([snap, { check: 'expectStateDelta', a: 'before', b: 'now', counts: { x: 1 }, otherStores: 'maybe' }])).toContain('otherStores');
    expect(reject([snap, { check: 'expectStateDelta', a: 'before', b: 'now' }])).toContain('needs counts');
    expect(reject([snap, { check: 'expectStateDelta', a: 'before', b: 'now', counts: { x: 1 }, extra: 1 }])).toContain('unknown key');
  });
});

describe('ldev run + ldev diff', () => {
  interface World {
    db: Db;
    ls: LocalStorageCapture | undefined;
    capture: () => Promise<CaptureResult>;
  }

  function setup(world: World, steps: unknown[], onKey: () => Promise<void> | void) {
    const dir = tempDir();
    const adb = new FakeAdb();
    const cdp = new FakeCdp();
    const deps = fakeDeps(adb, cdp, dir);
    const spec: FakePageSpec = {
      url: 'https://appassets.androidplatform.net/assets/loopdeck/index.html#home',
      countVisible: () => 1,
      locate: () => ({ total: 1, visible: 1 }),
      evaluate: (_arg, fn) => {
        switch (fn.name) {
          case 'readDiagnostics':
            return { ok: true, entries: [] };
          case 'errorScreenPresent':
            return false;
          case 'domProbe':
            return { mode: 'snapshot', items: [], truncated: false, viewport: {}, href: '' };
          case 'captureStateInPage':
            return Promise.all(pending).then(() => world.capture());
          case 'captureLocalStorageInPage':
            return world.ls;
          default:
            return undefined;
        }
      }
    };
    cdp.pages = [spec];
    // The "app" reacts to the ENTER key: that is how a scenario mutates the stored data.
    adb.failures.push((args) => {
      if (args.includes('keyevent') && args.includes('KEYCODE_ENTER')) pending.push(Promise.resolve(onKey()));
      return false;
    });
    const pending: Promise<unknown>[] = [];
    const scenarioPath = join(dir, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify({ schema: 1, id: 'delta', title: 'delta', steps }));
    const outDir = join(dir, 'out');
    return { dir, deps, outDir, run: () => runScenario(deps, { serial: 'T1', scenarioPath, outDir }), settle: () => Promise.all(pending) };
  }

  const delta = (extra: Record<string, unknown>) => ({ check: 'expectStateDelta', a: 'before', b: 'now', ...extra });
  const base = [{ do: 'launch' }, { do: 'snapshotState', label: 'before' }, { do: 'key', key: 'ENTER' }];

  it('PASSes a correct delta, FAILs a wrong one, and keeps raw values out of every output file', async () => {
    const db = new Db({ attempts: [{ id: 1, answer: SECRET }], packs: [{ id: 'p' }] });
    const world: World = { db, ls: { ok: true, entries: [['loopdeck3.diagnostics', h('1')]] }, capture: () => db.capture() };
    const good = setup(world, [...base, delta({ counts: { attempts: 1 }, otherStores: 'unchanged', ignoreLocalStorage: ['loopdeck3.diagnostics'] })], () =>
      db.change((tx) => tx.objectStore('attempts').put({ id: 2, answer: SECRET }))
    );
    const { summary, runDir } = await good.run();
    expect(summary.reasons).toEqual([]);
    expect(summary.final).toBe('PASS');
    expect(summary.stateDeltas[0]).toMatchObject({
      result: 'PASS',
      stores: [
        { name: 'attempts', before: 1, after: 2, added: 1 },
        { name: 'packs', added: 0, updated: 0 }
      ],
      localStorage: { available: true, excluded: [{ pattern: 'loopdeck3.diagnostics', keys: 1 }] }
    });
    for (const file of [join(runDir, 'summary.json'), join(runDir, 'events.ndjson'), join(runDir, 'snapshots', 'before.json'), join(runDir, 'snapshots', 's3.now.json')])
      expect(readFileSync(file, 'utf8'), file).not.toContain(SECRET);

    // A wrong expectation against the same kind of change: FAIL.
    const wrongDb = new Db({ attempts: [{ id: 1 }] });
    const wrong = setup({ db: wrongDb, ls: undefined, capture: () => wrongDb.capture() }, [...base, delta({ counts: { attempts: 2 } })], () =>
      wrongDb.change((tx) => tx.objectStore('attempts').put({ id: 2 }))
    );
    const failed = await wrong.run();
    expect(failed.summary.final).toBe('FAIL');
    expect(failed.summary.stateDeltas[0].reasons[0]).toContain('expected net change 2, got 1');

    // An unexpected value-only change in another store: FAIL.
    const sneakyDb = new Db({ attempts: [{ id: 1 }], packs: [{ id: 'p', v: 1 }] });
    const sneaky = setup(
      { db: sneakyDb, ls: undefined, capture: () => sneakyDb.capture() },
      [...base, delta({ counts: { attempts: 0 }, otherStores: 'unchanged' })],
      () => sneakyDb.change((tx) => tx.objectStore('packs').put({ id: 'p', v: 2 }))
    );
    expect((await sneaky.run()).summary.final).toBe('FAIL');
  });

  it('is INCONCLUSIVE when IndexedDB capture is incomplete or localStorage is required but unavailable', async () => {
    const db = new Db({ attempts: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const partial = setup(
      { db, ls: undefined, capture: () => db.capture(2) },
      [...base, delta({ counts: { attempts: 0 } })],
      () => undefined
    );
    expect((await partial.run()).summary.final).toBe('INCONCLUSIVE');

    const noLs = setup({ db, ls: undefined, capture: () => db.capture() }, [...base, delta({ counts: { attempts: 0 }, localStorage: 'unchanged' })], () => undefined);
    const result = await noLs.run();
    expect(result.summary.final).toBe('INCONCLUSIVE');
    expect(result.summary.reasons).toContain('state capture needed by a check was incomplete');
  });

  it('keeps expectStateSame working (same -> PASS, changed -> FAIL)', async () => {
    const db = new Db({ attempts: [{ id: 1 }] });
    const steps = [...base, { check: 'expectStateSame', a: 'before', b: 'now' }];
    expect((await setup({ db, ls: undefined, capture: () => db.capture() }, steps, () => undefined).run()).summary.final).toBe('PASS');
    const changing = setup({ db, ls: undefined, capture: () => db.capture() }, steps, () => db.change((tx) => tx.objectStore('attempts').put({ id: 9 })));
    expect((await changing.run()).summary.final).toBe('FAIL');
  });

  it('diffs two runs offline, by directory and by run id, with clear errors for missing data', async () => {
    const db = new Db({ attempts: [{ id: 1 }] });
    const world: World = { db, ls: { ok: true, entries: [['k', h('1')]] }, capture: () => db.capture() };
    const first = setup(world, [{ do: 'launch' }, { do: 'snapshotState', label: 'start' }, { check: 'expectNoErrorScreen' }], () => undefined);
    const a = await first.run();
    await db.change((tx) => tx.objectStore('attempts').put({ id: 2 }));
    world.ls = { ok: true, entries: [['k', h('2')]] };
    const second = setup(world, [{ do: 'launch' }, { do: 'snapshotState', label: 'end' }, { check: 'expectNoErrorScreen' }], () => undefined);
    const b = await second.run();

    const cli = (args: string[]) => runCli(args, first.deps);
    const same = await cli(['diff', `${a.runDir}:start`, `${a.runDir}:start`]);
    expect(JSON.parse(same.stdout).data).toMatchObject({ verdict: 'ok', changed: false });

    const result = await cli(['diff', `${a.runDir}:start`, `${b.runDir}:end`]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.changed).toBe(true);
    expect(data.stores[0]).toMatchObject({ name: 'attempts', before: 1, after: 2, added: 1 });
    expect(data.localStorage).toMatchObject({ updated: ['k'] });
    expect((await cli(['diff', `${a.runDir}:start`, `${b.runDir}:end`, '--expect-same'])).exitCode).toBe(1);
    expect(JSON.parse((await cli(['diff', `${a.runDir}:start`, `${b.runDir}:end`, '--ignore-local-storage', 'k'])).stdout).data.localStorage.excluded).toEqual([
      { pattern: 'k', keys: 1 }
    ]);

    // Run id under LDEV_HOME/runs.
    const home = join(first.dir, 'home');
    mkdirSync(join(home, 'runs'), { recursive: true });
    const runId = a.summary.runId;
    mkdirSync(join(home, 'runs', runId, 'snapshots'), { recursive: true });
    writeFileSync(join(home, 'runs', runId, 'snapshots', 'start.json'), readFileSync(join(a.runDir, 'snapshots', 'start.json')));
    const viaId = await runCli(['diff', `${runId}:start`, `${runId}:start`], { ...first.deps, env: { ...first.deps.env, LDEV_HOME: home } });
    expect(JSON.parse(viaId.stdout).data.changed).toBe(false);

    const missing = await cli(['diff', `${a.runDir}:nope`, `${b.runDir}:end`]);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout).error.message).toContain('Snapshot "nope" not found');
    expect(JSON.parse((await cli(['diff', `${join(first.dir, 'ghost')}:x`, `${b.runDir}:end`])).stdout).error.message).toContain('Run');
    expect(readdirSync(join(a.runDir, 'snapshots'))).toEqual(['start.json']); // diff wrote nothing
  });

  it('does not call a diff clean when localStorage was not captured, and --expect-same then exits INCOMPLETE', async () => {
    const dir = tempDir();
    const db = new Db({ attempts: [{ id: 1 }] });
    for (const [name, ls] of [
      ['a', undefined],
      ['b', { ok: true, entries: [['k', h('1')]] as [string, string][] }]
    ] as const) {
      mkdirSync(join(dir, name, 'snapshots'), { recursive: true });
      writeFileSync(join(dir, name, 'snapshots', 'x.json'), JSON.stringify(buildSnapshot(await db.capture(), ls)));
    }
    const deps = fakeDeps(new FakeAdb(), new FakeCdp(), dir);
    const ref = (name: string) => `${join(dir, name)}:x`;
    const plain = JSON.parse((await runCli(['diff', ref('a'), ref('a')], deps)).stdout);
    expect(plain).toMatchObject({ ok: true, exitCode: 0, data: { changed: false, localStorageCompared: false } });
    expect(plain.data.localStorage.available).toBe(false);
    const strict = await runCli(['diff', ref('a'), ref('a'), '--expect-same'], deps);
    expect(strict.exitCode).toBe(5);
    expect(strict.stderr).toContain('localStorage was not captured');
    expect((await runCli(['diff', ref('a'), ref('b'), '--expect-same'], deps)).exitCode).toBe(5); // one side only
    // Both captured and equal: still clean.
    expect((await runCli(['diff', ref('b'), ref('b'), '--expect-same'], deps)).exitCode).toBe(0);
  });

  it('keeps expectStateDelta with localStorage "any" independent of localStorage capture', async () => {
    const db = new Db({ attempts: [{ id: 1 }] });
    const world: World = { db, ls: undefined, capture: () => db.capture() };
    const result = await setup(world, [...base, delta({ counts: { attempts: 0 }, otherStores: 'unchanged' })], () => undefined).run();
    expect(result.summary.final).toBe('PASS');
    expect(result.summary.stateDeltas[0].localStorage.available).toBe(false);
  });

  it('exits INCOMPLETE for a legacy snapshot', async () => {
    const dir = tempDir();
    const run = join(dir, 'old');
    mkdirSync(join(run, 'snapshots'), { recursive: true });
    writeFileSync(
      join(run, 'snapshots', 'x.json'),
      JSON.stringify({ schema: 1, database: 'd', version: 1, complete: true, totalCount: 0, sha256: h('a'), stores: [], reasons: [] })
    );
    const result = await runCli(['diff', `${run}:x`, `${run}:x`], fakeDeps(new FakeAdb(), new FakeCdp(), dir));
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stdout).error.message).toContain('legacy format');
  });
});
