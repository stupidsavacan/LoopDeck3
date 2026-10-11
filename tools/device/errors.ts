export type ErrorCode =
  | 'USAGE'
  | 'UNSAFE'
  | 'SESSION'
  | 'LOCK'
  | 'IDENTITY'
  | 'ADB'
  | 'UI'
  | 'WEBVIEW'
  | 'GEOMETRY'
  | 'TIMEOUT'
  | 'CHECK_FAILED'
  | 'INCOMPLETE'
  | 'CLEANUP_FAILED'
  | 'INTERNAL';

/** Process exit status per error class; scripts can branch on these without parsing JSON. */
export const EXIT_CODES: Record<ErrorCode | 'OK', number> = {
  OK: 0,
  CHECK_FAILED: 1,
  USAGE: 2,
  UNSAFE: 3,
  SESSION: 3,
  LOCK: 3,
  IDENTITY: 3,
  ADB: 4,
  UI: 4,
  WEBVIEW: 4,
  GEOMETRY: 4,
  TIMEOUT: 4,
  CLEANUP_FAILED: 4,
  INCOMPLETE: 5,
  INTERNAL: 70
};

export class DeviceCliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DeviceCliError';
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function asCliError(error: unknown): DeviceCliError {
  if (error instanceof DeviceCliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DeviceCliError('INTERNAL', message);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeviceCliError('TIMEOUT', `${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
