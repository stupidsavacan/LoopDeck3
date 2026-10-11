import { runCli } from './cli.js';

/** Process entry point used by scripts/ldev.mjs. */
export async function main(argv: readonly string[]): Promise<void> {
  // On process termination retain both DIRTY intent and the lock. A child ADB
  // process may still be finishing; a new CLI must not overlap it accidentally.
  const result = await runCli(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
