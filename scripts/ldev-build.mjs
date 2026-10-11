// Content-addressed build of the ldev CLI. Every distinct source state compiles into its own
// directory, so a running CLI never has its files replaced or deleted by a concurrent build.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import ts from 'typescript';

const KEY_PATTERN = /^[0-9a-f]{16}$/;
const TEMP_PATTERN = /^\.tmp-[0-9a-f]{16}-\d+$/;
const MARKER = '.built';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Hash of the tsconfig and every *.ts source file (names + bytes). */
export function computeBuildKey(configPath, sourceDir) {
  const hash = createHash('sha256').update(ts.version).update('\0').update(readFileSync(configPath));
  for (const name of readdirSync(sourceDir).filter((file) => file.endsWith('.ts')).sort()) {
    hash.update(`\0${name}\0`).update(readFileSync(join(sourceDir, name)));
  }
  return hash.digest('hex').slice(0, 16);
}

/** Refuses any path that is not strictly inside `root` (guards every recursive removal). */
export function assertInside(root, child) {
  const base = resolve(root);
  const target = resolve(child);
  if (target === base || !target.startsWith(base + sep)) throw new Error(`Refusing to touch ${target}: not inside ${base}`);
  return target;
}

function removeInside(root, child) {
  rmSync(assertInside(root, child), { recursive: true, force: true });
}

/**
 * Removes only stale, name-validated build directories (old keys and abandoned temp dirs).
 * The current key is never touched, and nothing recent is removed, so a concurrent CLI that
 * is loading an older build keeps its files.
 */
export function pruneOldBuilds(outRoot, currentKey, nowMs = Date.now(), maxAgeMs = DAY_MS) {
  if (!existsSync(outRoot)) return [];
  const removed = [];
  for (const name of readdirSync(outRoot)) {
    if (name === currentKey || !(KEY_PATTERN.test(name) || TEMP_PATTERN.test(name))) continue;
    const path = join(outRoot, name);
    try {
      if (nowMs - statSync(path).mtimeMs < maxAgeMs) continue;
      removeInside(outRoot, path);
      removed.push(name);
    } catch {
      // best effort; another process may be using or removing it
    }
  }
  return removed;
}

/**
 * Returns the directory containing the compiled CLI for the current sources, compiling it
 * into a private temp directory first and publishing it with an atomic rename.
 */
export function ensureBuilt({ configPath, sourceDir, outRoot, onError }) {
  const key = computeBuildKey(configPath, sourceDir);
  const finalDir = join(outRoot, key);
  if (existsSync(join(finalDir, MARKER))) return finalDir;

  mkdirSync(outRoot, { recursive: true });
  const tempDir = join(outRoot, `.tmp-${key}-${process.pid}`);
  removeInside(outRoot, tempDir);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { outDir: tempDir, noEmit: false }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => onError(ts.flattenDiagnosticMessageText(d.messageText, '\n')) });
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const emitted = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics);
  if (diagnostics.length > 0 || emitted.emitSkipped) {
    removeInside(outRoot, tempDir);
    const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' };
    return onError(`TypeScript errors:\n${ts.formatDiagnostics(diagnostics, host)}`);
  }
  writeFileSync(join(tempDir, MARKER), `${key}\n`);
  try {
    renameSync(tempDir, finalDir);
  } catch (error) {
    // Another invocation published the same key first: use theirs, discard ours.
    removeInside(outRoot, tempDir);
    if (!existsSync(join(finalDir, MARKER))) throw error;
  }
  pruneOldBuilds(outRoot, key);
  return finalDir;
}
