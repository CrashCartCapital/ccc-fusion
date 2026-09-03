const PLACEHOLDER_SHA256 = "0".repeat(64);
const PLACEHOLDER_GIT_OID = "0".repeat(40);

export function buildSemanticProof(input) {
  return {
    schema: "ccc-prd.proof.v2",
    id: input.id,
    requirementIds: [...input.requirementIds],
    clauseIds: [...input.clauseIds],
    phases: [...input.phases],
    command: input.command,
    positiveOracle: input.positiveOracle,
    positiveCases: input.positiveCases.map((entry) => ({ ...entry })),
    negativeControls: input.negativeControls.map((entry) => ({ ...entry })),
    verifierClosure: [
      {
        role: "task_runner",
        path: "Taskfile.yml",
        baseGitBlobOid: PLACEHOLDER_GIT_OID,
        sha256: PLACEHOLDER_SHA256,
      },
      {
        role: "harness",
        path: "verify/project-verifier.mjs",
        baseGitBlobOid: PLACEHOLDER_GIT_OID,
        sha256: PLACEHOLDER_SHA256,
      },
      ...[".gitignore", "package.json"].map((path) => ({
        role: "config",
        path,
        baseGitBlobOid: PLACEHOLDER_GIT_OID,
        sha256: PLACEHOLDER_SHA256,
      })),
      ...(input.fixturePaths ?? []).map((path) => ({
        role: "fixture",
        path,
        baseGitBlobOid: PLACEHOLDER_GIT_OID,
        sha256: PLACEHOLDER_SHA256,
      })),
    ],
    candidateInputs: [...input.candidateInputs],
    ...(input.verifierProfile ? { verifierProfile: { ...input.verifierProfile } } : {}),
    executionToolchain: {
      task: {
        executablePath: "/model-untrusted/task",
        executableSha256: PLACEHOLDER_SHA256,
        version: "model-untrusted",
        versionOutputSha256: PLACEHOLDER_SHA256,
      },
      node: {
        executablePath: "/model-untrusted/node",
        executableSha256: PLACEHOLDER_SHA256,
        version: "model-untrusted",
        versionOutputSha256: PLACEHOLDER_SHA256,
      },
      proofHost: {
        id: "model-untrusted-proof-host",
        executablePath: "/model-untrusted/proof-host",
        executableSha256: PLACEHOLDER_SHA256,
        version: "model-untrusted",
        versionOutputSha256: PLACEHOLDER_SHA256,
      },
      linkedRuntime: [],
    },
    sourceRefs: input.sourceRefs.map((entry) => ({ ...entry })),
    confidence: "high",
  };
}
