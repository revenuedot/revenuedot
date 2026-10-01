import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on :8787; /v1, /v2 and /auth are proxied so cookies stay same-origin.
export default defineConfig({
  plugins: [react()],
  server: { port: 5178, proxy: { "/v1": "http://localhost:8787", "/v2": "http://localhost:8787", "/auth": "http://localhost:8787", "/rcbilling": "http://localhost:8787", "/pay": "http://localhost:8787" } },
  build: { outDir: "dist", emptyOutDir: true },
});
