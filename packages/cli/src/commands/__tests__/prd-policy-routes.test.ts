import { describe, expect, it } from "vitest";

import {
  parseProductPolicyRoutesFileContents,
  PrdProductRoutesFileError,
} from "../prd-policy-routes.js";

describe("CCC PRD product policy routes", () => {
  it("refuses a cli-transport route entry that omits cliAdapterId", () => {
    const routesFilePath = "/packet/routes.json";
    const raw = JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        "task-a": { providerId: "x", modelId: "y", transport: "pi" },
        "task-b": { providerId: "x", modelId: "y", transport: "cli" },
      },
    });

    expect(() => parseProductPolicyRoutesFileContents(raw, routesFilePath)).toThrowError(
      expect.objectContaining({
        name: PrdProductRoutesFileError.name,
        code: "CCC_PRD_ROUTES_FILE_INVALID",
        message: expect.stringContaining(routesFilePath),
      }),
    );
    expect(() => parseProductPolicyRoutesFileContents(raw, routesFilePath)).toThrow(/task-b/u);
  });
});
