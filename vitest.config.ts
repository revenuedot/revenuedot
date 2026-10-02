import { defineConfig } from "vitest/config";
// REVENUEDOT_TEST_PG_URL=<a Postgres server> runs every test on real Postgres (one database per test file, dropped at the
// end; see packages/contract/src/test-db.ts). Unset, tests use in-memory PGlite. Each query then crosses the network,
// so tests and hooks get more time.
const realPg = Boolean(process.env.REVENUEDOT_TEST_PG_URL?.trim());
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "ee/test/**/*.test.ts"],
    testTimeout: realPg ? 180_000 : 30_000,
    hookTimeout: realPg ? 180_000 : 10_000,
    globalSetup: ["./packages/contract/src/pg-global-setup.ts"],
    // REVENUEDOT_TEST_REQUEST_LOG=<file> records the routes each test calls (route coverage report).
    setupFiles: ["./packages/contract/src/request-log-setup.ts"],
  },
});
