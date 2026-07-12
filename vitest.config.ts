import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
