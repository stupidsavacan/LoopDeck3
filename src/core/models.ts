export type QuestionType = 'input' | 'choice' | 'multi_select';
export type AnswerResult = 'correct' | 'wrong' | 'revealed';
export type AnswerFormat = 'auto' | 'choice' | 'input';
export type StudyFilter = 'all' | 'wrong' | 'bookmarked';

export type ConcreteStudyQuestionMode = 'as_stored' | 'front_to_back' | 'back_to_front';
export type StudyQuestionMode = ConcreteStudyQuestionMode | 'mixed';

export interface StudySide {
  label: string;
  text: string;
  acceptableAnswers?: string[];
}

export interface TwoSidedStudyData {
  front: StudySide;
  back: StudySide;
}

export type AnswerJudgingMode = 'single' | 'any_of' | 'all_of' | 'exact_phrase' | 'numeric';

export interface AnswerJudgingRule {
  mode?: AnswerJudgingMode;
  caseSensitive?: boolean;
  ignoreSpaces?: boolean;
  ignorePunctuation?: boolean;
  allowJapaneseSentenceEdges?: boolean;
  requiresAll?: boolean;
  requiredParts?: string[];
}

export interface ManualChoiceCandidates {
  mode: 'manual';
  choices: string[];
  distractors?: string[];
  reason?: string;
}

export interface SideChoiceCandidates {
  front_to_back?: ManualChoiceCandidates;
  back_to_front?: ManualChoiceCandidates;
}

export type ReviewState = 'new' | 'learning' | 'review' | 'relearning' | 'leech' | 'mastered' | 'suspended';
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

export interface FolderInfo {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
}

export interface ModuleInfo {
  id: string;
  folderId: string;
  title: string;
  subject: string;
  subtitle?: string;
  preferredAnswerFormat?: AnswerFormat;
  color?: string;
  accent?: string;
  accentColor?: string;
  description?: string;
  tags?: string[];
  questionIds: string[];
}

interface VisualReferenceBase {
  label: string;
  color: string;
  shape?: 'rectangle' | 'circle';
}

interface PatternReferenceBase extends VisualReferenceBase {
  backgroundColor?: string;
  /** Pattern repeat distance in CSS pixels. */
  spacing?: number;
}

export type VisualReference =
  | (VisualReferenceBase & { type: 'color' })
  | (PatternReferenceBase & { type: 'stripe' | 'grid' | 'crosshatch'; angle?: number; lineWidth?: number })
  | (PatternReferenceBase & { type: 'dots'; lineWidth?: number })
  | (PatternReferenceBase & { type: 'checker' });

export interface BaseQuestion {
  id: string;
  moduleId: string;
  type: QuestionType;
  prompt: string;
  explanation?: string;
  imageAsset?: string;
  visualReferences?: VisualReference[];
  category?: string;
  number?: number;
  example?: string;
  sides?: TwoSidedStudyData;
  supportedStudyModes?: Array<'front_to_back' | 'back_to_front'>;
  activeStudyMode?: ConcreteStudyQuestionMode;
  autoReversed?: boolean;
  directionLabel?: string;
}

export interface InputQuestion extends BaseQuestion {
  type: 'input';
  answer: string;
  acceptableAnswers?: string[];
  acceptedAnswers?: string[];
  answerJudging?: AnswerJudgingRule;
  choiceCandidates?: ManualChoiceCandidates;
  sideChoiceCandidates?: SideChoiceCandidates;
  direction?: 'ja_to_en' | 'en_to_ja' | 'normal';
}

export interface ChoiceQuestion extends BaseQuestion {
  type: 'choice';
  choices: string[];
  answer: string;
  acceptableAnswers?: string[];
  acceptedAnswers?: string[];
  answerJudging?: AnswerJudgingRule;
  choiceCandidates?: ManualChoiceCandidates;
  sideChoiceCandidates?: SideChoiceCandidates;
}

export interface MultiSelectQuestion extends BaseQuestion {
  type: 'multi_select';
  choices: string[];
  correctChoices: string[];
}

export type Question = InputQuestion | ChoiceQuestion | MultiSelectQuestion;

export interface LoopDeckPack {
  packVersion: number;
  packId: string;
  title: string;
  description?: string;
  folders: FolderInfo[];
  modules: ModuleInfo[];
  questions: Question[];
}

export interface Attempt {
  attemptId: string;
  questionId: string;
  moduleId: string;
  answeredAt: string;
  result: AnswerResult;
  input: string | string[];
  answer: string | string[];
  elapsedMs: number;
  mode: 'normal' | 'review';
  nearMiss?: boolean;
  contentRetired?: boolean;
  hiddenTimeExcludedMs?: number;
  priorityDelta?: number;
  answerMode?: AnswerFormat;
  questionMode?: ConcreteStudyQuestionMode;
}

export interface QuizAnswerSource {
  packId: string;
  question: Question;
  packRevision?: string;
  resetEpoch?: string;
  imageDataUrl?: string | null;
}

export interface ReviewCard {
  questionId: string;
  questionMode?: ConcreteStudyQuestionMode;
  moduleId: string;
  state: ReviewState;
  dueAt: string | null;
  lastReviewedAt: string | null;
  firstReviewedAt: string | null;
  intervalDays: number;
  ease: number;
  totalReviews: number;
  totalCorrect: number;
  totalWrong: number;
  correctStreak: number;
  wrongStreak: number;
  lapseCount: number;
  leechLevel: number;
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewLog {
  reviewLogId: string;
  questionMode?: ConcreteStudyQuestionMode;
  questionId: string;
  moduleId: string;
  reviewedAt: string;
  rating: ReviewRating;
  result: AnswerResult;
  previousState: ReviewState;
  nextState: ReviewState;
  previousDueAt: string | null;
  nextDueAt: string | null;
  previousIntervalDays: number;
  nextIntervalDays: number;
  previousEase: number;
  nextEase: number;
  elapsedMs: number;
  attemptId?: string;
}

export interface StudySettings {
  shuffle: boolean;
  autoNext: boolean;
  autoRevealAfterIdle?: boolean;
  questionLimit: number | 'all';
  selectedRange?: string;
  selectedCategory?: string;
  filter?: StudyFilter;
  answerFormat?: AnswerFormat;
  questionMode?: StudyQuestionMode;
  showExample?: boolean;
  showNumber?: boolean;
  showCategory?: boolean;
}
