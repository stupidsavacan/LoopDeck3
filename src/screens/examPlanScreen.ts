import type { ScreenContext } from '../app/context';
import { localCalendarDayKey } from '../core/calendarDay';
import { buildExamPlan, examFolders, type ExamDay, type ExamPlan } from '../core/examPlan';
import { indexCardsByQuestion } from '../core/mastery';
import { activeReviewCards } from '../core/todayPlan';
import { getActiveModules, getActiveQuestions } from '../packs/packResolver';
import { isValidExamDate, readExamSetting, writeExamSetting, type ExamSetting } from '../storage/examPlans';
import { button, clear, el, toast } from '../ui/dom';
import { appendIconLabel } from '../ui/icons';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function dateLabel(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return `${month}月${day}日（${WEEKDAYS[date.getDay()]}）`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function renderSchedule(days: ExamDay[]): HTMLElement {
  const strip = el('ol', 'exam-schedule');
  strip.setAttribute('aria-label', '試験までの割り振り');
  for (const [index, day] of days.entries()) {
    const [, month, date] = day.date.split('-').map(Number);
    const item = el('li', `exam-day is-${day.kind}`);
    const label = index === 0 ? '今日' : day.kind === 'exam' ? '本番' : `${month}/${date}`;
    const value = day.kind === 'study' ? `${day.count}問` : day.kind === 'rest' ? '休み' : day.kind === 'review' ? '総復習' : '試験';
    item.append(el('span', 'exam-day-label', label), el('strong', 'exam-day-value', value));
    strip.append(item);
  }
  return strip;
}

function renderReadiness(plan: ExamPlan): HTMLElement {
  const card = el('section', 'card exam-readiness');
  card.append(el('h2', '', '教材ごとの仕上がり'));
  const list = el('div', 'exam-readiness-list');
  for (const item of plan.readiness) {
    const row = el('div', 'exam-readiness-row');
    const head = el('div', 'exam-readiness-head');
    head.append(
      el('span', 'exam-readiness-title', item.module.title),
      el('span', item.onTrack ? 'exam-tag on-track' : 'exam-tag behind', item.onTrack ? '間に合う' : 'ペース不足')
    );
    const bar = el('div', 'exam-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${item.module.title} 仕上がり ${percent(item.ratio)}、目標 ${percent(plan.goal)}`);
    const fill = el('span', 'exam-bar-fill');
    fill.style.width = percent(item.ratio);
    const goal = el('span', 'exam-bar-goal');
    goal.style.left = percent(plan.goal);
    bar.append(fill, goal);
    row.append(head, bar, el('span', 'exam-readiness-meta', `${percent(item.ratio)} · 残り ${item.remaining}問`));
    list.append(row);
  }
  card.append(list, el('p', 'hint', '縦の線は今日の時点の目標です。設定した日から試験日まで、同じペースで進めた場合の位置を示します。'));
  return card;
}

export async function renderExamPlanScreen(context: ScreenContext & { folderId: string }): Promise<void> {
  const { store, root, catalog, isCurrent, navigation, folderId } = context;
  if (!isCurrent()) return;
  const cards = await store.getReviewCards();
  if (!isCurrent()) return;

  const questions = getActiveQuestions(catalog);
  const modules = getActiveModules(catalog).filter((module) => module.questionIds.length > 0);
  const folder = examFolders(catalog.packs, modules).find((item) => item.id === folderId);
  const cardsByQuestion = indexCardsByQuestion(activeReviewCards(cards, new Map(questions.map((question) => [question.id, question]))));

  clear(root);
  const screen = el('main', 'screen exam-screen');
  const header = el('header', 'topbar');
  const back = button('', 'btn ghost');
  appendIconLabel(back, 'arrowLeft', 'ホーム');
  back.onclick = navigation.home;
  header.append(back);
  screen.append(header);
  root.append(screen);

  if (!folder) {
    screen.append(el('p', 'empty', 'この教材のまとまりが見つかりません。'));
    return;
  }
  const examFolder = folder;
  const body = el('div', 'exam-body');
  screen.append(body);

  function save(setting: ExamSetting | undefined): void {
    if (!writeExamSetting(examFolder.id, setting)) toast('試験日を保存できませんでした。');
    render();
  }

  function renderForm(setting: ExamSetting | undefined): HTMLElement {
    const form = el('section', 'card exam-form');
    form.append(el('h2', '', '試験日の設定'));
    const field = el('label', 'exam-date-field');
    field.htmlFor = 'exam-date-input';
    field.append(el('span', '', '試験日'));
    const input = el('input', 'exam-date-input') as HTMLInputElement;
    input.type = 'date';
    input.id = 'exam-date-input';
    // Required makes an empty field :invalid, so CSS can swap the browser's 「yyyy/mm/dd ()」 for a plain prompt.
    input.required = true;
    input.min = localCalendarDayKey(new Date());
    input.value = setting?.date ?? '';
    input.onchange = () => {
      if (!input.value) return;
      if (!isValidExamDate(input.value)) {
        toast('日付を確認してください。');
        return;
      }
      save({ date: input.value, setAt: setting?.setAt ?? new Date().toISOString(), restWeekdays: setting?.restWeekdays ?? [] });
    };
    const fieldRow = el('div', 'exam-date-row');
    fieldRow.append(field, input);
    form.append(fieldRow);

    if (setting) {
      const rest = el('fieldset', 'exam-rest');
      rest.append(el('legend', '', '新しい問題を出さない曜日'));
      const days = el('div', 'exam-rest-days');
      for (const [index, name] of WEEKDAYS.entries()) {
        const label = el('label', 'exam-rest-day');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.id = `exam-rest-${index}`;
        check.checked = setting.restWeekdays.includes(index);
        check.onchange = () => {
          const restWeekdays = check.checked ? [...setting.restWeekdays, index] : setting.restWeekdays.filter((day) => day !== index);
          if (restWeekdays.length >= 7) {
            toast('少なくとも1日は勉強する曜日を残してください。');
            check.checked = false;
            return;
          }
          save({ ...setting, restWeekdays });
        };
        label.append(check, el('span', '', name));
        days.append(label);
      }
      rest.append(days);
      const remove = button('試験日を消す', 'btn ghost danger');
      remove.onclick = () => save(undefined);
      form.append(rest, remove);
    }
    form.append(el('p', 'hint', '試験日はこの端末だけに保存されます。バックアップやクラウド同期には含まれません。'));
    return form;
  }

  function render(): void {
    if (!isCurrent()) return;
    const setting = readExamSetting(examFolder.id);
    const title = el('section', 'exam-title');
    title.append(el('h1', '', examFolder.title));
    const parts: HTMLElement[] = [title];

    if (setting) {
      const plan = buildExamPlan(examFolder, setting, cardsByQuestion);
      const hero = el('section', 'exam-hero');
      const count = el('p', 'exam-countdown');
      if (plan.daysLeft < 0) count.append(el('strong', '', '終了'));
      else if (plan.daysLeft === 0) count.append(el('strong', '', '今日'));
      else count.append(el('span', '', 'あと'), el('strong', '', String(plan.daysLeft)), el('span', '', '日'));
      const summary =
        plan.daysLeft < 0
          ? 'この試験日は過ぎています。次の試験日を設定し直してください。'
          : plan.remaining === 0
            ? 'すべての問題が定着しています。今日のループで復習を続けましょう。'
            : plan.dailyQuota === 0
              ? `新しい問題はもう割り振りません。残り${plan.remaining}問は今日のループの復習で仕上げます。`
              : plan.unplanned > 0
                ? `仕上がり ${percent(plan.overall)}。1日の上限 ${plan.dailyQuota}問 で割り振っても、${plan.unplanned}問 が試験までに回りきりません。休みの曜日を減らすか、優先する教材を先に進めてください。`
                : `仕上がり ${percent(plan.overall)}（目標 ${percent(plan.goal)}）。1日 ${plan.dailyQuota}問 のペースで、残り${plan.remaining}問を割り振っています。`;
      hero.append(el('p', 'exam-date', dateLabel(plan.examDate)), count, el('p', 'exam-summary', summary));
      parts.push(hero);
      if (plan.daysLeft >= 0) {
        parts.push(renderReadiness(plan));
        const schedule = el('section', 'card exam-schedule-card');
        schedule.append(el('h2', '', 'これからの割り振り'), renderSchedule(plan.schedule.slice(0, 15)));
        if (plan.schedule.length > 15) schedule.append(el('p', 'hint', `ほか${plan.schedule.length - 15}日分`));
        parts.push(schedule);
      }
      if (plan.daysLeft >= 0 && plan.dailyQuota > 0) {
        const start = button('', 'today-start exam-start');
        appendIconLabel(start, 'arrowRight', `今日の ${plan.dailyQuota}問 を始める`, 'end');
        start.onclick = navigation.today;
        parts.push(start);
      }
    } else {
      parts.push(el('p', 'exam-intro', '試験日を入れると、残りの日数から1日に解く問題数を割り振り、今日のループに入れます。'));
    }
    parts.push(renderForm(setting));
    body.replaceChildren(...parts);
  }

  render();
}
