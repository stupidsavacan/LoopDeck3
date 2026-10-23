// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Attempt, ModuleInfo, Question } from '../src/core/models';
import { buildRivalPairs, placeRivalsTogether } from '../src/core/rivalPairs';
import { createSession } from '../src/core/sessionEngine';
import { renderInlineQuiz } from '../src/screens/inlineQuiz';
import { parseAttempt } from '../src/storage/backupValidator';
import type { QuizDataStore } from '../src/storage/storageTypes';

function attempt(questionId: string, minute: number, patch: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: `${questionId}-${minute}`,
    questionId,
    moduleId: 'history',
    answeredAt: new Date(2026, 9, 20, 9, minute).toISOString(),
    result: 'correct',
    input: '',
    answer: '',
    elapsedMs: 1000,
    mode: 'normal',
    ...patch
  };
}

describe('rival pairs', () => {
  it('groups confusions in both directions into one pair', () => {
    const pairs = buildRivalPairs([
      attempt('3b', 1, { result: 'wrong', confusedWithQuestionId: '3c' }),
      attempt('3c', 2, { result: 'wrong', confusedWithQuestionId: '3b' }),
      attempt('x', 3, { result: 'wrong', confusedWithQuestionId: 'y', contentRetired: true })
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ questionIds: ['3b', '3c'], confusions: 2, defeated: false });
  });

  it('counts a pair as defeated after three correct answers on each side since the last confusion', () => {
    const history = [
      attempt('3b', 1, { result: 'wrong', confusedWithQuestionId: '3c' }),
      attempt('3b', 2),
      attempt('3c', 3),
      attempt('3b', 4),
      attempt('3c', 5),
      attempt('3b', 6)
    ];
    expect(buildRivalPairs(history)[0].defeated).toBe(false);
    const done = buildRivalPairs([...history, attempt('3c', 7)])[0];
    expect(done.defeated).toBe(true);
    expect(done.defeatedAt).toBe(new Date(2026, 9, 20, 9, 7).toISOString());
    expect(buildRivalPairs([...history, attempt('3c', 7), attempt('3c', 8, { result: 'wrong' })])[0].defeated).toBe(false);
  });

  it('places unresolved pairs side by side and keeps everything else in order', () => {
    const queue = ['a', '3b', 'b', 'c', '3c'].map((id) => ({ id }));
    const pairs = buildRivalPairs([attempt('3c', 1, { result: 'wrong', confusedWithQuestionId: '3b' })]);
    expect(placeRivalsTogether(queue, pairs).map((item) => item.id)).toEqual(['a', '3b', '3c', 'b', 'c']);
  });

  it('accepts the confusion in backups and rejects an empty one', () => {
    const raw = { ...attempt('3b', 1, { result: 'wrong' }), confusedWithQuestionId: '3c' };
    expect(parseAttempt(raw, 0).confusedWithQuestionId).toBe('3c');
    expect(() => parseAttempt({ ...raw, confusedWithQuestionId: '' }, 0)).toThrow();
  });
});

describe('confusions in the inline quiz', () => {
  const moduleInfo: ModuleInfo = { id: 'history', folderId: 'f', title: '歴史', subject: '社会', questionIds: ['3b', '3c'] };
  const threeB: Question = {
    id: '3b',
    moduleId: 'history',
    type: 'choice',
    prompt: '3B政策のドイツ本国側の都市は？',
    choices: ['ベルリン', 'カイロ'],
    answer: 'ベルリン'
  };
  const threeC: Question = { id: '3c', moduleId: 'history', type: 'input', prompt: '3C政策のエジプト側の都市は？', answer: 'カイロ' };

  function render(): { container: HTMLElement; saved: Attempt[] } {
    const saved: Attempt[] = [];
    const store: QuizDataStore = {
      recordAnswer: async (item) => {
        saved.push(item);
      },
      hasBookmark: async () => false,
      setBookmark: async () => {}
    };
    const container = document.createElement('div');
    document.body.append(container);
    const session = createSession(moduleInfo, [threeB], { shuffle: false, autoNext: false, questionLimit: 'all' }, 'normal', [
      threeB,
      threeC
    ]);
    renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store });
    return { container, saved };
  }

  const settle = () => new Promise((resolve) => window.setTimeout(resolve, 50));
  const choice = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('.choice-btn')].find((item) => item.textContent?.startsWith(text))!;

  it('saves which question the wrong answer belongs to', async () => {
    const { container, saved } = render();
    choice(container, 'カイロ').click();
    await settle();
    expect(saved[0]).toMatchObject({ result: 'wrong', confusedWithQuestionId: '3c' });
  });

  it('does not mark correct answers as confusions', async () => {
    const { container, saved } = render();
    choice(container, 'ベルリン').click();
    await settle();
    expect(saved[0].confusedWithQuestionId).toBeUndefined();
  });

  it('opens a detour that sorts the two answers and returns to the answered card', async () => {
    const { container } = render();
    choice(container, 'カイロ').click();
    await settle();
    container.querySelector<HTMLButtonElement>('.rival-open')!.click();

    const card = container.querySelector<HTMLElement>('.quiz-card')!;
    expect(card.hidden).toBe(true);
    const detour = container.querySelector<HTMLElement>('.rival-detour')!;
    expect(detour.querySelector('.rival-question')?.textContent).toBe('「カイロ」が答えなのはどっち？');

    for (let round = 0; round < 4; round += 1) {
      const question = detour.querySelector('.rival-question')?.textContent ?? '';
      const target = question.includes('カイロ') ? 'is-rival' : 'is-current';
      detour.querySelector<HTMLButtonElement>(`.rival-choice.${target}`)!.click();
      detour.querySelector<HTMLButtonElement>('.rival-next')!.click();
    }
    expect(detour.querySelector('.rival-result')?.textContent).toBe('4問中4問 見分けられました。');

    detour.querySelector<HTMLButtonElement>('.rival-back')!.click();
    expect(container.querySelector('.rival-detour')).toBeNull();
    expect(card.hidden).toBe(false);
    expect(container.querySelector('.prototype-next-ready')).not.toBeNull();
  });
});
