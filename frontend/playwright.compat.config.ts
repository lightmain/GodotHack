import { defineConfig, devices } from "@playwright/test";

const deploymentBasePath = "/BlissHack/";
const previewOrigin = "http://127.0.0.1:4176";
const basicFlowNames = [
  "plays through startup and routes terminal UI input",
  "enumerates a persisted save after returning home and refreshing",
  "exports, previews, imports, and restores a complete profile",
  "exports, clears, and restores a complete BlissHack backup",
  "exports, deletes, imports, and continues identical raw save bytes",
  "blocks a second game and retries after the owning page closes",
].join("|");

export default defineConfig({
  testDir: "./test/integration-tests/browser",
  outputDir: "./test-results/playwright-compat",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  grep: new RegExp(basicFlowNames),
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `${previewOrigin}${deploymentBasePath}`,
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: `VITE_BASE_PATH=${deploymentBasePath} npm run build && VITE_BASE_PATH=${deploymentBasePath} npm run preview -- --host 127.0.0.1 --port 4176 --strictPort`,
    url: `${previewOrigin}${deploymentBasePath}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
