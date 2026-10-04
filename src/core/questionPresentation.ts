import type { ConcreteStudyQuestionMode, InputQuestion, Question, StudyQuestionMode } from './models';

const JAPANESE_RE = /[\u3040-\u30ff\u3400-\u9fff]/;
const LATIN_RE = /[A-Za-z]/;
const HTML_RE = /<[^>]+>/;
const ENGLISH_TO_JAPANESE_LABEL = '\u82f1\u8a9e \u2192 \u65e5\u672c\u8a9e';
const JAPANESE_TO_ENGLISH_LABEL = '\u65e5\u672c\u8a9e \u2192 \u82f1\u8a9e';

interface AutoLanguageStudyData {
  storedMode: 'front_to_back' | 'back_to_front';
  reverseMode: 'front_to_back' | 'back_to_front';
  prompt: string;
  answerCandidates: string[];
}

export interface StudyPairSide {
  label: string;
  text: string;
  acceptableAnswers?: string[];
}

export interface StudyPair {
  front: StudyPairSide;
  back: StudyPairSide;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneAsStored<T extends Question>(question: T): T {
  return { ...question, activeStudyMode: 'as_stored' };
}

function normalizeTextForLang(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function hasHtml(value: unknown): boolean {
  return HTML_RE.test(String(value ?? ''));
}

function hasJapanese(value: string): boolean {
  return JAPANESE_RE.test(value);
}

function hasLatin(value: string): boolean {
  return LATIN_RE.test(value);
}

function isCompactVocabularyText(value: string): boolean {
  if (!value || value.length > 64) return false;
  if (/[.!?。！？]/.test(value)) return false;
  const latinWords = value.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) ?? [];
  return latinWords.length <= 6;
}

export function isEnglishOnlyStudyText(value: unknown): boolean {
  if (hasHtml(value)) return false;
  const text = normalizeTextForLang(value);
  return isCompactVocabularyText(text) && hasLatin(text) && !hasJapanese(text);
}

export function isJapaneseOnlyStudyText(value: unknown): boolean {
  if (hasHtml(value)) return false;
  const text = normalizeTextForLang(value);
  return isCompactVocabularyText(text) && hasJapanese(text) && !hasLatin(text);
}

function uniqueStrings(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) continue;
    const key = rawTextKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function rawTextKey(text: string): string {
  return text
    .replace(/[①-⑳㉑-㉟㊱-㊿]/g, (digit) => `circled-${digit.codePointAt(0)}`)
    .normalize('NFKC')
    .toLocaleLowerCase();
}

function answerCandidates(question: InputQuestion): string[] {
  const aliases = question.acceptedAnswers?.length ? question.acceptedAnswers : (question.acceptableAnswers ?? []);
  return uniqueStrings([question.answer, ...aliases]);
}

function autoLanguageStudyData(question: Question): AutoLanguageStudyData | undefined {
  if (question.type !== 'input' || question.imageAsset || question.visualReferences?.length) return undefined;
  const prompt = question.prompt.trim();
  if (!prompt || hasHtml(question.prompt)) return undefined;

  const candidates = answerCandidates(question);
  const japanese = candidates.filter(isJapaneseOnlyStudyText);
  const english = candidates.filter(isEnglishOnlyStudyText);

  if (isEnglishOnlyStudyText(prompt) && japanese.length) {
    return {
      storedMode: 'front_to_back',
      reverseMode: 'back_to_front',
      prompt,
      answerCandidates: japanese
    };
  }

  if (isJapaneseOnlyStudyText(prompt) && english.length) {
    return {
      storedMode: 'back_to_front',
      reverseMode: 'front_to_back',
      prompt,
      answerCandidates: english
    };
  }

  return undefined;
}

export function canAutoReverseQuestion(question: Question): boolean {
  return Boolean(autoLanguageStudyData(question));
}

function sideWithAliases(label: string, text: string, aliases: string[]): StudyPairSide {
  const normalizedText = rawTextKey(text.trim());
  const acceptableAnswers = uniqueStrings(aliases).filter((value) => rawTextKey(value) !== normalizedText);
  return {
    label,
    text: text.trim(),
    ...(acceptableAnswers.length ? { acceptableAnswers } : {})
  };
}

export function getQuestionStudyPair(question: Question): StudyPair | undefined {
  if (hasTwoSidedStudyData(question) && question.sides) {
    return {
      front: sideWithAliases(question.sides.front.label, question.sides.front.text, question.sides.front.acceptableAnswers ?? []),
      back: sideWithAliases(question.sides.back.label, question.sides.back.text, question.sides.back.acceptableAnswers ?? [])
    };
  }

  if (question.type === 'input') {
    const auto = autoLanguageStudyData(question);
    if (auto?.answerCandidates.length) {
      const primary = auto.answerCandidates[0];
      const aliases = auto.answerCandidates.slice(1);
      if (auto.storedMode === 'front_to_back') {
        return {
          front: sideWithAliases('\u82f1\u8a9e', auto.prompt, []),
          back: sideWithAliases('\u65e5\u672c\u8a9e', primary, aliases)
        };
      }
      return {
        front: sideWithAliases('\u82f1\u8a9e', primary, aliases),
        back: sideWithAliases('\u65e5\u672c\u8a9e', auto.prompt, [])
      };
    }
  }

  if (question.type === 'input' || question.type === 'choice') {
    const aliases = uniqueStrings(question.acceptedAnswers?.length ? question.acceptedAnswers : (question.acceptableAnswers ?? []));
    return {
      front: sideWithAliases('\u554f\u984c', question.prompt, []),
      back: sideWithAliases('\u7b54\u3048', question.answer, aliases)
    };
  }

  if (question.type === 'multi_select' && question.correctChoices.length) {
    return {
      front: sideWithAliases('\u554f\u984c', question.prompt, []),
      back: sideWithAliases('\u7b54\u3048', question.correctChoices.join(' / '), [])
    };
  }

  return undefined;
}

function directionLabel(mode: 'front_to_back' | 'back_to_front'): string {
  return mode === 'front_to_back' ? ENGLISH_TO_JAPANESE_LABEL : JAPANESE_TO_ENGLISH_LABEL;
}

function joinPromptCandidates(candidates: string[]): string {
  return candidates.every(isJapaneseOnlyStudyText) ? candidates.join('\u30fb') : candidates.join(' / ');
}

function presentAutoLanguageQuestion(question: InputQuestion, mode: 'front_to_back' | 'back_to_front'): InputQuestion | undefined {
  const data = autoLanguageStudyData(question);
  if (!data) return undefined;

  if (mode === data.storedMode) {
    return {
      ...question,
      acceptedAnswers: data.answerCandidates,
      activeStudyMode: mode,
      directionLabel: directionLabel(mode)
    };
  }

  if (mode !== data.reverseMode) return undefined;

  return {
    ...question,
    prompt: joinPromptCandidates(data.answerCandidates),
    answer: data.prompt,
    acceptableAnswers: [data.prompt],
    acceptedAnswers: [data.prompt],
    answerJudging: {
      ...question.answerJudging,
      mode: 'any_of'
    },
    activeStudyMode: mode,
    autoReversed: true,
    directionLabel: directionLabel(mode)
  };
}

export function hasTwoSidedStudyData(question: Question): boolean {
  return Boolean(question.sides && nonEmpty(question.sides.front?.text) && nonEmpty(question.sides.back?.text));
}

export function getSupportedStudyQuestionModes(question: Question): ConcreteStudyQuestionMode[] {
  const modes: ConcreteStudyQuestionMode[] = ['as_stored'];
  if (question.type !== 'input') return modes;

  if (!hasTwoSidedStudyData(question)) {
    const auto = autoLanguageStudyData(question);
    if (!auto) return modes;
    modes.push(auto.storedMode);
    if (auto.reverseMode !== auto.storedMode) modes.push(auto.reverseMode);
    return modes;
  }

  const supported = new Set(question.supportedStudyModes ?? []);
  if (supported.has('front_to_back')) modes.push('front_to_back');
  if (supported.has('back_to_front')) modes.push('back_to_front');
  return modes;
}

export function getModuleStudyQuestionModes(questions: Question[]): StudyQuestionMode[] {
  const modes: StudyQuestionMode[] = ['as_stored'];
  const supported = new Set<ConcreteStudyQuestionMode>();
  for (const question of questions) {
    for (const mode of getSupportedStudyQuestionModes(question)) supported.add(mode);
  }
  if (supported.has('front_to_back')) modes.push('front_to_back');
  if (supported.has('back_to_front')) modes.push('back_to_front');
  if (supported.has('front_to_back') && supported.has('back_to_front')) modes.push('mixed');
  return modes;
}

export function getStudyQuestionModeLabel(mode: StudyQuestionMode, sampleQuestion?: Question): string {
  if (mode === 'as_stored') return '\u901a\u5e38';
  if (mode === 'mixed') return '\u4e21\u65b9\u5411\u30df\u30c3\u30af\u30b9';
  if (sampleQuestion && !hasTwoSidedStudyData(sampleQuestion) && canAutoReverseQuestion(sampleQuestion)) return directionLabel(mode);
  const front = sampleQuestion?.sides?.front?.label?.trim() || '\u8868';
  const back = sampleQuestion?.sides?.back?.label?.trim() || '\u88cf';
  return mode === 'front_to_back' ? `${front} \u2192 ${back}` : `${back} \u2192 ${front}`;
}

export function resolveConcreteStudyQuestionMode(
  question: Question,
  requestedMode: StudyQuestionMode,
  random: () => number = Math.random
): ConcreteStudyQuestionMode {
  if (requestedMode === 'as_stored') return 'as_stored';
  const supported = getSupportedStudyQuestionModes(question);
  if (requestedMode === 'front_to_back') return supported.includes('front_to_back') ? 'front_to_back' : 'as_stored';
  if (requestedMode === 'back_to_front') return supported.includes('back_to_front') ? 'back_to_front' : 'as_stored';

  const concrete = supported.filter((mode): mode is 'front_to_back' | 'back_to_front' => mode !== 'as_stored');
  if (!concrete.length) return 'as_stored';
  return concrete[Math.floor(random() * concrete.length)] ?? concrete[0];
}

function sideAnswers(question: InputQuestion, mode: 'front_to_back' | 'back_to_front'): string[] {
  const side = mode === 'front_to_back' ? question.sides?.back : question.sides?.front;
  const answers = side?.acceptableAnswers?.filter((answer) => answer.trim().length > 0) ?? [];
  if (side?.text && !answers.some((answer) => answer.trim() === side.text.trim())) return [side.text, ...answers];
  return answers.length ? answers : side?.text ? [side.text] : [];
}

export function presentQuestionForStudy(question: Question, mode: ConcreteStudyQuestionMode): Question {
  if (mode === 'as_stored' || question.type !== 'input') return cloneAsStored(question);

  if (!hasTwoSidedStudyData(question)) {
    return presentAutoLanguageQuestion(question, mode) ?? cloneAsStored(question);
  }

  if (!getSupportedStudyQuestionModes(question).includes(mode) || !question.sides) return cloneAsStored(question);

  const { sides } = question;
  const promptSide = mode === 'front_to_back' ? sides.front : sides.back;
  const answerSide = mode === 'front_to_back' ? sides.back : sides.front;
  const acceptedAnswers = sideAnswers(question, mode);
  const sideChoiceCandidates = question.sideChoiceCandidates?.[mode];

  return {
    ...question,
    prompt: promptSide.text,
    answer: answerSide.text,
    acceptableAnswers: answerSide.acceptableAnswers ?? [],
    acceptedAnswers: acceptedAnswers.length ? acceptedAnswers : [answerSide.text],
    answerJudging: {
      ...question.answerJudging,
      mode: 'any_of'
    },
    choiceCandidates: sideChoiceCandidates ?? question.choiceCandidates,
    activeStudyMode: mode
  };
}
