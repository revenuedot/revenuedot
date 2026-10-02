// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: vitest setup for the route coverage report (scripts/e2e/journeys/coverage.ts). With
// REVENUEDOT_TEST_REQUEST_LOG=<file>, every request a test builds for the app under test (http://localhost/... or a reserved *.test host) is
// appended to <file> as { file, method, path }. Outbound calls the tests stub (real hosts) are not logged. Off otherwise.
import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { expect } from "vitest";

const log = process.env.REVENUEDOT_TEST_REQUEST_LOG;
if (log) {
  const Original = globalThis.Request;
  class LoggedRequest extends Original {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init);
      try {
        const u = new URL(this.url);
        // localhost, or a reserved .test host (tests that run two servers name them source.test, target.test).
        if (u.hostname === "localhost" || u.hostname.endsWith(".test")) {
          const file = relative(process.cwd(), expect.getState().testPath ?? "");
          appendFileSync(log!, `${JSON.stringify({ file, method: this.method, path: u.pathname })}\n`);
        }
      } catch { /* not a URL we log */ }
    }
  }
  globalThis.Request = LoggedRequest as typeof Request;
}
