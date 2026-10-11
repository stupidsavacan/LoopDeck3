import { parseArgs } from 'node:util';
import { COMMANDS, type CommandOutput, type Values } from './commands.js';
import { DeviceCliError, EXIT_CODES, asCliError, type ErrorCode } from './errors.js';
import { defaultDeps, type Deps } from './runtime.js';

export interface CliResult {
  exitCode: number;
  /** Exactly one JSON envelope (single line). */
  stdout: string;
  /** One concise human line. */
  stderr: string;
}

interface Envelope {
  ok: boolean;
  command: string;
  exitCode: number;
  data?: Record<string, unknown>;
  error?: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

function finish(envelope: Envelope, human: string): CliResult {
  return { exitCode: envelope.exitCode, stdout: `${JSON.stringify(envelope)}\n`, stderr: `${human}\n` };
}

function failure(command: string, error: DeviceCliError, data?: Record<string, unknown>): CliResult {
  const details = { ...(error.details ?? {}), ...(data ? { result: data } : {}) };
  return finish(
    {
      ok: false,
      command,
      exitCode: error.exitCode,
      error: { code: error.code, message: error.message, ...(Object.keys(details).length ? { details } : {}) }
    },
    `ldev ${command}: FAILED [${error.code}] ${error.message}`
  );
}

function help(): CliResult {
  const commands = Object.fromEntries(Object.entries(COMMANDS).map(([name, def]) => [name, { summary: def.summary, usage: def.usage }]));
  return finish({ ok: true, command: 'help', exitCode: 0, data: { commands } }, `ldev: ${Object.keys(COMMANDS).join(', ')}`);
}

/**
 * Parses strictly (unknown or misplaced options are errors, never ignored) before any
 * subprocess can start, runs one command, and returns one
 * JSON envelope. Never throws and never writes to the process streams: `main` does that.
 */
export async function runCli(argv: readonly string[], deps: Deps = defaultDeps()): Promise<CliResult> {
  const [name, ...rest] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') return help();
  const definition = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!definition)
    return failure(name, new DeviceCliError('USAGE', `Unknown command "${name}". Commands: ${Object.keys(COMMANDS).join(', ')}`));
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({ args: [...rest], options: definition.options, allowPositionals: true, strict: true });
    } catch (error) {
      throw new DeviceCliError('USAGE', `${(error as Error).message}. Usage: ldev ${definition.usage}`);
    }
    const positionals = parsed.positionals;
    if (positionals.length < definition.positionals.min || positionals.length > definition.positionals.max) {
      throw new DeviceCliError('USAGE', `Unexpected arguments. Usage: ldev ${definition.usage}`);
    }
    const output: CommandOutput = await definition.run({ name, values: parsed.values as Values, positionals, deps });
    if (output.failure) {
      return failure(name, new DeviceCliError(output.failure.code, output.failure.message), output.data);
    }
    return finish({ ok: true, command: name, exitCode: EXIT_CODES.OK, data: output.data }, `ldev ${name}: ok - ${output.summary}`);
  } catch (error) {
    return failure(name, asCliError(error));
  }
}
