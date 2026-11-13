import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));
const properties = await readFile(resolve(root, 'android/gradle.properties'), 'utf8');
const origin = /^syncApiOrigin=(\S+)\s*$/m.exec(properties)?.[1];
assert.ok(origin, 'Release cloud API must be configured in android/gradle.properties.');
assert.match(origin, /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.chatgpt\.site$/);

const config = await readFile(resolve(root, 'android/app/build/generated/source/buildConfig/release/com/loopdeck3/app/BuildConfig.java'), 'utf8');
function stringField(name) {
  const value = new RegExp(`public static final String ${name}\\s*=\\s*("[^"]*");`).exec(config)?.[1];
  assert.ok(value, `Missing BuildConfig.${name}`);
  return JSON.parse(value);
}
assert.equal(stringField('APPLICATION_ID'), 'com.loopdeck3.app', 'Public release must retain its existing application ID.');
assert.match(config, /public static final boolean DEBUG\s*=\s*false;/);
assert.equal(stringField('SYNC_API_ORIGIN'), origin, 'Release API is empty or differs from the approved endpoint.');

const apkPath = resolve(process.argv[2] ?? resolve(root, 'android/app/build/outputs/apk/release/app-release.apk'));
const apk = await JSZip.loadAsync(await readFile(apkPath));
const dexFiles = Object.values(apk.files).filter(file => /^classes\d*\.dex$/.test(file.name));
assert.ok(dexFiles.length, 'APK has no executable DEX.');
const dex = await Promise.all(dexFiles.map(file => file.async('nodebuffer')));
assert.ok(dex.some(bytes => bytes.includes(Buffer.from(origin))), 'APK executable code has no configured cloud endpoint.');
console.log(`Release cloud API verified: ${origin} (com.loopdeck3.app, non-debuggable)`);
