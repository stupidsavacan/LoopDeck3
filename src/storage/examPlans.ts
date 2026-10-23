/**
 * Exam dates per home folder (a collection such as 一学期中間テスト).
 * Like study preferences they live in this browser only: not in backups and not synced.
 */
export const EXAM_PLANS_KEY = 'loopdeck3.exams.v1';

export interface ExamSetting {
  /** Local calendar date of the exam, YYYY-MM-DD. */
  date: string;
  /** When the date was set; the plan's target line starts here. */
  setAt: string;
  /** 0 = Sunday … 6 = Saturday; no new questions are planned on these weekdays. */
  restWeekdays: number[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidExamDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function validSetting(value: unknown): value is ExamSetting {
  if (!value || typeof value !== 'object') return false;
  const setting = value as Partial<ExamSetting>;
  return (
    typeof setting.date === 'string' &&
    isValidExamDate(setting.date) &&
    typeof setting.setAt === 'string' &&
    Number.isFinite(Date.parse(setting.setAt)) &&
    Array.isArray(setting.restWeekdays) &&
    setting.restWeekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  );
}

export function readExamSettings(): Record<string, ExamSetting> {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXAM_PLANS_KEY) ?? '{}') as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ExamSetting] => validSetting(entry[1])));
  } catch {
    return {};
  }
}

export function readExamSetting(folderId: string): ExamSetting | undefined {
  return readExamSettings()[folderId];
}

/** Saves or, with `undefined`, removes a folder's exam. Returns false when storage refuses. */
export function writeExamSetting(folderId: string, setting: ExamSetting | undefined): boolean {
  try {
    const all = readExamSettings();
    if (setting) all[folderId] = { ...setting, restWeekdays: [...new Set(setting.restWeekdays)].sort((a, b) => a - b) };
    else delete all[folderId];
    localStorage.setItem(EXAM_PLANS_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
