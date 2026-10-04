// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModuleInfo, Question, VisualReference } from '../src/core/models';
import { createSession } from '../src/core/sessionEngine';
import { disposeInlineQuizzes, renderInlineQuiz } from '../src/screens/inlineQuiz';
import { studyStore } from '../src/storage/studyRepository';

const moduleInfo: ModuleInfo = { id: 'm', folderId: '', title: '模様', subject: '図', questionIds: ['q', 'next'] };
const container = document.createElement('div');
afterEach(() => disposeInlineQuizzes(container));

function render(references?: VisualReference[]) {
  const question: Question = { id: 'q', moduleId: 'm', type: 'input', prompt: '<b>模様</b>', answer: '確認', visualReferences: references };
  const next: Question = { ...question, id: 'next', visualReferences: undefined };
  const session = createSession(moduleInfo, [question, next], { shuffle: false, autoNext: false, questionLimit: 'all' });
  renderInlineQuiz(container, session, { onSessionChange() {}, onComplete() {} }, { store: studyStore });
  return session;
}

describe('active quiz visual references', () => {
  it('shows cues before answering and keeps labels and prompts as plain text', () => {
    render([
      { type: 'color', color: '#EDB0AA', label: '<img src=x onerror=alert(1)>' },
      { type: 'stripe', color: '#EF8A84', label: '下の縦線', shape: 'circle' }
    ]);
    const panel = container.querySelector('.question-visual-references')!;
    expect(panel.getAttribute('aria-label')).toBe('この問題だけの参考色・参考模様');
    expect(panel.querySelectorAll('.visual-reference-swatch')).toHaveLength(2);
    expect(panel.querySelector('.visual-reference-label')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(panel.querySelector('img')).toBeNull();
    expect(container.querySelector('.question-prompt')?.textContent).toBe('<b>模様</b>');
    expect(container.querySelector('.question-prompt b')).toBeNull();
    expect(panel.querySelector('.visual-reference-circle')).not.toBeNull();
    expect(container.querySelector('.result-area')?.textContent).toBe('');
  });

  it('does not leak references into the following question', () => {
    const session = render([{ type: 'color', color: '#123456', label: '参考色' }]);
    renderInlineQuiz(container, { ...session, index: 1 }, { onSessionChange() {}, onComplete() {} }, { store: studyStore });
    expect(container.querySelector('.question-visual-references')).toBeNull();
  });

  it('omits absent, empty, and invalid metadata rather than interpreting arbitrary styles', () => {
    for (const references of [undefined, [], [{ type: 'color', color: 'url(https://example.com)', label: '危険' }] as VisualReference[]]) {
      render(references);
      expect(container.querySelector('.question-visual-references')).toBeNull();
    }
  });
});
