import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();
const browserSafeCoreModules: { modules: { module: string }[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../scripts/lib/dashboard-browser-safe-core-modules.json", import.meta.url)), "utf8"),
);
const browserSafeCoreAliases = browserSafeCoreModules.modules.map(({ module }) => ({
  find: `@fusion/core/${module}`,
  replacement: fileURLToPath(new URL(`../../packages/core/src/${module}.ts`, import.meta.url)),
}));

/*
FNXC:DependencyGraphTests 2026-06-25-16:30:
The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, PHASE A)
quarantines plugin test files that construct a SQLite-backed store. The SQLite
runtime code is being deleted in this feature. Per the AGENTS.md flaky-test
deletion ratchet, these tests are quarantined on sight. Mirrored in
scripts/lib/test-quarantine.json.
*/
const quarantinedDependencyGraphTests = [
];

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fusion-plugin-examples\/dependency-graph\/dashboard-view$/,
        replacement: fileURLToPath(new URL("./src/dashboard-view.tsx", import.meta.url)),
      },
      {
        find: /^@fusion-plugin-examples\/dependency-graph$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      ...browserSafeCoreAliases,
      { find: "@fusion/core", replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)) },
      {
        find: "@fusion/plugin-sdk",
        replacement: fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
      },
      { find: "@fusion/dashboard", replacement: fileURLToPath(new URL("../../packages/dashboard", import.meta.url)) },
      {
        find: "lucide-react",
        replacement: fileURLToPath(new URL("../../packages/dashboard/node_modules/lucide-react", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...quarantinedDependencyGraphTests,
    ],
    environment: "jsdom",
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
  },
});
