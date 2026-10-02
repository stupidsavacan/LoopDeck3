import { describe, expect, it } from 'vitest';
import { buildGeneratedChoices } from '../src/core/choiceGenerator';
import { loadBuiltinPacks } from '../src/packs/builtinLoader';
import type { InputQuestion } from '../src/core/models';
import { buildRangeOptions, createSession } from '../src/core/sessionEngine';
import { validatePack } from '../src/packs/packValidator';

describe('built-in LoopDeck data', () => {
  const pack = loadBuiltinPacks()[0];

  it('caches the normalized and validated built-in pack for the app lifetime', () => {
    expect(loadBuiltinPacks()).toBe(loadBuiltinPacks());
  });

  it('loads as the active valid built-in dataset', () => {
    const result = validatePack(pack);
    expect(result.ok).toBe(true);
    expect(pack.modules.length).toBe(10);
    expect(pack.questions.length).toBe(1112);
  });

  it('does not expose source-project wording in active pack metadata', () => {
    const visibleMetadata = {
      packId: pack.packId,
      title: pack.title,
      description: pack.description,
      folders: pack.folders,
      modules: pack.modules.map((module) => ({
        id: module.id,
        folderId: module.folderId,
        title: module.title,
        subject: module.subject,
        description: module.description,
        tags: module.tags
      }))
    };
    expect(JSON.stringify(visibleMetadata)).not.toMatch(/studyhome|rescued|rescue/i);
  });

  it('does not include reverse practice modules or questions', () => {
    expect(pack.modules.some((module) => ['english_reverse', 'leap_reverse', 'leap_final_reverse'].includes(module.id))).toBe(false);
    expect(pack.questions.some((question) => ['english_reverse', 'leap_reverse', 'leap_final_reverse'].includes(question.moduleId))).toBe(false);
  });

  it('keeps 古文単語 empty and hides it from normal study cards', () => {
    const kobunVocab = pack.modules.find((module) => module.id === 'kobun_vocab' || module.title === '古文単語');
    expect(kobunVocab?.questionIds.length).toBe(0);
    expect(pack.modules.filter(module => module.questionIds.length > 0).some((module) => module.id === kobunVocab?.id)).toBe(false);
  });

  it('preserves original LEAP titles, question IDs, numbers, and ranges', () => {
    const leapModule = pack.modules.find((module) => module.id === 'leap');
    const leapFinalModule = pack.modules.find((module) => module.id === 'leap_final');
    const leap = pack.questions.filter((question) => question.moduleId === 'leap');
    const leapFinal = pack.questions.filter((question) => question.moduleId === 'leap_final');

    expect(leapModule?.title).toBe('LEAP 001〜200');
    expect(leapFinalModule?.title).toBe('LEAP 201〜300');
    expect(leap.map((question) => question.id)).toEqual(Array.from({ length: 200 }, (_, index) => `leap-${index + 1}`));
    expect(leapFinal.map((question) => question.id)).toEqual(Array.from({ length: 100 }, (_, index) => `leap_final-${index + 201}`));
    expect(leap.map((question) => question.number)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    expect(leapFinal.map((question) => question.number)).toEqual(Array.from({ length: 100 }, (_, index) => index + 201));
    expect(buildRangeOptions(leapFinal).map((option) => option.value)).toEqual(['all', '201-225', '226-250', '251-275', '276-300']);
  });

  it('keeps built-in history images as four shared path references', () => {
    const imageAssets = pack.questions.map((question) => question.imageAsset).filter((value): value is string => Boolean(value));
    const counts = imageAssets.reduce<Record<string, number>>((acc, path) => {
      acc[path] = (acc[path] ?? 0) + 1;
      return acc;
    }, {});

    expect(imageAssets).toHaveLength(32);
    expect(Object.keys(counts).sort()).toEqual([
      'images/history/graph63.png',
      'images/history/map62.png',
      'images/history/map64.png',
      'images/history/relation63.png'
    ]);
    expect(counts).toEqual({
      'images/history/map62.png': 11,
      'images/history/graph63.png': 5,
      'images/history/relation63.png': 6,
      'images/history/map64.png': 10
    });
    expect(imageAssets.every((path) => !path.startsWith('data:'))).toBe(true);
  });

  it('can generate four choices for the LEAP final input dataset', () => {
    const leapFinal = pack.questions.filter(
      (question): question is InputQuestion => question.moduleId === 'leap_final' && question.type === 'input'
    );
    const choices = buildGeneratedChoices(leapFinal[0], leapFinal, 4, () => 0.25);

    expect(leapFinal).toHaveLength(100);
    expect(choices).toHaveLength(4);
    expect(choices).toContain(leapFinal[0].answer);
  });

  it('can start required built-in modules', () => {
    for (const title of ['LEAP 001〜200', '化学', '歴史総合', '地理総合']) {
      const module = pack.modules.find((item) => item.title === title);
      expect(module, title).toBeTruthy();
      const questions = pack.questions.filter((question) => question.moduleId === module!.id);
      const session = createSession(module!, questions, { shuffle: false, autoNext: true, questionLimit: 'all' });
      expect(session.queue.length, title).toBeGreaterThan(0);
    }
  });
});
