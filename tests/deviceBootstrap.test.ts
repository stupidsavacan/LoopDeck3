import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertInside, computeBuildKey, ensureBuilt, pruneOldBuilds } from '../scripts/ldev-build.mjs';
import { tempDir } from './helpers/deviceFakes';

function project(source = 'export const value = 1;\n') {
  const dir = tempDir('ldev-build-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        types: [],
        rootDir: 'src'
      },
      include: ['src/**/*.ts']
    })
  );
  writeFileSync(join(dir, 'src', 'main.ts'), source);
  const options = {
    configPath: join(dir, 'tsconfig.json'),
    sourceDir: join(dir, 'src'),
    outRoot: join(dir, 'out'),
    onError: (message: string): never => {
      throw new Error(message);
    }
  };
  return { dir, options };
}

describe('content-addressed CLI build', () => {
  it('compiles into a key directory once and reuses it', () => {
    const { options } = project();
    const first = ensureBuilt(options);
    expect(first).toBe(join(options.outRoot, computeBuildKey(options.configPath, options.sourceDir)));
    expect(readFileSync(join(first, 'main.js'), 'utf8')).toContain('value = 1');
    const stamp = statSync(join(first, 'main.js')).mtimeMs;
    expect(ensureBuilt(options)).toBe(first);
    expect(statSync(join(first, 'main.js')).mtimeMs).toBe(stamp);
  }, 60_000);

  it('never replaces or deletes the build another process may be loading when sources change', () => {
    const { dir, options } = project();
    const first = ensureBuilt(options);
    writeFileSync(join(dir, 'src', 'main.ts'), 'export const value = 2;\n');
    const second = ensureBuilt(options);
    expect(second).not.toBe(first);
    expect(readFileSync(join(first, 'main.js'), 'utf8')).toContain('value = 1');
    expect(readFileSync(join(second, 'main.js'), 'utf8')).toContain('value = 2');
  }, 60_000);

  it('reports type errors, publishes nothing, and leaves no temp directory', () => {
    const { options } = project('export const value: number = "no";\n');
    expect(() => ensureBuilt(options)).toThrowError(/TypeScript errors/);
    expect(existsSync(options.outRoot) ? readdirSync(options.outRoot) : []).toEqual([]);
  }, 60_000);
});

describe('recursive removal safety', () => {
  it('refuses any path that is not strictly inside the output root', () => {
    const root = join(tempDir(), 'out');
    expect(() => assertInside(root, root)).toThrow(/not inside/);
    expect(() => assertInside(root, join(root, '..'))).toThrow(/not inside/);
    expect(() => assertInside(root, `${root}-evil`)).toThrow(/not inside/);
    expect(() => assertInside(root, join(root, '..', 'elsewhere'))).toThrow(/not inside/);
    expect(assertInside(root, join(root, 'abc'))).toBe(join(root, 'abc'));
  });

  it('prunes only stale, name-validated build directories and never the current or recent ones', () => {
    const root = join(tempDir(), 'out');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const names = {
      current: 'a'.repeat(16),
      stale: 'b'.repeat(16),
      recent: 'c'.repeat(16),
      staleTemp: `.tmp-${'d'.repeat(16)}-99`,
      unrelated: 'keep-me'
    };
    for (const name of Object.values(names)) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'file'), 'x');
    }
    for (const name of [names.current, names.stale, names.staleTemp, names.unrelated]) utimesSync(join(root, name), old, old);
    const removed = pruneOldBuilds(root, names.current);
    expect(removed.sort()).toEqual([names.stale, names.staleTemp].sort());
    expect(readdirSync(root).sort()).toEqual([names.current, names.recent, names.unrelated].sort());
  });
});
