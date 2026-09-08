import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "test/**/*.test.ts", "test/**/*.test.mjs"],
    testTimeout: 10000,
  },
});
