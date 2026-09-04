# CCC-Fusion Product Direction - 2026-08-11

**Status:** current repo-local product target. This is not implementation proof.
**Start commit for this docs lane:** `9e34798f9cbfe2acb62f48c9fd5783477f1faf75`

## Product goal

CCC-Fusion should turn a reviewed PRD packet into a dependable coding campaign: freeze the source, prove what the PRD actually says, create a dependency-aware execution plan, run the right workers, integrate safely, verify the exact combined tree, and stop before any protected delivery action unless the operator has explicitly opened that gate.

The product Ryan wants is a software factory, not a chat wrapper. It should do useful work in parallel when the dependency graph allows it, while keeping one writer in control of each atomic file/interface area at a time.

## Worker compute default

CCC-Fusion's worker policy is separate from Ryan's personal interactive coding preferences.

Default worker and orchestrator compute should run through OmniRoute endpoints, admitted per role rather than as one interchangeable pool:

- `glm-latest` / GLM 5.3 — spec- and contract-shaped tasks and authoring: PRD understanding, execution-plan/spec writing, and other work where the output's shape and precision matter more than raw throughput.
- `glm-flash-latest` / GLM 5.3 Flash — routine implementation: the default worker route for normal-sized coding tasks once the spec is clear. This is CCC-Fusion's golden implementation route; it must stay admitted the same way `glm-latest` and `gemini-flash-latest` are (a sealed OmniRoute combo snapshot plus an admission test in the golden Pi driver matrix).
- `minimax-latest` / MiniMax M3 — review, validation, brainstorming, and summarization roles only. Do not assign it routine implementation: it is a known no-commit risk on write-shaped tasks (see the MiniMax M3 never-writes evidence), so keep it out of the implementer seat even though it stays an admitted route.
- `gemini-flash-latest` / Gemini Flash — glue and integration work: wiring pieces together, small cross-cutting fixes, and other connective tasks between larger implementation or review passes.

Escalation is allowed when the task evidence justifies it:

1. OpenCode Go compute through OmniRoute, including Kimi K3 or Qwen 3.8 where available.
2. AGY or Gemini API compute for Gemini Pro latest, when available and appropriate.
3. AGY-delivered Opus 4.6 when the limited quota is worth spending.
4. Codex mid-tier, such as 5.6 Terra, with high or xhigh reasoning.
5. Codex high-tier, such as 5.6 Sol, at max reasoning only for work that still fails below.

Direct Anthropic Claude Code is not included as a routine CCC-Fusion worker route. Codex is a last-resort CCC-Fusion worker lane because Ryan uses that compute elsewhere.

## Harness learning target

CCC-Fusion needs a simple, useful harness-optimization loop. It should record enough data to learn which model works best for which task type and task size, without turning the product into a research platform.

At minimum, every worker attempt should leave auditable facts:

- model/provider route actually requested;
- harness used;
- task archetype;
- prompt/chunk size;
- owned paths;
- elapsed time;
- outcome;
- reviewer decision;
- failed check text when relevant.

The system should use this evidence to adjust chunk size and model routing. If GLM 5.3 Flash fails an implementation task because it is too broad, the first repair should usually be smaller, cleaner tasks before escalating to expensive models.

## Current harness truth

Do not assume OpenCode is already the normal CCC-Fusion worker harness. Current repo evidence points to Fusion's executor running embedded Pi/custom-provider sessions, with OmniRoute reachable through configured OpenAI-compatible provider endpoints. OpenCode via OmniRoute is a target/comparison lane until code and tests prove it is first-class in the CCC campaign path.

Every campaign receipt should distinguish:

- intended route;
- configured route;
- route actually requested;
- effective model/provider reported back;
- harness actually used.

## Campaign execution target

The desired campaign planner emits a dependency graph, not a flat fixed worker count. The graph can contain:

- multiple independent roots;
- successor tasks;
- multi-predecessor joins;
- research tasks that run ahead of implementation;
- domain or subsystem orchestrators that coordinate their own local workers and report upward through durable mail.

Worker count should be limited by measured capacity, not by an arbitrary permanent ceiling. The capacity controller should learn safe throughput from local hardware, provider quota, model latency, worktree/storage pressure, write-root leases, build/typecheck/test capacity, and integration throughput.

Important separation: D2 chunk extraction remains serial unless order-independent assembly, zero-residue failure handling, restart/resume behavior, and acceptance tests prove a parallel chunk path. Campaign-level DAG parallelism is a different layer. A serial extraction path can still produce a parallel coding campaign plan.

## Safety defaults

- One writer owns one atomic area or shared interface at a time.
- Independent readers and researchers can run ahead when they do not mutate the same files.
- Protected actions stay gated: push, merge, PR creation/update, private provider spend beyond allowed routes, external deployment, broker mutation, credentials, money, and destructive cleanup.
- A frozen campaign may preauthorize its exact push, PR creation or update, and merge actions. Only the dedicated terminal delivery agent may perform them, after it rechecks the exact commit, tree, target, required checks, remote state, and approval receipt.
- An unchanged, fully green campaign does not need a second approval at delivery time. Any drift, scope mismatch, stale receipt, or check failure voids the authority and fails closed.
- Ordinary workers must not push, merge, open PRs, restore branches, clean old worktrees, or call external delivery services.

## Acceptance criteria for the target

The current product target is not done until these pass on one exact tree:

- A CCC campaign importer accepts a DAG with independent roots, successors, and joins, and refuses invalid cycles or missing dependencies.
- The scheduler releases only dependency-ready tasks.
- Write-root leases prevent overlapping writers while allowing unrelated work to continue.
- Worker receipts show the requested route, effective route, harness, task archetype, and outcome.
- Capacity can ramp up and down from empirical limits rather than a hard-coded product ceiling.
- Interruption, restart, cancellation, stale approval, target drift, duplicate-effect, and middle-failure zero-residue cases are tested in a disposable environment.
- Build, typecheck, desktop checks, and the dedicated CCC product-acceptance proof all pass on the exact combined tree.
- Delivery runs only through the preauthorized terminal lane and refuses any changed candidate, target, checks, remote state, or approval receipt.

## Non-goals for this direction file

- No dashboard implementation in this documentation lane; dashboard-first operator UX remains a product target.
- No broad routing rewrite unrelated to CCC PRD campaigns.
- No reinforcement-learning platform.
- No live coding campaign against a private provider without authorization.
- No claim that this target is already implemented.
- No push, PR update, merge, force-push, or shared-history rewrite.
