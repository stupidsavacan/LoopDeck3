import { loadBuiltinPacks } from '../src/packs/builtinLoader';
import { describe, expect, it } from 'vitest';
import { normalizeAnswer } from '../src/core/answerJudge';
import { buildGeneratedChoices } from '../src/core/choiceGenerator';
import { createSession } from '../src/core/sessionEngine';

describe('built-in choice dataset audit', () => {
  const pack = loadBuiltinPacks()[0];

  it('can generate safe four-choice options for every input question in every non-empty module', () => {
    const failures: string[] = [];

    for (const module of pack.modules.filter((item) => item.questionIds.length > 0)) {
      const pool = pack.questions.filter((question) => question.moduleId === module.id);
      for (const question of pool) {
        if (question.type !== 'input') continue;
        const choices = buildGeneratedChoices(question, pool, 4, () => 0.25);
        const normalizedChoices = choices?.map(normalizeAnswer) ?? [];
        const accepted = new Set([question.answer, ...(question.acceptableAnswers ?? [])].map(normalizeAnswer));
        const wrongChoices = normalizedChoices.filter((choice) => choice !== normalizeAnswer(question.answer));

        if (!choices || choices.length !== 4 || new Set(normalizedChoices).size !== 4 || !choices.includes(question.answer)) {
          failures.push(`${module.title}: ${question.id} could not build four unique choices`);
          continue;
        }
        if (wrongChoices.some((choice) => accepted.has(choice))) {
          failures.push(`${module.title}: ${question.id} used an acceptable answer as a distractor`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps the full module available as the choice pool for a one-question session', () => {
    const module = pack.modules.find((item) => item.id === 'chemistry')!;
    const pool = pack.questions.filter((question) => question.moduleId === module.id);
    const session = createSession(module, pool.slice(0, 1), {
      shuffle: false,
      autoNext: false,
      questionLimit: 'all',
      answerFormat: 'choice'
    }, 'review', pool);

    expect(session.queue).toHaveLength(1);
    expect(session.choicePool).toHaveLength(pool.length);
  });

  it('keeps every native choice question valid', () => {
    const failures = pack.questions
      .filter((question) => question.type === 'choice')
      .filter((question) => question.choices.length < 2 || !question.choices.includes(question.answer) || new Set(question.choices.map(normalizeAnswer)).size !== question.choices.length)
      .map((question) => `${question.moduleId}: ${question.id}`);

    expect(failures).toEqual([]);
  });

  it('keeps every multi-select question valid', () => {
    const failures = pack.questions
      .filter((question) => question.type === 'multi_select')
      .filter((question) => question.correctChoices.length < 2 || question.correctChoices.some((answer) => !question.choices.includes(answer)))
      .map((question) => `${question.moduleId}: ${question.id}`);

    expect(failures).toEqual([]);
  });
});
