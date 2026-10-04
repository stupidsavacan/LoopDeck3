export function readContentEpoch(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('value' in value)) return '0';
  return typeof value.value === 'string' && value.value ? value.value : '0';
}

/** Invalidate every pre-restore quiz, including unchanged built-in questions. */
export function writeNewContentEpoch(transaction: IDBTransaction): void {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`;
  transaction.objectStore('contentMetadata').put({ key: 'contentEpoch', value });
}
