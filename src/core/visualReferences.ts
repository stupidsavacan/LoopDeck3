import type { VisualReference } from './models';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const TYPES = new Set(['color', 'stripe', 'grid', 'crosshatch', 'dots', 'checker']);
const LINE_TYPES = new Set(['stripe', 'grid', 'crosshatch']);

/** Shared by pack import and rendering; only literal colors and bounded numbers reach CSS. */
export function parseVisualReferences(value: unknown, path = 'visualReferences'): { references?: VisualReference[]; errors: string[] } {
  const errors: string[] = [];
  if (value === undefined) return { errors };
  if (!Array.isArray(value) || value.length > 16) return { errors: [`${path} must be an array of at most 16 references.`] };
  const references: VisualReference[] = [];
  value.forEach((raw: unknown, index) => {
    const location = `${path}[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${location} must be an object.`);
      return;
    }
    const item = raw as Record<string, unknown>;
    const before = errors.length;
    const type = item.type;
    if (typeof type !== 'string' || !TYPES.has(type)) {
      errors.push(`${location}.type is unsupported.`);
      return;
    }
    const allowed = new Set(['type', 'label', 'color', 'shape']);
    if (type !== 'color') ['backgroundColor', 'spacing'].forEach((key) => allowed.add(key));
    if (LINE_TYPES.has(type)) allowed.add('angle');
    if (LINE_TYPES.has(type) || type === 'dots') allowed.add('lineWidth');
    for (const key of Object.keys(item)) if (!allowed.has(key)) errors.push(`${location}.${key} is unsupported.`);
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 500)
      errors.push(`${location}.label must be non-empty plain text of at most 500 characters.`);
    for (const key of ['color', 'backgroundColor']) {
      if (key === 'backgroundColor' && item[key] === undefined) continue;
      if (typeof item[key] !== 'string' || !HEX_COLOR.test(item[key]))
        errors.push(`${location}.${key} must use a six-digit hex color such as #EDB0AA.`);
    }
    if (item.shape !== undefined && item.shape !== 'rectangle' && item.shape !== 'circle')
      errors.push(`${location}.shape must be rectangle or circle.`);
    for (const [key, min, max] of [
      ['spacing', 4, 64],
      ['lineWidth', 1, 32],
      ['angle', 0, 180]
    ] as const) {
      const number = item[key];
      if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max))
        errors.push(`${location}.${key} must be a finite number between ${min} and ${max}.`);
    }
    const spacing = typeof item.spacing === 'number' ? item.spacing : 12;
    const lineWidth = typeof item.lineWidth === 'number' ? item.lineWidth : 2;
    if ((LINE_TYPES.has(type) || type === 'dots') && lineWidth >= spacing)
      errors.push(`${location}.lineWidth must be smaller than spacing.`);
    if (errors.length === before)
      references.push({ ...item, type, label: item.label as string, color: item.color as string } as VisualReference);
  });
  return { references, errors };
}
