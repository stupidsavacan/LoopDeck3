export function computeBuildKey(configPath: string, sourceDir: string): string;
export function assertInside(root: string, child: string): string;
export function pruneOldBuilds(outRoot: string, currentKey: string, nowMs?: number, maxAgeMs?: number): string[];
export function ensureBuilt(options: { configPath: string; sourceDir: string; outRoot: string; onError: (message: string) => never }): string;
