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

export const TIMEOUTS = {
  adbMs: 15_000,
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
