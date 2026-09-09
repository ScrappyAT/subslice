import { defineConfig } from "vitest/config";

// Vitest resolves modules through Vite, not tsc, so tsconfig's "paths"
// alias (@/* -> project root) has no effect here on its own — route files
// under app/ use that alias internally, so their tests need the same
// mapping or every "@/lib/..." import inside them fails to resolve.
export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
});
