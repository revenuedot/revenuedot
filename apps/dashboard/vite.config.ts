import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// In development the API runs on :8787; /v1, /v2 and /auth are proxied so cookies stay same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@/` is where the ai-elements and shadcn components live (components.json).
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5178, proxy: { "/v1": "http://localhost:8787", "/v2": "http://localhost:8787", "/auth": "http://localhost:8787", "/rcbilling": "http://localhost:8787", "/pay": "http://localhost:8787", "/share": "http://localhost:8787", "/agents": { target: "ws://localhost:8787", ws: true } } },
  build: { outDir: "dist", emptyOutDir: true },
});
