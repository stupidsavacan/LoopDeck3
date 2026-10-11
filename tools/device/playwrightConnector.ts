import type { Page } from '@playwright/test';
import { elementProbe, type Locator } from './pageScripts.js';
import type { CdpBrowser, CdpConnector, CdpPage, ExpectTarget, LocateResult } from './webview.js';

type Role = Parameters<Page['getByRole']>[0];

const resolve = (page: Page, locator: Locator) =>
  'css' in locator ? page.locator(locator.css) : page.getByRole(locator.role as Role, { name: locator.name, exact: true });

function wrap(page: Page): CdpPage {
  return {
    playwrightPage: page,
    url: () => page.url(),
    evaluate: ((fn: unknown, arg: unknown) => page.evaluate(fn as (arg: unknown) => unknown, arg)) as CdpPage['evaluate'],
    mouseClick: (x, y) => page.mouse.click(x, y),
    async locate(locator, options): Promise<LocateResult> {
      let base;
      let total: number;
      let visible: number;
      try {
        base = resolve(page, locator);
        total = await base.count();
        visible = await base.filter({ visible: true }).count();
      } catch {
        return { total: 0, visible: 0, error: 'invalid locator' };
      }
      if (visible !== 1) return { total, visible, error: visible === 0 ? 'no visible match' : 'ambiguous: multiple visible matches' };
      const target = base.filter({ visible: true });
      if (options.scroll) await target.scrollIntoViewIfNeeded({ timeout: 3_000 });
      const measure = await target.evaluate(elementProbe, { points: options.points });
      return { total, visible, measure, error: measure.point ? undefined : 'target is outside the visible viewport' };
    },
    async countVisible(target: ExpectTarget): Promise<number> {
      try {
        const base = 'text' in target ? page.getByText(target.text, { exact: true }) : page.locator(target.css);
        return await base.filter({ visible: true }).count();
      } catch {
        return -1;
      }
    }
  };
}

/** Thin adapter over Playwright's connectOverCDP. Closing a connected browser only disconnects; the Android app keeps running. */
export const playwrightConnector: CdpConnector = {
  async connect(endpoint, timeoutMs): Promise<CdpBrowser> {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
    return {
      pages: () => browser.contexts().flatMap((context) => context.pages().map(wrap)),
      close: () => browser.close()
    };
  }
};
