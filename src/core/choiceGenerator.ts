import { getAcceptedAnswers, judgeInputAnswer, normalizeAnswer, normalizeAnswerForQuestion } from './answerJudge';
import type { ChoiceQuestion, ConcreteStudyQuestionMode, InputQuestion, Question } from './models';
import { presentQuestionForStudy } from './questionPresentation';

type RandomSource = () => number;

export interface IndexedChoiceCandidate {
  questionId: string;
  moduleId: string;
  category?: string;
  answer: string;
  normalizedAnswer: string;
  studyMode: ConcreteStudyQuestionMode;
}

export interface GeneratedChoiceOrigin {
  questionId: string;
  moduleId: string;
  studyMode: ConcreteStudyQuestionMode;
}

export interface GeneratedChoiceOption {
  text: string;
  kind: 'correct' | 'generated_distractor' | 'manual_distractor';
  origin?: GeneratedChoiceOrigin;
}

export type ChoiceCandidateIndex = ReadonlyMap<ConcreteStudyQuestionMode, readonly IndexedChoiceCandidate[]>;

const INDEXED_MODES: ConcreteStudyQuestionMode[] = ['as_stored', 'front_to_back', 'back_to_front'];

function shuffle<T>(items: T[], random: RandomSource): T[] {
  const copied = [...items];
  for (let index = copied.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copied[index], copied[target]] = [copied[target], copied[index]];
  }
  return copied;
}

function candidateAnswer(question: Question): string | undefined {
  if (question.type === 'multi_select') return undefined;
  const answer = question.answer.trim();
  return answer || undefined;
}

function uniqueAnswers(question: InputQuestion | ChoiceQuestion, values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const normalized = normalizeAnswerForQuestion(question, trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

export function getManualChoiceCandidates(question: Question, optionCount = 4): string[] | undefined {
  if (question.type === 'multi_select') return undefined;
  const mode = question.activeStudyMode;
  const manual =
    mode === 'front_to_back' || mode === 'back_to_front'
      ? (question.sideChoiceCandidates?.[mode] ?? question.choiceCandidates)
      : question.choiceCandidates;
  if (!manual || manual.mode !== 'manual') return undefined;

  const choices = uniqueAnswers(question, manual.choices);
  const accepted = new Set(getAcceptedAnswers(question).map((answer) => normalizeAnswerForQuestion(question, answer)));
  const correct = normalizeAnswerForQuestion(question, question.answer);
  if (!choices.some((choice) => normalizeAnswerForQuestion(question, choice) === correct)) return undefined;

  const wrongChoices = choices.filter((choice) => {
    const normalized = normalizeAnswerForQuestion(question, choice);
    return normalized === correct || (!accepted.has(normalized) && !judgeInputAnswer(question, choice));
  });

  if (wrongChoices.length < optionCount) return undefined;
  return wrongChoices;
}

function presentCandidateForMode(candidate: Question, mode: ConcreteStudyQuestionMode): Question | undefined {
  if (mode === 'as_stored') return candidate;
  const presented = presentQuestionForStudy(candidate, mode);
  return presented.activeStudyMode === mode ? presented : undefined;
}

export function buildChoiceCandidateIndex(pool: Question[]): ChoiceCandidateIndex {
  const byMode = new Map<ConcreteStudyQuestionMode, IndexedChoiceCandidate[]>();
  for (const mode of INDEXED_MODES) byMode.set(mode, []);

  for (const candidate of pool) {
    for (const mode of INDEXED_MODES) {
      const presented = presentCandidateForMode(candidate, mode);
      const answer = presented ? candidateAnswer(presented) : undefined;
      if (!answer) continue;
      const normalizedAnswer = normalizeAnswer(answer);
      if (!normalizedAnswer) continue;
      byMode.get(mode)?.push({
        questionId: candidate.id,
        moduleId: candidate.moduleId,
        category: candidate.category,
        answer,
        normalizedAnswer,
        studyMode: mode
      });
    }
  }

  return byMode;
}

export function buildGeneratedChoiceOptions(
  question: InputQuestion,
  pool: Question[],
  optionCount = 4,
  random: RandomSource = Math.random,
  candidateIndex?: ChoiceCandidateIndex
): GeneratedChoiceOption[] | undefined {
  if (optionCount < 2) return undefined;

  const correct = question.answer.trim();
  if (!correct) return undefined;
  const correctOption: GeneratedChoiceOption = { text: correct, kind: 'correct' };

  const manualChoices = getManualChoiceCandidates(question, optionCount);
  if (manualChoices) {
    const correctKey = normalizeAnswerForQuestion(question, correct);
    const distractors = manualChoices.filter((choice) => normalizeAnswerForQuestion(question, choice) !== correctKey);
    if (distractors.length >= optionCount - 1) {
      const manualOptions = shuffle(distractors, random)
        .slice(0, optionCount - 1)
        .map((text): GeneratedChoiceOption => ({ text, kind: 'manual_distractor' }));
      return shuffle([correctOption, ...manualOptions], random);
    }
  }

  const activeMode = question.activeStudyMode ?? 'as_stored';
  const accepted = new Set(getAcceptedAnswers(question).map((answer) => normalizeAnswerForQuestion(question, answer)));
  const seen = new Set(accepted);
  const distractors: GeneratedChoiceOption[] = [];
  const indexedCandidates = candidateIndex?.get(activeMode) ?? buildChoiceCandidateIndex(pool).get(activeMode) ?? [];

  for (const priority of [0, 1, 2]) {
    const candidates = indexedCandidates.filter((candidate) => {
      if (candidate.questionId === question.id) return false;
      const candidatePriority = candidate.moduleId === question.moduleId ? (candidate.category === question.category ? 0 : 1) : 2;
      return candidatePriority === priority;
    });

    for (const candidate of shuffle([...candidates], random)) {
      const key = normalizeAnswerForQuestion(question, candidate.answer);
      if (!key || seen.has(key) || judgeInputAnswer(question, candidate.answer)) continue;
      seen.add(key);
      distractors.push({
        text: candidate.answer,
        kind: 'generated_distractor',
        origin: {
          questionId: candidate.questionId,
          moduleId: candidate.moduleId,
          studyMode: candidate.studyMode
        }
      });
      if (distractors.length === optionCount - 1) return shuffle([correctOption, ...distractors], random);
    }
  }

  return undefined;
}

export function buildGeneratedChoices(
  question: InputQuestion,
  pool: Question[],
  optionCount = 4,
  random: RandomSource = Math.random,
  candidateIndex?: ChoiceCandidateIndex
): string[] | undefined {
  return buildGeneratedChoiceOptions(question, pool, optionCount, random, candidateIndex)?.map((option) => option.text);
}
