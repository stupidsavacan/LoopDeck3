/** Clear only study state; keep unrelated app preferences and other applications' keys. */
export function clearBrowserStudyState(packId?: string): boolean {
  try {
    const prefixes = ['loopdeck3.session.', 'loopdeck3.preferences.'];
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
      (key): key is string => key !== null
    );
    for (const key of keys) {
      const prefix = prefixes.find((value) => key.startsWith(value));
      if (packId === undefined) {
        if (prefix) localStorage.removeItem(key);
      } else if (prefix) {
        try {
          const identity: unknown = JSON.parse(key.slice(prefix.length));
          if (Array.isArray(identity) && identity.length === 2 && identity[0] === packId) localStorage.removeItem(key);
        } catch {
          // A malformed key has no trustworthy pack owner.
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
