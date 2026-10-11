import { describe, expect, it, vi } from 'vitest';
import { playwrightConnector } from '../tools/device/playwrightConnector';

const fake = vi.hoisted(() => ({ error: new Error('Connection closed') }));
vi.mock('@playwright/test', () => ({
  chromium: {
    connectOverCDP: async () => ({
      contexts: () => [
        {
          pages: () => [
            {
              getByText: () => ({
                filter: () => ({
                  count: async () => {
                    throw fake.error;
                  }
                })
              }),
              locator: () => ({
                filter: () => ({
                  count: async () => {
                    throw fake.error;
                  }
                })
              })
            }
          ]
        }
      ],
      close: async () => {}
    })
  }
}));

describe('WebView expectation errors', () => {
  it.each([{ text: 'Ready' }, { css: '.ready' }])('reports a dropped connection as WEBVIEW: %s', async (target) => {
    fake.error = new Error('Target page, context or browser has been closed');
    const browser = await playwrightConnector.connect('http://127.0.0.1:1234', 1000);
    await expect(browser.pages()[0].countVisible(target)).rejects.toMatchObject({ code: 'WEBVIEW', exitCode: 4 });
  });

  it('still identifies a CSS parse error as invalid syntax', async () => {
    fake.error = new Error('Unexpected token "" while parsing css selector "["');
    const browser = await playwrightConnector.connect('http://127.0.0.1:1234', 1000);
    expect(await browser.pages()[0].countVisible({ css: '[' })).toBe(-1);
  });
});
