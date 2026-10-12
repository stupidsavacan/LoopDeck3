import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMANDS, type CommandDef, type CommandOutput, type Values } from './commands.js';
import { DeviceCliError, EXIT_CODES, asCliError, type ErrorCode } from './errors.js';
import { Recorder, SUMMARY_FILE, recordParams, type OpScope } from './explore.js';
import { defaultDeps, type Deps } from './runtime.js';
import { SessionHandle, sessionPaths } from './session.js';

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

/** Session-bound commands are recorded once `prepare --record` linked an exploration; recording never makes a command fail. */
async function beginRecording(
  definition: CommandDef,
  name: string,
  values: Values,
  positionals: readonly string[],
  deps: Deps
): Promise<OpScope | null> {
  if (name === 'prepare' || !('session' in definition.options)) return null;
  try {
    const recorder = Recorder.open(deps, sessionPaths(typeof values.session === 'string' ? values.session : undefined, deps.cwd));
    return recorder ? await recorder.begin(name, recordParams(values, positionals)) : null;
  } catch {
    return null;
  }
}

/** Writes summary.json after `finish` (CLEAN) or a failed `finish` (still DIRTY) and returns the short form. */
function summarizeExploration(recorder: Recorder, values: Values, deps: Deps): Record<string, unknown> | null {
  try {
    const paths = sessionPaths(typeof values.session === 'string' ? values.session : undefined, deps.cwd);
    const status = SessionHandle.read(paths, deps.now)?.record.status === 'CLEAN' ? 'CLEAN' : 'DIRTY';
    const summary = recorder.writeSummary(status);
    return {
      dir: recorder.dir,
      summaryFile: join(recorder.dir, SUMMARY_FILE),
      sessionStatus: summary.sessionStatus,
      operations: summary.operations,
      observations: summary.observations,
      errors: summary.errors,
      stateChanges: summary.stateChanges,
      firstAnomaly: summary.firstAnomaly,
      unobserved: summary.unobserved
    };
  } catch {
    return null;
  }
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
    const values = parsed.values as Values;
    // One place records every session-bound command of a `prepare --record` session (see explore.ts).
    const recording = await beginRecording(definition, name, values, positionals, deps);
    let output: CommandOutput;
    try {
      output = await definition.run({ name, values, positionals, deps, recording });
    } catch (error) {
      recording?.end({ ok: false, errorCode: asCliError(error).code });
      if (recording && name === 'finish') summarizeExploration(recording.recorder, values, deps);
      throw error;
    }
    recording?.end({ ok: !output.failure, errorCode: output.failure?.code ?? null });
    if (recording) {
      const exploration = name === 'finish' ? summarizeExploration(recording.recorder, values, deps) : null;
      output.data = { ...output.data, recording: { seq: recording.seq }, ...(exploration ? { exploration } : {}) };
    }
    if (output.failure) {
      return failure(name, new DeviceCliError(output.failure.code, output.failure.message), output.data);
    }
    return finish({ ok: true, command: name, exitCode: EXIT_CODES.OK, data: output.data }, `ldev ${name}: ok - ${output.summary}`);
  } catch (error) {
    return failure(name, asCliError(error));
  }
}
