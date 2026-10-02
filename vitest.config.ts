import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "ee/test/**/*.test.ts"], testTimeout: 30000 } });
