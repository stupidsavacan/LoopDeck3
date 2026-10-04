import type {
  AnswerJudgingMode,
  AnswerJudgingRule,
  ConcreteStudyQuestionMode,
  FolderInfo,
  InputQuestion,
  LoopDeckPack,
  ManualChoiceCandidates,
  ModuleInfo,
  Question,
  SideChoiceCandidates,
  StudySide,
  TwoSidedStudyData
} from '../core/models';
import { extensionOf, isSafeImageAssetRef, isSafePackPath } from './assetSafety';
import { judgeInputAnswer, normalizeAnswer, normalizeAnswerForQuestion } from '../core/answerJudge';
import { presentQuestionForStudy } from '../core/questionPresentation';
import { parseVisualReferences } from '../core/visualReferences';
import { FORBIDDEN_EXTENSIONS, type PackValidationIssue, type PackValidationResult } from './packTypes';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const QUESTION_TYPES = new Set(['input', 'choice', 'multi_select']);
const DIRECTIONS = new Set(['ja_to_en', 'en_to_ja', 'normal']);
const STUDY_MODES = new Set<ConcreteStudyQuestionMode>(['as_stored', 'front_to_back', 'back_to_front']);
const REVERSIBLE_STUDY_MODES = new Set(['front_to_back', 'back_to_front']);
const ANSWER_JUDGING_MODES = new Set<AnswerJudgingMode>(['single', 'any_of', 'all_of', 'exact_phrase', 'numeric']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const nonEmpty = (value: string): boolean => Boolean(value.trim());

function issue(message: string, path?: string): PackValidationIssue {
  return { level: 'error', message, path };
}

function optionalString(record: Record<string, unknown>, key: string, path: string, issues: PackValidationIssue[]): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    issues.push(issue(`${path}.${key} must be a string.`));
    return undefined;
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, path: string, issues: PackValidationIssue[]): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    issues.push(issue(`${path}.${key} must be a boolean.`));
    return undefined;
  }
  return value;
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: PackValidationIssue[]
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(issue(`${path}.${key} must be a finite number.`));
    return undefined;
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: PackValidationIssue[]
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isStringArray(value)) {
    issues.push(issue(`${path}.${key} must be an array of strings.`));
    return undefined;
  }
  return [...value];
}

function optionalHexColor(record: Record<string, unknown>, key: string, path: string, issues: PackValidationIssue[]): string | undefined {
  const value = optionalString(record, key, path, issues);
  if (value === undefined) return undefined;
  if (!HEX_COLOR.test(value)) {
    issues.push(issue(`${path}.${key} must use a six-digit hex color such as #2563EB.`));
    return undefined;
  }
  return value;
}

function uniqueStrings(values: string[], path: string, issues: PackValidationIssue[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) issues.push(issue(`${path} contains duplicate value: ${value}`));
    seen.add(value);
  }
}

function parseStudySide(value: unknown, path: string, issues: PackValidationIssue[]): StudySide | undefined {
  if (!isObject(value)) {
    issues.push(issue(`${path} must be an object.`));
    return undefined;
  }
  if (typeof value.label !== 'string' || !nonEmpty(value.label)) issues.push(issue(`${path}.label is required.`));
  if (typeof value.text !== 'string' || !nonEmpty(value.text)) issues.push(issue(`${path}.text is required.`));
  const acceptableAnswers = optionalStringArray(value, 'acceptableAnswers', path, issues);
  if (typeof value.label !== 'string' || !nonEmpty(value.label) || typeof value.text !== 'string' || !nonEmpty(value.text))
    return undefined;
  return {
    label: value.label,
    text: value.text,
    ...(acceptableAnswers ? { acceptableAnswers } : {})
  };
}

function parseSides(value: unknown, path: string, issues: PackValidationIssue[]): TwoSidedStudyData | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    issues.push(issue(`${path} must be an object.`));
    return undefined;
  }
  const front = parseStudySide(value.front, `${path}.front`, issues);
  const back = parseStudySide(value.back, `${path}.back`, issues);
  return front && back ? { front, back } : undefined;
}

function parseAnswerJudging(value: unknown, path: string, issues: PackValidationIssue[]): AnswerJudgingRule | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    issues.push(issue(`${path} must be an object.`));
    return undefined;
  }

  let mode: AnswerJudgingMode | undefined;
  if (value.mode !== undefined) {
    if (typeof value.mode !== 'string' || !ANSWER_JUDGING_MODES.has(value.mode as AnswerJudgingMode))
      issues.push(issue(`${path}.mode is unsupported.`));
    else mode = value.mode as AnswerJudgingMode;
  }

  const caseSensitive = optionalBoolean(value, 'caseSensitive', path, issues);
  const ignoreSpaces = optionalBoolean(value, 'ignoreSpaces', path, issues);
  const ignorePunctuation = optionalBoolean(value, 'ignorePunctuation', path, issues);
  const allowJapaneseSentenceEdges = optionalBoolean(value, 'allowJapaneseSentenceEdges', path, issues);
  const requiresAll = optionalBoolean(value, 'requiresAll', path, issues);
  const requiredParts = optionalStringArray(value, 'requiredParts', path, issues);
  if (mode === 'all_of' && (!requiredParts || requiredParts.length === 0))
    issues.push(issue(`${path}.requiredParts is required for all_of judging.`));

  return {
    ...(mode ? { mode } : {}),
    ...(caseSensitive !== undefined ? { caseSensitive } : {}),
    ...(ignoreSpaces !== undefined ? { ignoreSpaces } : {}),
    ...(ignorePunctuation !== undefined ? { ignorePunctuation } : {}),
    ...(allowJapaneseSentenceEdges !== undefined ? { allowJapaneseSentenceEdges } : {}),
    ...(requiresAll !== undefined ? { requiresAll } : {}),
    ...(requiredParts ? { requiredParts } : {})
  };
}

function parseManualChoiceCandidates(
  value: unknown,
  path: string,
  issues: PackValidationIssue[],
  expectedAnswer?: string
): ManualChoiceCandidates | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    issues.push(issue(`${path} must be an object.`));
    return undefined;
  }
  if (value.mode !== 'manual') issues.push(issue(`${path}.mode must be manual.`));
  if (!isStringArray(value.choices) || value.choices.length < 2) issues.push(issue(`${path}.choices must contain at least two strings.`));
  const choices = isStringArray(value.choices) ? [...value.choices] : [];
  if (choices.length) uniqueStrings(choices, `${path}.choices`, issues);
  if (expectedAnswer && choices.length && !choices.includes(expectedAnswer))
    issues.push(issue(`${path}.choices must include the primary answer.`));
  const distractors = optionalStringArray(value, 'distractors', path, issues);
  const reason = optionalString(value, 'reason', path, issues);
  if (value.mode !== 'manual' || choices.length < 2) return undefined;
  return {
    mode: 'manual',
    choices,
    ...(distractors ? { distractors } : {}),
    ...(reason !== undefined ? { reason } : {})
  };
}

function parseSideChoiceCandidates(value: unknown, path: string, issues: PackValidationIssue[]): SideChoiceCandidates | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    issues.push(issue(`${path} must be an object.`));
    return undefined;
  }
  const frontToBack = parseManualChoiceCandidates(value.front_to_back, `${path}.front_to_back`, issues);
  const backToFront = parseManualChoiceCandidates(value.back_to_front, `${path}.back_to_front`, issues);
  return {
    ...(frontToBack ? { front_to_back: frontToBack } : {}),
    ...(backToFront ? { back_to_front: backToFront } : {})
  };
}

function parseQuestion(raw: unknown, index: number, ids: Set<string>, issues: PackValidationIssue[]): Question | undefined {
  const path = `questions[${index}]`;
  if (!isObject(raw)) {
    issues.push(issue(`${path} must be an object.`));
    return undefined;
  }

  const id = raw.id;
  const moduleId = raw.moduleId;
  const type = raw.type;
  const prompt = raw.prompt;
  if (typeof id !== 'string' || !nonEmpty(id)) issues.push(issue(`${path}.id is required.`));
  if (typeof id === 'string' && ids.has(id)) issues.push(issue(`Duplicate question id: ${id}`));
  if (typeof id === 'string') ids.add(id);
  if (typeof moduleId !== 'string' || !nonEmpty(moduleId)) issues.push(issue(`${path}.moduleId is required.`));
  if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) issues.push(issue(`${path}.type is unsupported.`));
  if (typeof prompt !== 'string' || !nonEmpty(prompt)) issues.push(issue(`${path}.prompt is required.`));
  if (
    typeof id !== 'string' ||
    !nonEmpty(id) ||
    typeof moduleId !== 'string' ||
    !nonEmpty(moduleId) ||
    typeof type !== 'string' ||
    !QUESTION_TYPES.has(type) ||
    typeof prompt !== 'string' ||
    !nonEmpty(prompt)
  )
    return undefined;

  const explanation = optionalString(raw, 'explanation', path, issues);
  const visualReferences = parseVisualReferences(raw.visualReferences, `${path}.visualReferences`);
  issues.push(...visualReferences.errors.map((message) => issue(message)));
  const imageAsset = optionalString(raw, 'imageAsset', path, issues);
  if (imageAsset !== undefined && !isSafeImageAssetRef(imageAsset))
    issues.push(issue(`${path}.imageAsset must be a safe local supported image path.`, imageAsset));
  const category = optionalString(raw, 'category', path, issues)?.trim();
  const number = optionalFiniteNumber(raw, 'number', path, issues);
  const example = optionalString(raw, 'example', path, issues);
  const sides = parseSides(raw.sides, `${path}.sides`, issues);
  let supportedStudyModes: Array<'front_to_back' | 'back_to_front'> | undefined;
  if (raw.supportedStudyModes !== undefined) {
    if (
      !Array.isArray(raw.supportedStudyModes) ||
      !raw.supportedStudyModes.every((mode) => typeof mode === 'string' && REVERSIBLE_STUDY_MODES.has(mode))
    ) {
      issues.push(issue(`${path}.supportedStudyModes contains an unsupported value.`));
    } else {
      supportedStudyModes = [...raw.supportedStudyModes] as Array<'front_to_back' | 'back_to_front'>;
      uniqueStrings(supportedStudyModes, `${path}.supportedStudyModes`, issues);
    }
  }
  let activeStudyMode: ConcreteStudyQuestionMode | undefined;
  if (raw.activeStudyMode !== undefined) {
    if (typeof raw.activeStudyMode !== 'string' || !STUDY_MODES.has(raw.activeStudyMode as ConcreteStudyQuestionMode))
      issues.push(issue(`${path}.activeStudyMode is unsupported.`));
    else activeStudyMode = raw.activeStudyMode as ConcreteStudyQuestionMode;
  }
  const autoReversed = optionalBoolean(raw, 'autoReversed', path, issues);
  const directionLabel = optionalString(raw, 'directionLabel', path, issues);

  const base = {
    id,
    moduleId,
    type,
    prompt,
    ...(explanation !== undefined ? { explanation } : {}),
    ...(visualReferences.references !== undefined ? { visualReferences: visualReferences.references } : {}),
    ...(imageAsset !== undefined && isSafeImageAssetRef(imageAsset) ? { imageAsset } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(example !== undefined ? { example } : {}),
    ...(sides ? { sides } : {}),
    ...(supportedStudyModes ? { supportedStudyModes } : {}),
    ...(activeStudyMode ? { activeStudyMode } : {}),
    ...(autoReversed !== undefined ? { autoReversed } : {}),
    ...(directionLabel !== undefined ? { directionLabel } : {})
  };

  if (type === 'input') {
    if (typeof raw.answer !== 'string' || !nonEmpty(raw.answer)) issues.push(issue(`Input question ${id} needs answer.`));
    if (typeof raw.answer !== 'string' || !nonEmpty(raw.answer)) return undefined;
    const acceptableAnswers = optionalStringArray(raw, 'acceptableAnswers', path, issues);
    const acceptedAnswers = optionalStringArray(raw, 'acceptedAnswers', path, issues);
    const answerJudging = parseAnswerJudging(raw.answerJudging, `${path}.answerJudging`, issues);
    const choiceCandidates = parseManualChoiceCandidates(raw.choiceCandidates, `${path}.choiceCandidates`, issues, raw.answer);
    const sideChoiceCandidates = parseSideChoiceCandidates(raw.sideChoiceCandidates, `${path}.sideChoiceCandidates`, issues);
    let direction: InputQuestion['direction'];
    if (raw.direction !== undefined) {
      if (typeof raw.direction !== 'string' || !DIRECTIONS.has(raw.direction)) issues.push(issue(`${path}.direction is unsupported.`));
      else direction = raw.direction as InputQuestion['direction'];
    }
    return {
      ...base,
      type: 'input',
      answer: raw.answer,
      ...(acceptableAnswers ? { acceptableAnswers } : {}),
      ...(acceptedAnswers ? { acceptedAnswers } : {}),
      ...(answerJudging ? { answerJudging } : {}),
      ...(choiceCandidates ? { choiceCandidates } : {}),
      ...(sideChoiceCandidates ? { sideChoiceCandidates } : {}),
      ...(direction ? { direction } : {})
    };
  }

  if (type === 'choice') {
    if (!isStringArray(raw.choices) || raw.choices.length < 2) issues.push(issue(`Choice question ${id} needs at least two choices.`));
    if (typeof raw.answer !== 'string' || !nonEmpty(raw.answer)) issues.push(issue(`Choice question ${id} needs answer.`));
    const choices = isStringArray(raw.choices) ? [...raw.choices] : [];
    if (choices.length) uniqueStrings(choices, `${path}.choices`, issues);
    if (typeof raw.answer === 'string' && choices.length && !choices.includes(raw.answer))
      issues.push(issue(`Choice question ${id} answer must appear in choices.`));
    if (choices.length < 2 || typeof raw.answer !== 'string' || !nonEmpty(raw.answer)) return undefined;
    const acceptableAnswers = optionalStringArray(raw, 'acceptableAnswers', path, issues);
    const acceptedAnswers = optionalStringArray(raw, 'acceptedAnswers', path, issues);
    const answerJudging = parseAnswerJudging(raw.answerJudging, `${path}.answerJudging`, issues);
    const choiceCandidates = parseManualChoiceCandidates(raw.choiceCandidates, `${path}.choiceCandidates`, issues, raw.answer);
    const sideChoiceCandidates = parseSideChoiceCandidates(raw.sideChoiceCandidates, `${path}.sideChoiceCandidates`, issues);
    return {
      ...base,
      type: 'choice',
      choices,
      answer: raw.answer,
      ...(acceptableAnswers ? { acceptableAnswers } : {}),
      ...(acceptedAnswers ? { acceptedAnswers } : {}),
      ...(answerJudging ? { answerJudging } : {}),
      ...(choiceCandidates ? { choiceCandidates } : {}),
      ...(sideChoiceCandidates ? { sideChoiceCandidates } : {})
    };
  }

  if (!isStringArray(raw.choices) || raw.choices.length < 2) issues.push(issue(`Multi-select question ${id} needs choices.`));
  if (!isStringArray(raw.correctChoices) || raw.correctChoices.length < 1)
    issues.push(issue(`Multi-select question ${id} needs correctChoices.`));
  const choices = isStringArray(raw.choices) ? [...raw.choices] : [];
  const correctChoices = isStringArray(raw.correctChoices) ? [...raw.correctChoices] : [];
  if (choices.length) uniqueStrings(choices, `${path}.choices`, issues);
  if (correctChoices.length) uniqueStrings(correctChoices, `${path}.correctChoices`, issues);
  for (const correct of correctChoices)
    if (!choices.includes(correct)) issues.push(issue(`Multi-select question ${id} correct choice is missing from choices: ${correct}`));
  if (choices.length < 2 || correctChoices.length < 1) return undefined;
  return { ...base, type: 'multi_select', choices, correctChoices };
}

function parseFolders(value: unknown, issues: PackValidationIssue[]): FolderInfo[] {
  if (!Array.isArray(value)) {
    issues.push(issue('folders must be an array.'));
    return [];
  }
  const result: FolderInfo[] = [];
  const ids = new Set<string>();
  value.forEach((raw, index) => {
    const path = `folders[${index}]`;
    if (!isObject(raw)) {
      issues.push(issue(`${path} must be an object.`));
      return;
    }
    if (typeof raw.id !== 'string' || !nonEmpty(raw.id)) {
      issues.push(issue(`${path}.id is required.`));
      return;
    }
    const id = raw.id.trim();
    if (ids.has(id)) issues.push(issue(`Duplicate folder id: ${id}`));
    ids.add(id);
    if (raw.title !== undefined && typeof raw.title !== 'string') issues.push(issue(`${path}.title must be a string.`));
    const title = typeof raw.title === 'string' && nonEmpty(raw.title) ? raw.title : raw.id;
    const description = normalizedOptionalString(raw.description, undefined, issues, path + '.description');
    const tags = normalizedOptionalStringArray(raw.tags, issues, path + '.tags');
    result.push({ id, title, ...(description !== undefined ? { description } : {}), ...(tags ? { tags } : {}) });
  });
  return result;
}

function parseModules(value: unknown, issues: PackValidationIssue[]): ModuleInfo[] {
  if (!Array.isArray(value)) {
    issues.push(issue('modules must be an array.'));
    return [];
  }
  const result: ModuleInfo[] = [];
  const ids = new Set<string>();
  value.forEach((raw, index) => {
    const path = `modules[${index}]`;
    if (!isObject(raw)) {
      issues.push(issue(`${path} must be an object.`));
      return;
    }
    if (typeof raw.id !== 'string' || !nonEmpty(raw.id)) {
      issues.push(issue(`${path}.id is required.`));
      return;
    }
    if (ids.has(raw.id)) issues.push(issue(`Duplicate module id: ${raw.id}`));
    ids.add(raw.id);
    if (!isStringArray(raw.questionIds)) {
      issues.push(issue(`Module ${raw.id} needs questionIds.`));
      return;
    }
    uniqueStrings(raw.questionIds, `${path}.questionIds`, issues);
    const folderId = normalizedOptionalString(raw.folderId, '', issues, path + '.folderId') ?? '';
    const titleValue = normalizedOptionalString(raw.title, raw.id, issues, path + '.title');
    const subject = normalizedOptionalString(raw.subject, 'その他', issues, path + '.subject') ?? 'その他';
    const subtitle = normalizedOptionalString(raw.subtitle, undefined, issues, path + '.subtitle');
    const preferredAnswerFormat = raw.preferredAnswerFormat;
    if (
      preferredAnswerFormat !== undefined &&
      preferredAnswerFormat !== 'auto' &&
      preferredAnswerFormat !== 'choice' &&
      preferredAnswerFormat !== 'input'
    ) {
      issues.push(issue(`${path}.preferredAnswerFormat is unsupported.`));
    }
    const color = optionalHexColor(raw, 'color', path, issues);
    const accent = optionalHexColor(raw, 'accent', path, issues);
    const accentColor = optionalHexColor(raw, 'accentColor', path, issues);
    const description = normalizedOptionalString(raw.description, undefined, issues, path + '.description');
    const tags = normalizedOptionalStringArray(raw.tags, issues, path + '.tags');
    result.push({
      id: raw.id,
      folderId,
      title: titleValue && nonEmpty(titleValue) ? titleValue : raw.id,
      subject,
      ...(subtitle !== undefined ? { subtitle } : {}),
      ...(preferredAnswerFormat === 'auto' || preferredAnswerFormat === 'choice' || preferredAnswerFormat === 'input'
        ? { preferredAnswerFormat }
        : {}),
      ...(color ? { color } : {}),
      ...(accent ? { accent } : {}),
      ...(accentColor ? { accentColor } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tags ? { tags } : {}),
      questionIds: [...raw.questionIds]
    });
  });
  return result;
}

function normalizedOptionalString(
  value: unknown,
  fallback: string | undefined,
  issues: PackValidationIssue[],
  label: string
): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    issues.push({ level: 'warning', message: `${label} must be a string when present; using a safe default.` });
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizedOptionalStringArray(value: unknown, issues: PackValidationIssue[], label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ level: 'warning', message: `${label} must be an array of strings when present; ignoring it.` });
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === 'string');
  if (strings.length !== value.length) {
    issues.push({ level: 'warning', message: `${label} contained non-string values; they were ignored.` });
  }
  return strings;
}

export function validatePackFiles(paths: string[]): PackValidationIssue[] {
  const issues: PackValidationIssue[] = [];
  for (const path of paths) {
    if (!isSafePackPath(path)) issues.push({ level: 'error', message: 'Unsafe path is not allowed.', path });
    const ext = extensionOf(path);
    if (FORBIDDEN_EXTENSIONS.includes(ext))
      issues.push({ level: 'error', message: `Executable or renderable file is rejected: ${ext}`, path });
  }
  return issues;
}

export function validatePack(rawPack: unknown): PackValidationResult {
  const issues: PackValidationIssue[] = [];
  const contractIssue = (message: string): PackValidationIssue => ({ level: 'error', message });
  if (!isObject(rawPack)) return { ok: false, issues: [issue('Pack must be an object.')] };

  if (rawPack.packVersion !== 1) issues.push(issue('packVersion must be 1.'));
  if (typeof rawPack.packId !== 'string' || !nonEmpty(rawPack.packId)) issues.push(issue('packId is required.'));
  if (typeof rawPack.title !== 'string' || !nonEmpty(rawPack.title)) issues.push(issue('title is required.'));
  const description = optionalString(rawPack, 'description', 'pack', issues);
  const folders = parseFolders(rawPack.folders, issues);
  const modules = parseModules(rawPack.modules, issues);

  const questionIds = new Set<string>();
  const questions: Question[] = [];
  if (!Array.isArray(rawPack.questions)) issues.push(issue('questions must be an array.'));
  else
    rawPack.questions.forEach((raw, index) => {
      const parsed = parseQuestion(raw, index, questionIds, issues);
      if (parsed) {
        if (parsed.number !== undefined && (!Number.isSafeInteger(parsed.number) || parsed.number <= 0))
          issues.push(contractIssue(`Question ${parsed.id}.number must be a positive safe integer.`));
        if (
          parsed.type !== 'multi_select' &&
          parsed.answerJudging?.mode === 'all_of' &&
          parsed.answerJudging.requiredParts?.some((part) => !normalizeAnswerForQuestion(parsed, part))
        )
          issues.push(contractIssue(`Question ${parsed.id} required parts must remain non-empty under answer normalization.`));
        if (parsed.type !== 'input') {
          const keys = parsed.choices.map((choice) =>
            parsed.type === 'choice' ? normalizeAnswerForQuestion(parsed, choice) : normalizeAnswer(choice)
          );
          if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
            issues.push(contractIssue(`Question ${parsed.id} choices must be non-empty and distinct under answer normalization.`));
          }
          if (parsed.type === 'choice' && parsed.choices.some((choice) => choice !== parsed.answer && judgeInputAnswer(parsed, choice))) {
            issues.push(contractIssue(`Question ${parsed.id} contains a distractor accepted as correct by its answer judging rule.`));
          }
        }
        if (parsed.type !== 'input' && parsed.supportedStudyModes?.length) {
          issues.push(contractIssue(`Question ${parsed.id}: reversible study modes are only supported for input questions.`));
        }
        if (parsed.type === 'input' && parsed.sideChoiceCandidates) {
          for (const mode of ['front_to_back', 'back_to_front'] as const) {
            const manual = parsed.sideChoiceCandidates[mode];
            if (!manual) continue;
            const presented = presentQuestionForStudy(parsed, mode);
            if (presented.activeStudyMode !== mode || presented.type !== 'input')
              issues.push(contractIssue(`Question ${parsed.id}: ${mode} choices require a supported study direction.`));
            else if (!manual.choices.includes(presented.answer))
              issues.push(contractIssue(`Question ${parsed.id}: ${mode} choices must include the directional answer.`));
          }
        }
        questions.push(parsed);
      }
    });

  const folderIds = new Set(folders.map((folder) => folder.id));
  const moduleById = new Map(modules.map((module) => [module.id, module]));
  const questionById = new Map(questions.map((question) => [question.id, question]));

  for (const module of modules) {
    const ordinals = new Set<number>();
    module.questionIds.forEach((id, index) => {
      const ordinal = questionById.get(id)?.number ?? index + 1;
      if (ordinals.has(ordinal)) issues.push(contractIssue(`Module ${module.id} has duplicate question number: ${ordinal}`));
      ordinals.add(ordinal);
    });
    if (module.folderId && !folderIds.has(module.folderId))
      issues.push(issue(`Module ${module.id} references unknown folderId: ${module.folderId}`));
    for (const id of module.questionIds) {
      const question = questionById.get(id);
      if (!question) issues.push(issue(`Module ${module.id} references unknown questionId: ${id}`));
      else if (question.moduleId !== module.id)
        issues.push(issue(`Question ${id} belongs to module ${question.moduleId}, not ${module.id}.`));
    }
  }

  for (const question of questions) {
    const module = moduleById.get(question.moduleId);
    if (!module) issues.push(issue(`Question ${question.id} references unknown moduleId: ${question.moduleId}`));
    else if (!module.questionIds.includes(question.id))
      issues.push(issue(`Question ${question.id} is not listed in module ${module.id}.questionIds.`));
  }

  const ok = !issues.some((entry) => entry.level === 'error');
  if (
    !ok ||
    rawPack.packVersion !== 1 ||
    typeof rawPack.packId !== 'string' ||
    !nonEmpty(rawPack.packId) ||
    typeof rawPack.title !== 'string' ||
    !nonEmpty(rawPack.title)
  ) {
    return { ok: false, issues };
  }

  const pack: LoopDeckPack = {
    packVersion: 1,
    packId: rawPack.packId,
    title: rawPack.title,
    ...(description !== undefined ? { description } : {}),
    folders,
    modules,
    questions
  };
  return { ok: true, issues, pack };
}

/**
 * Question IDs are global user-data keys (attempts, bookmarks and review data),
 * so two active packIds may not own the same question ID. A later pack with the
 * same packId is a full replacement and is deduplicated before this check.
 */
export function validateActivePackIdentities(packs: LoopDeckPack[]): PackValidationIssue[] {
  const latestByPackId = new Map<string, LoopDeckPack>();
  for (const pack of packs) latestByPackId.set(pack.packId, pack);

  const ownerByQuestionId = new Map<string, string>();
  const issues: PackValidationIssue[] = [];
  for (const pack of latestByPackId.values()) {
    for (const question of pack.questions) {
      const previousOwner = ownerByQuestionId.get(question.id);
      if (previousOwner && previousOwner !== pack.packId) {
        issues.push({
          level: 'error',
          message: `Question id must be globally unique across active packs: ${question.id} (${previousOwner}, ${pack.packId})`
        });
        continue;
      }
      ownerByQuestionId.set(question.id, pack.packId);
    }
  }
  return issues;
}
