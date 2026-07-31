export const CCC_PRD_INTAKE_CONTRACT_SCHEMA_VERSION =
  "ccc-prd.intake-contract.v1" as const;

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

### REQ-001 — <Requirement name>

<Required behavior, including important constraints and dependencies.>

## Acceptance behavior and expected proof

- REQ-001 behavior: <observable acceptance behavior>
- REQ-001 proof: <exact verifier command or reviewable proof>

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
