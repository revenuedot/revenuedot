// Guards the self-host configuration and the repo's own claims against drift.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("self-host configuration", () => {
  it("docker compose passes the response-signing key to the server (empty default) and .env.example documents it", () => {
    expect(read("docker-compose.yml")).toMatch(/^\s+REVENUEDOT_SIGNING_KEY: \$\{REVENUEDOT_SIGNING_KEY:-\}$/m);
    expect(read(".env.example")).toMatch(/^# REVENUEDOT_SIGNING_KEY=$/m);
  });

  it("every environment variable the Node entry reads is passed by docker compose or documented in .env.example", () => {
    const vars = new Set([...read("apps/server/src/entry.node.ts").matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]!));
    vars.add("REVENUEDOT_SIGNING_KEY"); // read by services/signing.ts through globalThis.process
    const compose = read("docker-compose.yml");
    const example = read(".env.example");
    for (const v of vars) {
      if (v === "DASHBOARD_DIST") continue; // set by the Dockerfile
      expect(compose.includes(`${v}:`) || example.includes(`${v}=`), v).toBe(true);
    }
  });

  it("the image's start command finds pnpm without downloading it (corepack install in the final stage)", () => {
    const final = read("Dockerfile").split(/^FROM /m).pop()!;
    expect(final).toMatch(/^CMD \["pnpm",/m);
    expect(final).toMatch(/^RUN corepack install$/m);
    expect(final.indexOf("RUN corepack install")).toBeGreaterThan(final.indexOf("COPY --from=build /app /app"));
    expect(JSON.parse(read("package.json")).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });
});

describe("repo documentation", () => {
  it("README states the real number of SDK and webhook fixtures", () => {
    const count = (dir: string) => readdirSync(join(root, "packages/contract/fixtures", dir)).filter((f) => f.endsWith(".json")).length;
    const sdk = count("ios") + count("android");
    expect(read("README.md")).toContain(`(${sdk} request and response samples, plus ${count("webhooks")} webhook samples)`);
  });

  it("LICENSING.md names paths that exist, and the MIT CLI ships its own LICENSE", () => {
    const text = read("LICENSING.md");
    for (const [, dir] of text.matchAll(/"((?:packages|apps|ee)\/[^"]*)"/g)) {
      expect(existsSync(join(root, dir!)), dir).toBe(true);
    }
    expect(JSON.parse(read("packages/importer/package.json")).license).toBe("MIT");
    expect(read("packages/importer/LICENSE")).toMatch(/^MIT License/);
  });
});
