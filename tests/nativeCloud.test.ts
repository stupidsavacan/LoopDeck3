import 'fake-indexeddb/auto';
import { afterEach, it, expect, vi } from 'vitest';
import { LocalDatabase } from '../src/storage/indexedDb';
import { CloudStore } from '../src/cloud/store';
import { nativeCloud, NATIVE_TOKEN_REFERENCE, stageNative, mirrorNative } from '../src/platform/nativeCloud';
import type { SyncJob } from '../src/storage/cloudRecords';
afterEach(() => vi.unstubAllGlobals());
it('stores only a Keystore reference in Android IndexedDB and preserves outbox on logout', async () => {
  let secret = '';
  const bridge = {
    origin: () => 'https://sync.test',
    credentials: vi.fn((_origin: string, token: string) => {
      secret = token;
      return true;
    }),
    token: () => secret,
    logout: () => {
      secret = '';
    },
    mirror: vi.fn((_raw: string) => true)
  };
  vi.stubGlobal('LoopDeckCloud', bridge);
  const db = new LocalDatabase('native-credentials-' + crypto.randomUUID()),
    store = new CloudStore(db),
    token = '1'.repeat(64);
  try {
    await store.configure({ key: 'settings', apiUrl: 'https://sync.test', token, deviceName: 'test', setupComplete: true });
    const stored = await db.all('cloudConfig');
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored).toMatchObject([{ token: NATIVE_TOKEN_REFERENCE }]);
    expect((await store.settings())?.token).toBe(token);
    await db.request('cloudOutbox', 'readwrite', (s) => s.put({ opId: 'retained' }));
    await mirrorNative(db);
    expect(bridge.mirror.mock.calls[0][0]).not.toContain(token);
    await store.clearToken();
    expect((await store.settings())?.token).toBeUndefined();
    expect(await db.all('cloudOutbox')).toHaveLength(1);
  } finally {
    db.close();
  }
});
it('stages the stable snapshot ZIP in ordered bounded chunks rather than relying on WebView lifetime', async () => {
  const input = new Uint8Array(100000);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  const chunks: number[] = [];
  const output: number[] = [];
  vi.stubGlobal('LoopDeckCloud', {
    begin: () => true,
    append: (_op: string, offset: number, base64: string) => {
      expect(offset).toBe(output.length);
      const bytes = atob(base64);
      chunks.push(bytes.length);
      for (const b of bytes) output.push(b.charCodeAt(0));
      return true;
    },
    finish: () => true
  });
  await stageNative({ opId: 'fixture', zip: new Blob([input]), sha256: 'sha', fingerprint: 'fp' } as SyncJob);
  expect(chunks).toEqual([49152, 49152, 1696]);
  expect(new Uint8Array(output)).toEqual(input);
  expect(nativeCloud()).toBeDefined();
});
