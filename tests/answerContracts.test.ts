import { describe, expect, it } from 'vitest';
import type { InputQuestion, LoopDeckPack, Question } from '../src/core/models';
import { buildGeneratedChoiceOptions } from '../src/core/choiceGenerator';
import { presentQuestionForStudy } from '../src/core/questionPresentation';
import { buildWrongAnswerFeedback, normalizeWrongAnswerLookup } from '../src/core/wrongAnswerExplanation';
import { validatePack } from '../src/packs/packValidator';

const question: InputQuestion = { id: 'dog', moduleId: 'm', type: 'input', prompt: 'dog', answer: '犬' };
function pack(q: Question): LoopDeckPack {
  return {
    packVersion: 1,
    packId: 'p',
    title: 'Pack',
    folders: [],
    modules: [{ id: 'm', title: 'M', folderId: '', subject: '', questionIds: [q.id] }],
    questions: [q]
  };
}

describe('answer judging validator contracts', () => {
  it.each([
    { ...question, type: 'choice' as const, answer: 'A', choices: ['A', 'Ａ'] },
    { ...question, type: 'choice' as const, answer: 'A', choices: ['A', '   '] },
    { ...question, type: 'multi_select' as const, choices: ['A', 'Ａ', 'B'], correctChoices: ['A', 'Ａ'] },
    { ...question, type: 'multi_select' as const, choices: ['', 'A'], correctChoices: [''] },
    { ...question, answerJudging: { mode: 'all_of' as const, requiredParts: ['   '] } }
  ])('rejects the normalization-invalid pack from issue #103: %#', (q) => {
    expect(validatePack(pack(q)).ok).toBe(false);
  });
});

describe('direction-specific choices', () => {
  it('preserves case-sensitive distractors in authored and generated sets', () => {
    const q = {
      ...question,
      answer: 'Polish',
      answerJudging: { caseSensitive: true },
      choiceCandidates: { mode: 'manual' as const, choices: ['Polish', 'polish'] }
    };
    expect(
      buildGeneratedChoiceOptions(q, [q], 2)
        ?.map((option) => option.text)
        .sort()
    ).toEqual(['Polish', 'polish']);
    const generated = { ...q, choiceCandidates: undefined };
    expect(
      buildGeneratedChoiceOptions(generated, [generated, { ...question, id: 'other', answer: 'polish' }], 2)
        ?.map((option) => option.text)
        .sort()
    ).toEqual(['Polish', 'polish']);
  });

  it('validates automatically reversible directional answers even without authored sides', () => {
    const invalid = { ...question, sideChoiceCandidates: { back_to_front: { mode: 'manual' as const, choices: ['cat', 'bird'] } } };
    expect(validatePack(pack(invalid)).ok).toBe(false);
    const valid = { ...question, sideChoiceCandidates: { back_to_front: { mode: 'manual' as const, choices: ['dog', 'cat', 'bird'] } } };
    const result = validatePack(pack(valid));
    expect(result.ok).toBe(true);
    const presented = presentQuestionForStudy(result.pack!.questions[0], 'back_to_front');
    if (presented.type !== 'input') throw new Error('Expected an input study presentation');
    expect(
      buildGeneratedChoiceOptions(presented, [valid], 3, () => 0)
        ?.map((option) => option.text)
        .sort()
    ).toEqual(['bird', 'cat', 'dog']);
  });

  it('rejects manual choices attached to unsupported directional presentation', () => {
    const q = {
      ...question,
      prompt: '一般問題です',
      sideChoiceCandidates: { back_to_front: { mode: 'manual' as const, choices: ['犬', '猫'] } }
    };
    expect(validatePack(pack(q)).ok).toBe(false);
  });
});

describe('generated-choice exact provenance', () => {
  const current = { ...question, id: 'current', prompt: 'cat', answer: '猫' };
  const origin = { questionId: question.id, moduleId: question.moduleId, studyMode: 'back_to_front' as const };

  it('verifies against the presented answer, excluding the opposite side', () => {
    const q = {
      ...question,
      sides: { front: { label: 'English', text: 'dog' }, back: { label: 'Japanese', text: '犬' } },
      supportedStudyModes: ['front_to_back', 'back_to_front'] as InputQuestion['supportedStudyModes']
    };
    expect(buildWrongAnswerFeedback('choice', 'dog', current, [q], undefined, origin)?.matchKind).toBe('exact_origin');
    expect(buildWrongAnswerFeedback('choice', '犬', current, [q], undefined, origin)?.matchKind).not.toBe('exact_origin');
  });

  it('does not promote excluded aliases or case mismatches to exact provenance', () => {
    const q = {
      ...question,
      answer: 'Polish',
      acceptedAnswers: ['Polish'],
      acceptableAnswers: ['polish'],
      answerJudging: { caseSensitive: true }
    };
    const stored = { ...origin, studyMode: 'as_stored' as const };
    expect(buildWrongAnswerFeedback('choice', 'polish', current, [q], undefined, stored)?.matchKind).not.toBe('exact_origin');
    expect(buildWrongAnswerFeedback('choice', 'Polish', current, [q], undefined, stored)?.matchKind).toBe('exact_origin');
  });

  it.each(['徳川家康。', '徳川・家康', '徳川／家康', '徳川－家康'])('normalizes Japanese lookup punctuation: %s', (value) => {
    expect(normalizeWrongAnswerLookup(value)).toBe('徳川家康');
  });
});
