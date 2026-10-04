import type { LoopDeckPack, ModuleInfo, Question } from '../core/models';

export interface ImportConflictAnalysis {
  existingImportedPack?: LoopDeckPack;
  moduleMergeTarget?: LoopDeckPack;
  ambiguousModuleMerge: boolean;
  duplicateImportedPackId: boolean;
  duplicateActivePackId: boolean;
  duplicateModuleIds: string[];
  duplicateQuestionIds: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

export function sharedModuleIds(left: LoopDeckPack, right: LoopDeckPack): string[] {
  const leftIds = new Set(left.modules.map((module) => module.id));
  return unique(right.modules.map((module) => module.id).filter((moduleId) => leftIds.has(moduleId)));
}

export function analyzeImportConflicts(
  pack: LoopDeckPack,
  importedPacks: LoopDeckPack[],
  activePacks: LoopDeckPack[],
  activeModules: ModuleInfo[],
  activeQuestions: Question[]
): ImportConflictAnalysis {
  const existingImportedPack = importedPacks.find((importedPack) => importedPack.packId === pack.packId);
  const activePackIds = new Set(activePacks.map((activePack) => activePack.packId));
  const activeModuleIds = new Set(activeModules.map((module) => module.id));
  const activeQuestionIds = new Set(activeQuestions.map((question) => question.id));
  const incomingModuleIds = new Set(pack.modules.map((module) => module.id));
  const moduleOwners = activePacks.filter((activePack) =>
    activePack.modules.some((module) => incomingModuleIds.has(module.id) && activeModules.some((activeModule) => activeModule === module))
  );
  const ambiguousModuleMerge = moduleOwners.length > 1;
  const moduleMergeTarget = existingImportedPack || ambiguousModuleMerge ? undefined : moduleOwners[0];

  return {
    existingImportedPack,
    moduleMergeTarget,
    ambiguousModuleMerge,
    duplicateImportedPackId: Boolean(existingImportedPack),
    duplicateActivePackId: activePackIds.has(pack.packId),
    duplicateModuleIds: unique(pack.modules.map((module) => module.id).filter((moduleId) => activeModuleIds.has(moduleId))),
    duplicateQuestionIds: unique(pack.questions.map((question) => question.id).filter((questionId) => activeQuestionIds.has(questionId)))
  };
}
