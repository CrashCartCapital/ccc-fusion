import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";

const merged = mergeConfig(baseConfig, defineConfig({
  test: {
    maxWorkers: 1,
    minWorkers: 1,
    // Installed whole-product commands can legitimately run behind long model
    // and PostgreSQL work; keep this guard generous while remaining finite.
    env: {
      FUSION_TEST_SUBPROCESS_TIMEOUT_MS: "600000",
    },
  },
}));

merged.test = {
  ...merged.test,
  globalSetup: [resolve(__dirname, "../core/src/__test-utils__/pg-gate-global-setup.ts")],
};

export default merged;
