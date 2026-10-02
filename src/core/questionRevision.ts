import type { Question } from './models';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** Exact content identity; persisted checkpoints cannot silently resume changed material. */
export function questionRevision(question: Question): string {
  return JSON.stringify(canonical(question));
}
