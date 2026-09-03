export const taskOrder = [
  "TASK-TELEMETRY-CONTRACT",
  "TASK-TELEMETRY-INGEST",
  "TASK-TELEMETRY-AUDIT",
  "TASK-TELEMETRY-BROADCAST",
  "TASK-TELEMETRY-CLI",
  "TASK-TELEMETRY-INTEGRATE",
] as const;

export const ownedFilesByTask = {
  "TASK-TELEMETRY-CONTRACT": ["src/contract.ts"],
  "TASK-TELEMETRY-INGEST": ["src/ingest.ts"],
  "TASK-TELEMETRY-AUDIT": ["src/audit.ts"],
  "TASK-TELEMETRY-BROADCAST": ["src/broadcast.ts"],
  "TASK-TELEMETRY-CLI": ["src/health-cli.ts", "README.md"],
  "TASK-TELEMETRY-INTEGRATE": ["src/app.ts", "tests/telemetry.test.ts"],
} as const;

export const exactCandidateFiles = Object.values(ownedFilesByTask).flat().sort();
