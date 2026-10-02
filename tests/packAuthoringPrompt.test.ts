import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packAuthoringPrompt from '../src/packs/packAuthoringPrompt.txt?raw';
import englishVocabularyRules from '../docs/english-vocabulary-pack-rules.md?raw';
import { ALLOWED_IMAGE_EXTENSIONS, FORBIDDEN_EXTENSIONS } from '../src/packs/packTypes';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderImportScreen } from '../src/screens/importScreen';

describe('pack authoring prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ships the current Sol-oriented authoring contract with semantic drift guards', () => {
    expect(packAuthoringPrompt.length).toBeGreaterThan(8000);
    expect(packAuthoringPrompt).toContain('Authoring contract revision: 2026-10-01');
    expect(packAuthoringPrompt).toContain('Target LoopDeck packVersion: 1');
    expect(packAuthoringPrompt).toContain('Prompt target: modern reasoning models including GPT-5.6 Sol');

    for (const questionType of ['input', 'choice', 'multi_select']) {
      expect(packAuthoringPrompt).toContain(`### ${questionType}`);
    }
    for (const mode of ['single', 'any_of', 'all_of', 'exact_phrase', 'numeric']) {
      expect(packAuthoringPrompt).toContain(`\`${mode}\``);
    }
    for (const direction of ['ja_to_en', 'en_to_ja', 'normal']) {
      expect(packAuthoringPrompt).toContain(`\`${direction}\``);
    }
    for (const extension of ALLOWED_IMAGE_EXTENSIONS) expect(packAuthoringPrompt).toContain(extension);
    for (const extension of FORBIDDEN_EXTENSIONS) expect(packAuthoringPrompt).toContain(extension);

    expect(packAuthoringPrompt).toContain('answerJudging');
    expect(packAuthoringPrompt).toContain('requiredParts');
    expect(packAuthoringPrompt).toContain('supportedStudyModes');
    expect(packAuthoringPrompt).toContain('choiceCandidates');
    expect(packAuthoringPrompt).toContain('sideChoiceCandidates');
    expect(packAuthoringPrompt).toContain('example');
    expect(packAuthoringPrompt).toContain('manifest.json');

    // User-authoritative hierarchy contract: source file boundaries must not become app hierarchy.
    expect(packAuthoringPrompt).toContain('Hierarchy contract: Folder -> Module -> category -> Question');
    expect(packAuthoringPrompt).toContain(
      'Do not create a Folder merely because the source contains multiple pages, images, chapters, headings, or topics.'
    );
    expect(packAuthoringPrompt).toContain('Do not create one Module per image, page, worksheet side, heading, or small topic.');
    expect(packAuthoringPrompt).toContain('Do not invent a semantic taxonomy merely because the content can be classified that way.');
    expect(packAuthoringPrompt).toContain('approximately 25 consecutive vocabulary items per category');

    // Vocabulary storage is constrained by the existing Japanese-to-English worksheet/PDF planner.
    expect(packAuthoringPrompt).toContain('English vocabulary canonical format and worksheet/PDF compatibility');
    expect(packAuthoringPrompt).toContain('`prompt`: the English word or phrase itself, with no Japanese question wrapper');
    expect(packAuthoringPrompt).toContain('Do not set canonical vocabulary items to `direction: "en_to_ja"`');
    expect(packAuthoringPrompt).toContain('Do not convert canonical vocabulary data into a `sides`-only representation.');
    expect(packAuthoringPrompt).toContain('worksheet/PDF planner reads `answer` plus `acceptableAnswers`');
    expect(packAuthoringPrompt).toContain('`sides` is additive study metadata');
    expect(packAuthoringPrompt).toContain('same-language vocabulary');
    expect(packAuthoringPrompt).toContain('old-Japanese word <-> meaning');
    expect(packAuthoringPrompt).toContain('Do not use `explanation` merely to restate');
    expect(packAuthoringPrompt).toContain('Do not put an example sentence in `explanation`; use `example`');

    expect(englishVocabularyRules).toContain('Optional two-sided study metadata');
    expect(englishVocabularyRules).toContain(
      'must not replace or change canonical `prompt`, `answer`, `acceptableAnswers`, `number`, or `direction` fields'
    );
    expect(englishVocabularyRules).toContain('same-language vocabulary');
    expect(englishVocabularyRules).toContain('`example` stores an example sentence or usage example');
    expect(englishVocabularyRules).toContain('`explanation` stores additional post-answer learning information');

    // Source is primary, but uncertain source facts may be externally verified without silent replacement.
    expect(packAuthoringPrompt).toContain(
      'External verification is allowed and useful when the supplied material is unclear, incomplete, suspicious, or difficult to read'
    );
    expect(packAuthoringPrompt).toContain('do not silently replace a supplied fact when an external source disagrees with it');
    expect(packAuthoringPrompt).toContain('do not expand the tested scope with unrelated outside facts');

    // Image quality and high-risk runtime semantics remain explicit.
    expect(packAuthoringPrompt).toContain('treat a user-supplied worksheet/map/graph/image as factual authority for the figure itself');
    expect(packAuthoringPrompt).toContain('never invent missing labels, values, legends, locations, or relationships');
    expect(packAuthoringPrompt).toContain('one authoritative figure may and should be reused for multiple targeted questions');
    expect(packAuthoringPrompt).toContain('legible at normal phone-scale display');
    expect(packAuthoringPrompt).toContain('a JSON-only pack cannot carry a local image payload');
    expect(packAuthoringPrompt).toContain('Question IDs must be globally unique across different active packIds');
    expect(packAuthoringPrompt).toContain('Merge import upserts assets');
    expect(packAuthoringPrompt).toContain('whole JSON/ZIP/backup file: at most 32 MiB');
    expect(packAuthoringPrompt).toContain('ZIP entry count: at most 256 entries');
    expect(packAuthoringPrompt).toContain('preferredAnswerFormat');
    expect(packAuthoringPrompt).toContain('broken folder/module/question cross-references');
    expect(packAuthoringPrompt).toContain('A pack that imports successfully can still behave incorrectly');
    expect(packAuthoringPrompt).toContain('activeStudyMode');
  });

  it('downloads a non-empty UTF-8 text prompt from the import screen action', async () => {
    const root = document.createElement('div');
    await renderImportScreen(screenContext({ root: root, catalog: resolveActivePacks([]), refreshCatalog: async () => {}, navigation: { home: () => {} } })
    );

    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:loopdeck-authoring-prompt');
    const revokeObjectURL = vi.fn<(url: string) => void>();

    try {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

      let downloadedFilename = '';
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
        downloadedFilename = this.download;
      });
      vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
        if (typeof handler === 'function') handler();
        return 1;
      }) as typeof window.setTimeout);

      const download = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'AI用Pack作成プロンプトを保存'
      );
      expect(download).toBeDefined();

      download!.click();

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0][0];
      expect(blob.size).toBeGreaterThan(8000);
      expect(blob.type).toBe('text/plain;charset=utf-8');
      expect(downloadedFilename).toBe('loopdeck-pack-authoring-prompt.txt');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:loopdeck-authoring-prompt');
    } finally {
      if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });
});
