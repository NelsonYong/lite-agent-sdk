import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/compat/**/*.smoke.ts"],
    testTimeout: 120_000,
  },
});
