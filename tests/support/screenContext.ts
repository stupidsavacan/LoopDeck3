import { studyStore } from '../../src/storage/studyRepository';
import { createQuestionImageAssetResolver } from '../../src/packs/packAssetResolver';
import type { ScreenContext, Navigation } from '../../src/app/context';
import { resolveActivePacks } from '../../src/packs/packResolver';
export function screenContext(options: Partial<Omit<ScreenContext, 'navigation'>> & { navigation?: Partial<Navigation>; moduleId?: string }): ScreenContext & { moduleId: string } {
 return {store: studyStore, resolveImage: createQuestionImageAssetResolver(options.catalog ?? resolveActivePacks([]), options.store ?? studyStore), root: document.createElement('div'), catalog: resolveActivePacks([]), isCurrent: () => true, refreshCatalog: async () => {}, moduleId: '', ...options, navigation: {home: () => {}, module: () => {}, review: () => {}, import: () => {}, graphs: () => {}, pdfWorksheet: () => {}, debugLog: () => {}, ...options.navigation} };
}
