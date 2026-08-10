import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
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

function assertParseValid(sources) {
  for (const source of sources) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    assert.deepEqual(
      sourceFile.parseDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
      [],
      source,
    );
  }
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

  it("flags nested package value imports", () => {
    const nested = 'import { schema } from "@fusion/core/postgres/schema";';

    assert.equal(violations(nested).length, 1);
  });

  it("flags package value imports whose dot segments escape the core prefix", () => {
    const source = 'import { TaskStore } from "@fusion/core/../store";';

    assertParseValid([source]);
    assert.equal(violations(source).length, 1);
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

  it("flags forbidden literals when comments separate import and export tokens", () => {
    const sources = [
      'import/* static */{ TaskStore }/* clause */from/* module */"../../../core/src/store";',
      'import/* side effect */"../../../core/src/store";',
      'export/* static */{ TaskStore }/* clause */from/* module */"../../../core/src/store";',
      'await import/* call */(/* before */"../../../core/src/store"/* after */);',
    ];

    assertParseValid(sources);
    assert.deepEqual(sources.map((source) => violations(source).length), [1, 1, 1, 1]);
  });

  it("flags literal dynamic imports with comments, options, and a trailing comma", () => {
    const source = 'await import(/* before */"../../../core/src/store"/* after */, { with: { type: "json" } },);';

    assertParseValid([source]);
    assert.equal(violations(source).length, 1);
  });

  it("classifies module literals after stripping query and hash suffixes", () => {
    const relativeQuery = 'import { TaskStore } from "../../../core/src/store?worker";';
    const packageHash = 'import { TaskStore } from "@fusion/core/store#browser";';
    const reviewedPackageQuery = 'import { detectContentLanguage } from "@fusion/core/detect-content-language?worker";';

    assertParseValid([relativeQuery, packageHash, reviewedPackageQuery]);
    assert.equal(violations(relativeQuery).length, 1);
    assert.equal(violations(packageHash).length, 1);
    assert.deepEqual(violations(reviewedPackageQuery), []);
  });

  it("flags escaped slash spellings by their cooked module literal", () => {
    const source = String.raw`import { TaskStore } from "..\/..\/..\/core\/src\/store";`;

    assertParseValid([source]);
    assert.equal(violations(source).length, 1);
  });

  it("flags normalized paths that resolve under core source", () => {
    const sources = [
      'import { TaskStore } from "../../../core/./src/store";',
      'import { TaskStore } from "../../../core//src/store";',
      'import { TaskStore } from "../../../core/unused/../src/store";',
    ];

    assertParseValid(sources);
    assert.deepEqual(sources.map((source) => violations(source).length), [1, 1, 1]);
  });

  it("finds literal dynamic imports nested inside template interpolations", () => {
    const source = 'const value = `prefix ${import("../../../core/src/store")}`;';

    assertParseValid([source]);
    assert.equal(violations(source).length, 1);
  });

  it("preserves type-only package imports while rejecting relative import types", () => {
    const allowed = [
      'import type { TaskStore } from "@fusion/core/store";',
      'import { type TaskStore } from "@fusion/core/store";',
      'export type { TaskStore } from "@fusion/core/store";',
      'export { type TaskStore } from "@fusion/core/store";',
      'type Store = import("@fusion/core/store").TaskStore;',
    ];
    const relativeImportType = 'type Store = import("../../../core/src/store").TaskStore;';

    assertParseValid([...allowed, relativeImportType]);
    assert.ok(allowed.every((source) => violations(source).length === 0));
    assert.equal(violations(relativeImportType).length, 1);
  });

  it("ignores computed dynamic module paths", () => {
    const sources = [
      'const modulePath = "../../../core/src/store"; void import(modulePath);',
      'const leaf = "store"; void import(`../../../core/src/${leaf}`);',
    ];

    assertParseValid(sources);
    assert.ok(sources.every((source) => violations(source).length === 0));
  });

  it("preserves source line and snippet diagnostics", () => {
    const source = [
      "const safe = true;",
      'await import/* call */("../../../core/src/store", { with: { type: "json" } });',
    ].join("\n");

    assertParseValid([source]);
    assert.deepEqual(violations(source), [{
      type: "node-only-core-import",
      filePath: file,
      lineNumber: 2,
      line: 'await import/* call */("../../../core/src/store", { with: { type: "json" } });',
      specifier: "../../../core/src/store",
      module: "store",
    }]);
  });

  it("rejects reviewed relative leaves while allowing reviewed package subpaths", () => {
    const relativeLeaf = 'import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";';
    const packageLeaf = 'import { detectContentLanguage } from "@fusion/core/detect-content-language";';

    assert.equal(violations(relativeLeaf).length, 1);
    assert.deepEqual(violations(packageLeaf), []);
  });

  it("normalizes reviewed package subpaths and preserves package-root imports", () => {
    const normalizedReviewed = 'import { detectContentLanguage } from "@fusion/core/./detect-content-language";';
    const packageRootValue = 'import { Task } from "@fusion/core";';
    const packageRootType = 'import type { Task } from "@fusion/core";';

    assertParseValid([normalizedReviewed, packageRootValue, packageRootType]);
    assert.deepEqual(violations(normalizedReviewed), []);
    assert.deepEqual(violations(packageRootValue), []);
    assert.deepEqual(violations(packageRootType), []);
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
