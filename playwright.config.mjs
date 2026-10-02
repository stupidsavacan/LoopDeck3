import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './qa',
  testMatch: '**/*.qa.mjs',
  timeout: 120_000,
  workers: 2,
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: process.env.QA_REPORT_DIR || 'qa-report', open: 'never' }], ['json', { outputFile: `${process.env.QA_RESULTS_DIR || 'qa-results'}/results.json` }]],
  outputDir: `${process.env.QA_RESULTS_DIR || 'qa-results'}/artifacts`,
  use: {
    channel: process.env.QA_BROWSER || 'chrome',
    headless: !process.env.QA_HEADED,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
});
