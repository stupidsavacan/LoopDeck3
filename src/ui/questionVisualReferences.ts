import type { Question, VisualReference } from '../core/models';
import { parseVisualReferences } from '../core/visualReferences';
import { el } from './dom';

function renderSwatch(reference: VisualReference): HTMLElement {
  const swatch = el('span', 'visual-reference-swatch');
  swatch.setAttribute('aria-hidden', 'true');
  swatch.dataset.type = reference.type;
  if (reference.shape === 'circle') swatch.classList.add('visual-reference-circle');
  if (reference.type === 'color') {
    swatch.style.backgroundColor = reference.color;
    return swatch;
  }
  const background = reference.backgroundColor ?? '#FFFFFF';
  const spacing = reference.spacing ?? 12;
  swatch.style.backgroundColor = background;
  if (reference.type === 'checker') {
    swatch.style.backgroundImage = `repeating-conic-gradient(${reference.color} 0% 25%, ${background} 25% 50%)`;
    swatch.style.backgroundSize = `${spacing * 2}px ${spacing * 2}px`;
  } else if (reference.type === 'dots') {
    const radius = (reference.lineWidth ?? 2) / 2;
    swatch.style.backgroundImage = `radial-gradient(circle, ${reference.color} ${radius}px, transparent ${radius}px)`;
    swatch.style.backgroundSize = `${spacing}px ${spacing}px`;
  } else {
    const lineWidth = reference.lineWidth ?? 2;
    const angle = reference.angle ?? (reference.type === 'crosshatch' ? 45 : 90);
    const line = (degrees: number) =>
      `repeating-linear-gradient(${degrees}deg, transparent 0px ${spacing - lineWidth}px, ${reference.color} ${spacing - lineWidth}px ${spacing}px)`;
    swatch.style.backgroundImage = reference.type === 'stripe' ? line(angle) : `${line(angle)}, ${line((angle + 90) % 180)}`;
  }
  return swatch;
}

export function renderQuestionVisualReferences(question: Question): HTMLElement | undefined {
  const parsed = parseVisualReferences(question.visualReferences);
  if (parsed.errors.length || !parsed.references?.length) return undefined;
  const panel = el('section', 'question-visual-references');
  panel.setAttribute('aria-label', 'この問題だけの参考色・参考模様');
  panel.append(el('h4', 'visual-reference-title', 'この問題だけの参考色・参考模様'));
  const list = el('ul', 'visual-reference-list');
  for (const reference of parsed.references) {
    const row = el('li', 'visual-reference-row');
    row.append(renderSwatch(reference), el('span', 'visual-reference-label', reference.label));
    list.append(row);
  }
  panel.append(list);
  return panel;
}
