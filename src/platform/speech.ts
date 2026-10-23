/**
 * Read-aloud through the browser's speech synthesis. Android WebView often
 * exposes the API without any voices; then nothing is offered at all.
 */

const JAPANESE = /[぀-ヿ㐀-鿿]/;

function synthesis(): SpeechSynthesis | undefined {
  try {
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

export function speechAvailable(): boolean {
  return (synthesis()?.getVoices().length ?? 0) > 0;
}

/** Calls `ready` once voices exist, now or when the browser finishes loading them. */
export function whenSpeechReady(ready: () => void): void {
  const speech = synthesis();
  if (!speech) return;
  if (speech.getVoices().length > 0) {
    ready();
    return;
  }
  speech.addEventListener('voiceschanged', function handle() {
    if (speech.getVoices().length === 0) return;
    speech.removeEventListener('voiceschanged', handle);
    ready();
  });
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
