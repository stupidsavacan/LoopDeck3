import builtinQuestionPack from '../../data/builtin/catalog.json';
import type { LoopDeckPack } from '../core/models';
import { writeDebugLog } from '../debug/debugLog';
import { validatePack } from './packValidator';

let cachedBuiltinPacks: LoopDeckPack[] | undefined;

export function loadBuiltinPacks(): LoopDeckPack[] {
  if (cachedBuiltinPacks) return cachedBuiltinPacks;

  const normalizedPack = builtinQuestionPack;
  const result = validatePack(normalizedPack);
  if (!result.ok || !result.pack) {
    console.error(result.issues);
    writeDebugLog({
      level: 'error',
      area: 'builtinLoader',
      code: 'PACK-BUILTIN',
      userMessage: '組み込み教材の読み込みに失敗しました。',
      detail: 'Built-in LoopDeck pack is invalid.',
      context: { issues: result.issues }
    });
    throw new Error('Built-in LoopDeck pack is invalid.');
  }
  cachedBuiltinPacks = [result.pack];
  return cachedBuiltinPacks;
}
