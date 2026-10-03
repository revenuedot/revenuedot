import { defineConfig } from "@playwright/test";
import { createServer } from "node:net";

/** True when nothing listens on the port (checked on every interface, like the e2e server binds). */
function free(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer().once("error", () => done(false)).once("listening", () => s.close(() => done(true)));
    s.listen(port);
  });
}

/**
 * The e2e server takes PORT and the Cloud server PORT + 1 (e2e/cloud-server.ts). E2E_PORT pins them; without it a free
 * pair is picked, so parallel runs (other agents, other worktrees) never reach another run's server. The choice goes
 * into process.env, which Playwright's worker processes inherit and the specs read (moves.spec.ts and others).
 */
async function pickPort(): Promise<number> {
  const pinned = process.env.E2E_PORT;
  // A server you started yourself (E2E_BASE_URL): the specs that build URLs from E2E_PORT use its port.
  if (!pinned && process.env.E2E_BASE_URL) return Number(new URL(process.env.E2E_BASE_URL).port || 5199);
  if (pinned) {
    const port = Number(pinned);
    if (!Number.isInteger(port) || port < 1 || port > 65534) throw new Error(`E2E_PORT=${pinned} is not a port number.`);
    if (!process.env.E2E_BASE_URL && !process.env.E2E_PORT_CHECKED && !(await free(port) && await free(port + 1))) {
      throw new Error(`E2E_PORT=${port}: port ${port} or ${port + 1} is already in use (another e2e server?). Unset E2E_PORT to pick a free port, choose another E2E_PORT, or set E2E_BASE_URL to test a server you started yourself.`);
    }
    return port;
  }
  // Below the systems' outgoing-connection ranges (Linux from 32768, macOS from 49152).
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    if (await free(port) && await free(port + 1)) return port;
  }
  throw new Error("No free port pair found for the e2e server. Set E2E_PORT to a free port (it also uses E2E_PORT + 1).");
}

const PORT = await pickPort();
// Worker processes load this file again with the same environment: the port is then the run's own server, not a clash.
process.env.E2E_PORT = String(PORT);
process.env.E2E_PORT_CHECKED = "1";
/** E2E_BASE_URL: run against an e2e server you started yourself (for example on a Railway development database). */
const EXTERNAL = process.env.E2E_BASE_URL;

/** Runs against e2e/server.ts: the real API on an in-memory database plus the built dashboard (see e2e/README.md). */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // CI (.github/workflows/ci.yml, job e2e): failures also show as annotations on the pull request.
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: { baseURL: EXTERNAL ?? `http://localhost:${PORT}`, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: EXTERNAL ? undefined : {
    command: `PORT=${PORT} tsx e2e/server.ts`,
    cwd: new URL("..", import.meta.url).pathname,
    // 503 while the server seeds its data, 200 when it is ready.
    url: `http://localhost:${PORT}/__ready`,
    stdout: "pipe",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
