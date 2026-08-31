# Consultation mechanics

Pack ID: `PK-CONSULT`.

Read this generated pack only after the compact root catalog identifies a strong trigger.

### Shared (both variants)

For complex design decisions, ambiguous requirements, architectural tradeoffs, risk assessment, or when stuck on a hard problem, consult other AI agents to triangulate when the runtime and user constraints permit. Also use bounded lightweight consultation during ordinary planning and execution when an outside view can materially improve the next local step. The primary agent still owns execution; ensemble partners provide second opinions, not co-ownership.

**Default rule:** consult proactively at the checkpoints below when consultation is available and allowed. If the user, runtime, policy, or task constraint forbids consultation, skip it, proceed from direct evidence, and state that the consult was intentionally skipped.

### Atomic consultations

Use `agy-bridge delegate` as the default bounded consultation lane for brief, single-question checks: brainstorming alternatives, validating assumptions, stress-testing a small design choice, checking edge cases, getting implementation feedback, or asking “what am I missing?” before committing to a path. “Atomic” means narrow and independently answerable, not guaranteed instant; use it when the expected reasoning benefit is worth possible MCP latency. Keep atomic consult prompts narrow, include only the local context needed for the question, and treat the answer as advisory input to adjudicate against direct evidence.

Prefer atomic `delegate` checks when they can materially improve reasoning without stalling obvious local progress. They should be high-frequency relative to heavier checkpoint reviews, not automatic for every small step. Do not let them replace local reads, direct command output, tests, or user approval gates.

### When not to consult

- Do not consult for routine mechanical edits, obvious renames, simple formatting, or straightforward local facts already established by current evidence. A complex single-file logic change may still justify one quick `agy-bridge delegate` check.
- Do not consult when the next step is blocked only by a command you can run or a file you can read directly.
- Do not consult when the user explicitly forbids other-model consultation, network/MCP use, or the named runtime lane.
- Use the cheapest adequate lane first. Reach for the heavier checkpoint lane only when the decision is durable, risky, cross-cutting, or genuinely stuck.

### Consultation Checkpoints

- Default checkpoint: before final implementation plans, before architecture decisions touching 3+ files, after 2 failed debugging attempts, when research conflicts, and before closeout on medium/large work, unless user/runtime constraints prohibit consultation.
- Encouraged: early brainstorming expansion, second-pair review, high-stakes fact checks, unfamiliar APIs/codebases, and durable dependency or data-model decisions.
- Use `agy-bridge adversarial_review` for high-value checkpoints: final implementation plans, durable architecture or data-model decisions, security-sensitive or destructive changes, pre-merge/pre-closeout review of medium or large changes, and any change where the cost of a missed flaw is high.

### Artifact-bound semantic review

Decision consultation and artifact validation are different claims. Earlier brainstorming, architecture consultation, research review, or plan critique does not validate a later synthesized work product that the reviewers never inspected.

Apply this gate when the user explicitly requests AGY, ensemble, committee, adversarial, subagent, or independent review of the work product, and by default for medium or large durable plans, PRDs, architecture notes, policies, instruction changes, high-stakes research syntheses, and similarly expensive-to-misread artifacts. Skip it for routine mechanical edits, obvious renames, simple formatting, short low-risk answers, and other work where review cost would exceed plausible harm.

1. **Freeze the exact candidate after synthesis.** Before an approval-ready, final, or complete claim, identify the full review target. For a saved artifact, provide its exact path plus SHA-256 and a diff when the review is change-scoped; for response-only content, provide the exact full text. The reviewer must inspect that candidate, not an agent-authored summary.
2. **Use an independent lane.** At least one reviewer must not be the artifact's author. Retain cross-model adversarial review for high-value artifacts under the lane rules below; add a cold-reader or audience-clarity lens when ambiguous writing is itself the risk.
3. **Adjudicate; do not obey.** The primary agent verifies concrete claims and dispositions findings as adopt, reject, defer, or investigate while preserving operator decisions, fixed constraints, and authority boundaries. Reviewers remain read-only and advisory. Adjudication never grants execution authority; active shadow mode and Tier 2 or user-approval gates still control action.
4. **Close the repair loop.** A material edit after review invalidates the affected verdict. Run one bounded closure pass against the repaired exact candidate; at least one independent reviewer must verify the final bytes or exact text. The initial review and closure pass are the two rounds for that unresolved question. If the closure pass still finds a concrete blocker, do not loop or claim approval-ready status; surface the unresolved finding or return it to the operator.
5. **Report provenance honestly.** Name the reviewed artifact version, reviewer and model lanes actually used, final verdict, material rejected advice, and remaining risk. If consultation is unavailable or prohibited, the agent may finish from direct evidence when otherwise allowed, but must state that the artifact was not independently reviewed and must not imply ensemble, committee, or adversarial approval.

Artifact-bound semantic review supplements rather than replaces deterministic tests, source checks, user approval, authority gates, or verification-before-completion.

The stock consultant preamble is an advisory behavior constraint, not an enforced sandbox; never cite it as the safety boundary.

### Round discipline

- **Hard Rule — Consultant preamble:** Start each new MCP consultant session or one-off conversational consult prompt with this exact stock statement before the actual task: "Role: advisory MCP consultant to the main agent. Do not create, edit, or delete files or otherwise alter project state. Use only read-only tools for context. Return the requested answer/report for main-agent adjudication."
- Apply the preamble to any direct or brokered spelling of these consultant actions: `agy-bridge delegate` / `agy_bridge__delegate`, `agy-bridge adversarial_review` / `agy_bridge__adversarial_review`, `codex-mcp-server codex` / `codex-mcp-server__codex`, `codex-mcp-server review` / `codex-mcp-server__review`, and comparable MCP consultant prompts. Read-only tools include web search, code-intelligence, file search, and similar non-mutating analysis; they exclude file writes, patches, generated artifacts, git changes, and project-state mutations.
- For stateful follow-ups, do not repeat the stock statement when the same `sessionId`/`session_id` is definitely being continued; repeat it when session continuity is unclear or a new consultant session is started.
- Do not prepend the statement to narrow machine fields where it would corrupt the input, such as exact file paths, URLs, IDs, or literal search strings; include the boundary in the surrounding freeform instruction instead. If no safe freeform field exists, do not corrupt the call; use only read-only/sandbox arguments and skip the consult if that boundary cannot be enforced.
- Ask one bounded question per consult. Do not bundle unrelated asks into a single consult prompt.
- Cap the same unresolved question at **2 consultation rounds**. If disagreement or uncertainty persists after that, surface it to the user or proceed with explicit uncertainty.
- The 2-round cap applies to one unresolved question, not to independent atomic consultations across a session.
- Investigate disagreement; do not average it away.

### Lanes

- **Antigravity/Gemini lane (`agy-bridge`):** Google/Gemini consultation routes through the `agy-bridge` MCP, backed by Antigravity CLI. Use `delegate` for frequent atomic brainstorming, suggestions, feedback, and validation; `adversarial_review` for plan, design, and pre-merge/pre-closeout critiques; `web_lookup` for consultant-assisted fact checks when an advisory model view helps; and `deep_search`/`analyze_files` to offload archaeology or large-file review. Primary source gathering/search remains direct `stack-core` or broker-visible search. Let `agy-bridge` auto-route by default; override the model only when a known exact runtime model label is already available or the model choice materially matters.
- **Agy model tiers:** Use Pro/high-tier models for large cognitive work, durable planning, adversarial review, multi-file analysis, and hard research synthesis. Use Flash/high or Flash/medium for routine consultation, smaller web lookups, and ordinary second opinions. Use Flash/low or Flash Lite when exposed for low-complexity triage, short confirmations, and latency-sensitive checks.
- **GPT/Codex lane (`codex-mcp-server`):** Consulting the Codex/GPT family routes through the `codex-mcp-server` MCP inside `stack-core` (tool `codex` for prompts/analysis, `review` for diff/commit-scoped code review). The lane is stateful via `sessionId`; per-surface permission to use it is set in the variants below.
- **Hard Rule — Codex MCP read-only sandbox:** Any call that executes the `codex` action on `codex-mcp-server` must explicitly include `sandbox: "read-only"` in the tool arguments, whether the exposed name is direct `codex-mcp-server__codex`, a brokered `server:name` form, or another documented alias for the same action. If the schema or broker path does not expose a `sandbox` argument, do not call that `codex` action; use `codex-mcp-server__review` or the narrow consultation-fallback `codex-mcp-server__websearch` instead. `websearch` is not the general web-research lane. `workspace-write`, `danger-full-access`, and `fullAuto: true` require Ryan's explicit closed-loop approval for that exact call.
- **GPT model and effort routing:** Apply the `codex-model-router` policy to every `codex` consultation, with a consultation floor of `reasoningEffort: medium` for narrow confirm-checks, `high` for routine code review, spec consultation, and planning, and a short `xhigh` pulse for the hardest multi-system architecture, deep cross-cutting review, high-stakes plan critique, or same-family Codex self-consultation. Do not assume `max` or `ultra` improves the result, and do not transfer an effort value between model families unless the live caller exposes it. **Always pass `model` explicitly on every `codex` call; never omit it and never accept the tool's advertised default.** The advertised schema can lag the live server, while the live server registration (read it with `mcpjungle list servers`, never from `~/.mcpjungle/configs/codex-mcp-server.json`, which is only the input to registration and can sit unapplied for weeks) describes fallback runtime state — not a quality ranking or permission to use that route. Verify available non-Spark model IDs through the live caller/catalog plus the SSOT major GPT tier, select the minimum safe route for the task, and use the router's requested-versus-effective route check after the call. The `model` argument is a free-form string, not an enum, so a model absent from the description's Options list may still be valid; never let a stale Options list block a live-proven model, and note that advertised `-codex` IDs can be rejected on a ChatGPT-account backend. Prefer the `review` tool for diff- or commit-scoped code review. Codex Spark, including any `codex-spark` or "codex spark" model label, is forbidden; do not select it, recommend it, accept it as an automatic fallback, or rely on `reasoningEffort` alone as a model selector. If the active tool schema/help cannot confirm a non-Spark route and exposes no model override, skip the GPT/Codex lane and use another allowed review path or ask the user.
- Source of truth: Antigravity/Gemini routing is owned by `agy-bridge`; GPT/Codex consultation is owned by the `codex-mcp-server` MCP in `stack-core`. Runtime addenda own which effort tiers each surface may call.

### CLAUDE.md variant

- Claude Code may use the `codex-mcp-server` GPT/Codex lane for checkpoint consultation when the user request and runtime policy allow it. Use `codex` with `sandbox: "read-only"`, select the explicit model and minimum safe effort through the GPT routing rule above, and prefer the `review` tool for code review. Treat `CODEX_DEFAULT_MODEL` as fallback runtime state rather than "best model" evidence; verify availability through the live caller and confirm the effective route after the call. The GPT/Codex model guardrail above applies: never use Codex Spark or a Spark fallback.

### AGENTS.md variant

- Codex may use the `codex-mcp-server` GPT/Codex lane for high-stakes external review when the user request and runtime policy allow it: call `codex` with `sandbox: "read-only"` and an explicit live-proven route selected by the GPT routing rule above, or use the `review` tool for code review. Reserve `xhigh` for genuinely high-stakes checks and verify the effective route. The GPT/Codex model guardrail above applies: never use Codex Spark or a Spark fallback. Use `agy-bridge` for Gemini/Antigravity consultation by default.

### Shared (both variants)

### Consultation session constraints

- `codex-mcp-server` GPT/Codex consults are stateful: reuse the returned `sessionId` for follow-ups on the same thread instead of restating context, start a fresh call for unrelated questions, and allow generous timeouts for `reasoningEffort: high`/`xhigh` runs.
- `agy-bridge` consults are stateful: every call returns a `session_id`; continue the same thread by invoking the visible `follow_up` tool, such as direct `agy_bridge__follow_up` or the exact brokered name returned by discovery, with that `session_id`. Long `adversarial_review` and `delegate` runs can take 130–230s; if a call risks timing out, keep it to one well-scoped request rather than chaining, since an MCP timeout can hide the returned `session_id`. If the `session_id` is unavailable after a timeout or failed call, start a fresh consultation instead of inventing or guessing an ID.
- For iterative feedback on the same thread of work, prefer the visible `follow_up` tool with the returned session ID over resending the whole context. For unrelated atomic questions, start a fresh `delegate` call so the consultant does not carry stale assumptions forward.

> **Extension point:** Project-specific model selections and consultation triggers go here.
