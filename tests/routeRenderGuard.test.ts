import { screenContext } from './support/screenContext';
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attempt } from '../src/core/models';
import { resolveActivePacks } from '../src/packs/packResolver';
import { renderGraphsScreen } from '../src/screens/graphsScreen';
import { studyStore } from '../src/storage/studyRepository';
import { RouteRenderCoordinator } from '../src/ui/routeRenderGuard';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('route render ownership', () => {
  it('keeps a delayed stale route from replacing a newer fast route or its loading state', async () => {
    vi.useFakeTimers();
    const coordinator = new RouteRenderCoordinator();
    const root = document.createElement('div');
    root.textContent = 'previous';

    const render = async (label: string, delayMs: number) => {
      const lease = coordinator.begin();
      const loadingTimer = window.setTimeout(() => {
        if (lease.isCurrent()) root.textContent = `loading:${label}`;
      }, 2000);
      try {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
        if (lease.isCurrent()) root.textContent = label;
      } finally {
        window.clearTimeout(loadingTimer);
      }
    };

    const slowA = render('A', 3000);
    await vi.advanceTimersByTimeAsync(100);
    const fastB = render('B', 10);
    await vi.advanceTimersByTimeAsync(10);

    expect(root.textContent).toBe('B');

    await vi.advanceTimersByTimeAsync(2890);
    await Promise.all([slowA, fastB]);
    expect(root.textContent).toBe('B');
  });

  it('preserves the two-second loading threshold for the active route', async () => {
    vi.useFakeTimers();
    const coordinator = new RouteRenderCoordinator();
    const root = document.createElement('div');
    root.textContent = 'previous';
    const lease = coordinator.begin();
    const loadingTimer = window.setTimeout(() => {
      if (lease.isCurrent()) root.textContent = 'loading';
    }, 2000);

    await vi.advanceTimersByTimeAsync(1999);
    expect(root.textContent).toBe('previous');
    await vi.advanceTimersByTimeAsync(1);
    expect(root.textContent).toBe('loading');

    window.clearTimeout(loadingTimer);
  });

  it('prevents an async screen from clearing the root after its lease becomes stale', async () => {
    let resolveAttempts!: (attempts: Attempt[]) => void;
    const delayedAttempts = new Promise<Attempt[]>((resolve) => {
      resolveAttempts = resolve;
    });
    vi.spyOn(studyStore, 'getAttempts').mockReturnValueOnce(delayedAttempts);

    const root = document.createElement('div');
    root.textContent = 'newer route';
    let current = true;
    const pending = renderGraphsScreen(screenContext({ root: root, catalog: resolveActivePacks([]), isCurrent: () => current, navigation: { home: () => {}, review: () => {} } })
    );

    current = false;
    resolveAttempts([]);
    await pending;

    expect(root.textContent).toBe('newer route');
  });
});
