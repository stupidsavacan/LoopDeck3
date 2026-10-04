import type { ChoiceQuestion, InputQuestion } from './models';

const CIRCLED_DIGITS = /[①-⑳㉑-㉟㊱-㊿]/g;
const JAPANESE_TEXT = /[\u3040-\u30ff\u3400-\u9fff]/;

/** Preserve the numbered meaning boundaries before NFKC converts them into ordinary digits. */
export function normalizeJapaneseMeaningSeparators(value: string): string {
  return value
    .replace(/^\s*[①-⑳㉑-㉟㊱-㊿]\s*/, '')
    .replace(CIRCLED_DIGITS, '、')
    .replace(/\s*、\s*/g, '、')
    .trim();
}

export function usesJapaneseVocabularyAnswers(question: InputQuestion | ChoiceQuestion): boolean {
  const rule = question.answerJudging;
  if (question.type !== 'input' || question.imageAsset || rule?.caseSensitive) return false;
  if (rule?.mode && rule.mode !== 'single' && rule.mode !== 'any_of') return false;
  const prompt = question.prompt.normalize('NFKC').trim();
  if (prompt.length > 64 || !/^[A-Za-z]+(?:[-'][A-Za-z]+)*(?:\s+[A-Za-z]+(?:[-'][A-Za-z]+)*){0,5}$/.test(prompt)) return false;
  const candidates = question.acceptedAnswers?.length
    ? [question.answer, ...question.acceptedAnswers]
    : [question.answer, ...(question.acceptableAnswers ?? [])];
  return candidates.every((candidate) => {
    if (/[①-⑳㉑-㉟㊱-㊿]/.test(candidate) && !/^\s*[①-⑳㉑-㉟㊱-㊿]/.test(candidate)) return false;
    const text = normalizeJapaneseMeaningSeparators(candidate).normalize('NFKC');
    return JAPANESE_TEXT.test(text) && !/[A-Za-z0-9０-９<>()[\]]/.test(text) && text.split('、').every((part) => JAPANESE_TEXT.test(part));
  });
}
