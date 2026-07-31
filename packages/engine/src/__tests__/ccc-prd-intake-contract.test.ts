import { describe, expect, it } from "vitest";
import {
  CCC_PRD_INTAKE_CONTRACT_SCHEMA_VERSION,
  lintCccPrdIntakeMarkdown,
  renderCccPrdIntakeTemplate,
} from "../ccc-prd/intake-contract.js";

const completePrd = `# Example product

## Product outcome

Make the operator journey work without developer-written glue.

## Implementation boundary

- Target repository: /workspace/example
- Baseline commit: 0123456789abcdef0123456789abcdef01234567
- Allowed write roots: src/product, tests/product
- Forbidden paths: .github, infrastructure

## Requirements

### REQ-001 — Supported operator route

The normal CLI must execute the product journey.

## Acceptance behavior and expected proof

- REQ-001: run \`pnpm test -- product\` against the campaign-created commit.

## Constraints and dependencies

- Preserve the existing task engine.

## Non-goals

- Automatic merge.

## Risks

- A stale proof could authorize changed code.

## Protected actions

- Merge requires exact human approval.

## Open questions

- None.
`;

describe("optional CCC PRD Intake Contract", () => {
  it("accepts the optional template without rewriting an existing PRD", () => {
    const template = renderCccPrdIntakeTemplate();
    expect(template).toContain("# <Product or change name>");
    expect(template).toContain("Target repository:");
    expect(template).toContain("Baseline commit:");
    expect(template).toContain("Allowed write roots:");
    expect(template).toContain("Acceptance behavior and expected proof");
    expect(template).toContain("Protected actions");

    expect(lintCccPrdIntakeMarkdown({
      sourcePath: "PRJ-HUM-Example.md",
      markdown: completePrd,
    })).toEqual({
      schema: CCC_PRD_INTAKE_CONTRACT_SCHEMA_VERSION,
      sourcePath: "PRJ-HUM-Example.md",
      optionalContract: true,
      readyForIntake: true,
      blockingQuestions: [],
      advisories: [],
    });
  });

  it("turns missing implementation facts into understandable blocking questions", () => {
    const result = lintCccPrdIntakeMarkdown({
      sourcePath: "legacy-prd.md",
      markdown: `# Legacy idea

## Requirements

- Make the product easier to use.
`,
    });

    expect(result.readyForIntake).toBe(false);
    expect(result.blockingQuestions.map(({ code }) => ({ code }))).toEqual([
      { code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED" },
      { code: "CCC_PRD_BASELINE_REQUIRED" },
      { code: "CCC_PRD_ALLOWED_PATHS_REQUIRED" },
      { code: "CCC_PRD_ACCEPTANCE_BEHAVIOR_REQUIRED" },
      { code: "CCC_PRD_EXPECTED_PROOF_REQUIRED" },
      { code: "CCC_PRD_PROTECTED_ACTIONS_REQUIRED" },
    ]);
    expect(result.blockingQuestions[0]?.message).toMatch(/target repository/i);
    expect(result.blockingQuestions[1]?.message).toMatch(/baseline/i);
    expect(result.blockingQuestions[2]?.message).toMatch(/allowed.*paths|write roots/i);
    expect(result.blockingQuestions[3]?.message).toMatch(/acceptance behavior/i);
    expect(result.blockingQuestions[4]?.message).toMatch(/proof/i);
    expect(result.blockingQuestions[5]?.message).toMatch(/protected actions/i);
  });

  it("treats explicit none as a decision and reports optional structure only as advice", () => {
    const result = lintCccPrdIntakeMarkdown({
      sourcePath: "compact.md",
      markdown: `# Compact PRD

Target repository: /workspace/example
Baseline: current commit 0123456789abcdef0123456789abcdef01234567
Allowed paths: src/example

## Requirements

- REQ-001: expose one normal CLI route.

## Acceptance

- Behavior: the CLI returns the admitted result.
- Proof: \`pnpm test -- cli-route\`.

## Protected actions

None.
`,
    });

    expect(result.readyForIntake).toBe(true);
    expect(result.blockingQuestions).toEqual([]);
    expect(result.advisories.map(({ code }) => ({ code }))).toEqual([
      { code: "CCC_PRD_CONSTRAINTS_RECOMMENDED" },
      { code: "CCC_PRD_NON_GOALS_RECOMMENDED" },
      { code: "CCC_PRD_RISKS_RECOMMENDED" },
      { code: "CCC_PRD_OPEN_QUESTIONS_RECOMMENDED" },
    ]);
  });

  it("refuses blank documents and never invents missing decisions", () => {
    const result = lintCccPrdIntakeMarkdown({
      sourcePath: "blank.md",
      markdown: " \n",
    });
    expect(result.readyForIntake).toBe(false);
    expect(result.blockingQuestions).toContainEqual(expect.objectContaining({
      code: "CCC_PRD_DOCUMENT_EMPTY",
    }));
  });
});
