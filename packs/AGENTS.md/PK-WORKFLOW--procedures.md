# Workflow procedures

Pack ID: `PK-WORKFLOW`.

Read this generated pack only after the compact root catalog identifies a strong trigger.

### Operating Principles

- freeze design before implementing ambiguous feature or architecture requests
- diagnose before editing when the issue is a bug, failing test, or unclear regression
- use fresh, cited sources for current or high-stakes research rather than stale memory
- use the proof/readiness gate, plus artifact-bound semantic review when Ensemble Consultation triggers it, before claiming completion
- evaluate new tool surfaces against the live stack before promoting them into default workflow
- use bounded atomic ensemble consultation to improve planning and execution without replacing direct evidence
- if the project depends on unattended execution, make the prepared route explicit: `forge-spec -> forge-prep -> Dagu -> Ralph`

### Execution Lane Selection

Use Dagu/Ralph guidance only when a task needs an execution lane, not ordinary search or tool selection.

- Treat Dagu and Ralph as tools/CLIs, not current skills; do not revive retired Dagu/Ralph skills just because the tools are installed.
- Treat Taskfile as the repo command floor: call `task verify`, `task lint`, `task test`, or repo-specific tasks before raw shell when a task exists.
- **Hard Rule —** CrashCartCapital CI compute is local/self-hosted by default. GitHub Actions may dispatch and report, but before pushing a new or changed workflow, inspect every `runs-on` value and the live repo runner inventory; hosted runners are failures unless Ryan explicitly authorizes them for that repository. New repositories must register an exact repo-scoped runner or keep CI disabled before the first push, and completion proof must name the runner that executed each job.
- Use Pueue for durable background shell jobs that should outlive a terminal or obey local concurrency limits; do not treat it as a DAG, retry, cron, proof, or agent-loop engine.
- Use Dagu as the outer conductor for dependency ordering, approvals, retries, parent/child visibility, persistent state, or crash resume. Prefer deterministic command steps on the critical path; agent/harness steps may reason, route, or prepare, but proof comes from commands, artifacts, receipts, and gates.
- Use Ralph as the bounded leaf execution loop selected by Dagu; Ralph iterates inside the chosen work unit and emits events or proof for review.
- Keep AtomicAgents as an inner typed LLM/programming layer; it does not replace Dagu, Ralph, Taskfile, Pueue, approvals, or proof.

### AtomicAgents Framework Boundary

**AtomicAgents framework** means the Python package `atomic-agents`, imported as `atomic_agents`; it does not mean `agy-bridge` atomic consultations.

- Consider AtomicAgents for Python-heavy work needing typed LLM outputs, reusable review roles, structured decisions, source-grounded synthesis, bounded extraction, or proof artifacts; good patterns include typed review committees, source/reviewer chains, citation packets, proposal-only patch packets, and one-tool read-only wrappers.
- Keep it as an inner typed LLM layer. Normal Python and Ryan's stack still own orchestration, retries, approvals, routing, memory, side effects, and verification.
- Before implementation, recheck Python version, installed package version, importability, source/release, model route, and MCP use. If preflight cannot run, mark implementation claims unverified.
- Prefer source-proven current AtomicAgents patterns; reject stale API assumptions unless current source proves them. Keep exact class names and rejected forms in the project/package extension point, not as durable global root law.
- Model output may propose, classify, adjudicate, or draft; deterministic code owns paths, tool risk, sensitivity, approvals, broker/tool names, credentials, commands, writes, and proof commands. Schemas structure work; they do not authorize action.
- Do not wrap broad MCP catalogs. Start with one synthetic or allowlisted read-only tool; prove transport, auth, schema snapshots, risk classification, refusal behavior, timeouts, audit logs, and drift handling before expansion.
- Promotion needs schema/refusal/provider-route proof, source-labeled context, non-durable chat history, observability, and a source-labeled proof bundle.

### Parallel Work And Subagents

- When the active runtime exposes safe subagent or parallel-worker support, the active runtime policy permits delegation, and a task has two or more independent workstreams, keep a low threshold for parallel delegation before doing everything in the parent thread; good branches include read-heavy source discovery, log parsing, option search, test or risk review, file archaeology, and isolated implementation slices.
- Use an available coordination or subagent-dispatch skill when present; otherwise keep the parent-managed task split explicit. Each worker request should name one workstream, exact scope, allowed files/tools, read/write boundary, expected output, stop condition, and critical constraints.
- Default to read-only workers. When the runtime exposes worker model, effort, sandbox, tool, MCP, or permission controls, match them to the assigned boundary: read-only branches get the safest/read-only available access, and write branches get no broader access than their exact assigned target.
- Write-capable workers require one explicit isolated write scope. In non-vault code repos, the parent first applies the active Git Model and establishes or assigns one concrete branch, worktree, or platform-native workspace per write workstream; cleanup and staging/integration proof remain required where that Git Model requires them. In vault targets whose overlay forbids worktrees, branches, commits, or PRs, workers may write only exact disjoint note/source targets under parent integration.
- Do not parallelize routine edits, shared-state writes, live configuration changes, protected paths, approval-gated operations, or facts a direct file read or command can settle faster. Keep fan-out flat by default: respect runtime thread/cost limits, do not recursively spawn subagents unless explicitly required, and collect or reconcile finished workers before final integration. The parent owns source-first verification, conflict resolution, integration, final edits, and the user-facing answer.

### Consultation Integration Points

Use this section as the lifecycle trigger layer; detailed lane mechanics, consultant preamble, model guardrails, sandbox rules, and stateful follow-up discipline live in **Ensemble Consultation**.

Lifecycle cues: planning -> `agy-bridge delegate` for alternatives/assumptions; plan freeze or high-risk decisions -> `agy-bridge adversarial_review`; tricky execution or repeated failures -> atomic `delegate`; after synthesizing a gate-triggering durable artifact -> freeze the exact candidate -> independent semantic review under **Ensemble Consultation** -> adjudicate and repair -> closure pass on the repaired candidate -> deterministic verification -> closeout. GPT/Codex review remains conditional on the active runtime addendum and **Ensemble Consultation**. Skip consultation for simple reads, routine edits, or facts a direct command can establish.

### Skill Discipline

When multiple runtime skills could apply, prefer process before investigation before implementation before coordination. Use the runtime-injected skill list as the source of truth for which specific skills exist.

Skill discipline: if the user explicitly names a skill, or the task clearly matches an available runtime skill under the active runtime policy, load/read the current skill instructions before acting; follow only relevant referenced files; do not broaden into adjacent skills; if an obvious skill is unavailable, irrelevant, or blocked, say why briefly. Roots provide dispatch cues, not a static skill catalog.

### Principle-to-Skill Dispatch

Use this table as a routing cue, not a fixed command catalog. Before invoking a skill, verify it exists in the current runtime-injected skill list. Before using an MCP tool, follow **MCP Server Reference** discovery and exact-name rules. If the named skill or tool route is unavailable, follow the principle directly with local tools and evidence.

| Operating Principle | Runtime Skill / Tool Cue | Backup / Escalation |
|---|---|---|
| Freeze design before building | Process skill for brainstorming, product design, or spec freezing | Repo-local spec workflow when present |
| Diagnose before editing | Debugging or investigation skill | Direct reproducer and local evidence |
| Use fresh cited sources | Research skill with current-source discipline | Direct source lookup and citation |
| Verify before claiming done | Verification/readiness skill | Smallest falsifiable proof command |
| Evaluate before adopting | Tool/surface evaluation process | Direct live-stack comparison with evidence |
| Triangulate planning or execution | `agy-bridge delegate` / `adversarial_review` under **Ensemble Consultation** | Proceed from local evidence and state why consultation was skipped |

> **Extension point:** Project-specific workflow sources go here.
