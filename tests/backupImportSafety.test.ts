import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { studyStore } from '../src/storage/studyRepository';
import { validateBackupPayload } from '../src/storage/backupValidator';

function validPack() {
  return {
    packVersion: 1,
    packId: 'backup-safe-pack',
    title: 'Backup Safe Pack',
    folders: [{ id: 'f', title: 'Folder' }],
    modules: [{ id: 'm', folderId: 'f', title: 'Module', subject: 'demo', questionIds: ['q'] }],
    questions: [{ id: 'q', moduleId: 'm', type: 'input', prompt: 'Q?', answer: 'A' }]
  };
}

function backup(overrides: Record<string, unknown> = {}) {
  return {
    format: 'loopdeck3.backup', schema: 1,
    exportedAt: '2026-09-27T00:00:00.000Z',
    attempts: [],
    bookmarks: [],
    importedPacks: [validPack()],
    ...overrides
  };
}

describe('backup import trust boundary', () => {
  it('runs imported packs through the normal pack validator before any DB write', async () => {
    const attemptId = 'backup-rejected-before-write';
    const malformed = backup({
      attempts: [
        {
          attemptId,
          questionId: 'q',
          moduleId: 'm',
          answeredAt: '2026-09-27T00:00:00.000Z',
          result: 'correct',
          input: 'A',
          answer: 'A',
          elapsedMs: 10,
          mode: 'normal'
        }
      ],
      importedPacks: [
        {
          ...validPack(),
          modules: [{ id: 'm', folderId: 'missing-folder', title: 'Module', subject: 'demo', questionIds: ['q'] }]
        }
      ]
    });

    await expect(studyStore.restoreSnapshot(malformed, 'merge')).rejects.toThrow(/unknown folderId/);
    expect((await studyStore.getAttempts()).some((attempt) => attempt.attemptId === attemptId)).toBe(false);
    expect((await studyStore.getImportedPacks()).some((pack) => pack.packId === 'backup-safe-pack')).toBe(false);
  });

  it('rejects malformed learning records and unsafe stored assets', () => {
    expect(() =>
      validateBackupPayload(
        backup({
          attempts: [{ attemptId: 'a', questionId: 'q', moduleId: 'm', answeredAt: 'not-a-date' }]
        })
      )
    ).toThrow(/answeredAt/);

    expect(() =>
      validateBackupPayload(
        backup({
          importedPackAssets: [
            {
              assetId: 'backup-safe-pack:images/x.png',
              packId: 'backup-safe-pack',
              path: 'images/x.png',
              mimeType: 'image/png',
              dataUrl: 'data:text/html;base64,PHNjcmlwdD4='
            }
          ]
        })
      )
    ).toThrow(/dataUrl/);
  });
});
