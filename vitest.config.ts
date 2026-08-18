import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Integration tests hit a live server and are opt-in via env:
    //   VIDEODRAFT_TEST_BASE_URL + VIDEODRAFT_TEST_TOKEN
    testTimeout: 20_000,
  },
});
