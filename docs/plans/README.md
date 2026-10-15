# CCC-Fusion Plans Index

This folder contains current direction plus older design and execution records. Start with the current target before reading older files.

## Current target

- [2026-10-13 Request-to-code implementation PRD v3](./2026-10-13-ccc-fusion-request-to-code-prd-v3.md) - current implementation target for turning a plain-language request into a reviewed PRD, dependency plan, and checked code. It carries Ryan's explicit model amendment: the routine pool is GLM 5.3 (`glm/glm-5.3`), GLM 5.3 Flash (`glm/glm-5.3-flash`), and MiniMax M3 (`minimax/MiniMax-M3`), assigned by role. GLM 5.2 is excluded from new worker and fallback routes. Where the defaults below still say GLM 5.2, PRD v3 wins. Preserved byte-for-byte; sha256 `5aa8bc8dad8d2ad975983ad0af94209e3f09989b079f799ef65f0d5fe1c03927`.
- [Request-to-code v3 implementation contract](./request-to-code-v3/) - the frozen implementation contract for PRD v3 (`CONTRACT-v3.5.md`), the four design ADRs (`adr/`), and errata E1-E17 (`errata/`). Precedence: the highest-numbered erratum wins, then E16, E15 and so on down to E1, then the contract, then the PRD for intent. `run-state-2026-10-15.json` is the orchestrator's last checkpoint. Start with [the Codex handoff](./2026-10-15-request-to-code-v3-codex-handoff.md).
- [2026-08-11 CCC-Fusion product direction](./2026-08-11-ccc-fusion-product-direction.md) - current repo-local direction for worker compute, campaign parallelism, capacity learning, and delivery boundaries.

## How to read older plans

Older files are retained as evidence. They may describe work that was only planned, locally tested, partially implemented, or later superseded. Do not treat an older plan as current authority where it conflicts with the current target above.

Keep these labels separate when using this folder:

- **Written in a plan:** described here, not necessarily present in code.
- **Present in code:** exists in the repository, not necessarily exercised by CCC campaigns.
- **Passing tests:** proved by a named check on a named tree.
- **Ready to push:** locally integrated and review-ready, still not pushed.
- **Pushed or merged:** changed remote state, which this docs lane did not do.
- **Running or proved in real use:** verified in a live runtime, not implied by source docs.

## Recent evidence files

- [D2 chunked extraction design](./2026-08-03-ccc-fusion-d2-chunked-extraction-design.md) - historical design with partial implementation evidence. It remains the reference for serial chunk extraction. It is not proof that campaign-level DAG parallelism is implemented.
- [OmniRoute routing experiment report](./2026-08-03-omniroute-routing-experiment-report.md) - measured evidence from 2026-08-03. Its model-role recommendations are superseded by the current product direction, but its exactness, receipt, and quota findings remain useful evidence leads.
- [Phase 3 routing implementation spec](./2026-08-03-ccc-fusion-phase3-routing-implementation-spec.md) - historical implementation spec based on the 2026-08-03 experiment. Treat it as evidence, not current worker-compute policy.
- [Routing-contract waves record](./2026-08-02-ccc-fusion-routing-contract-waves.md) - historical accepted-commit record for route contracts and linear multi-task chain work.
- [Stage 4 real-PRD understanding](./2026-08-02-ccc-fusion-stage4-real-prd-understanding.md) - historical review-only proof over real vault PRDs.
- [PRD v0.2 successor proposal](./2026-08-02-ccc-fusion-prd-v0.2-successor-proposal.md) - historical proposal outside the vault.
- [PRD corpus diversity matrix](./2026-08-03-prd-corpus-diversity-matrix.md) - historical evidence for real packet diversity.
- [PRD product vertical slice](./2026-07-30-ccc-fusion-prd-product-vertical-slice.md) - historical vertical-slice plan and evidence record.

## Locked defaults for next planning

- Superseded on 2026-10-13 by PRD v3 for model identity (GLM 5.3, GLM 5.3 Flash, MiniMax M3 by role); the rest of this list still applies.
- Routine CCC-Fusion workers should use OmniRoute endpoints, mainly MiniMax M3 and GLM 5.2, unless measured evidence says a task class needs escalation.
- Orchestrator workers can also use MiniMax M3 and GLM 5.2 when the chunk size and role fit.
- Escalation should be explicit and recorded: first resize the task for MiniMax M3 or GLM 5.2; then OpenCode Go through OmniRoute for Kimi K3 or Qwen 3.8; then Gemini Pro or limited AGY-delivered Opus 4.6 when available; then Codex Terra high/xhigh, Terra max, and finally Sol max.
- Direct Anthropic Claude Code is not a routine CCC-Fusion worker route.
- Capacity should not be an arbitrary fixed worker count. The product target is "as much safe parallelism as the machine, providers, worktrees, storage, and verification gates can actually sustain."
- Delivery stays gated. Ordinary workers must not push, merge, open PRs, or perform protected external actions. A frozen campaign may preauthorize exact push, PR creation or update, and merge actions for the dedicated terminal delivery agent; unchanged authority is not requested twice, and any drift fails closed.
