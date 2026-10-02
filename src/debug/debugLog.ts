export type DebugLogLevel = 'info' | 'warn' | 'error';

export interface DebugLogEntry {
  id: string;
  timestamp: string;
  level: DebugLogLevel;
  area: string;
  code?: string;
  userMessage?: string;
  detail?: string;
  stack?: string;
  route?: string;
  userAgent?: string;
  context?: Record<string, unknown>;
}

const DEBUG_LOG_KEY = 'loopdeck3.diagnostics';
const MAX_DEBUG_LOGS = 200;
let globalLoggingRegistered = false;

function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    // Ignore and use fallback.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function safeUserAgent(): string | undefined {
  try {
    return navigator.userAgent;
  } catch {
    return undefined;
  }
}

function safeRoute(): string | undefined {
  try {
    return window.location.hash || '#home';
  } catch {
    return undefined;
  }
}

function readStoredLogs(): DebugLogEntry[] {
  try {
    const raw = localStorage.getItem(DEBUG_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is DebugLogEntry => {
      if (typeof entry !== 'object' || entry === null) return false;
      const record = entry as Partial<DebugLogEntry>;
      return typeof record.id === 'string' && typeof record.timestamp === 'string' && typeof record.level === 'string' && typeof record.area === 'string';
    });
  } catch {
    return [];
  }
}

export function writeDebugLog(entry: Omit<DebugLogEntry, 'id' | 'timestamp' | 'userAgent'>): void {
  try {
    const next: DebugLogEntry = {
      ...entry,
      id: makeId(),
      timestamp: new Date().toISOString(),
      route: entry.route ?? safeRoute(),
      userAgent: safeUserAgent()
    };
    const logs = [next, ...readStoredLogs()].slice(0, MAX_DEBUG_LOGS);
    localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(logs));
  } catch {
    // Debug logging must never break the main app.
  }
}

export function readDebugLogs(): DebugLogEntry[] {
  return readStoredLogs().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function clearDebugLogs(): void {
  try {
    localStorage.removeItem(DEBUG_LOG_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function formatDebugLogsForCopy(logs: DebugLogEntry[] = readDebugLogs()): string {
  if (!logs.length) return 'LoopDeck debug log: no entries';
  return logs.map((log) => {
    const lines = [
      `[${log.timestamp}] ${log.level.toUpperCase()} / ${log.area}`,
      log.code ? `code: ${log.code}` : undefined,
      log.userMessage ? `userMessage: ${log.userMessage}` : undefined,
      log.detail ? `detail: ${log.detail}` : undefined,
      log.route ? `route: ${log.route}` : undefined,
      log.userAgent ? `userAgent: ${log.userAgent}` : undefined,
      log.context ? `context: ${JSON.stringify(log.context)}` : undefined,
      log.stack ? `stack:\n${log.stack}` : undefined
    ].filter((line): line is string => Boolean(line));
    return lines.join('\n');
  }).join('\n\n---\n\n');
}

function stackFromReason(reason: unknown): string | undefined {
  if (reason instanceof Error) return reason.stack;
  return undefined;
}

export function registerGlobalErrorLogging(): void {
  if (globalLoggingRegistered) return;
  globalLoggingRegistered = true;

  window.addEventListener('error', (event) => {
    writeDebugLog({
      level: 'error',
      area: 'global',
      code: 'GLOBAL-ERROR',
      userMessage: event.message || 'Unhandled window error',
      detail: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
      stack: stackFromReason(event.error),
      context: { lineno: event.lineno, colno: event.colno }
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    writeDebugLog({
      level: 'error',
      area: 'global',
      code: 'GLOBAL-REJECTION',
      userMessage: reason instanceof Error ? reason.message : 'Unhandled promise rejection',
      detail: reason instanceof Error ? reason.name : String(reason),
      stack: stackFromReason(reason)
    });
  });
}
