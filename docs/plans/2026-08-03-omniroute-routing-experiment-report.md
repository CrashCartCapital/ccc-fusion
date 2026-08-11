# OmniRoute Routing Experiment — Measured Report

> **Historical evidence note:** This report is retained as measured evidence from 2026-08-03. Its older model-role recommendations are superseded by [2026-08-11 product direction](./2026-08-11-ccc-fusion-product-direction.md). MiniMax M3 exactness risks remain evidence to test and route around; they are not a permanent product exclusion.

- **Date:** 2026-08-03
- **Session:** E ("OmniRoute experimenter"), Phase 3
- **Target:** OmniRoute v3.8.48, `http://127.0.0.1:8092`, 13 connections, 10 combos
- **Raw evidence:** `/tmp/omniroute-exp-2026-08-03/` (outside the repo, never committed)
- **Repo writes by this session:** this file only.

---

## 1. Executive summary

I sent **302 measured requests** through the local OmniRoute gateway plus **50 Gemini-CLI calls**, all within the operator's spend policy (Codex 11, Claude 8 — both far under the 30 cap, cheap classes only).

Five findings matter:

1. **Quota is collected but not served.** The known finding is confirmed at the endpoint and *refuted* at the system level. OmniRoute writes real per-window quota to a database table every few minutes — at the end of the run it knew the Claude weekly window was at **32%** and the 5-hour session at **33%** — while `/api/usage/quota` simultaneously reported `quotaTotal:null, percentRemaining:100` for all 13 providers. The 100% is a hardcoded default, not evidence. But the data exists, so this is a wiring bug, not an observability ceiling.
2. **Latency and success metrics are contaminated by the response cache.** OmniRoute records cache hits as genuine provider successes. One combo shows `avgLatencyMs: 6` purely because six of my requests were served from cache. Any health- or latency-aware balancer built on these numbers is reading a fiction.
3. **Identity fidelity is clean.** Across all 302 requests, **zero** responses came from a model outside the requested model or its declared combo chain. No silent aliasing or substitution was reproduced.
4. **A combo can silently route around a non-existent model.** `minor-task-monkey`'s priority-1 member `codex/gpt-5.4-mini` is not in the catalog. Ten requests produced zero errors, zero fallback counts, and zero health signal — the chain just skipped it.
5. **Model quality diverges sharply on a trivial deterministic task.** Reversing a 9-character string: `gemini-3.1-flash-lite` and `gpt-5.6-luna` scored 100%; `MiniMax-M2.7` scored **45%** and `MiniMax-M3` **60%**. This is direct empirical support for the frozen policy that MoE/MiniMax models are auxiliary only and never used for verbatim extraction.

Two premises in my brief did **not** survive contact with evidence, and I report them as refuted rather than quietly dropping them: the antigravity token expiry was a non-event (§7), and the Gemini CLI as named is structurally dead while its `agy` sibling works (§8).

---

## 2. Methodology

### 2.1 Discovery, not assumption

I located the gateway from live state rather than config lore: `lsof -nP -iTCP -sTCP:LISTEN` showed node PID 1666 on `127.0.0.1:8092`; `lsof -p 1666` gave cwd `~/.omniroute-devstack-candidate/v3.8.48/source/` and the live DB at `~/.omniroute-devstack/data/storage.sqlite`. Port 4040 was excluded from every scan and never touched.

A version discrepancy is worth recording: the process title reads `omniroute (v16.2.10)` (the npm wrapper), while the running build and API both report **3.8.48**. Trust the API.

`/v1/*` is open on loopback; `/api/*` returns HTTP 401. I used the MCP tools (`mcp__stack-core__omniroute__*`) for authenticated admin reads so no key material ever entered my shell, argv, or scratch files.

### 2.2 The workload

Each request asks the model to reverse a **freshly generated random 9-character uppercase token**:

```
Reverse this string. Reply with ONLY the reversed string, no explanation, no punctuation: <TOKEN>
```

This design does three jobs at once:

- **Cache-busting.** A unique token per request guarantees a real provider call. Result: **300 of 302 requests were cache MISS** (the 2 non-MISS are the 2 failures). Every latency number below is a real network round trip.
- **Work verification.** The correct answer cannot be produced without actually performing the transform, so `correct%` measures capability, not luck or caching.
- **Benign and clean.** No vault content, no repo content, no personal data, no secrets.

Harness: `/tmp/omniroute-exp-2026-08-03/bench2.sh`, driver `sweep.sh`, both with `set -o pipefail` and per-lane exit codes. Requests are sequential within a lane, so the throughput column is *sequential* throughput (1/latency), not a saturation measurement — I did not run a concurrency saturation test against paid lanes.

### 2.3 What I measured per request

From response headers (`x-omniroute-*`) and body: effective model, effective provider, server-side latency, cost receipt, cache status, finish reason, token counts, and correctness. Wall-clock latency measured client-side.

### 2.4 Budget compliance (operator spend policy, verified)

| Lane | Policy | Actual | Class used | Within policy |
|---|---|---|---|---|
| Codex | max ~30, Luna-class only | **11** | `gpt-5.6-luna` only | Yes |
| Claude | max ~30, Sonnet-class only | **8** | `claude-sonnet-4-6` only | Yes |
| MiniMax + GLM/ZAI | effectively unlimited | 92 | — | Yes |
| Gemini free API | high volume fine | 35 | — | Yes |
| Gemini CLI (`agy`) | headroom, characterize limits | 50 | — | Yes |
| Local oMLX (M5 + pool) | free/unlimited | 35 | — | Yes |

No `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5-high`, or any Opus model was ever invoked. Verified by querying effective model across all 302 records, not by trusting intent.

**Three combos were deliberately not burn-in tested**, because their priority-1 member is an expensive Codex model that the spend policy forbids and their strategies (fill-first / auto / priority) would drive traffic straight into it:

| Combo | Priority-1 member | Why skipped |
|---|---|---|
| `top-tier-heavy` | `codex/gpt-5.6-sol` | Sol is not Luna-class |
| `top-tier-standard` | `codex/gpt-5.6-terra` | Terra is not Luna-class |
| `hindsight-reflect-deep` | `cx/gpt-5.5-high` | Not a cheap class |

This is a real, deliberate coverage gap. I measured their non-Codex chain members individually instead (glm-5.2, MiniMax-M3, antigravity variants all appear in other lanes), but I have **no end-to-end measurement of those three combos** and do not claim any.

---

## 3. Audit: what is actually there

Confirmed against live state: **13 connections, 10 combos, zero open circuit breakers**, `cryptography: healthy (aes-256-gcm)`.

| Combo | Strategy | Chain (priority order) |
|---|---|---|
| `top-tier-heavy` | fill-first | gpt-5.6-sol → gemini-3-pro-preview → gemini-pro-agent |
| `top-tier-standard` | auto | gpt-5.6-terra → gemini-3.1-pro-low → glm-5.2 → MiniMax-M3 |
| `mid-tier-plus` | least-used | MiniMax-M2.7 → gpt-5.6-luna → glm-5.1 → gemini-3.5-flash-preview → gpt-oss-120b:free |
| `mid-tier-standard` | round-robin | glm-5.1 → MiniMax-M2.7 → gemini-3.5-flash-low |
| `minor-task-monkey` | reset-aware | **gpt-5.4-mini (does not exist)** → glm-5-turbo → gemini-3.1-flash-lite |
| `sidestreet` | priority | glm-5.1 → gemini-3-pro-preview → nemotron-3-super-120b:free → gemini-3.5-flash |
| `pre-flight-query-decanter` | priority | antigravity flash-lite → gemini(api) flash-lite → glm-5-turbo → omlx-local gpt-oss-20b |
| `pca-receipt-ensemble` | priority | MiniMax-M3 → glm-5.1 |
| `hindsight-extract-fast` | priority | gemini(api) flash-lite → antigravity flash-lite → omlx-local gpt-oss-20b |
| `hindsight-reflect-deep` | priority | cx/gpt-5.5-high → glm-5.2 → gemini-pro-agent → MiniMax-M3 → gemini-3.5-flash |

Models catalog: **794 entries**. Two distinct local lanes exist and should not be conflated: `omlx-local/*` (M5 Max, `127.0.0.1:8000`, 22 models) and `olla-local/*` ("Olla Tailnet Pool", 22 models). I verified the M2 Max tunnel on `127.0.0.1:18000` is up and serving, but I did **not** prove that "Olla Tailnet Pool" is the M2 Max — the tunnel exposes only 2 models and does not include `gpt-oss-20b`, so the pool is reaching something else. Treat that mapping as unproven.

---

## 4. Quota observability verdict

**Verdict: the known finding is CONFIRMED at the endpoint and REFUTED at the system level. Quota is observable — it is being measured and stored right now — but the endpoint does not serve it.**

### 4.1 The endpoint's answer

Every one of the 13 providers returns the same shape. Raw capture: `raw/quota-endpoint-response.json`.

```json
{ "provider": "claude", "quotaUsed": 0, "quotaTotal": null,
  "percentRemaining": 100, "resetAt": null, "tokenStatus": "valid" }
```

Unauthenticated proof of the auth boundary: `raw/quota-direct-401.txt` (`GET /api/usage/quota -> HTTP 401`).

### 4.2 What the database knew at the same moment

Raw capture: `raw/quota-final-comparison.txt`, `raw/quota-db-latest.csv`.

| Wall clock | Endpoint says (claude) | DB `quota_snapshots` says (claude) |
|---|---|---|
| 17:02:57Z | `quotaTotal:null`, `percentRemaining:100` | session **66%**, weekly **35%** |
| 17:15:43Z | (unchanged) | session **52%**, weekly **34%** |
| 17:40:54Z | `quotaTotal:null`, `percentRemaining:100` | session **33%**, weekly **32%** |

The database tracked the Claude 5-hour window falling from 66% to 33% over the run — live, real depletion, with real reset timestamps (`next_reset_at = 2026-08-03T20:00:00Z`) — while the endpoint reported a flat 100% and `resetAt: null` throughout.

`quota_snapshots` holds **97,221 rows** spanning 2026-05-27 to now, with a live collector (392 antigravity snapshots in the last hour alone). Codex session sat at 61–63%. GLM and MiniMax genuinely were at 99–100%, which independently corroborates the operator's "idle capacity" characterization of those lanes.

### 4.3 Root cause

`src/app/api/usage/quota/route.ts` (lines 64–108). `quotaTotal` becomes non-null on only three paths:

1. `getLearnedLimits()` returns a limit for `provider:connectionId` — an **in-memory** map populated from upstream rate-limit response headers. Empty here.
2. The connection is currently rate-limited (`rateLimitedUntil` in the future) → hardcoded `100/100/0%`.
3. `syntheticUsage > 0`, computed as `min(95, queued*10 + running*5 + executing*3)` — an **instantaneous queue-pressure gauge**.

Otherwise the initialized defaults survive untouched: `quotaTotal = null`, `quotaUsed = 0`, `percentRemaining = 100`.

So `percentRemaining: 100` precisely means: *"no rate-limit headers have ever been learned for this connection, it is not currently rate-limited, and nothing is queued this instant."* It does not mean any quota remains. Critically, the endpoint **never reads `quota_snapshots`** — the one place the real answer lives. There is also no cumulative usage counter anywhere in this path; `quotaUsed` is derived, never accumulated.

Even the synthetic path is unusable for balancing: it is a congestion signal that decays to 100 the moment the queue drains, so it carries zero memory of consumption.

### 4.4 Proposed fix

Join the freshest `quota_snapshots` row per `(provider, connection_id, window_key)` into the quota response, and return windows as a list rather than collapsing to one number:

```sql
SELECT s.provider, s.connection_id, s.window_key,
       s.remaining_percentage, s.is_exhausted, s.next_reset_at, s.created_at
FROM quota_snapshots s
JOIN (SELECT provider, connection_id, window_key, MAX(created_at) mc
      FROM quota_snapshots GROUP BY provider, connection_id, window_key) m
  ON s.provider = m.provider AND s.connection_id = m.connection_id
 AND s.window_key = m.window_key AND s.created_at = m.mc;
```

Three requirements on the fix:

- **Stale data must read as unknown, not as full.** Attach `created_at` and treat a snapshot older than ~2 collector intervals as `null`, never as 100.
- **Keep `percentRemaining` null when unknown.** The current default is the entire bug. An honest `null` is legal per E3; a fabricated 100 is not.
- **Preserve multiple windows.** Claude's 5-hour (33%) and 7-day (32%) windows bind differently and a single scalar destroys that.

Until this lands, **`percentRemaining` from `/api/usage/quota` must not be used as a load-balancing input.** Anything balancing on it is balancing on a constant.

---

## 5. Metrics cache contamination

**OmniRoute's combo metrics cannot distinguish a semantic-cache hit from a real provider call, and records cache hits as genuine fast successes.**

Discovered accidentally and then confirmed deliberately. My first probe batch sent an identical prompt 6 times to `pre-flight-query-decanter`. The first call took 6410ms (`x-omniroute-cache: MISS`); calls 2–6 returned in 45–55ms (`x-omniroute-cache: HIT`). Then `get_combo_metrics` reported:

```json
"pre-flight-query-decanter": {
  "totalRequests": 6, "totalSuccesses": 6, "totalFailures": 0,
  "avgLatencyMs": 6, "successRate": 100, "fallbackRate": 0 }
```

An `avgLatencyMs` of **6** for a combo whose real p50 is **3456ms** — a ~575× understatement — because cached responses were counted as provider successes.

The cache also crosses request shapes: a HIT populated by a *direct* `antigravity/gemini-3.1-flash-lite` call was served to a subsequent *combo* request, so the cache key is content+model, not combo.

**Consequences, stated plainly:**

- A latency-aware balancer will converge on whichever combo happens to have the warmest cache, not the fastest provider — a self-reinforcing loop, since routing more traffic to a cached prompt produces more hits and an even better score.
- A health-aware balancer will read cache hits as provider health. A provider could be entirely down while its combo shows 100% success, as long as the prompts repeat.
- Cost is understated identically: cache hits carry `x-omniroute-response-cost: 0.0000000000`.

**Proposed fix:** tag every metrics record with the cache disposition already computed for the `x-omniroute-cache` header, and expose metrics split three ways — `served_from_cache`, `served_by_provider`, and combined. Routing and health decisions must consume only `served_by_provider`. Until that exists, **combo latency and success metrics are `unknown` for routing purposes per E3** — not "good", not "bad", unusable. My own per-lane numbers in §6 avoid this trap by construction: 300/302 verified cache MISS.

---

## 6. Measured results

N per lane, cache-busted, sequential. `correct%` = exact reversal produced.

### 6.1 Direct model lanes

| lane | N | ok | fail | p50 ms | p95 ms | correct% | cost receipt |
|---|---|---|---|---|---|---|---|
| `omlx-local/gpt-oss-20b` (M5) | 20 | 20 | 0 | **865** | 3383 | 85.0 | $0 (local) |
| `minimax/MiniMax-M3` | 15 | 15 | 0 | 1468 | 2795 | **60.0** | $0.00070650 |
| `antigravity/gemini-3.1-flash-lite` (pre) | 8 | 8 | 0 | 2294 | 4294 | 100.0 | $0 (subscription) |
| `antigravity/gemini-3.1-flash-lite` (post) | 8 | 8 | 0 | 3140 | 9537 | 87.5 | $0 (subscription) |
| `olla-local/gpt-oss-20b` (pool) | 15 | 14 | **1** | 2548 | 12047 | 71.4 | $0 (local) |
| `codex/gpt-5.6-luna` | 8 | 8 | 0 | 2193 | 2812 | **100.0** | $0.00523500 |
| `gemini/gemini-3.1-flash-lite` (API) | 20 | 20 | 0 | 3128 | 6005 | **100.0** | $0.00579375 |
| `claude/claude-sonnet-4-6` | 8 | 8 | 0 | 3156 | 4470 | 87.5 | $0.00236700 |
| `glm/glm-5.2` | 10 | 10 | 0 | 3848 | 5466 | 90.0 | $0.02481380 |
| `glm/glm-5.1` | 20 | 20 | 0 | 4666 | 6043 | 85.0 | $0.04646420 |
| `minimax/MiniMax-M2.7` | 20 | 20 | 0 | 7776 | 10061 | **45.0** | $0.01040800 |
| `glm/glm-5-turbo` | 15 | 15 | 0 | 8757 | 24571 | 93.3 | $0.02885440 |
| `gemini/gemini-3.5-flash` (API) | 15 | 14 | **1** | 13695 | **68083** | 85.7 | $0.03851250 |

### 6.2 Combo lanes

| combo | N | ok | p50 ms | p95 ms | correct% | which chain member actually served |
|---|---|---|---|---|---|---|
| `pca-receipt-ensemble` | 15 | 15 | **1070** | 2966 | **46.7** | MiniMax-M3 ×15 (priority-1, never fell back) |
| `hindsight-extract-fast` | 20 | 20 | 2299 | 2851 | **95.0** | gemini-3.1-flash-lite ×20 (priority-1) |
| `minor-task-monkey` | 10 | 10 | 2841 | 4642 | 90.0 | gemini-3.1-flash-lite ×5, glm-5-turbo ×5 — **priority-1 never served** |
| `mid-tier-plus` | 12 | 12 | 2992 | 9315 | 91.7 | MiniMax-M2.7 ×3, gpt-5.6-luna ×3, glm-5.1 ×3, gemini-3.5-flash-preview ×3 (even least-used spread) |
| `pre-flight-query-decanter` | 20 | 20 | 3456 | 4711 | 80.0 | antigravity flash-lite ×20 (priority-1) |
| `sidestreet` | 15 | 15 | 3910 | 11209 | 86.7 | glm-5.1 ×14, nemotron-120b:free ×1 |
| `mid-tier-standard` | 20 | 20 | 4122 | 14094 | 85.0 | MiniMax-M2.7 ×7, gemini-3.5-flash-low ×7, glm-5.1 ×6 (clean round-robin) |

### 6.3 Failure modes observed

Only 2 hard failures in 302 requests (99.3% success):

| lane | failure | interpretation |
|---|---|---|
| `gemini/gemini-3.5-flash` | 1× HTTP 502 | upstream error surfaced correctly; also the worst tail in the run (p95 68s) |
| `olla-local/gpt-oss-20b` | 1× curl rc≠0, no HTTP | connection-level timeout to the tailnet pool |

Notably, **no combo ever exercised a fallback**. Every combo request was served by the strategy's intended member. I therefore have **no measurement of failover latency under real provider failure** — the one thing that would have produced it (the antigravity expiry) turned out to be a non-event (§7). This is an honest gap: the fallback path in these ten combos remains unmeasured.

### 6.4 Gateway overhead

The gap between client wall-clock and `x-omniroute-latency-ms` is consistently **35–60ms** at p50 across every lane (one outlier: `minor-task-monkey` at 167ms). OmniRoute's own routing cost is small and stable; essentially all latency is the upstream provider.

### 6.5 Quality is not correlated with latency

The fastest lanes are not the best, and two of the worst-scoring lanes are among the fastest. `MiniMax-M3` answers in 1.5s and is wrong 40% of the time; `pca-receipt-ensemble` (M3 at priority 1) is the fastest combo measured and the **least accurate at 46.7%**. Observed failure mode is character transposition and dropping — exactly the verbatim-infidelity signature:

```
token=EMCCNDFNC  expected=CNFDNCCME  got=CNFNDMCCE   (transposed)
token=LOVEQKWBA  expected=ABWKQEVOL  got=ABWKEVOL    (dropped a character)
token=UUHLHLTLH  expected=HLTLHLHUU  got=HLTLHLU     (dropped two)
```

A router optimizing on latency alone would pick precisely the wrong models for any task where exactness matters.

---

## 7. The antigravity token expiry — premise refuted

My brief stated the antigravity token was expiring and expected a degraded lane. I set up a before/after natural experiment around the stated deadline of `2026-08-03T17:31:42Z`.

| Phase | Time | N | Result |
|---|---|---|---|
| Pre-expiry, direct | 17:09 | 8 | 8/8 OK, antigravity, p50 2294ms |
| Post-expiry, direct | 17:33 | 8 | **8/8 OK, still antigravity**, p50 3140ms |
| Post-expiry, combo `pre-flight` | 17:33–17:34 | 8 | **8/8 OK, still antigravity priority-1**, no failover |

**Zero failures. No failover. No degradation.** The cause is visible in the connection record: `token_expires_at` moved from `17:31:42Z` to **`18:26:42Z`**, with `updated_at = 17:34:17.882Z` — precisely when my probe finished. **OmniRoute silently refreshed the token on demand**, transparently to the caller.

I did not touch any credential refresh flow; I only observed one happen. One post-expiry call took 12708ms against a ~3000ms baseline, which is consistent with an inline refresh, but with N=1 I am not asserting causation.

Two implications:

- The lane is **not** degraded. `tokenStatus: "valid"` was correct, and the alarm in my brief was a false positive.
- `token_expires_at` is a **poor routing signal**, because it is refreshed reactively. A balancer that pre-emptively drains a lane approaching its expiry timestamp would be draining a healthy lane for nothing. `deriveTokenStatus` only reports `"expiring"` inside a 15-minute window, and even that predicts nothing about actual availability.

---

## 8. Gemini CLI characterization

### 8.1 The named Gemini CLI is dead, not throttled

The `gemini` binary fails structurally on every call:

```
IneligibleTierError: This client is no longer supported for Gemini Code Assist for
individuals. To continue using Gemini, please migrate to the Antigravity suite of
products: https://antigravity.google
```

This is not a rate limit and no backoff can fix it. The premise "Gemini CLI has plenty of headroom" is refuted for this binary. It also explains why `antigravity` exists as a connection — it is the successor path.

### 8.2 The working lane is `agy` (agy-bridge)

`agy -p '<prompt>'` works headless and returns useful telemetry, including genuine quota signals:

```
[agy-bridge] model: gemini-3.5-flash-high | failover: gemini-3.6-flash-high: quota exhausted
```

That is a **real** quota-exhaustion signal with an automatic model-level failover — notably more honest than OmniRoute's own quota endpoint.

### 8.3 Sequential behaviour (N=30)

| metric | value |
|---|---|
| N / ok / fail | 30 / 29 / 1 |
| confirmed `RESOURCE_EXHAUSTED` (429) | **1** (call 6) |
| correctness | 29/29 |
| latency p50 / p90 / p95 | 8136 / 10651 / 10805 ms |
| min / max | 6827 / 24070 ms |
| sustained offered rate | **6.8 req/min** |

The single failure was on the *eligibility check*, not the completion, and **self-healed on the very next call with no backoff applied**.

### 8.4 Soft-throttle curve — my earlier hypothesis was wrong

I initially flagged a 24-second call around #20 as progressive throttling. Blocking the run disproves that:

| calls | n | p50 ms | max ms | failures |
|---|---|---|---|---|
| 1–5 | 5 | 9679 | 10738 | 0 |
| 6–10 | 5 | 7424 | 8136 | **1** |
| 11–15 | 5 | 8206 | 9341 | 0 |
| 16–20 | 5 | 8686 | **24070** | 0 |
| 21–25 | 5 | 8076 | 10629 | 0 |
| 26–30 | 5 | 7519 | 8809 | 0 |

p50 is **flat and mildly declining** (9679 → 7519ms). The 24s call is an isolated outlier, not a trend. **There is no progressive soft throttle at 6.8 req/min.** Degradation does not start within 30 sequential calls at that rate.

### 8.5 Concurrency (waves of 2/4/6/8)

| wave | n | ok | fail | p50 ms | confirmed 429 |
|---|---|---|---|---|---|
| 2 | 2 | 1 | 1 | 7779 | 0 |
| 4 | 4 | 3 | 1 | 12989 | 0 |
| 6 | 6 | 5 | 1 | 10268 | 0 |
| 8 | 8 | 5 | **3** | 8938 | 0 |

Failures rise with parallelism, but every one carries the same generic signature — `Error: Agent execution terminated due to error.` — with **no 429 and no quota text**. I therefore **cannot attribute these to server-side rate limiting**; local CLI/session contention is at least as plausible. Stated as unknown rather than guessed.

### 8.6 Derived backoff policy

Scoped to what I measured — sequential ≤6.8 req/min for 30 calls, and concurrency ≤8:

1. **Serialize by default.** Run `agy` calls sequentially. Concurrency bought no throughput (p50 rose from ~8.1s to ~13s at wave 4) and cost a 17–37% failure rate. Cap at **1 in-flight**; if parallelism is required, cap at **2** and expect retries.
2. **No proactive pacing below 7 req/min.** No added delay is justified — the data shows no degradation there.
3. **On `RESOURCE_EXHAUSTED` / 429: retry once immediately.** Measured behaviour is a single-call transient that self-healed with zero wait. An immediate single retry is correct and cheap.
4. **If the immediate retry also fails, back off 30s, then 60s, then 120s (cap), max 3 attempts.** This is *extrapolation beyond my data* — I observed only one 429 and never a consecutive pair. Flagged as unvalidated; test T-9 pins it.
5. **Treat `Agent execution terminated due to error` as retryable-once but attribute it to local contention,** not the provider — do not let it open a provider circuit breaker.
6. **Never treat `IneligibleTierError` as retryable.** It is terminal; fail the lane over to `antigravity` or the Gemini API key immediately.

---

## 9. Identity fidelity (frozen decision E2)

**Result: clean. Zero identity violations in 302 requests.**

Every response's effective identity (`x-omniroute-model` + `x-omniroute-provider`, cross-checked against the body `model` field) was either the exact requested model or a declared member of the requested combo's chain. The analyzer checked combo membership against the live `/v1/combos` chain definitions; `identity_offchain_N = 0` for all 21 lanes.

**One anomaly I chased and could not reproduce.** My very first exploratory probe — a *streaming* request to `mid-tier-standard`, before cache-busting was in place — returned `model: "glm-5.2"`, a model not in that combo's chain (glm-5.1 → MiniMax-M2.7 → gemini-3.5-flash-low). I investigated properly rather than reporting it as fact:

- The stored chain in the `combos` table contains `glm/glm-5.1`; `glm-5.2` is absent.
- `combo_adaptation_state` is **empty**, so adaptive substitution is not the cause.
- Direct `glm/glm-5.1` returns `glm-5.1` in both streaming and non-streaming modes.
- Across N=20 on `mid-tier-standard` and N=20 on `glm/glm-5.1`, it **never recurred**.

I am recording it as a **single unreproduced observation, not a finding**. Test T-6 pins the invariant so a future recurrence is caught rather than re-litigated.

A related artifact worth noting for maintainers: the combo's internal step id is `mid-tier-standard-model-1-glm-glm-4-7-...` while the model is `glm/glm-5.1` — the entry was re-pointed from glm-4.7 without regenerating its id. Cosmetic, but it makes `byTarget` metrics keys misleading to read.

### Silent skip of a non-existent chain member

`minor-task-monkey` declares priority-1 `codex/gpt-5.4-mini`. That model **is not in the 794-entry catalog** (only `openrouter/openai/gpt-5.4-mini` exists, a different provider). Across 10 requests it was served 5× by glm-5-turbo and 5× by gemini-3.1-flash-lite, with:

- zero errors returned to the caller,
- `totalFallbacks: 0` in combo metrics,
- no health or circuit-breaker signal.

A permanently broken chain member is invisible. This is not an identity *violation* (the models that served were legitimate chain members), but it is an **observability failure**: a combo can silently degrade to a shorter chain forever. Test T-7 covers it.

---

## 10. Cost (frozen decision E3)

Every request carried a per-response receipt header, `x-omniroute-response-cost`, and I recorded it verbatim. Receipts are present for **all 302 requests**. Totals per lane appear in §6.1.

Zero-valued receipts for `antigravity` and both local lanes are **genuine zeros** (subscription and local compute), not missing data — distinct from unknown.

**However, cost is not consistently receipted, and I flag this rather than reporting a single number as truth.** Two OmniRoute surfaces disagree about the same 9 antigravity requests:

| Surface | Reported cost for the same 9 antigravity calls |
|---|---|
| `x-omniroute-response-cost` header (per response) | `0.0000000000` each → **$0.00** total |
| `omniroute_cost_report` `byProvider` | **$0.012484** |

Both cannot be right. The plausible reading is that the header reports realized subscription cost (zero) while the cost report imputes an equivalent list price — but I did not prove which, and I will not fabricate a reconciliation.

Additionally, `omniroute_cost_report` returns a top-level `totalCost: 0` and `requestCount: 0` while its own `byProvider`/`byModel` breakdown shows 58 requests — the aggregate is broken while the breakdown works.

**Per E3, the honest statement is:** per-request receipts exist and are usable for *relative* lane comparison; **absolute spend for subscription lanes is `unknown`** pending reconciliation of the two surfaces. No fabricated number is offered.

One measurement caveat that inflates every cost and latency figure equally: prompt token counts came back around **2055 tokens for a ~20-token prompt**, so roughly 2000 tokens of system/context material are injected per request. This is consistent across lanes and does not affect relative comparisons, but absolute per-request cost in production will depend on that injection.

---

## 11. Which observability surfaces actually work

This matters more than any single metric: a routing policy may only depend on surfaces that are proven live. Several OmniRoute surfaces are broken in ways that look like healthy data.

| Surface | State | Evidence |
|---|---|---|
| `x-omniroute-*` response headers | **Works** — model, provider, latency, cost, cache, version | 302/302 requests |
| `/v1/models`, `/v1/combos` | **Works** | 794 models, 10 combos |
| `omniroute_get_health` | **Works** — version, circuit breakers, crypto | breakers `[]` |
| `quota_snapshots` DB table | **Works** — real per-window %, real reset times, live collector | 97,221 rows |
| `get_combo_metrics(comboId)` | **Works, but cache-contaminated** (§5) | `avgLatencyMs: 6` |
| `list_combos(includeMetrics:true)` | **BROKEN** — returns `metrics: null` for all 10 combos | tool output |
| `/api/usage/quota` | **BROKEN** — constant `null`/`100` for all 13 (§4) | `raw/quota-endpoint-response.json` |
| `get_provider_metrics(provider)` | **BROKEN** — `requestCount: 0`, all latency percentiles `0` | reported 0 while cost report showed 45 glm requests |
| `omniroute_cost_report` top-level | **BROKEN** — `totalCost: 0`, `requestCount: 0` | breakdown shows 58 requests |
| `get_session_snapshot` | **PARTIAL** — `topModels` correct; `topProviders` all `"unknown"`; `requestCount: 0` | tool output |

**API asymmetry, called out explicitly:** `get_combo_metrics(comboId)` returns full per-target data, while `list_combos(includeMetrics: true)` returns `metrics: null` for every combo. Anyone building on the list endpoint will silently conclude no combo has ever been used. Per-combo metrics must be fetched individually by `comboId`, and the `includeMetrics` flag on the list endpoint should be treated as non-functional.

Note also that `get_combo_metrics` and `get_session_snapshot` are **in-memory and reset**: `sessionStart` moved to `17:17:39Z` mid-experiment with `requestCount: 0`, discarding earlier counts. They are not a durable basis for routing.

---

## 12. Routing policy proposal

Two hard constraints shape this. First, the **role policy is settled** and is encoded below as correctness, not preference. Second, the policy may only claim awareness of what §11 proves observable — which rules out quota-aware and health-aware balancing today.

### 12.1 Role policy (settled — not re-litigated)

| Role | Models | Rule |
|---|---|---|
| Code-writing | `codex/gpt-5.6-luna` and `glm/glm-5.2` primary; Sonnet-class third | escalate to `gpt-5.6-terra` (complex) / `gpt-5.6-sol` (architectural) |
| Auxiliary only | all Gemini variants, `MiniMax-M3` | second opinions, critique, search — **never production code** |
| Extraction / understanding | dense/frontier verbatim-capable models only | **never MoE** (measured: MoE paraphrased 25/33 quotes on quote-bearing extraction) |

My data independently corroborates the MoE exclusion: MiniMax-M2.7 scored **45%** and MiniMax-M3 **60%** on exact 9-character reversal, failing by transposition and character-dropping — the same infidelity mode.

### 12.2 Task archetype → combo mapping

| Archetype | Route | Measured basis |
|---|---|---|
| Cheap pre-flight / triage | `pre-flight-query-decanter` | p50 3456ms, 20/20 OK, priority-1 stable |
| Bulk extraction (verbatim) | `hindsight-extract-fast` | **p50 2299ms, p95 2851ms, 95% correct** — best accuracy/latency combination measured |
| Latency-critical, low-stakes | `omlx-local/gpt-oss-20b` (M5) | **p50 865ms**, free, 85% correct |
| Code-writing (routine) | `codex/gpt-5.6-luna` direct | **100% correct**, p50 2193ms, tightest tail (p95 2812ms) |
| Code-writing (secondary) | `glm/glm-5.2` direct | 90% correct, p50 3848ms |
| Balanced general work | `mid-tier-plus` | 91.7% correct, even 4-way spread, exercises Luna |
| Second opinion / critique | `sidestreet` or `agy` | auxiliary role only |
| **Not recommended as-is** | `pca-receipt-ensemble` | **46.7% correct** — MoE at priority-1; unfit for receipt work where exactness is the point |
| **Repair before use** | `minor-task-monkey` | priority-1 model does not exist (§9) |

### 12.3 Load-balancing policy — honestly scoped

**Do not build quota-aware balancing on `/api/usage/quota` today.** It returns a constant. Balancing on it is balancing on nothing.

**Do not build latency- or health-aware balancing on combo metrics today.** They are cache-contaminated (§5) and in-memory (§11).

What *is* safely usable right now:

1. **Static role-based routing** (§12.1) — depends only on the catalog, which is reliable.
2. **Per-request effective-identity verification** via `x-omniroute-model` / `x-omniroute-provider`. Proven reliable across 302 requests; this is the one trustworthy runtime signal. Assert the served model is an intended chain member and alarm when it is not.
3. **Client-side latency measurement**, cache-busted or cache-tagged. My own numbers demonstrate the method; gateway overhead is a stable 35–60ms.
4. **Direct reads of `quota_snapshots`** as an interim quota signal — with a staleness guard, since some windows (codex weekly) were last written on 2026-07-12.

Once §4.4 and §5 land, the policy can be extended to: prefer lanes with `remaining_percentage` above a floor across *all* their windows; treat `is_exhausted` as a hard drain; and use `next_reset_at` for scheduling. **That extension is explicitly not authorized by current data.**

Guidance derived from measurement rather than assumption:

- **Do not pre-drain on `token_expires_at`.** Refresh is reactive and transparent (§7).
- **Do not treat GLM/MiniMax "100%" as headroom proof.** It is real in `quota_snapshots` but a default in the endpoint; only the former counts.
- **Weight by correctness, not latency.** §6.5 shows they are anti-correlated on the lanes that matter.

---

## 13. Test list for the implementer

| ID | Test | Pins |
|---|---|---|
| T-1 | `/api/usage/quota` returns non-null `quotaTotal`/`percentRemaining` for a provider with a fresh `quota_snapshots` row | §4 core fix |
| T-2 | A snapshot older than the staleness threshold yields `percentRemaining: null`, **never** 100 | prevents the default-as-evidence bug returning |
| T-3 | Multi-window providers return all windows (Claude 5h **and** 7d), not a collapsed scalar | §4.4 |
| T-4 | Endpoint value matches the DB value for the same `(provider, connection_id, window_key)` within one collector interval | end-to-end wiring |
| T-5 | Combo metrics exclude or tag cache hits: N cached + M real calls yields `served_by_provider == M` and real latency | §5 |
| T-6 | A combo request's `x-omniroute-model` is always a declared chain member; non-members fail the assertion | §9 identity, catches the glm-5.2 anomaly |
| T-7 | A combo containing a non-existent model surfaces a warning/health signal instead of silently skipping | §9 `gpt-5.4-mini` |
| T-8 | `list_combos(includeMetrics:true)` returns the same metrics as `get_combo_metrics(comboId)` | §11 asymmetry |
| T-9 | `agy` backoff: a simulated consecutive 429 pair triggers immediate retry then 30s backoff, capped at 3 attempts | §8.6 — validates my extrapolated rule |
| T-10 | `IneligibleTierError` is classified terminal, never retried, and fails over immediately | §8.1 |
| T-11 | Forced provider failure produces a real fallback with `totalFallbacks` incremented and measurable failover latency | §6.3 unmeasured gap |
| T-12 | `get_provider_metrics` `requestCount` is non-zero after N requests to that provider | §11 |
| T-13 | Cost: header receipt and `cost_report` agree for the same request set, or the difference is documented and typed | §10 E3 |
| T-14 | Token refresh across `token_expires_at` produces zero caller-visible failures | §7 regression guard |

---

## 14. Acceptance summary and honest gaps

**Delivered:** 302 measured gateway requests + 50 Gemini-CLI calls across 21 lanes, all cache-busted and verified; quota verdict backed by raw captures; identity fidelity per E2 (clean, 0/302); cost receipts per E3 with the contradiction flagged rather than reconciled by guesswork; Gemini CLI backoff derived and its extrapolated portion labelled; routing policy scoped to proven-observable surfaces only. Budgets held with margin: **Codex 11/30, Claude 8/30**, cheap classes only.

**Gaps I am not papering over:**

1. **`top-tier-heavy`, `top-tier-standard`, `hindsight-reflect-deep` were never burn-in tested** — their priority-1 members are expensive Codex models the spend policy forbids. No end-to-end numbers exist for them and none are implied.
2. **No fallback path was ever exercised.** Zero fallbacks occurred in 302 requests, and the antigravity expiry that should have forced one was silently refreshed away. Failover latency is **unmeasured** (test T-11).
3. **The glm-5.2 anomaly is unreproduced** and recorded as an observation, not a finding.
4. **Concurrency failures on `agy` are unattributed** — generic errors with no 429; server throttling vs local contention is `unknown`.
5. **Absolute subscription cost is `unknown`** per E3, because two OmniRoute surfaces disagree.
6. **"Olla Tailnet Pool" was not proven to be the M2 Max.** The tunnel is up but serves a different model set.
7. **Sequential throughput only.** No saturation testing against paid lanes.

### Evidence paths (not committed; outside the repo)

| Path | Contents |
|---|---|
| `/tmp/omniroute-exp-2026-08-03/data/results.jsonl` | 302 per-request records |
| `/tmp/omniroute-exp-2026-08-03/data/summary.json` | per-lane computed summary |
| `/tmp/omniroute-exp-2026-08-03/data/analysis.md` | per-lane tables |
| `/tmp/omniroute-exp-2026-08-03/data/throughput.md` | throughput + gateway overhead |
| `/tmp/omniroute-exp-2026-08-03/data/agy-cli.jsonl`, `agy-conc.jsonl`, `agy-analysis.md` | Gemini CLI characterization |
| `/tmp/omniroute-exp-2026-08-03/raw/quota-endpoint-response.json` | raw null-quota response (13 providers) |
| `/tmp/omniroute-exp-2026-08-03/raw/quota-final-comparison.txt` | endpoint-vs-DB side-by-side |
| `/tmp/omniroute-exp-2026-08-03/raw/quota-db-latest.csv` | latest snapshot per provider/window |
| `/tmp/omniroute-exp-2026-08-03/raw/quota-direct-401.txt` | auth-boundary proof |
| `/tmp/omniroute-exp-2026-08-03/raw/v1-combos.json`, `v1-models.json` | combo chains, model catalog |
| `/tmp/omniroute-exp-2026-08-03/bench2.sh`, `sweep.sh`, `agy-burst.sh`, `agy-conc.sh`, `antigravity-post.sh`, `analyze.py` | harnesses |

No secrets, tokens, or Authorization headers were written to any of these files; only `x-omniroute-*` response headers were retained, and connection display names arrive already redacted from the tool layer.
