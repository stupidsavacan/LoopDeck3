import 'fake-indexeddb/auto';
import { afterEach, describe, it, expect } from 'vitest';
import { LocalDatabase } from '../src/storage/indexedDb';
import { StudyRepository } from '../src/storage/studyRepository';
import { CloudStore } from '../src/cloud/store';
import type { LoopDeckPack } from '../src/core/models';
import type { CloudRevision } from '../src/cloud/api';
import { CloudApi } from '../src/cloud/api';
import type { SyncJob } from '../src/storage/cloudRecords';
import { contentFingerprint } from '../src/packs/contentFingerprint';
import { SyncEngine } from '../src/cloud/engine';
const databases: LocalDatabase[] = [];
function context() {
  const db = new LocalDatabase('cloud-test-' + crypto.randomUUID());
  databases.push(db);
  return { db, repo: new StudyRepository(db), cloud: new CloudStore(db) };
}
function pack(id = 'cloud-test', answer = 'A'): LoopDeckPack {
  return {
    packVersion: 1,
    packId: id,
    title: 'Pack',
    folders: [{ id: id + '-f', title: 'Folder' }],
    modules: [{ id: id + '-m', folderId: id + '-f', title: 'Module', subject: 'demo', questionIds: [id + '-q'] }],
    questions: [{ id: id + '-q', moduleId: id + '-m', type: 'input', prompt: 'A?', answer }]
  };
}
const head = (packId: string): CloudRevision => ({
  packId,
  revision: 1,
  contentFingerprint: 'fp',
  sha256: 'sha',
  size: 12,
  title: 'Cloud',
  questions: 1,
  committedAt: '2026-10-22T00:00:00Z'
});
async function login(cloud: CloudStore, setupComplete = false) {
  await cloud.configure({ key: 'settings', apiUrl: 'https://sync.test', token: 'fixture', deviceName: 'test', setupComplete });
}
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});
describe('durable pack cloud intent', () => {
  it('keeps a conflicting cloud pack staged and still applies unrelated valid packs', async () => {
    const {db,repo,cloud}=context();
    const existing=pack('existing');await repo.saveImportedPack(existing);await login(cloud,true);
    const conflict={...existing,packId:'a-conflict',title:'Conflicting pack'};
    const safe=pack('z-safe');
    for(const incoming of [conflict,safe])await cloud.stage({packId:incoming.packId,head:{...head(incoming.packId),contentFingerprint:await contentFingerprint(incoming,[])},expectedGeneration:0,pack:incoming,assets:[]});
    const engine=new SyncEngine(cloud,repo,()=>true);
    await expect(engine.applyStaged()).rejects.toThrow(/a-conflict.*IDが重複/);
    expect((await repo.getImportedPacks()).map(p=>p.packId)).toContain('z-safe');
    expect((await db.all<{packId:string}>('cloudStaging')).map(p=>p.packId)).toEqual(['a-conflict']);
  });
  it('shares exactly ten selected packs out of thirty existing packs', async () => {
    const { repo, db, cloud } = context();
    for (let i = 0; i < 30; i++) await repo.saveImportedPack(pack('existing-' + i));
    await login(cloud);
    await cloud.setup(
      Array.from({ length: 10 }, (_, i) => 'existing-' + i),
      [],
      []
    );
    expect(await db.all('cloudOutbox')).toHaveLength(10);
    const states = await db.all<{ mode: string }>('packSync');
    expect(states.filter((s) => s.mode === 'localOnly')).toHaveLength(20);
    await repo.saveImportedPack(pack('existing-29', 'Changed'));
    expect(await db.all('cloudOutbox')).toHaveLength(10);
  });
  it('keeps a restore operation ID across a lost response and database reopening', async () => {
    const { db, cloud } = context();
    const operations: string[] = [];
    const api = new CloudApi('https://sync.test', undefined, async (_url, options) => {
      operations.push(new Headers(options?.headers).get('Idempotency-Key')!);
      if (operations.length === 1) throw new TypeError('lost response');
      return new Response(JSON.stringify({ ...head('cloud-test'), sha256: '1'.repeat(64), contentFingerprint: '2'.repeat(64) }));
    });
    await expect(cloud.restore(api, 'cloud-test', 1)).rejects.toThrow();
    db.close();
    await cloud.restore(api, 'cloud-test', 1);
    expect(operations[0]).toBe(operations[1]);
    expect(await db.all('cloudConfig')).toHaveLength(0);
  });
  it('cloud replacement retains the existing retire/SRS/bookmark semantics', async () => {
    const { db, repo, cloud } = context();
    await login(cloud, true);
    await repo.saveImportedPackFromCloud(pack(), [], { origin: 'remote', revision: 1, fingerprint: 'first', expectedGeneration: 0 });
    await repo.recordAnswer({
      attemptId: 'cloud-answer',
      questionId: 'cloud-test-q',
      moduleId: 'cloud-test-m',
      answeredAt: '2026-10-22T00:00:00.000Z',
      result: 'wrong',
      input: 'wrong',
      answer: 'A',
      elapsedMs: 1000,
      mode: 'normal'
    });
    await repo.setBookmark('cloud-test-q', true);
    await repo.saveImportedPackFromCloud(pack('cloud-test', 'Changed'), [], {
      origin: 'remote',
      revision: 2,
      fingerprint: 'second',
      expectedGeneration: (await cloud.state('cloud-test'))!.generation
    });
    expect(await repo.getAttempts()).toEqual([]);
    expect(await repo.getBookmarks()).toEqual([]);
    expect(await repo.getReviewCards()).toEqual([]);
    expect((await repo.exportSnapshot()).attempts).toMatchObject([{ attemptId: 'cloud-answer', contentRetired: true }]);
    expect(await db.all('cloudOutbox')).toHaveLength(0);
  });
  it('preserves completed setup and a newer token when another tab finishes an older login/request', async () => {
    const { cloud } = context();
    await login(cloud, true);
    await cloud.configure({ key: 'settings', apiUrl: 'https://sync.test', token: 'newer', deviceName: 'new', setupComplete: false });
    await cloud.clearToken('fixture');
    expect(await cloud.settings()).toMatchObject({ token: 'newer', setupComplete: true });
  });
  it('does not advance last success while an operation is pending', async () => {
    const { repo, cloud } = context();
    await login(cloud, true);
    await repo.saveImportedPack(pack());
    expect(await cloud.success(1000)).toBe(false);
    expect((await cloud.settings())?.lastSuccess).toBeUndefined();
  });
  it('never uploads existing local packs merely on startup; first setup respects choices and cloud priority', async () => {
    const { db, repo, cloud } = context();
    await repo.saveImportedPack(pack('one'));
    await repo.saveImportedPack(pack('two'));
    await repo.saveImportedPack(pack('three'));
    expect(await db.all('cloudOutbox')).toHaveLength(0);
    await login(cloud);
    await cloud.setup(['one', 'three'], ['cloud-only'], [head('one'), head('cloud-only')]);
    expect(await db.all<SyncJob>('cloudOutbox')).toMatchObject([{ packId: 'three' }]);
    expect((await cloud.state('one'))?.dirty).toBe(false);
    expect((await cloud.state('two'))?.mode).toBe('localOnly');
    expect((await cloud.state('cloud-only'))?.mode).toBe('localOnly');
    await repo.saveImportedPack(pack('two', 'B'));
    expect(await db.all<SyncJob>('cloudOutbox')).toHaveLength(1);
  });
  it('snapshots final imported content and collapses only operations never attempted', async () => {
    const { db, repo, cloud } = context();
    await login(cloud, true);
    await repo.saveImportedPack(pack());
    const claimed = await cloud.claim('first', Date.now());
    expect(claimed).toBeDefined();
    await repo.saveImportedPack(pack('cloud-test', 'B'));
    await repo.saveImportedPack(pack('cloud-test', 'C'));
    const jobs = await db.all<SyncJob>('cloudOutbox');
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.attempts === 0)?.pack.questions[0]).toMatchObject({ answer: 'C' });
    expect(await cloud.claim('other', Date.now())).toBeUndefined();
    await cloud.acknowledge(claimed!, { ...head('cloud-test'), contentFingerprint: 'first' });
    expect((await cloud.state('cloud-test'))?.dirty).toBe(true);
    expect(await cloud.claim('other', Date.now())).toMatchObject({ pack: { questions: [{ answer: 'C' }] } });
  });
  it('atomically deletes local pack, in-flight intent, and staged update; manual import clears tombstone', async () => {
    const { db, repo, cloud } = context();
    await login(cloud, true);
    await repo.saveImportedPack(pack());
    const job = await cloud.claim('sender', Date.now());
    await db.request('cloudStaging', 'readwrite', (s) => s.put({ packId: 'cloud-test' }));
    await repo.deleteImportedPack('cloud-test');
    expect(await repo.getImportedPacks()).toHaveLength(0);
    expect(await db.all('cloudOutbox')).toHaveLength(0);
    expect(await db.all('cloudStaging')).toHaveLength(0);
    expect((await cloud.state('cloud-test'))?.mode).toBe('excludedByDeletion');
    await cloud.acknowledge(job!, head('cloud-test'));
    expect((await cloud.state('cloud-test'))?.mode).toBe('excludedByDeletion');
    await repo.saveImportedPack(pack());
    expect((await cloud.state('cloud-test'))?.mode).toBe('enabled');
    expect(await db.all('cloudOutbox')).toHaveLength(1);
  });
  it('remote install uses normal storage without echo and rejects dirty/stale/off races', async () => {
    const { db, repo, cloud } = context();
    await login(cloud, true);
    const p = pack();
    await repo.saveImportedPackFromCloud(p, [], { origin: 'remote', revision: 1, fingerprint: 'first', expectedGeneration: 0 });
    expect(await db.all('cloudOutbox')).toHaveLength(0);
    const generation = (await cloud.state(p.packId))!.generation;
    await repo.saveImportedPack(pack('cloud-test', 'local'));
    await expect(
      repo.saveImportedPackFromCloud(pack('cloud-test', 'remote'), [], {
        origin: 'remote',
        revision: 2,
        fingerprint: 'second',
        expectedGeneration: generation
      })
    ).rejects.toThrow();
    expect((await repo.getImportedPacks())[0].questions[0]).toMatchObject({ answer: 'local' });
    await cloud.setEnabled(p.packId, false);
    expect(await db.all('cloudOutbox')).toHaveLength(0);
  });
  it('backup restore never uploads and preserves deletion exclusions', async () => {
    const { db, repo, cloud } = context();
    await login(cloud, true);
    await repo.saveImportedPack(pack());
    const snapshot = await repo.exportSnapshot();
    await repo.deleteImportedPack('cloud-test');
    await repo.restoreSnapshot(snapshot, 'replace');
    expect(await db.all('cloudOutbox')).toHaveLength(0);
    expect((await cloud.state('cloud-test'))?.mode).toBe('excludedByDeletion');
  });
  it('invalid cross-pack question collision rolls back sync jobs and pack state', async () => {
    const { db, repo, cloud } = context();
    await login(cloud, true);
    const a = pack('first'),
      b = pack('second');
    b.questions[0].id = a.questions[0].id;
    b.modules[0].questionIds = [a.questions[0].id];
    await repo.saveImportedPack(a);
    await expect(repo.saveImportedPack(b)).rejects.toThrow();
    expect(await repo.getImportedPacks()).toHaveLength(1);
    expect(await cloud.state('second')).toBeUndefined();
    expect(await db.all('cloudOutbox')).toHaveLength(1);
  });
  it('logout preserves local packs and queued operation IDs across reopening', async () => {
    const { db, repo, cloud } = context();
    await login(cloud, true);
    await repo.saveImportedPack(pack());
    const jobs = await db.all<SyncJob>('cloudOutbox');
    await cloud.clearToken();
    db.close();
    expect(await db.all<SyncJob>('cloudOutbox')).toEqual(jobs);
    expect(await repo.getImportedPacks()).toHaveLength(1);
    expect((await cloud.settings())?.token).toBeUndefined();
  });
  it('semantic fingerprint ignores runtime installation fields but detects answer changes', async () => {
    const p = pack();
    const original = await contentFingerprint(p, []);
    expect(await contentFingerprint({ ...p, installedOrder: 9, contentRevision: 'runtime' } as LoopDeckPack, [])).toBe(original);
    expect(await contentFingerprint(pack('cloud-test', 'B'), [])).not.toBe(original);
  });
});
