import { defineConfig } from "drizzle-kit";
// The enterprise tables (ee/server/schema.ts, ee/LICENSE) are listed too, so later migrations keep them (migration 0025).
export default defineConfig({ dialect: "postgresql", schema: ["./src/schema.ts", "../../ee/server/schema.ts"], out: "./migrations" });
