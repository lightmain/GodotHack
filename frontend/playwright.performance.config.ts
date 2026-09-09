import { defineConfig } from "@playwright/test";

const origin = "http://127.0.0.1:4177";

export default defineConfig({
  testDir: "./test/integration-tests/performance",
  outputDir: "./test-results/playwright-performance",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `${origin}/`,
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4177 --strictPort",
    url: `${origin}/test/integration-tests/performance/inventory-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
