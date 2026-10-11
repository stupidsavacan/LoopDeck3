#!/usr/bin/env node
// Bootstrap for the Android developer CLI. Sources live in tools/device/*.ts and are
// compiled with the repo's own TypeScript into content-addressed, ignored directories under
// qa-results/device-cli/<key>/ (see ldev-build.mjs), then imported.
// Usage: npm run device -- <command> [options]   (or: node scripts/ldev.mjs <command> ...)
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureBuilt } from './ldev-build.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, command: 'build', exitCode: 70, error: { code: 'INTERNAL', message } })}\n`);
  process.stderr.write(`ldev: build FAILED ${message}\n`);
  process.exit(70);
}

const buildDir = ensureBuilt({
  configPath: join(repoRoot, 'tsconfig.device.json'),
  sourceDir: join(repoRoot, 'tools', 'device'),
  outRoot: join(repoRoot, 'qa-results', 'device-cli'),
  onError: fail
});

/** Load the same immutable tooling build for repository-owned QA fixtures. */
export async function loadDeviceModule(name) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error('Invalid device module name');
  return import(pathToFileURL(join(buildDir, `${name}.js`)).href);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { main } = await loadDeviceModule('main');
  await main(process.argv.slice(2));
}
