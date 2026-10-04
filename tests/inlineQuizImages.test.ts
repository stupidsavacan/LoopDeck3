// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { LoopDeckPack, ModuleInfo, Question } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { createQuestionImageAssetResolver } from '../src/packs/packAssetResolver';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { studyStore } from '../src/storage/studyRepository';

const moduleInfo: ModuleInfo = {
  id: 'image-module',
  folderId: 'image-folder',
  title: 'Image Module',
  subject: 'demo',
  questionIds: ['image-question']
};

const imageQuestion: Question = {
  id: 'image-question',
  moduleId: 'image-module',
  type: 'input',
  prompt: 'Read the image.',
  answer: 'Answer',
  imageAsset: 'images/map.png'
};

function session() {
  return createSession(moduleInfo, [imageQuestion], { shuffle: false, autoNext: false, questionLimit: 'all' });
}

async function settleImageResolution(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
  }
}

describe('renderInlineQuiz image assets', () => {
  it('renders a resolved safe data URL as img.question-image', async () => {
    const container = document.createElement('div');
    renderInlineQuiz(
      container,
      session(),
      { onSessionChange() {}, onComplete() {} },
      {
        store: studyStore,
        ...{
          resolveImageAsset: async () =>
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        }
      }
    );

    await settleImageResolution();

    const image = container.querySelector<HTMLImageElement>('img.question-image');
    expect(image).not.toBeNull();
    expect(image?.src).toBe(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    );
    expect(container.querySelector('.image-fallback')).toBeNull();
  });

  it('renders a validated relative built-in image path', async () => {
    const container = document.createElement('div');
    renderInlineQuiz(
      container,
      session(),
      { onSessionChange() {}, onComplete() {} },
      {
        store: studyStore,
        ...{
          resolveImageAsset: async () => 'images/map.png'
        }
      }
    );

    await settleImageResolution();

    const image = container.querySelector<HTMLImageElement>('img.question-image');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe('images/map.png');
    expect(container.querySelector('.image-fallback')).toBeNull();
  });

  it('renders an image through the active pack resolver and IndexedDB storage', async () => {
    const pack: LoopDeckPack = {
      packVersion: 1,
      packId: 'inline-real-storage-pack',
      title: 'Stored image pack',
      folders: [{ id: 'image-folder', title: 'Images' }],
      modules: [moduleInfo],
      questions: [imageQuestion]
    };
    await studyStore.deleteImportedPack(pack.packId);
    await studyStore.saveImportedPackWithAssets(
      pack,
      [
        {
          packId: pack.packId,
          path: 'images/map.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        }
      ],
      'replace'
    );
    const resolveImageAsset = createQuestionImageAssetResolver(resolveActivePacks([pack]), studyStore);

    const container = document.createElement('div');
    renderInlineQuiz(container, session(), { onSessionChange() {}, onComplete() {} }, { store: studyStore, ...{ resolveImageAsset } });
    await settleImageResolution();

    expect(container.querySelector<HTMLImageElement>('img.question-image')?.src).toBe(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    );
    expect(container.querySelector('.image-fallback')).toBeNull();
    await studyStore.deleteImportedPack(pack.packId);
  });

  it('shows the missing-image fallback when the resolver returns undefined', async () => {
    const container = document.createElement('div');
    renderInlineQuiz(
      container,
      session(),
      { onSessionChange() {}, onComplete() {} },
      {
        store: studyStore,
        ...{
          resolveImageAsset: async () => undefined
        }
      }
    );

    await settleImageResolution();

    expect(container.querySelector('img.question-image')).toBeNull();
    expect(container.querySelector('.image-fallback')?.textContent).toContain(
      '\u753b\u50cf\u30d5\u30a1\u30a4\u30eb\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093'
    );
  });
});
