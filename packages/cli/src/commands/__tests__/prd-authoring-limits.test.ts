import { describe, expect, it } from "vitest";
import { runPrdCommand } from "../prd.js";

describe("prd authoring limits descendant contract", () => {
  it("admits a zero review ceiling before reporting semantic authoring admission failure", async () => {
    const output: string[] = [];
    const exit = await runPrdCommand([
      "author", "/definitely-not-a-fusion-packet", "/definitely-not-a-fusion-packet/manifest.json", "/definitely-not-a-fusion-packet/candidate.sidecar.json",
      "--target", "fixtures/target", "--base", "0123456789abcdef0123456789abcdef01234567", "--provider", "loopback-authoring", "--model", "fixture-model",
      "--max-requests", "1", "--max-duration-ms", "1000", "--max-concurrency", "1", "--max-prompt-bytes", "1000", "--max-response-bytes", "1000", "--max-review-items", "0",
    ], { write: (line) => output.push(line) });
    expect(exit).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ kind: "refusal", diagnostics: [{ code: "CCC_PRD_AUTHORING_ADMISSION_FAILED" }] });
  });
});
