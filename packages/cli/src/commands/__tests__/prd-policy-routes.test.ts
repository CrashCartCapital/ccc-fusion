import { describe, expect, it } from "vitest";

import {
  parseProductPolicyRoutesFileContents,
  PrdProductRoutesFileError,
} from "../prd-policy-routes.js";

describe("CCC PRD product policy routes", () => {
  it("preserves a sealed combo terminal-member allowlist for canonical policy validation", () => {
    const routesFilePath = "/packet/routes.json";
    const raw = JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        "task-a": {
          providerId: "golden-omniroute-glm-latest",
          modelId: "combo/glm-latest",
          transport: "pi",
          receiptAdapterId: "terminal-route-sse-comments.v1",
          terminalRouteMembers: [
            { provider: "glm", model: "glm-5.3" },
            { provider: "minimax", model: "MiniMax-M3" },
          ],
        },
      },
    });

    expect(parseProductPolicyRoutesFileContents(raw, routesFilePath)).toEqual({
      "task-a": {
        providerId: "golden-omniroute-glm-latest",
        modelId: "combo/glm-latest",
        transport: "pi",
        receiptAdapterId: "terminal-route-sse-comments.v1",
        terminalRouteMembers: [
          { provider: "glm", model: "glm-5.3" },
          { provider: "minimax", model: "MiniMax-M3" },
        ],
      },
    });
  });

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

  it.each([
    ["non-canonical member", [
      { provider: " glm", model: "glm-5.3" },
    ], /exact canonical provider and model/u],
    ["duplicate member", [
      { provider: "glm", model: "glm-5.3" },
      { provider: "glm", model: "glm-5.3" },
    ], /duplicate terminal route member/u],
  ])("refuses a %s in the immediate routes-file boundary", (_label, terminalRouteMembers, error) => {
    const routesFilePath = "/packet/routes.json";
    const raw = JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        "task-a": {
          providerId: "golden-omniroute-glm-latest",
          modelId: "combo/glm-latest",
          transport: "pi",
          receiptAdapterId: "terminal-route-sse-comments.v1",
          terminalRouteMembers,
        },
      },
    });

    expect(() => parseProductPolicyRoutesFileContents(raw, routesFilePath)).toThrow(error);
  });
});
