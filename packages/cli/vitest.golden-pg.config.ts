import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";

const merged = mergeConfig(baseConfig, defineConfig({
  test: {
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
  },
}));

merged.test = {
  ...merged.test,
  globalSetup: [resolve(__dirname, "../core/src/__test-utils__/pg-gate-global-setup.ts")],
};

export default merged;
