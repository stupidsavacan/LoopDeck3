import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizController } from '../src/core/quizController';
import { createSession } from '../src/core/sessionEngine';
import type { Question, Attempt } from '../src/core/models';
const question: Question = { id: 'q', moduleId: 'm', type: 'input', prompt: 'Animal', answer: 'dog' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup(autoNext = false) {
  const session = createSession({ id: 'm', title: 'Module', folderId: '', subject: 'Test', questionIds: ['q'] }, [question], { shuffle: false, autoNext, questionLimit: 'all' });
  const callbacks = { isCurrent: vi.fn(() => true), persist: vi.fn(async (_attempt: Attempt) => {}), onAdvance: vi.fn(), onCheckpoint: vi.fn(), onCheckpointError: vi.fn(), onPersistenceChange: vi.fn() };
  const controller = new QuizController({ session, question, answerMode: 'input', ...callbacks });
  return { controller, callbacks };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T00:00:00Z')); });
afterEach(() => vi.useRealTimers());
describe('headless question runtime', () => {
  it('locks duplicate answers and advance until the single persistence command completes', async () => {
    const { controller, callbacks } = setup(); const save = deferred(); callbacks.persist.mockReturnValue(save.promise);
    expect(controller.answer('dog')).toMatchObject({ result: 'correct' });
    expect(controller.answer('cat')).toBeUndefined();
    const pending = controller.save(); await controller.save(); controller.advance();
    expect(callbacks.persist).toHaveBeenCalledOnce(); expect(callbacks.onAdvance).not.toHaveBeenCalled();
    save.resolve(); await pending; controller.advance(); controller.advance();
    expect(callbacks.onAdvance).toHaveBeenCalledOnce(); expect(callbacks.onAdvance.mock.calls[0][0]).toMatchObject({ index: 1, attempts: [expect.objectContaining({ result: 'correct' })] });
  });
  it('retries the exact answer command after failure', async () => {
    const { controller, callbacks } = setup(); callbacks.persist.mockRejectedValueOnce(new Error('Disk full'));
    const attempt = controller.answer('cat'); await controller.save();
    expect(controller.phase).toBe('failed'); controller.advance(); expect(callbacks.onAdvance).not.toHaveBeenCalled();
    await controller.save(); expect(controller.phase).toBe('saved');
    expect(callbacks.persist.mock.calls.map(call => call[0])).toEqual([attempt, attempt]);
  });
  it('ignores an answer completion after disposal', async () => {
    const { controller, callbacks } = setup(true); const save = deferred(); callbacks.persist.mockReturnValue(save.promise);
    controller.answer('dog'); const pending = controller.save(); controller.dispose(); save.resolve(); await pending; await vi.runAllTimersAsync();
    expect(controller.phase).toBe('disposed'); expect(callbacks.onCheckpoint).not.toHaveBeenCalled(); expect(callbacks.onAdvance).not.toHaveBeenCalled();
    expect(callbacks.onPersistenceChange).toHaveBeenCalledTimes(1);
  });
  it('cancels auto advance when the owner disposes a saved question', async () => {
    const { controller, callbacks } = setup(true); controller.answer('dog'); await controller.save(); controller.dispose();
    await vi.advanceTimersByTimeAsync(1000); expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });
  it('cannot create an auto advance timer after the saved observer disposes it', async () => {
    const { controller, callbacks } = setup(true);
    callbacks.onPersistenceChange.mockImplementation((phase: string) => { if (phase === 'saved') controller.dispose(); });
    controller.answer('dog'); await controller.save();
    expect(vi.getTimerCount()).toBe(0); expect(controller.phase).toBe('disposed');
  });
  it('does not retry committed data when checkpoint storage fails', async () => {
    const { controller, callbacks } = setup(true); callbacks.onCheckpoint.mockImplementation(() => { throw new Error('Checkpoint full'); });
    controller.answer('dog'); await controller.save(); await controller.save(); await vi.advanceTimersByTimeAsync(650);
    expect(callbacks.persist).toHaveBeenCalledOnce(); expect(callbacks.onCheckpointError).toHaveBeenCalledOnce(); expect(callbacks.onAdvance).toHaveBeenCalledOnce();
  });
  it('excludes hidden time and suspension from answer timing and checkpoints', () => {
    const { controller, callbacks } = setup(); vi.advanceTimersByTime(2000); controller.setHidden(true);
    vi.advanceTimersByTime(10000); controller.setHidden(false); vi.advanceTimersByTime(1000);
    controller.excludeSuspension(500); controller.checkpoint();
    expect(callbacks.onCheckpoint.mock.calls.at(-1)?.[0]).toMatchObject({ currentElapsedMs: 2500, currentHiddenTimeExcludedMs: 10500 });
    expect(controller.answer('dog')).toMatchObject({ elapsedMs: 2500, hiddenTimeExcludedMs: 10500 });
  });
  it('ignores obsolete owners even if disposal was delayed', async () => {
    const { controller, callbacks } = setup(); controller.answer('dog'); callbacks.isCurrent.mockReturnValue(false); await controller.save(); controller.advance(); controller.checkpoint();
    expect(callbacks.persist).not.toHaveBeenCalled(); expect(callbacks.onAdvance).not.toHaveBeenCalled(); expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
  });
});
