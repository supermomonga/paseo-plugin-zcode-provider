import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@getpaseo/plugin/provider": fileURLToPath(
        new URL("./vendor/paseo/provider.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["server/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 10000,
  },
});
