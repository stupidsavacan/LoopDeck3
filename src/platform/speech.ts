/**
 * Read-aloud through the browser's speech synthesis. The Android app's WebView cannot
 * speak reliably, so inside it read-aloud is never offered; browsers offer it once
 * they report a voice.
 */

const JAPANESE = /[぀-ヿ㐀-鿿]/;

/** The Android app injects this bridge into its WebView; a phone browser never has it. */
function insideAndroidApp(): boolean {
  return typeof window !== 'undefined' && window.LoopDeck3Host !== undefined;
}

function synthesis(): SpeechSynthesis | undefined {
  try {
    if (insideAndroidApp()) return undefined;
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function'
      ? window.speechSynthesis
      : undefined;
  } catch {
    return undefined;
  }
}

export function speechLanguage(text: string): 'ja-JP' | 'en-US' {
  return JAPANESE.test(text) ? 'ja-JP' : 'en-US';
}

/**
 * Calls `ready` once voices exist, now or when the browser finishes loading them.
 * Returns a cancel function; a browser that never loads voices would otherwise keep every waiting caller alive.
 */
export function whenSpeechReady(ready: () => void): () => void {
  const speech = synthesis();
  if (!speech) return () => undefined;
  if (speech.getVoices().length > 0) {
    ready();
    return () => undefined;
  }
  const handle = () => {
    if (speech.getVoices().length === 0) return;
    speech.removeEventListener('voiceschanged', handle);
    ready();
  };
  speech.addEventListener('voiceschanged', handle);
  return () => speech.removeEventListener('voiceschanged', handle);
}

export function speak(text: string): boolean {
  const speech = synthesis();
  const value = text.trim();
  if (!speech || !value) return false;
  const lang = speechLanguage(value);
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.lang = lang;
  const voice = speech.getVoices().find((item) => item.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
  if (voice) utterance.voice = voice;
  speech.cancel();
  speech.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  synthesis()?.cancel();
}
