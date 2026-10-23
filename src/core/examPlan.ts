import { localCalendarDayKey } from './calendarDay';
import { moduleMastery } from './mastery';
import type { LoopDeckPack, ModuleInfo, ReviewCard } from './models';

/** Keeps a single day's new questions to a size one sitting can finish. */
export const MAX_DAILY_QUOTA = 60;

export interface ExamSettingInput {
  date: string;
  setAt: string;
  restWeekdays: number[];
}

export interface ExamFolder {
  id: string;
  title: string;
  modules: ModuleInfo[];
}

export interface ExamModuleReadiness {
  module: ModuleInfo;
  /** 0–1 from {@link moduleMastery}. */
  ratio: number;
  /** Questions not yet solid. */
  remaining: number;
  onTrack: boolean;
}

export type ExamDayKind = 'study' | 'rest' | 'review' | 'exam';

export interface ExamDay {
  date: string;
  kind: ExamDayKind;
  /** Planned questions; 0 on rest, review and exam days. */
  count: number;
}

export interface ExamPlan {
  folder: ExamFolder;
  examDate: string;
  /** Calendar days from today until the exam day; 0 means the exam is today, negative means it is over. */
  daysLeft: number;
  readiness: ExamModuleReadiness[];
  /** 0–1 across all questions of the folder. */
  overall: number;
  /** 0–1: where readiness should be today if progress were even since the date was set. */
  goal: number;
  /** New or unfinished questions per remaining study day. */
  dailyQuota: number;
  remaining: number;
  /** Questions that do not fit even at {@link MAX_DAILY_QUOTA} per study day. */
  unplanned: number;
  schedule: ExamDay[];
  /** The least ready module that still has questions to study; today's new questions come from it. */
  focusModuleId?: string;
}

const DAY_MS = 86_400_000;

function localDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function dayDiff(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

/** Home folders as exam targets: a folder's modules are the ones that name it. */
export function examFolders(packs: readonly LoopDeckPack[], modules: readonly ModuleInfo[]): ExamFolder[] {
  const titles = new Map<string, string>();
  for (const pack of packs) for (const folder of pack.folders ?? []) if (folder.id) titles.set(folder.id, folder.title || folder.id);
  const byFolder = new Map<string, ModuleInfo[]>();
  for (const module of modules) {
    if (!module.folderId || !titles.has(module.folderId)) continue;
    byFolder.set(module.folderId, [...(byFolder.get(module.folderId) ?? []), module]);
  }
  return [...byFolder].map(([id, folderModules]) => ({ id, title: titles.get(id) ?? id, modules: folderModules }));
}

export function buildExamPlan(
  folder: ExamFolder,
  setting: ExamSettingInput,
  cardsByQuestion: ReadonlyMap<string, ReviewCard[]>,
  now = new Date()
): ExamPlan {
  const exam = localDate(setting.date);
  const daysLeft = dayDiff(now, exam);
  const setAt = new Date(setting.setAt);
  const span = Math.max(1, dayDiff(setAt, exam));
  const goal = Math.min(1, Math.max(0, dayDiff(setAt, now) / span));

  let solidWeighted = 0;
  let total = 0;
  let remaining = 0;
  const readiness = folder.modules.map((module) => {
    const mastery = moduleMastery(module, cardsByQuestion);
    const moduleRemaining = mastery.total - mastery.counts.solid;
    solidWeighted += mastery.ratio * mastery.total;
    total += mastery.total;
    remaining += moduleRemaining;
    return { module, ratio: mastery.ratio, remaining: moduleRemaining, onTrack: mastery.ratio >= goal };
  });

  // Today up to two days before the exam are study days; the day before is for review only.
  const schedule: ExamDay[] = [];
  for (let offset = 0; offset <= Math.max(0, daysLeft); offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const kind: ExamDayKind =
      offset === daysLeft ? 'exam' : offset === daysLeft - 1 ? 'review' : setting.restWeekdays.includes(date.getDay()) ? 'rest' : 'study';
    schedule.push({ date: localCalendarDayKey(date), kind, count: 0 });
  }
  const studyDays = schedule.filter((day) => day.kind === 'study');
  // With no study day left (exam tomorrow or today) nothing new is planned; reviews still come through today's loop.
  const dailyQuota = studyDays.length === 0 || remaining === 0 ? 0 : Math.min(MAX_DAILY_QUOTA, Math.ceil(remaining / studyDays.length));
  let left = remaining;
  for (const day of studyDays) {
    day.count = Math.min(dailyQuota, left);
    left -= day.count;
  }

  // When even the daily cap cannot fit everything, no module with unfinished questions is on track.
  if (left > 0) for (const item of readiness) if (item.remaining > 0) item.onTrack = false;
  const focus = readiness.filter((item) => item.remaining > 0).sort((a, b) => a.ratio - b.ratio)[0];
  return {
    folder,
    examDate: setting.date,
    daysLeft,
    readiness,
    overall: total ? solidWeighted / total : 0,
    goal,
    dailyQuota,
    remaining,
    unplanned: left,
    schedule,
    focusModuleId: focus?.module.id
  };
}

/** The closest exam that is today or later, if any folder has one. */
export function nearestExamPlan(
  folders: readonly ExamFolder[],
  settings: Readonly<Record<string, ExamSettingInput>>,
  cardsByQuestion: ReadonlyMap<string, ReviewCard[]>,
  now = new Date()
): ExamPlan | undefined {
  return folders
    .flatMap((folder) => (settings[folder.id] ? [buildExamPlan(folder, settings[folder.id], cardsByQuestion, now)] : []))
    .filter((plan) => plan.daysLeft >= 0)
    .sort((a, b) => a.daysLeft - b.daysLeft)[0];
}

/** How the nearest exam shapes today's loop: its daily quota from its least ready module. */
export function examLoopOptions(plan: ExamPlan | undefined): { focusModuleId?: string; freshCount?: number } {
  if (!plan) return {};
  if (plan.dailyQuota > 0) return { focusModuleId: plan.focusModuleId, freshCount: plan.dailyQuota };
  // The exam is tomorrow or today: keep the loop to reviews instead of starting new material.
  if (plan.remaining > 0) return { freshCount: 0 };
  return {};
}

/** Short label such as 「一学期中間テストまで 9日」 or 「…は今日」. */
export function examCountdownLabel(plan: Pick<ExamPlan, 'daysLeft' | 'folder'>): string {
  return plan.daysLeft === 0 ? `${plan.folder.title}は今日` : `${plan.folder.title}まで ${plan.daysLeft}日`;
}
