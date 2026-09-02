import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";

const merged = mergeConfig(baseConfig, defineConfig({
  test: {
    maxWorkers: 1,
    minWorkers: 1,
    // A controller verifier can legitimately use the full 30-minute project
    // limit plus its termination grace. Keep the outer test guard longer so it
    // detects a true orphan instead of pre-failing a still-bounded verifier.
    env: {
      FUSION_TEST_SUBPROCESS_TIMEOUT_MS: "1830000",
    },
  },
}));

merged.test = {
  ...merged.test,
  globalSetup: [resolve(__dirname, "../core/src/__test-utils__/pg-gate-global-setup.ts")],
};

export default merged;
