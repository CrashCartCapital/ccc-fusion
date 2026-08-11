---
"@runfusion/fusion": patch
---

summary: CCC campaign work items now default to 3 attempts on transient provider failures instead of 1.
category: fix
dev: The CCC PRD importer's generated workflow IR (`nativeWorkflowIr` in `packages/core/src/ccc-prd/importer.ts`) now stamps `config.maxRetries: 3` on every executable node it emits — task prompt nodes, the proof-suite gate, and the merge seam. Previously no retry budget was emitted, so the engine's work-item fallback of a single total attempt (`workflow-task-runtime.ts`) let one transient provider error terminal-fail a campaign work item into exhausted/manual-required. Only engine-classified `TransientError` failures consume attempts; `PermanentError` still parks manual-required on first classification, the engine cap of 10 is unchanged, topology nodes (start/end/split/join) carry no budget, and non-CCC workflows are untouched. Already-imported campaigns keep their stored IR and admitted irHash, so the change applies to new imports only.
