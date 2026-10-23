import { button, el } from './dom';
import { appendIconLabel } from './icons';

export interface TodayHeroSummary {
  now: Date;
  streak: number;
  /** Answers already recorded today. */
  done: number;
  reviewCount: number;
  freshCount: number;
  focusTitle?: string;
  estimatedMinutes: number;
  /** A loop left midway today: position and length of the saved session. */
  resume?: { index: number; total: number };
  onStart(): void;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 46;

function dateLabel(now: Date, streak: number): string {
  const date = `${now.getMonth() + 1}月${now.getDate()}日（${WEEKDAYS[now.getDay()]}）`;
  return streak > 0 ? `${date} · 連続 ${streak}日` : date;
}

function ring(done: number, total: number, caption: string): HTMLElement {
  const wrap = el('div', 'today-ring');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', total > 0 ? `${caption} ${done}問、全${total}問` : '今日の問題はありません');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 108 108');
  svg.setAttribute('aria-hidden', 'true');
  const circumference = 2 * Math.PI * RING_RADIUS;
  const ratio = total > 0 ? Math.min(1, done / total) : 1;
  for (const [className, dash] of [
    ['today-ring-track', `${circumference} ${circumference}`],
    ['today-ring-fill', `${circumference * ratio} ${circumference}`]
  ] as const) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('class', className);
    circle.setAttribute('cx', '54');
    circle.setAttribute('cy', '54');
    circle.setAttribute('r', String(RING_RADIUS));
    circle.setAttribute('stroke-dasharray', dash);
    svg.append(circle);
  }
  const value = el('div', 'today-ring-value');
  const count = el('strong', '', String(done));
  count.append(el('small', '', `/${total}`));
  value.append(count, el('span', '', caption));
  wrap.append(svg, value);
  return wrap;
}

function planLine(summary: TodayHeroSummary): string {
  const parts: string[] = [];
  if (summary.reviewCount) parts.push(`復習 ${summary.reviewCount}問`);
  if (summary.freshCount) parts.push(`${summary.focusTitle ?? '新しい問題'}の新出 ${summary.freshCount}問`);
  return parts.join(' ＋ ');
}

/** The opening card while study data loads; it keeps the hero's height so the shelf does not jump. */
export function renderTodayHeroLoading(now = new Date()): HTMLElement {
  const hero = el('section', 'hero today-hero is-loading');
  hero.setAttribute('aria-busy', 'true');
  hero.append(
    el('p', 'today-date', dateLabel(now, 0)),
    el('h1', 'today-heading', '今日のループ'),
    el('p', 'today-plan', '今日の計画を作っています…')
  );
  return hero;
}

export function renderTodayHero(summary: TodayHeroSummary): HTMLElement {
  const hero = el('section', 'hero today-hero');
  const remaining = summary.resume ? summary.resume.total - summary.resume.index : summary.reviewCount + summary.freshCount;
  const total = summary.resume ? summary.resume.total : summary.done + remaining;
  const done = summary.resume ? summary.resume.index : summary.done;

  const body = el('div', 'today-hero-body');
  const copy = el('div', 'today-hero-copy');
  if (summary.resume) {
    copy.append(
      el('h1', 'today-heading', '続きから始めよう。'),
      el('p', 'today-plan', `今日のループ ${done}/${total}問まで進んでいます。`)
    );
  } else if (remaining > 0) {
    copy.append(
      el('h1', 'today-heading', '今日はこれだけ。'),
      el('p', 'today-plan', planLine(summary)),
      el('p', 'today-minutes', `目安 ${summary.estimatedMinutes}分`)
    );
  } else {
    copy.append(
      el('h1', 'today-heading', '今日の分は終わり。'),
      el(
        'p',
        'today-plan',
        summary.done ? 'お疲れさまでした。下の棚から好きな教材も選べます。' : '期限の来た復習も、新しい問題もありません。'
      )
    );
  }
  body.append(ring(done, total, summary.resume ? 'ループの進み' : '今日の回答'), copy);
  hero.append(el('p', 'today-date', dateLabel(summary.now, summary.streak)), body);

  if (remaining > 0) {
    const start = button('', 'today-start');
    appendIconLabel(start, 'arrowRight', summary.resume ? `続きから（${done + 1}/${total}）` : '今日のループを始める', 'end');
    start.onclick = summary.onStart;
    hero.append(start);
  }
  return hero;
}
