import type { WeeklyRecap } from '../core/weeklyRecap';
import { saveBlob } from '../platform/fileSave';
import { button, el, toast } from './dom';

type Theme = 'ink' | 'blue' | 'lime' | 'orange';

interface StorySlide {
  kicker: string;
  big: string;
  unit?: string;
  line: string;
  theme: Theme;
  showWeek?: boolean;
}

const THEMES: Record<Theme, { background: string; text: string; muted: string }> = {
  ink: { background: '#0a1020', text: '#ffffff', muted: '#c9cfdc' },
  blue: { background: '#2148e0', text: '#ffffff', muted: '#e6ecff' },
  lime: { background: '#c7ff55', text: '#0a1020', muted: '#2d3a00' },
  orange: { background: '#c2410c', text: '#ffffff', muted: '#ffe4d1' }
};
const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];

function shorten(text: string, length = 18): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** 「2026-10-19」 reads like a database field; 「10月19日からの週」 reads like a calendar. */
function weekLabel(weekStart: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
  return match ? `${Number(match[2])}月${Number(match[3])}日からの週` : `${weekStart} の週`;
}

export function weeklySlides(recap: WeeklyRecap, periodLabel: string): StorySlide[] {
  if (recap.answered === 0) {
    return [{ kicker: periodLabel, big: '0', unit: '問', line: 'この週の学習記録はまだありません。', theme: 'ink', showWeek: true }];
  }
  const diff = recap.answered - recap.previousAnswered;
  const slides: StorySlide[] = [
    { kicker: periodLabel, big: String(recap.studyDays), unit: '日', line: '学習した日', theme: 'ink', showWeek: true },
    {
      kicker: '解いた問題',
      big: String(recap.answered),
      unit: '問',
      line: recap.previousAnswered === 0 ? '前の週は記録なし' : `前の週より ${diff >= 0 ? '+' : ''}${diff}問`,
      theme: 'blue'
    }
  ];
  if (recap.topModule?.kind === 'gain') {
    slides.push({
      kicker: '一番伸びた教材',
      big: `+${Math.round(recap.topModule.gain * 100)}`,
      unit: '%',
      line: `${recap.topModule.title}の正答率`,
      theme: 'lime'
    });
  } else if (recap.topModule) {
    slides.push({
      kicker: '一番解いた教材',
      big: String(recap.topModule.answered),
      unit: '問',
      line: recap.topModule.title,
      theme: 'lime'
    });
  }
  if (recap.defeatedPairs.length) {
    const [a, b] = recap.defeatedPairs[0];
    slides.push({
      kicker: '克服した取り違え',
      big: String(recap.defeatedPairs.length),
      unit: '組',
      line: `「${shorten(a)}」と「${shorten(b)}」をもう間違えなくなりました。`,
      theme: 'orange'
    });
  }
  return slides;
}

function wrapLines(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const char of text) {
    if (context.measureText(line + char).width > width && line) {
      lines.push(line);
      line = char;
    } else line += char;
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws one slide as a 1080×1350 image for sharing. */
async function slideImage(slide: StorySlide, recap: WeeklyRecap): Promise<Blob | undefined> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  const theme = THEMES[slide.theme];
  const font = (weight: number, size: number) => `${weight} ${size}px "Noto Sans JP", "Hiragino Sans", sans-serif`;
  context.fillStyle = theme.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = theme.muted;
  context.font = font(800, 40);
  context.fillText(`LOOPDECK · ${weekLabel(recap.weekStart)}`, 96, 150);
  context.font = font(800, 56);
  context.fillText(slide.kicker, 96, 330);
  context.fillStyle = theme.text;
  context.font = font(900, 300);
  context.fillText(slide.big, 90, 640);
  const bigWidth = context.measureText(slide.big).width;
  if (slide.unit) {
    context.font = font(900, 96);
    context.fillText(slide.unit, 110 + bigWidth, 640);
  }
  context.font = font(900, 64);
  wrapLines(context, slide.line, 888).forEach((line, index) => context.fillText(line, 96, 800 + index * 88));
  if (slide.showWeek) {
    recap.days.forEach((day, index) => {
      context.fillStyle = day.studied ? '#c7ff55' : 'rgba(255, 255, 255, 0.16)';
      context.fillRect(96 + index * 130, 1080, 108, 108);
      context.fillStyle = theme.muted;
      context.font = font(800, 36);
      context.fillText(WEEKDAYS[index], 132 + index * 130, 1250);
    });
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/png'));
}

/** A full-screen story of a week's study. Tap or "次へ" moves through the cards. */
export function openWeeklyStory(recap: WeeklyRecap, periodLabel: string, onClose?: () => void): HTMLDialogElement {
  const slides = weeklySlides(recap, periodLabel);
  let index = 0;
  const dialog = el('dialog', 'weekly-story') as HTMLDialogElement;
  dialog.setAttribute('aria-label', periodLabel);
  const bars = el('div', 'weekly-bars');
  const stage = el('button', 'weekly-stage') as HTMLButtonElement;
  stage.type = 'button';
  stage.setAttribute('aria-label', '次のカードへ');
  const footer = el('div', 'weekly-footer');
  const close = button('閉じる', 'weekly-close');
  const save = button('画像で保存', 'weekly-save');
  const next = button('次へ', 'weekly-next');
  footer.append(close, save, next);
  dialog.append(bars, stage, footer);

  function render(): void {
    const slide = slides[index];
    dialog.dataset.theme = slide.theme;
    bars.replaceChildren(...slides.map((_, position) => el('span', position <= index ? 'weekly-bar is-seen' : 'weekly-bar')));
    const big = el('strong', 'weekly-big', slide.big);
    if (slide.unit) big.append(el('small', '', slide.unit));
    const children: HTMLElement[] = [
      el('span', 'weekly-period', weekLabel(recap.weekStart)),
      el('span', 'weekly-kicker', slide.kicker),
      big,
      el('span', 'weekly-line', slide.line)
    ];
    if (slide.showWeek) {
      const week = el('span', 'weekly-days');
      recap.days.forEach((day, position) => {
        const cell = el('span', day.studied ? 'weekly-day is-studied' : 'weekly-day');
        cell.append(el('span', 'weekly-day-mark'), el('span', 'weekly-day-name', WEEKDAYS[position]));
        week.append(cell);
      });
      children.push(week);
    }
    stage.replaceChildren(...children);
    next.textContent = index + 1 < slides.length ? '次へ' : '最初から';
  }

  const advance = () => {
    index = (index + 1) % slides.length;
    render();
  };
  const finish = () => {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    dialog.remove();
    onClose?.();
  };
  stage.onclick = advance;
  next.onclick = advance;
  close.onclick = finish;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    finish();
  });
  save.onclick = async () => {
    save.disabled = true;
    try {
      const blob = await slideImage(slides[index], recap);
      if (!blob) {
        toast('この環境では画像を作れませんでした。');
        return;
      }
      await saveBlob(blob, `loopdeck-week-${recap.weekStart}-${index + 1}.png`);
    } catch (error) {
      toast(error instanceof Error ? error.message : '画像を保存できませんでした。');
    } finally {
      save.disabled = false;
    }
  };

  render();
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  return dialog;
}
