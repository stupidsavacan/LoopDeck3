export interface NativeSaveResult {
  id: string;
  ok: boolean;
  code: string;
  message: string;
  bytes?: number;
}

export interface NativeSaveProgress {
  phase: 'begin' | 'chunk' | 'picker' | 'complete';
  saveId: string;
  chunkIndex?: number;
  chunkCount?: number;
  bytes?: number;
}

interface LoopDeck3HostBridge {
  beginSaveFile(saveId: string, filename: string, mimeType: string, expectedBytes: number, expectedChunks: number): boolean;
  appendSaveFileChunk(saveId: string, chunkIndex: number, base64Chunk: string): boolean;
  finishSaveFile(saveId: string): boolean;
  cancelSaveFile(saveId: string): void;
}

declare global {
  interface Window {
    LoopDeck3Host?: LoopDeck3HostBridge;
  }
}

const ANDROID_SAVE_RAW_CHUNK_SIZE = 48 * 1024;
const NATIVE_SAVE_TIMEOUT_MS = 120_000;
const MAX_NATIVE_SAVE_BYTES = 256 * 1024 * 1024;

function exportError(code: string, message: string, cause?: unknown): Error {
  const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  return new Error(`[${code}] ${message}${causeText ? ` / ${causeText}` : ''}`);
}

function blobChunkToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      if (!base64) reject(exportError('SAV-B002', '保存データのbase64化結果が空です。'));
      else resolve(base64);
    };
    reader.onerror = () => reject(exportError('SAV-B001', '保存データをbase64へ変換できません。', reader.error));
    reader.readAsDataURL(blob);
  });
}

function createNativeSaveWaiter(
  saveId: string,
  timeoutMs = NATIVE_SAVE_TIMEOUT_MS
): {
  promise: Promise<NativeSaveResult>;
  cancel: () => void;
} {
  let timeoutId = 0;
  let handler: (event: Event) => void = () => undefined;
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    window.removeEventListener('loopdeck3-save-result', handler);
    window.clearTimeout(timeoutId);
  };

  const promise = new Promise<NativeSaveResult>((resolve, reject) => {
    handler = (event: Event) => {
      const detail = (event as CustomEvent<NativeSaveResult>).detail;
      if (!detail || detail.id !== saveId) return;
      cleanup();
      if (detail.ok) resolve(detail);
      else reject(exportError(detail.code || 'SAV-E999', detail.message || 'Android保存に失敗しました。'));
    };
    window.addEventListener('loopdeck3-save-result', handler);
    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(exportError('SAV-A032', 'Android保存結果を受信できませんでした。もう一度お試しください。'));
    }, timeoutMs);
  });

  return { promise, cancel: cleanup };
}

export function waitForNativeSave(saveId: string, timeoutMs = NATIVE_SAVE_TIMEOUT_MS): Promise<NativeSaveResult> {
  return createNativeSaveWaiter(saveId, timeoutMs).promise;
}

function downloadBlobInBrowser(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function nativeBridge(): LoopDeck3HostBridge | undefined {
  const bridge = window.LoopDeck3Host;
  if (!bridge) return undefined;
  if (typeof bridge.beginSaveFile !== 'function') return undefined;
  if (typeof bridge.appendSaveFileChunk !== 'function') return undefined;
  if (typeof bridge.finishSaveFile !== 'function') return undefined;
  if (typeof bridge.cancelSaveFile !== 'function') return undefined;
  return bridge;
}

export interface SaveBlobOptions {
  onNativeProgress?: (progress: NativeSaveProgress) => void;
}

export interface SaveBlobResult {
  mode: 'native' | 'browser';
  nativeResult?: NativeSaveResult;
}

export async function saveBlob(blob: Blob, filename: string, options: SaveBlobOptions = {}): Promise<SaveBlobResult> {
  const bridge = nativeBridge();
  if (!bridge) {
    downloadBlobInBrowser(blob, filename);
    return { mode: 'browser' };
  }

  if (blob.size <= 0) throw exportError('SAV-V001', '保存データのサイズが0Bです。');
  if (blob.size > MAX_NATIVE_SAVE_BYTES) {
    throw exportError('SAV-V002', `Android保存の上限 ${MAX_NATIVE_SAVE_BYTES.toLocaleString()} bytes を超えています。`);
  }

  const chunkCount = Math.ceil(blob.size / ANDROID_SAVE_RAW_CHUNK_SIZE);
  const saveId = `loopdeck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mimeType = blob.type || 'application/octet-stream';
  const waiter = createNativeSaveWaiter(saveId);
  let sessionStarted = false;

  try {
    options.onNativeProgress?.({ phase: 'begin', saveId, chunkCount, bytes: blob.size });
    if (!bridge.beginSaveFile(saveId, filename, mimeType, blob.size, chunkCount)) {
      throw exportError('SAV-A011', 'Android保存セッションの開始に失敗しました。');
    }
    sessionStarted = true;

    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * ANDROID_SAVE_RAW_CHUNK_SIZE;
      const chunk = blob.slice(start, Math.min(blob.size, start + ANDROID_SAVE_RAW_CHUNK_SIZE));
      const base64Chunk = await blobChunkToBase64(chunk);
      if (!bridge.appendSaveFileChunk(saveId, index, base64Chunk)) {
        throw exportError('SAV-A012', `Android保存チャンク送信に失敗しました。chunk=${index + 1}/${chunkCount}`);
      }
      options.onNativeProgress?.({
        phase: 'chunk',
        saveId,
        chunkIndex: index + 1,
        chunkCount,
        bytes: Math.min(blob.size, start + chunk.size)
      });
    }

    options.onNativeProgress?.({ phase: 'picker', saveId, chunkCount, bytes: blob.size });
    if (!bridge.finishSaveFile(saveId)) throw exportError('SAV-A031', 'Android保存処理の開始に失敗しました。');
    sessionStarted = false;

    const nativeResult = await waiter.promise;
    options.onNativeProgress?.({ phase: 'complete', saveId, chunkCount, bytes: nativeResult.bytes ?? blob.size });
    return { mode: 'native', nativeResult };
  } catch (error) {
    waiter.cancel();
    if (sessionStarted) {
      try {
        bridge.cancelSaveFile(saveId);
      } catch {
        // Native idle cleanup remains the final safety net.
      }
    }
    throw error;
  }
}
