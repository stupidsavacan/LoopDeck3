// Fixed targets for the Android developer CLI. Nothing here is configurable on
// purpose: the CLI only ever drives the LoopDeck3 debug build.
export const APP_PACKAGE = 'com.loopdeck3.app.debug';
export const APP_COMPONENT = 'com.loopdeck3.app.debug/com.loopdeck3.app.MainActivity';
export const APP_ORIGIN = 'https://appassets.androidplatform.net';
export const APP_PATH = '/assets/loopdeck/index.html';
export const APP_PAGE_URL = `${APP_ORIGIN}${APP_PATH}`;
export const DB_NAME = 'loopdeck3-learning';
export const WEBVIEW_CLASS = 'android.webkit.WebView';
export const DOCUMENTS_UI_PACKAGES: readonly string[] = ['com.google.android.documentsui', 'com.android.documentsui'];
export const DEFAULT_SESSION_ROOT = 'qa-results/android';

/**
 * IndexedDB stores that hold what the learner created. `reset` requires every one to be empty.
 * Mirrors USER_DATA_STORES in src/storage/indexedDb.ts (tests/deviceReset.test.ts keeps them equal).
 * `contentMetadata` is written by the app itself on start and is deliberately not listed.
 */
export const USER_DATA_STORES: readonly string[] = ['attempts', 'bookmarks', 'packs', 'packAssets', 'reviewCards', 'reviewLogs'];
export const APP_METADATA_STORES: readonly string[] = ['contentMetadata'];

/**
 * localStorage keys that hold what the learner did. `reset` requires none of them to exist afterwards.
 * Anything else the app writes while starting (the diagnostics log, the home screen's `in-player` flag,
 * the catalog-changes broadcast) is app metadata and is only reported. tests/deviceManagement.test.ts
 * fails when src/ gains a `loopdeck3.*` key that is in neither list, so this stays honest.
 */
export const USER_LOCAL_STORAGE_KEYS: readonly string[] = ['loopdeck3.review.scope', 'loopdeck3.library.last-module'];
export const USER_LOCAL_STORAGE_PREFIXES: readonly string[] = [
  'loopdeck3.session.',
  'loopdeck3.preferences.',
  'loopdeck3.library.folders.',
  'loopdeck3.today.'
];
export const APP_LOCAL_STORAGE_KEYS: readonly string[] = [
  'loopdeck3.diagnostics',
  'loopdeck3.library.in-player',
  'loopdeck3.catalog-changes',
  // A one-shot sessionStorage flag from the home resume banner; never learner data.
  'loopdeck3.library.autoresume'
];

/** Where raw run evidence lives: outside the repository. */
export function resolveLdevHome(env: NodeJS.ProcessEnv, _platform: string, homedir: string): string {
  if (env.LDEV_HOME) return env.LDEV_HOME;
  if (env.LOCALAPPDATA) return `${env.LOCALAPPDATA}/LoopDeck3/ldev`;
  return `${homedir}/.loopdeck3-ldev`;
}

/** Keys `ldev key` may send. HOME/POWER/etc. are reachable only through typed lifecycle commands. */
export const ALLOWED_KEYS: readonly string[] = [
  'BACK',
  'ENTER',
  'TAB',
  'ESCAPE',
  'DPAD_UP',
  'DPAD_DOWN',
  'DPAD_LEFT',
  'DPAD_RIGHT',
  'DPAD_CENTER',
  'PAGE_UP',
  'PAGE_DOWN'
];

export const ROTATION_SETTINGS = ['accelerometer_rotation', 'user_rotation'] as const;
export type RotationSetting = (typeof ROTATION_SETTINGS)[number];

/** `settings put system` keys the CLI may touch: rotation (rotate) and the text scale (setting font-scale). */
export const SYSTEM_SETTINGS = [...ROTATION_SETTINGS, 'font_scale'] as const;
export type SystemSetting = (typeof SYSTEM_SETTINGS)[number];

/** `cmd uimode night <value>`; `yes` is dark mode, `auto` follows the system. */
export const NIGHT_MODES = ['yes', 'no', 'auto', 'custom_schedule', 'custom_bedtime'] as const;
export type NightMode = (typeof NIGHT_MODES)[number];

/** Settings recorded in the session (with their original value) before they are changed. */
export type TrackedSettingKey = 'uimode' | 'font_scale';

/** The release build of the same app; named only so it can be refused explicitly. */
export const RELEASE_PACKAGE = 'com.loopdeck3.app';

/** Where raw shell may write: the tool's own device-side scratch space. */
export const SHELL_WRITE_ROOTS: readonly string[] = [
  '/sdcard/Download/ldev/',
  '/storage/emulated/0/Download/ldev/',
  '/data/local/tmp/ldev-',
  `/sdcard/Android/data/${APP_PACKAGE}/`,
  `/storage/emulated/0/Android/data/${APP_PACKAGE}/`
];

export const TIMEOUTS = {
  adbMs: 15_000,
  installMs: 90_000,
  pmClearMs: 30_000,
  resetVerifyMs: 20_000,
  /** First start after `pm clear` is slower than a resume (WebView and app initialise from nothing). */
  freshStartMs: 45_000,
  processStopMs: 5_000,
  screencapMs: 20_000,
  cdpConnectMs: 10_000,
  cdpEvaluateMs: 20_000,
  stateCaptureMs: 60_000,
  uiReadyMs: 15_000,
  uiPollMs: 250,
  expectMs: 5_000,
  maxExpectMs: 30_000
} as const;

export const LIMITS = {
  maxStdoutBytes: 8 * 1024 * 1024,
  maxScreenshotBytes: 32 * 1024 * 1024,
  maxLogLines: 500,
  maxLogBytes: 512 * 1024,
  maxUiNodes: 5_000,
  maxDomItems: 400,
  stateMaxRecords: 200_000,
  stateMaxBytes: 128 * 1024 * 1024
} as const;
