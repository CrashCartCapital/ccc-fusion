import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { scanFileContent } from "../check-no-node-only-core-imports-in-dashboard.mjs";

const file = "packages/dashboard/app/components/Fixture.tsx";
const allowlist = [
  "types",
  "near-duplicate-canonical",
  "task-merge",
  "model-pricing",
  "mobile-nav-primary-items",
  "active-merge-status",
  "workflow-settings-resolver",
  "settings-schema",
  "session-advisor",
  "blocker-fanout",
  "detect-content-language",
];

function violations(content) {
  return scanFileContent(content, file, { allowlist });
}

describe("check-no-node-only-core-imports-in-dashboard", () => {
  it("flags the near-duplicate browser-bundle regression and store imports", () => {
    const nearDuplicate = 'import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate";';
    const store = 'import { TaskStore } from "../../../core/src/store";';
    const sideEffect = 'import "../../../core/src/near-duplicate-canonical";';

    assert.equal(violations(nearDuplicate).length, 1);
    assert.equal(violations(store).length, 1);
    assert.equal(violations(sideEffect).length, 1);
  });

  it("flags nested relative core source imports", () => {
    const nested = 'import { schema } from "../../../core/src/postgres/schema";';

    assert.equal(violations(nested).length, 1);
  });

  it("flags whole-statement and inline type-only relative core imports", () => {
    const wholeStatement = 'import type { Foo } from "../../../core/src/near-duplicate-canonical";';
    const inlineSpecifier = 'import { type Foo } from "../../../core/src/near-duplicate-canonical";';

    assert.equal(violations(wholeStatement).length, 1);
    assert.equal(violations(inlineSpecifier).length, 1);
  });

  it("flags a mixed value and type import", () => {
    const source = 'import { type Foo, bar } from "../../../core/src/near-duplicate";';

    assert.equal(violations(source).length, 1);
  });

  it("flags dynamic template imports, including Vite-ignore imports", () => {
    const direct = 'await import(`../../../core/src/near-duplicate-canonical`);';
    const viteIgnored = 'await import(/* @vite-ignore */ `../../../core/src/near-duplicate-canonical`);';

    assert.equal(violations(direct).length, 1);
    assert.equal(violations(viteIgnored).length, 1);
  });

  it("flags type and value re-exports from relative core source", () => {
    const typeExport = 'export type { Foo } from "../../../core/src/near-duplicate-canonical";';
    const valueExport = 'export { bar } from "../../../core/src/near-duplicate-canonical";';

    assert.equal(violations(typeExport).length, 1);
    assert.equal(violations(valueExport).length, 1);
  });

  it("rejects reviewed relative leaves while allowing reviewed package subpaths", () => {
    const relativeLeaf = 'import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";';
    const packageLeaf = 'import { detectContentLanguage } from "@fusion/core/detect-content-language";';

    assert.equal(violations(relativeLeaf).length, 1);
    assert.deepEqual(violations(packageLeaf), []);
  });

  it("defines every reviewed package subpath as an explicit Vite source alias before the broad alias", () => {
    const modules = JSON.parse(readFileSync("scripts/lib/dashboard-browser-safe-core-modules.json", "utf8")).modules;
    const viteConfig = readFileSync("packages/dashboard/vite.config.ts", "utf8");
    const broadAliasIndex = viteConfig.indexOf('"@fusion/core":');

    assert.notEqual(broadAliasIndex, -1, "missing broad @fusion/core Vite alias");
    for (const { module } of modules) {
      const explicitAlias = `"@fusion/core/${module}": resolve(__dirname, "../core/src/${module}.ts")`;
      const explicitAliasIndex = viteConfig.indexOf(explicitAlias);
      assert.notEqual(explicitAliasIndex, -1, `missing explicit Vite source alias for @fusion/core/${module}`);
      assert.ok(explicitAliasIndex < broadAliasIndex, `@fusion/core/${module} must precede the broad @fusion/core alias`);
    }
  });

  it("ignores comment and string mentions of a forbidden specifier", () => {
    const source = [
      '// import { TaskStore } from "../../../core/src/store";',
      'const example = "import { TaskStore } from \\"../../../core/src/store\\"";',
      'const template = `export { TaskStore } from "../../../core/src/store"`; ',
    ].join("\n");

    assert.deepEqual(violations(source), []);
  });
});
