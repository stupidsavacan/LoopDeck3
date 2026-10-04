import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function androidBuildVersion(runNumber, runAttempt, sha) {
  const run = Number(runNumber);
  const attempt = Number(runAttempt);
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new Error('Android version requires a positive run number and attempt in 1..99.');
  }
  const versionCode = 3000 + run * 100 + attempt;
  if (versionCode > 2_100_000_000) throw new Error('Android versionCode exceeds the supported maximum.');
  if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('Android version requires a full Git commit SHA.');
  return { versionCode, versionName: `${version}+${run}.${attempt}.${sha.slice(0, 7)}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { versionCode, versionName } = androidBuildVersion(process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT, process.env.GITHUB_SHA);
  if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required.');
  appendFileSync(process.env.GITHUB_ENV, `LOOPDECK_VERSION_CODE=${versionCode}\nLOOPDECK_VERSION_NAME=${versionName}\n`);
  console.log(`Android ${versionName} (${versionCode})`);
}
