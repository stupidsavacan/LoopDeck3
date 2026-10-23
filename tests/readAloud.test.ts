// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleInfo, Question } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { speak, speechLanguage, whenSpeechReady } from '../src/platform/speech';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import type { QuizDataStore } from '../src/storage/storageTypes';

class FakeUtterance {
  lang = '';
  voice: { lang: string } | null = null;
  constructor(public text: string) {}
}

function installSpeech(voices: Array<{ lang: string }>) {
  const listeners = new Set<() => void>();
  const spoken: FakeUtterance[] = [];
  const fake = {
    voices,
    getVoices: () => fake.voices,
    speak: vi.fn((utterance: FakeUtterance) => spoken.push(utterance)),
    cancel: vi.fn(),
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    fire: () => [...listeners].forEach((listener) => listener())
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: fake });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  return { fake, spoken };
}

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  vi.unstubAllGlobals();
});

describe('speech helpers', () => {
  it('picks Japanese for kana or kanji and English otherwise', () => {
    expect(speechLanguage('consider')).toBe('en-US');
    expect(speechLanguage('〜をよく考える')).toBe('ja-JP');
  });

  it('waits for voices before reporting ready, and speaks with a matching voice', () => {
    const { fake, spoken } = installSpeech([]);
    const ready = vi.fn();
    whenSpeechReady(ready);
    expect(ready).not.toHaveBeenCalled();
    fake.voices = [{ lang: 'ja_JP' }, { lang: 'en-US' }];
    fake.fire();
    expect(ready).toHaveBeenCalledTimes(1);

    expect(speak('consider')).toBe(true);
    expect(spoken[0]).toMatchObject({ text: 'consider', lang: 'en-US', voice: { lang: 'en-US' } });
    expect(fake.cancel).toHaveBeenCalled();
  });

  it('does nothing without the API', () => {
    expect(speak('hello')).toBe(false);
  });
});

describe('read-aloud in the inline quiz', () => {
  const module: ModuleInfo = { id: 'leap', folderId: 'f', title: 'LEAP', subject: '英語', questionIds: ['q'] };
  const question: Question = { id: 'q', moduleId: 'leap', type: 'input', prompt: 'consider', answer: '〜をよく考える' };
  const store: QuizDataStore = { recordAnswer: async () => {}, hasBookmark: async () => false, setBookmark: async () => {} };

  function render(): HTMLElement {
    const container = document.createElement('div');
    document.body.append(container);
    const session = createSession(module, [question], { shuffle: false, autoNext: false, questionLimit: 'all', answerFormat: 'input' });
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store });
    return container;
  }

  it('stays hidden on devices without voices', () => {
    installSpeech([]);
    expect(render().querySelector<HTMLButtonElement>('.speak-button')?.hidden).toBe(true);
  });

  it('reads the prompt, then the answer once answered', async () => {
    const { spoken } = installSpeech([{ lang: 'en-US' }, { lang: 'ja-JP' }]);
    const container = render();
    const readAloud = container.querySelector<HTMLButtonElement>('.speak-button')!;
    expect(readAloud.hidden).toBe(false);
    readAloud.click();
    expect(spoken.at(-1)?.text).toBe('consider');

    container.querySelector<HTMLButtonElement>('button[aria-label="答えを見る"]')!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    readAloud.click();
    expect(spoken.at(-1)).toMatchObject({ text: '〜をよく考える', lang: 'ja-JP' });
  });
});
