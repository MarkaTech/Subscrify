import { defineConfig } from "vitest/config";

// Standalone Vitest config: unit tests are pure Node and must not load the
// Remix/Shopify Vite plugins (they expect a full app dev environment).
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts", "workers/**/*.test.ts"],
    environment: "node",
  },
});
