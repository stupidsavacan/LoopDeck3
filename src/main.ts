import './styles.css';
import './homeFeatures.css';
import './mobileUxFixes.css';
import './editorialUi.css';
import './questionVisualReferences.css';
import './flashcard.css';
import { registerGlobalErrorLogging } from './debug/debugLog';
import { StudyApplication } from './app/application';
import './cloud/cloud.css';
import { database } from './storage/indexedDb';
import { StudyRepository } from './storage/studyRepository';
import { CloudStore } from './cloud/store';
import { SyncEngine } from './cloud/engine';
import { mountCloudSync } from './cloud/ui';
import { parseRoute } from './app/context';
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root.');
registerGlobalErrorLogging();
const repository = new StudyRepository(database);
const application = new StudyApplication(root, { store: repository });
application.start();
const cloudStore = new CloudStore(database);
const syncEngine = new SyncEngine(
  cloudStore,
  repository,
  () => ['home', 'graphs'].includes(parseRoute(location.hash).name),
  undefined,
  (work) => application.applyCatalogUpdate(work)
);
mountCloudSync(cloudStore, repository, syncEngine);
syncEngine.start();
addEventListener('hashchange', () => {
  void syncEngine.tick();
});
