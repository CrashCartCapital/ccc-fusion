import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCccPrdImportTestBundle,
  rehashCccPrdImportTestBundle,
} from "../__test-utils__/ccc-prd-import-fixture.js";
import { assertCccPrdImportBundle } from "../ccc-prd/import-admission.js";

describe("CCC PRD import admission boundaries", () => {
  it("requires declared controller .fusion custody separately from narrow model roots", () => {
    const targetRoot = "/tmp/ccc-prd-import-admission-narrow-roots";
    const fixture = createCccPrdImportTestBundle(targetRoot, "narrow-roots");
    const narrowBundle = rehashCccPrdImportTestBundle({
      ...fixture,
      admittedWriteRoots: [{
        path: join(targetRoot, "src", "only-model-file.ts"),
        purpose: "model candidate output",
      }],
    });

    expect(() => assertCccPrdImportBundle(narrowBundle, targetRoot, "idem-narrow-roots"))
      .toThrow(/output is outside admitted write roots/u);

    const controllerCustodiedBundle = rehashCccPrdImportTestBundle({
      ...narrowBundle,
      admittedWriteRoots: [
        {
          path: join(targetRoot, ".fusion"),
          purpose: "Fusion-managed campaign state and artifacts",
        },
        ...narrowBundle.admittedWriteRoots,
      ],
    });

    expect(() => assertCccPrdImportBundle(controllerCustodiedBundle, targetRoot, "idem-controller-root"))
      .not.toThrow();
  });
});
