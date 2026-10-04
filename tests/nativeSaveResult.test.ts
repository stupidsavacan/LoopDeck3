// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBlob, waitForNativeSave } from '../src/platform/nativeFileSave';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.LoopDeck3Host;
});

describe('Android native save result waiting', () => {
  function controlledSave() {
    vi.useFakeTimers();
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:application/octet-stream;base64,YQ==';
        onload: (() => void) | undefined;
        readAsDataURL() {
          this.onload?.();
        }
      }
    );
    let saveId = '';
    let pickerOpened = false;
    const cancelSaveFile = vi.fn();
    window.LoopDeck3Host = {
      beginSaveFile(id) {
        saveId = id;
        return true;
      },
      appendSaveFileChunk() {
        return true;
      },
      finishSaveFile() {
        pickerOpened = true;
        return true;
      },
      cancelSaveFile
    };
    const finish = (ok = true) =>
      window.dispatchEvent(
        new CustomEvent('loopdeck3-save-result', {
          detail: { id: saveId, ok, code: ok ? 'SAV-OK' : 'SAV-A004', message: 'done', bytes: 1 }
        })
      );
    return {
      cancelSaveFile,
      finish,
      get pickerOpened() {
        return pickerOpened;
      }
    };
  }

  it('allows a long system-picker wait, then resolves once and permits another save', async () => {
    const bridge = controlledSave();
    const waiting = saveBlob(new Blob(['a']), 'a.txt');
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.pickerOpened).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(bridge.cancelSaveFile).not.toHaveBeenCalled();
    bridge.finish();
    await expect(waiting).resolves.toMatchObject({ mode: 'native' });
    bridge.finish(false);
    const retry = saveBlob(new Blob(['a']), 'retry.txt');
    await vi.advanceTimersByTimeAsync(0);
    bridge.finish();
    await expect(retry).resolves.toMatchObject({ mode: 'native' });
  });

  it.each(['abort', 'pagehide'])('cancels the native pending picker after finish on %s', async (cause) => {
    const bridge = controlledSave();
    const controller = new AbortController();
    const waiting = saveBlob(new Blob(['a']), 'a.txt', { signal: controller.signal });
    const assertion = expect(waiting).rejects.toThrow('[SAV-A004]');
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.pickerOpened).toBe(true);
    if (cause === 'abort') controller.abort();
    else window.dispatchEvent(new Event('pagehide'));
    await assertion;
    expect(bridge.cancelSaveFile).toHaveBeenCalledTimes(1);
    bridge.finish();
    expect(bridge.cancelSaveFile).toHaveBeenCalledTimes(1);
  });

  it('times out a stalled transfer, cancels it and never launches its picker', async () => {
    const bridge = controlledSave();
    vi.stubGlobal(
      'FileReader',
      class {
        readAsDataURL() {}
      }
    );
    const assertion = expect(saveBlob(new Blob(['a']), 'a.txt')).rejects.toThrow('[SAV-A032]');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(bridge.cancelSaveFile).toHaveBeenCalledTimes(1);
    expect(bridge.pickerOpened).toBe(false);
  });

  it('resolves only for the matching save id', async () => {
    const waiting = waitForNativeSave('wanted', 1000);
    window.dispatchEvent(
      new CustomEvent('loopdeck3-save-result', {
        detail: { id: 'other', ok: true, code: 'SAV-OK', message: 'other' }
      })
    );
    window.dispatchEvent(
      new CustomEvent('loopdeck3-save-result', {
        detail: { id: 'wanted', ok: true, code: 'SAV-OK', message: 'saved', bytes: 42 }
      })
    );

    await expect(waiting).resolves.toMatchObject({ id: 'wanted', ok: true, bytes: 42 });
  });

  it('rejects native failures with their error code', async () => {
    const waiting = waitForNativeSave('failed', 1000);
    window.dispatchEvent(
      new CustomEvent('loopdeck3-save-result', {
        detail: { id: 'failed', ok: false, code: 'SAV-A004', message: 'cancelled' }
      })
    );

    await expect(waiting).rejects.toThrow('[SAV-A004] cancelled');
  });

  it('times out instead of waiting forever when no native callback arrives', async () => {
    vi.useFakeTimers();
    const assertion = expect(waitForNativeSave('missing', 25)).rejects.toThrow('[SAV-A032]');
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });

  it('streams Blob chunks through the unified native bridge without legacy saveFile', async () => {
    const appended: Array<{ index: number; base64: string }> = [];
    let saveId = '';
    window.LoopDeck3Host = {
      beginSaveFile(id, _filename, _mimeType, expectedBytes, expectedChunks) {
        saveId = id;
        expect(expectedBytes).toBe(100_000);
        expect(expectedChunks).toBe(3);
        return true;
      },
      appendSaveFileChunk(_id, index, base64Chunk) {
        appended.push({ index, base64: base64Chunk });
        return true;
      },
      finishSaveFile(id) {
        queueMicrotask(() =>
          window.dispatchEvent(
            new CustomEvent('loopdeck3-save-result', {
              detail: { id, ok: true, code: 'SAV-OK', message: 'saved', bytes: 100_000 }
            })
          )
        );
        return true;
      },
      cancelSaveFile() {}
    };

    const result = await saveBlob(new Blob([new Uint8Array(100_000)], { type: 'application/octet-stream' }), 'big.bin');

    expect(result.mode).toBe('native');
    expect(result.nativeResult?.bytes).toBe(100_000);
    expect(saveId).toMatch(/^loopdeck-/);
    expect(appended.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(appended[0].base64.length).toBeLessThanOrEqual(65_536);
    expect(appended[1].base64.length).toBeLessThanOrEqual(65_536);
  });

  it('cancels a native session when a chunk append is rejected', async () => {
    const cancelled: string[] = [];
    window.LoopDeck3Host = {
      beginSaveFile() {
        return true;
      },
      appendSaveFileChunk() {
        return false;
      },
      finishSaveFile() {
        return true;
      },
      cancelSaveFile(id) {
        cancelled.push(id);
      }
    };

    await expect(saveBlob(new Blob(['failure']), 'failure.txt')).rejects.toThrow('[SAV-A012]');
    expect(cancelled).toHaveLength(1);
  });
});
