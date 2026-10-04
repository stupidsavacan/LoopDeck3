import type { ConcreteStudyQuestionMode, Question, StudyQuestionMode } from './models';
import { getAcceptedAnswers, normalizeAnswer, normalizeAnswerForQuestion, removeAnswerPunctuation } from './answerJudge';
import { getQuestionStudyPair, getSupportedStudyQuestionModes, presentQuestionForStudy, type StudyPair } from './questionPresentation';

export type WrongAnswerExplanationSource = 'choice' | 'input';
export type WrongAnswerMatchKind = 'exact_origin' | 'lookup' | 'ambiguous' | 'not_found';
export type WrongAnswerMatchRole =
  'primary_answer' | 'acceptable_answer' | 'accepted_answer' | 'front' | 'front_alias' | 'back' | 'back_alias' | 'multi_select_correct';

export interface WrongAnswerOrigin {
  questionId: string;
  moduleId: string;
  studyMode: ConcreteStudyQuestionMode;
}

export interface WrongAnswerAlternative {
  questionId: string;
  matchedAnswer: string;
  matchRole: WrongAnswerMatchRole;
  pair?: StudyPair;
  explanation?: string;
}

export interface WrongAnswerFeedback {
  source: WrongAnswerExplanationSource;
  value: string;
  found: boolean;
  matchKind: WrongAnswerMatchKind;
  matchedQuestionId?: string;
  matchedAnswer?: string;
  matchRole?: WrongAnswerMatchRole;
  pair?: StudyPair;
  explanation?: string;
  alternatives?: WrongAnswerAlternative[];
}

export type WrongAnswerExplanation = WrongAnswerFeedback;

export interface IndexedWrongAnswerMatch {
  question: Question;
  matchedAnswer: string;
  matchRole: WrongAnswerMatchRole;
}

export type WrongAnswerLookupIndex = ReadonlyMap<string, readonly IndexedWrongAnswerMatch[]>;

const TAG_RE = /<[^>]*>/g;

export function normalizeWrongAnswerLookup(value: unknown): string {
  return removeAnswerPunctuation(
    String(value ?? '')
      .normalize('NFKC')
      .replace(TAG_RE, '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/\p{S}/gu, '')
  )
    .toLocaleLowerCase()
    .trim();
}

function cleanText(value: unknown): string | undefined {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(TAG_RE, '')
    .trim();
  return normalizeWrongAnswerLookup(text) ? text : undefined;
}

function pushMatch(
  result: Array<{ matchedAnswer: string; matchRole: WrongAnswerMatchRole }>,
  value: unknown,
  matchRole: WrongAnswerMatchRole
): void {
  const matchedAnswer = cleanText(value);
  if (matchedAnswer) result.push({ matchedAnswer, matchRole });
}

export function collectAnswerMatches(question: Question): Array<{ matchedAnswer: string; matchRole: WrongAnswerMatchRole }> {
  const result: Array<{ matchedAnswer: string; matchRole: WrongAnswerMatchRole }> = [];

  if ('answer' in question) pushMatch(result, question.answer, 'primary_answer');
  if ('acceptableAnswers' in question) {
    for (const value of question.acceptableAnswers ?? []) pushMatch(result, value, 'acceptable_answer');
  }
  if ('acceptedAnswers' in question) {
    for (const value of question.acceptedAnswers ?? []) pushMatch(result, value, 'accepted_answer');
  }

  pushMatch(result, question.sides?.front?.text, 'front');
  for (const value of question.sides?.front?.acceptableAnswers ?? []) pushMatch(result, value, 'front_alias');
  pushMatch(result, question.sides?.back?.text, 'back');
  for (const value of question.sides?.back?.acceptableAnswers ?? []) pushMatch(result, value, 'back_alias');

  if (question.type === 'multi_select') {
    for (const value of question.correctChoices) pushMatch(result, value, 'multi_select_correct');
  }

  return result;
}

export function collectAnswerTexts(question: Question): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const match of collectAnswerMatches(question)) {
    const key = normalizeWrongAnswerLookup(match.matchedAnswer);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(match.matchedAnswer);
  }
  return values;
}

export function buildWrongAnswerLookupIndex(allQuestions: Question[]): WrongAnswerLookupIndex {
  const index = new Map<string, IndexedWrongAnswerMatch[]>();
  for (const question of allQuestions) {
    for (const match of collectAnswerMatches(question)) {
      const key = normalizeWrongAnswerLookup(match.matchedAnswer);
      if (!key) continue;
      const matches = index.get(key) ?? [];
      matches.push({ question, ...match });
      index.set(key, matches);
    }
  }
  return index;
}

export function buildWrongAnswerLookupIndexForStudyMode(
  allQuestions: Question[],
  requestedMode: StudyQuestionMode
): WrongAnswerLookupIndex {
  const presentedQuestions = allQuestions.flatMap((question) => {
    if (requestedMode === 'mixed') {
      const modes = getSupportedStudyQuestionModes(question).filter((mode) => mode !== 'as_stored');
      return modes.length ? modes.map((mode) => presentQuestionForStudy(question, mode)) : [presentQuestionForStudy(question, 'as_stored')];
    }
    return [presentQuestionForStudy(question, requestedMode)];
  });
  return buildWrongAnswerLookupIndex(presentedQuestions);
}
function orderedMatches(
  value: string,
  currentQuestion: Question,
  allQuestions: Question[],
  lookupIndex?: WrongAnswerLookupIndex
): IndexedWrongAnswerMatch[] {
  const key = normalizeWrongAnswerLookup(value);
  if (!key) return [];
  const matches = [...((lookupIndex ?? buildWrongAnswerLookupIndex(allQuestions)).get(key) ?? [])].filter(
    (match) => match.question.id !== currentQuestion.id
  );
  return [
    ...matches.filter((match) => match.question.moduleId === currentQuestion.moduleId),
    ...matches.filter((match) => match.question.moduleId !== currentQuestion.moduleId)
  ];
}

export function findQuestionByAnswer(
  value: string,
  currentQuestion: Question,
  allQuestions: Question[],
  lookupIndex?: WrongAnswerLookupIndex
): { question: Question; matchedAnswer: string; matchRole: WrongAnswerMatchRole } | undefined {
  const hit = orderedMatches(value, currentQuestion, allQuestions, lookupIndex)[0];
  return hit ? { question: hit.question, matchedAnswer: hit.matchedAnswer, matchRole: hit.matchRole } : undefined;
}

function roleFromPair(pair: StudyPair | undefined, value: string): WrongAnswerMatchRole | undefined {
  if (!pair) return undefined;
  const key = normalizeWrongAnswerLookup(value);
  if (!key) return undefined;
  if (normalizeWrongAnswerLookup(pair.front.text) === key) return 'front';
  if ((pair.front.acceptableAnswers ?? []).some((item) => normalizeWrongAnswerLookup(item) === key)) return 'front_alias';
  if (normalizeWrongAnswerLookup(pair.back.text) === key) return 'back';
  if ((pair.back.acceptableAnswers ?? []).some((item) => normalizeWrongAnswerLookup(item) === key)) return 'back_alias';
  return undefined;
}

function exactOriginRole(
  question: Question,
  studyMode: ConcreteStudyQuestionMode,
  value: string,
  pair: StudyPair | undefined
): WrongAnswerMatchRole | undefined {
  const key = normalizeWrongAnswerLookup(value);
  const matches = collectAnswerMatches(question).filter((match) => normalizeWrongAnswerLookup(match.matchedAnswer) === key);

  if (studyMode === 'front_to_back') {
    const sideMatch = matches.find((match) => match.matchRole === 'back' || match.matchRole === 'back_alias');
    return sideMatch?.matchRole ?? roleFromPair(pair, value) ?? matches[0]?.matchRole;
  }
  if (studyMode === 'back_to_front') {
    const sideMatch = matches.find((match) => match.matchRole === 'front' || match.matchRole === 'front_alias');
    return sideMatch?.matchRole ?? roleFromPair(pair, value) ?? matches[0]?.matchRole;
  }

  const storedMatch = matches.find(
    (match) => match.matchRole === 'primary_answer' || match.matchRole === 'acceptable_answer' || match.matchRole === 'accepted_answer'
  );
  return storedMatch?.matchRole ?? matches[0]?.matchRole ?? roleFromPair(pair, value);
}

function explanationText(question: Question): string {
  return typeof question.explanation === 'string' ? question.explanation.trim() : '';
}

function alternativeFromMatch(match: IndexedWrongAnswerMatch): WrongAnswerAlternative {
  return {
    questionId: match.question.id,
    matchedAnswer: match.matchedAnswer,
    matchRole: match.matchRole,
    pair: getQuestionStudyPair(match.question),
    explanation: explanationText(match.question)
  };
}

export function buildWrongAnswerFeedback(
  source: WrongAnswerExplanationSource,
  value: string,
  currentQuestion: Question,
  allQuestions: Question[],
  lookupIndex?: WrongAnswerLookupIndex,
  origin?: WrongAnswerOrigin
): WrongAnswerFeedback | undefined {
  if (!normalizeWrongAnswerLookup(value)) return undefined;

  if (origin) {
    const question = allQuestions.find((candidate) => candidate.id === origin.questionId && candidate.moduleId === origin.moduleId);
    const presented = question ? presentQuestionForStudy(question, origin.studyMode) : undefined;
    const valueMatches =
      presented &&
      (presented.type === 'multi_select'
        ? presented.correctChoices.some((answer) => normalizeAnswer(answer) === normalizeAnswer(value))
        : getAcceptedAnswers(presented).some(
            (answer) => normalizeAnswerForQuestion(presented, answer) === normalizeAnswerForQuestion(presented, value)
          ));
    if (question && question.id !== currentQuestion.id && presented?.activeStudyMode === origin.studyMode && valueMatches) {
      const pair = getQuestionStudyPair(question);
      return {
        source,
        value,
        found: true,
        matchKind: 'exact_origin',
        matchedQuestionId: question.id,
        matchedAnswer: cleanText(value) ?? value,
        matchRole: exactOriginRole(question, origin.studyMode, value, pair),
        pair,
        explanation: explanationText(question)
      };
    }
  }

  const matches = orderedMatches(value, currentQuestion, allQuestions, lookupIndex);
  if (!matches.length) {
    return { source, value, found: false, matchKind: 'not_found' };
  }

  const questionIds = new Set(matches.map((match) => match.question.id));
  if (questionIds.size > 1) {
    return {
      source,
      value,
      found: true,
      matchKind: 'ambiguous',
      alternatives: matches.map(alternativeFromMatch)
    };
  }

  const rolePriority: WrongAnswerMatchRole[] = [
    'primary_answer',
    'acceptable_answer',
    'accepted_answer',
    'back',
    'back_alias',
    'front',
    'front_alias',
    'multi_select_correct'
  ];
  const hit =
    rolePriority
      .map((role) => matches.find((match) => match.matchRole === role))
      .find((match): match is IndexedWrongAnswerMatch => Boolean(match)) ?? matches[0];
  return {
    source,
    value,
    found: true,
    matchKind: 'lookup',
    matchedQuestionId: hit.question.id,
    matchedAnswer: hit.matchedAnswer,
    matchRole: hit.matchRole,
    pair: getQuestionStudyPair(hit.question),
    explanation: explanationText(hit.question),
    ...(matches.length > 1 ? { alternatives: matches.map(alternativeFromMatch) } : {})
  };
}

export function buildWrongAnswerExplanation(
  source: WrongAnswerExplanationSource,
  value: string,
  currentQuestion: Question,
  allQuestions: Question[],
  lookupIndex?: WrongAnswerLookupIndex
): WrongAnswerExplanation | undefined {
  return buildWrongAnswerFeedback(source, value, currentQuestion, allQuestions, lookupIndex);
}
