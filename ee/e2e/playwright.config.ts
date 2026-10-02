// RevenueDot Enterprise (ee/LICENSE). Browser tests for the enterprise features: ee/e2e/server.ts (the real API on a
// Railway development Postgres, the built dashboard, the local test identity provider). Run with ee/e2e/run.sh.
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5462);
const IDP_PORT = Number(process.env.E2E_IDP_PORT ?? PORT + 1);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: {
    command: `PORT=${PORT} IDP_PORT=${IDP_PORT} npx tsx ee/e2e/server.ts`,
    cwd: new URL("../..", import.meta.url).pathname,
    url: `http://localhost:${PORT}/__ready`,
    stdout: "pipe",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
