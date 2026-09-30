import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5199);

/** Runs against e2e/server.ts: the real API on an in-memory database plus the built dashboard (see e2e/README.md). */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: {
    command: `PORT=${PORT} tsx e2e/server.ts`,
    cwd: new URL("..", import.meta.url).pathname,
    // 503 while the server seeds its data, 200 when it is ready.
    url: `http://localhost:${PORT}/__ready`,
    stdout: "pipe",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
