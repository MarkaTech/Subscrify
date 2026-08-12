import { defineConfig } from "vitest/config";

// Standalone Vitest config: unit tests are pure Node and must not load the
// Remix/Shopify Vite plugins (they expect a full app dev environment).
export default defineConfig({
  test: {
    // .tsx too: the legal-page Markdown renderer returns React elements, and
    // its test asserts on that element tree. Still pure Node — nothing here
    // touches a DOM.
    include: ["app/**/*.test.ts", "app/**/*.test.tsx", "workers/**/*.test.ts"],
    environment: "node",
  },
});
