import { CCC_CAMPAIGN_TASK_VERIFY_DECLARATION_PATTERN_SOURCE } from "../ccc-campaign-proof-admission.js";
import { parseCccPrdAcceptanceClauseInventory } from "./acceptance-clauses.js";

export const CCC_PRD_INTAKE_CONTRACT_V1_SCHEMA_VERSION =
  "ccc-prd.intake-contract.v1" as const;
export const CCC_PRD_INTAKE_CONTRACT_V2_SCHEMA_VERSION =
  "ccc-prd.intake-contract.v2" as const;
export const CCC_PRD_INTAKE_CONTRACT_SCHEMA_VERSION =
  CCC_PRD_INTAKE_CONTRACT_V2_SCHEMA_VERSION;

export type CccPrdIntakeContractFinding = Readonly<{
  code: string;
  message: string;
}>;

export type CccPrdIntakeLintResult = Readonly<{
  schema: typeof CCC_PRD_INTAKE_CONTRACT_SCHEMA_VERSION;
  sourcePath: string;
  optionalContract: true;
  readyForIntake: boolean;
  blockingQuestions: readonly CccPrdIntakeContractFinding[];
  advisories: readonly CccPrdIntakeContractFinding[];
}>;

export type LintCccPrdIntakeMarkdownInput = Readonly<{
  sourcePath: string;
  markdown: string;
}>;

const TEMPLATE = `# <Product or change name>

## Product outcome

<What should a normal operator be able to do when this is complete?>

## Implementation boundary

- Target repository: <absolute path or stable repository identifier>
- Baseline commit: <40-hex commit>
- Allowed write roots: <target-relative paths>
- Forbidden paths: <target-relative paths, or None>

## Requirements

### Requirement REQ-001

<Required behavior, including important constraints and dependencies.>

#### Acceptance clauses

- [AC-REQ-001-001] <One exact, observable acceptance behavior on this physical line.>

## Expected proof

### Proof PROOF-REQ-001

- the verifier command task verify:<slug> passes only when <positive oracle stated literally>.
- Accepted clause IDs: AC-REQ-001-001
- Phases: task and final_integrated
- Positive cases: <stable case ID and expected passing behavior>
- Negative controls: <stable control ID and expected refusal behavior>
- Trusted verifier closure: Taskfile.yml, proof/<trusted-harness>.mjs
- Candidate inputs: <task-owned implementation paths judged by the harness>
- Admitted campaign proof grammar: ${CCC_CAMPAIGN_TASK_VERIFY_DECLARATION_PATTERN_SOURCE}
- The exact proof.command must appear inside this proof's cited source span.
- Trusted verifier files must already be regular Git blobs at the baseline and must be outside every model-writeable root.

## Constraints and dependencies

- <Constraint or dependency, or None>

## Non-goals

- <Explicitly excluded work, or None>

## Risks

- <Material failure or safety risk, or None>

## Protected actions

- <Human approval boundary such as merge, production access, spending, or None>

## Open questions

- <Implementation-changing question, or None>
`;

function withoutFencedCode(markdown: string): string {
  return markdown.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/gu, "$1");
}

function hasInlineValue(markdown: string, labels: readonly string[]): boolean {
  const lines = markdown.split(/\r?\n/gu);
  return lines.some((line) => {
    const normalized = line
      .replace(/^\s*(?:[-*+]\s+)?/u, "")
      .replace(/^\s*#{1,6}\s+/u, "")
      .trim();
    for (const label of labels) {
      const prefix = `${label.toLowerCase()}:`;
      if (!normalized.toLowerCase().startsWith(prefix)) continue;
      const value = normalized.slice(prefix.length).trim();
      return (
        value.length > 0
        && !/^(?:<.*>|\[.*\]|tbd|todo|unknown|unspecified)$/iu.test(value)
      );
    }
    return false;
  });
}

function hasHeading(markdown: string, labels: readonly RegExp[]): boolean {
  return markdown
    .split(/\r?\n/gu)
    .some((line) => {
      const match = /^\s*#{1,6}\s+(.+?)\s*$/u.exec(line);
      return Boolean(match && labels.some((label) => label.test(match[1]!)));
    });
}

function result(
  sourcePath: string,
  blockingQuestions: CccPrdIntakeContractFinding[],
  advisories: CccPrdIntakeContractFinding[],
): CccPrdIntakeLintResult {
  return {
    schema: CCC_PRD_INTAKE_CONTRACT_SCHEMA_VERSION,
    sourcePath,
    optionalContract: true,
    readyForIntake: blockingQuestions.length === 0,
    blockingQuestions,
    advisories,
  };
}

export function renderCccPrdIntakeTemplate(): string {
  return TEMPLATE;
}

export function lintCccPrdIntakeMarkdown(
  input: LintCccPrdIntakeMarkdownInput,
): CccPrdIntakeLintResult {
  const markdown = withoutFencedCode(input.markdown);
  if (markdown.trim().length === 0) {
    return result(input.sourcePath, [{
      code: "CCC_PRD_DOCUMENT_EMPTY",
      message: "The PRD is empty, so Fusion cannot extract a product decision.",
    }], []);
  }

  const blockingQuestions: CccPrdIntakeContractFinding[] = [];
  if (!hasInlineValue(markdown, ["Target repository", "Repository target"])) {
    blockingQuestions.push({
      code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED",
      message: "Which target repository should this PRD change?",
    });
  }

  const baselineLine = markdown
    .split(/\r?\n/gu)
    .find((line) => /\b(?:baseline|base commit|baseline commit)\s*:/iu.test(line));
  if (!baselineLine || !/\b[0-9a-f]{40}\b/iu.test(baselineLine)) {
    blockingQuestions.push({
      code: "CCC_PRD_BASELINE_REQUIRED",
      message: "Which exact 40-hex baseline commit should Fusion freeze?",
    });
  }

  if (!hasInlineValue(markdown, [
    "Allowed write roots",
    "Allowed paths",
    "Writable paths",
  ])) {
    blockingQuestions.push({
      code: "CCC_PRD_ALLOWED_PATHS_REQUIRED",
      message: "Which target-relative paths or write roots may the campaign change?",
    });
  }

  const hasAcceptance = (
    hasHeading(markdown, [/\bacceptance\b/iu])
    || hasInlineValue(markdown, ["Acceptance", "Acceptance behavior", "Behavior"])
  );
  if (!hasAcceptance) {
    blockingQuestions.push({
      code: "CCC_PRD_ACCEPTANCE_BEHAVIOR_REQUIRED",
      message: "What observable acceptance behavior proves the requirement is satisfied?",
    });
  }

  try {
    const inventory = parseCccPrdAcceptanceClauseInventory({
      sourcePath: input.sourcePath,
      sourceBytes: Buffer.from(markdown, "utf8"),
    });
    if (inventory.clauses.length === 0) {
      blockingQuestions.push({
        code: "CCC_PRD_ACCEPTANCE_CLAUSES_REQUIRED",
        message: "Declare each acceptance behavior with the exact Requirement and Acceptance clauses grammar so Fusion can preserve it byte-for-byte.",
      });
    }
  } catch (error) {
    blockingQuestions.push({
      code: "CCC_PRD_ACCEPTANCE_CLAUSES_MALFORMED",
      message: error instanceof Error
        ? error.message
        : "Acceptance clauses do not match the exact clause grammar.",
    });
  }

  const hasExpectedProof = (
    hasHeading(markdown, [/\bexpected proof\b/iu, /\bverification\b/iu])
    || hasInlineValue(markdown, ["Proof", "Expected proof", "Verifier", "Verification"])
    || /(?:^|\n)\s*[-*+]\s+[^\n]*(?:proof|verifier)\s*:/iu.test(markdown)
  );
  if (!hasExpectedProof) {
    blockingQuestions.push({
      code: "CCC_PRD_EXPECTED_PROOF_REQUIRED",
      message: "Which exact verifier or reviewable proof must execute against the campaign result?",
    });
  }
  if (!/\bthe verifier command task verify:[a-z0-9][a-z0-9:-]{0,63}(?: --(?: [a-z0-9][a-z0-9:._/-]{0,63}){0,8})?/iu.test(markdown)) {
    blockingQuestions.push({
      code: "CCC_PRD_PROOF_DECLARATION_REQUIRED",
      message: "State the exact words 'the verifier command task verify:<slug>' inside the proof's source text.",
    });
  }

  if (!hasHeading(markdown, [/\bprotected actions?\b/iu])) {
    blockingQuestions.push({
      code: "CCC_PRD_PROTECTED_ACTIONS_REQUIRED",
      message: "Which protected actions require operator approval? State None when there are none.",
    });
  }

  const advisories: CccPrdIntakeContractFinding[] = [];
  if (!hasHeading(markdown, [/\bconstraints?\b/iu, /\bdependencies\b/iu])) {
    advisories.push({
      code: "CCC_PRD_CONSTRAINTS_RECOMMENDED",
      message: "Record constraints and dependencies, or state None.",
    });
  }
  if (!hasHeading(markdown, [/\bnon-goals?\b/iu, /\bout of scope\b/iu])) {
    advisories.push({
      code: "CCC_PRD_NON_GOALS_RECOMMENDED",
      message: "Record non-goals or out-of-scope work, or state None.",
    });
  }
  if (!hasHeading(markdown, [/\brisks?\b/iu])) {
    advisories.push({
      code: "CCC_PRD_RISKS_RECOMMENDED",
      message: "Record material risks, or state None.",
    });
  }
  if (!hasHeading(markdown, [/\bopen questions?\b/iu, /\bunresolved decisions?\b/iu])) {
    advisories.push({
      code: "CCC_PRD_OPEN_QUESTIONS_RECOMMENDED",
      message: "Record implementation-changing open questions, or state None.",
    });
  }

  return result(input.sourcePath, blockingQuestions, advisories);
}
