const CHANNEL = 'loopdeck3.catalog-changes';
const LOCAL_EVENT = 'loopdeck3-catalog-change';

/** Scope notifications to the injected database, after its write has committed. */
export function notifyPackChanges(database: string): void {
  const message = JSON.stringify({ database, revision: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}` });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: message }));
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage(message);
      channel.close();
    }
  } catch {
    /* Browser storage remains an independent notification path. */
  }
  try {
    localStorage.setItem(CHANNEL, message);
  } catch {
    /* Do not fail a committed write. */
  }
}

export function subscribePackChanges(database: string, onChange: () => void): () => void {
  let lastRevision = '';
  const receive = (message: unknown) => {
    if (typeof message !== 'string') return;
    try {
      const parsed: unknown = JSON.parse(message);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('database' in parsed) ||
        parsed.database !== database ||
        !('revision' in parsed) ||
        typeof parsed.revision !== 'string' ||
        parsed.revision === lastRevision
      )
        return;
      lastRevision = parsed.revision;
      onChange();
    } catch {
      /* Ignore malformed and unrelated messages. */
    }
  };
  const local = (event: Event) => receive((event as CustomEvent<unknown>).detail);
  const storage = (event: StorageEvent) => {
    if (event.key === CHANNEL) receive(event.newValue);
  };
  window.addEventListener(LOCAL_EVENT, local);
  window.addEventListener('storage', storage);
  let channel: BroadcastChannel | undefined;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => receive(event.data);
    }
  } catch {
    /* Same-window and storage notifications remain available. */
  }
  return () => {
    window.removeEventListener(LOCAL_EVENT, local);
    window.removeEventListener('storage', storage);
    channel?.close();
  };
}
