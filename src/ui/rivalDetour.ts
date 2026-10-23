import { button, el } from './dom';

/** One side of a confused pair: what is asked and what answers it. */
export interface RivalSide {
  prompt: string;
  answer: string;
}

type Choice = 'current' | 'rival';

/**
 * A short practice that sorts the two answers back to their own questions.
 * It records nothing; mastery still comes from the regular attempts.
 */
export function renderRivalDetour(current: RivalSide, rival: RivalSide, onDone: () => void): HTMLElement {
  const section = el('section', 'rival-detour');
  section.setAttribute('aria-label', '寄り道：2つの問題を見分ける');
  const rounds: Choice[] = ['rival', 'current', 'current', 'rival'];
  let index = 0;
  let score = 0;

  const head = el('div', 'rival-head');
  head.append(el('p', 'eyebrow', '寄り道'), el('h3', '', '2つの問題を見分ける'));
  const sides = el('div', 'rival-sides');
  for (const [label, side, kind] of [
    ['この問題', current, 'current'],
    ['選んだ答えの問題', rival, 'rival']
  ] as const) {
    const card = el('div', `rival-side is-${kind}`);
    card.append(
      el('span', 'rival-side-label', label),
      el('p', 'rival-side-prompt', side.prompt),
      el('strong', 'rival-side-answer', `答え：${side.answer}`)
    );
    sides.append(card);
  }
  const progress = el('div', 'rival-progress');
  progress.setAttribute('aria-hidden', 'true');
  const round = el('div', 'rival-round');
  const back = button('元の問題に戻る', 'btn ghost rival-back');
  back.onclick = onDone;
  section.append(head, sides, progress, round, back);

  function renderProgress(): void {
    progress.replaceChildren(
      ...rounds.map((_, position) =>
        el('span', position < index ? 'rival-dot done' : position === index ? 'rival-dot current' : 'rival-dot')
      )
    );
  }

  function renderRound(): void {
    renderProgress();
    if (index >= rounds.length) {
      round.replaceChildren(el('p', 'rival-result', `${rounds.length}問中${score}問 見分けられました。`));
      back.textContent = '元の問題に戻る';
      back.className = 'btn primary rival-back';
      back.focus();
      return;
    }
    const target = rounds[index];
    const answer = (target === 'current' ? current : rival).answer;
    const question = el('p', 'rival-question', `「${answer}」が答えなのはどっち？`);
    const choices = el('div', 'rival-choices');
    const feedback = el('p', 'rival-feedback');
    feedback.setAttribute('aria-live', 'polite');
    const buttons = (['current', 'rival'] as const).map((kind) => {
      const choice = button(kind === 'current' ? 'この問題' : '選んだ答えの問題', `rival-choice is-${kind}`);
      choice.onclick = () => {
        for (const item of buttons) item.disabled = true;
        const correct = kind === target;
        if (correct) score += 1;
        choice.classList.add(correct ? 'is-right' : 'is-wrong');
        feedback.textContent = correct ? '正解。' : `「${answer}」は${target === 'current' ? 'この問題' : '選んだ答えの問題'}の答えです。`;
        const next = button(index + 1 < rounds.length ? '次へ' : '結果を見る', 'btn rival-next');
        next.onclick = () => {
          index += 1;
          renderRound();
        };
        round.append(next);
        next.focus();
      };
      return choice;
    });
    choices.append(...buttons);
    round.replaceChildren(question, choices, feedback);
  }

  renderRound();
  return section;
}
