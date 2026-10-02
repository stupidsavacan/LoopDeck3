import { describe, expect, it } from 'vitest';
import type { LoopDeckPack, ModuleInfo, Question } from '../src/core/models';
import {
  getActiveModules,
  getActivePacks,
  getQuestionById,
  getQuestionsForModule,
  getModuleById,
  resolveActivePacks
} from '../src/packs/packResolver';

function inputQuestion(id: string, moduleId: string, prompt: string): Question {
  return {
    id,
    moduleId,
    type: 'input',
    prompt,
    answer: `${prompt} answer`
  };
}

function moduleInfo(id: string, title: string, questionIds: string[]): ModuleInfo {
  return {
    id,
    folderId: 'term1_midterm',
    title,
    subject: '英語',
    description: `${title} description`,
    tags: [title],
    questionIds
  };
}

function pack(packId: string, title: string, modules: ModuleInfo[], questions: Question[]): LoopDeckPack {
  return {
    packVersion: 1,
    packId,
    title,
    folders: [{ id: 'term1_midterm', title: '一学期中間テスト' }],
    modules,
    questions
  };
}

describe('packResolver duplicate ID resolution', () => {
  it('uses imported module/question data when it overrides a built-in module', () => {
    const builtin = pack(
      'loopdeck-builtin-v1',
      'Built-in',
      [moduleInfo('leap', 'LEAP old', ['leap-001'])],
      [inputQuestion('leap-001', 'leap', 'old prompt')]
    );
    const imported = pack(
      'user-leap-update',
      'Imported LEAP',
      [moduleInfo('leap', 'LEAP new', ['leap-001'])],
      [inputQuestion('leap-001', 'leap', 'new prompt')]
    );

    const view = resolveActivePacks([builtin, imported]);

    expect(getModuleById(view, 'leap')?.title).toBe('LEAP new');
    expect(getQuestionsForModule(view, 'leap')).toHaveLength(1);
    expect(getQuestionsForModule(view, 'leap')[0]?.prompt).toBe('new prompt');
  });

  it('treats a later pack with the same packId as a full replacement', () => {
    const v1 = pack(
      'custom-leap',
      'Custom LEAP v1',
      [moduleInfo('custom-leap-module', 'Custom old', ['old-question'])],
      [inputQuestion('old-question', 'custom-leap-module', 'old content')]
    );
    const v2 = pack(
      'custom-leap',
      'Custom LEAP v2',
      [moduleInfo('custom-leap-module', 'Custom new', ['new-question'])],
      [inputQuestion('new-question', 'custom-leap-module', 'new content')]
    );

    const view = resolveActivePacks([v1, v2]);

    expect(getActivePacks(view)).toHaveLength(1);
    expect(getActivePacks(view)[0]?.title).toBe('Custom LEAP v2');
    expect(getQuestionsForModule(view, 'custom-leap-module')).toHaveLength(1);
    expect(getQuestionsForModule(view, 'custom-leap-module')[0]?.prompt).toBe('new content');
    expect(getQuestionById(view, 'old-question')).toBeUndefined();
  });

  it('scopes same-id question lookup to the pack that owns each active module', () => {
    const builtin = pack(
      'loopdeck-builtin-v1',
      'Built-in',
      [moduleInfo('builtin-module', 'Built-in module', ['shared-question'])],
      [inputQuestion('shared-question', 'builtin-module', 'old shared prompt')]
    );
    const imported = pack(
      'imported-pack',
      'Imported',
      [moduleInfo('imported-module', 'Imported module', ['shared-question'])],
      [inputQuestion('shared-question', 'imported-module', 'new shared prompt')]
    );

    const view = resolveActivePacks([builtin, imported]);

    expect(getQuestionsForModule(view, 'builtin-module')[0]?.prompt).toBe('old shared prompt');
    expect(getQuestionsForModule(view, 'imported-module')[0]?.prompt).toBe('new shared prompt');
    expect(getQuestionById(view, 'shared-question')?.prompt).toBe('new shared prompt');
  });

  it('uses the same resolved module object for Home and module opening', () => {
    const builtin = pack(
      'loopdeck-builtin-v1',
      'Built-in',
      [moduleInfo('leap', 'LEAP old', ['leap-001'])],
      [inputQuestion('leap-001', 'leap', 'old prompt')]
    );
    const imported = pack(
      'user-leap-update',
      'Imported LEAP',
      [moduleInfo('leap', 'LEAP new', ['leap-001'])],
      [inputQuestion('leap-001', 'leap', 'new prompt')]
    );

    const view = resolveActivePacks([builtin, imported]);
    const homeModules = getActiveModules(view).filter(module => module.questionIds.length > 0);
    const homeModule = new Map(homeModules.map((module) => [module.id, module])).get('leap');
    const openedModule = getModuleById(view, 'leap');

    expect(homeModule).toBe(openedModule);
    expect(getQuestionsForModule(view, openedModule)[0]?.prompt).toBe('new prompt');
  });
});
