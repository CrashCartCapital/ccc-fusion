# CI Runtime

[← Docs index](./README.md)

Status: **PARTIAL — Linux lanes live and in daily use; native macOS Darwin proof lane UNPROVEN (registration is a separate, parallel host-side work package, not part of any PR)**

Repository: `CrashCartCapital/ccc-fusion`

Source: `.archive/full-suite-restore-plan-20260911.md` ("Host — register the macOS runner" work package) and `.archive/full-suite-red-diagnosis-20260911.md`, following the same M2 runner recording standard as [`surface-system`'s `docs/ci-runtime.md`](https://github.com/CrashCartCapital/surface-system/blob/main/docs/ci-runtime.md) (current truth table, explicit lifecycle proof/unproven lines, read-only re-entry checks — never claimed automatic availability from a single passing run).

## Plain meaning

All of ccc-fusion's self-hosted CI (`pr-checks.yml`, `full-suite.yml`, `ccc-prd-product-gate.yml`) runs on one physical host, `m2max-omlx` (an M2 Max Mac running macOS 26.6.2), through two different runner mechanisms: four ordinary Linux containers plus one bubblewrap-capable Linux container, all inside a shared Colima VM (`colima-ci`) behind a global three-slot admission queue; and, once registered, a native macOS runner for the one test tier that needs a real macOS sandbox (`bubblewrap`/Linux namespaces cannot provide the confinement backend the semantic-v2 proof sandbox needs — see `docs/testing.md`'s "Darwin proof lane" section). The native macOS runner is **planned and its host-side setup is a work package outside this repository's version control** (a one-time SSH registration mirroring two other native runners already running this way for other repos) — this document records what its configuration is *supposed to be* per the plan, and marks every runtime-lifecycle claim UNPROVEN until it is independently re-checked and this document is updated with the observed evidence.

## Current truth

| Surface | Configuration | State | Boundary |
|---|---|---|---|
| Host | `m2max-omlx`, M2 Max, macOS 26.6.2 | `LIVE` | Shared with other repos' CI and with local inference/routing workloads (see the Ryan Stack SSOT); do not assume CI has the whole host. |
| Linux lanes | Colima VM `colima-ci`; runner pool labeled `ccc-fusion` (×4 containers) plus one `ccc-fusion-bwrap` (×1, `sudo`+`bwrap` capable); admission-queued (global 3-slot admission queue shared across the whole `colima-ci` fleet, not per-repo) | `LIVE` | `test-shards`/most jobs land on plain `ccc-fusion` containers (no `sudo`, no `python3`, no `bwrap`, no Task — see `docs/testing.md`'s runner-image staleness note); only `test-slow`/gate jobs use `ccc-fusion-bwrap`. |
| Native macOS runner | Labels `[self-hosted, macOS, ARM64, ccc-fusion-darwin-proof-v1, m2max-ccc-fusion-macos-arm64-1]`; root `/Users/ryanpappal/ci/native-runners/m2max-ccc-fusion-macos-arm64-1`; LaunchAgent `actions.runner.CrashCartCapital-ccc-fusion.m2max-ccc-fusion-macos-arm64-1` (`gui/501`, `KeepAlive`) | `PLANNED / UNPROVEN` | Registration mirrors two other native runners already running this pattern on the same host, and is deliberately outside the Colima fleet, the admission queue, and `ci-runners.lock` — but it has not yet been independently re-verified live from this document. |
| Runner ID / first accepted run | **TBD (fill from `gh api repos/CrashCartCapital/ccc-fusion/actions/runners`)** | `TBD` | Do not fabricate an ID or run number; leave this placeholder until a real `gh api` read fills it in, then replace this row. |
| Registered | UNPROVEN until recorded | `UNPROVEN` | |
| Online | UNPROVEN until recorded | `UNPROVEN` | |
| Supervised (foreground SSH vs. durable LaunchAgent) | UNPROVEN until recorded | `UNPROVEN` | |
| Reboot-restored | UNPROVEN until recorded | `UNPROVEN` | A LaunchAgent under `gui/501` does not restart at boot before login the way a LaunchDaemon would; do not assume reboot survival without an observed post-reboot check. |

## Native macOS runner: planned configuration

| Item | Value |
|---|---|
| Runner root | `/Users/ryanpappal/ci/native-runners/m2max-ccc-fusion-macos-arm64-1` |
| LaunchAgent label | `actions.runner.CrashCartCapital-ccc-fusion.m2max-ccc-fusion-macos-arm64-1` |
| Logs | `~/Library/Logs/actions.runner.CrashCartCapital-ccc-fusion.m2max-ccc-fusion-macos-arm64-1/` |
| Recovery | `cd /Users/ryanpappal/ci/native-runners/m2max-ccc-fusion-macos-arm64-1 && ./svc.sh status` then `./svc.sh start` if not running |
| pnpm/Node caches | `/Users/ryanpappal/ci/caches/ccc-fusion` (local pnpm store; no cloud actions/cache on this lane) |
| Go Task | Pinned `3.52.0` at `/Users/ryanpappal/ci/toolchains/task/3.52.0` (the workflow and tests hardcode this path until PR-B's `FUSION_TASK_BIN`/PATH-lookup change lands — see the restore plan's W2-code work package) |
| Disposable PostgreSQL | Per-job, from Homebrew `postgresql@16` (`initdb`/`pg_ctl` into `$RUNNER_TEMP`, a freshly chosen free port, trust auth on `127.0.0.1`) — **never bind `:5432`**: the host already runs a live PG17 instance on `:5432` for unrelated work, and CI must not touch it. |
| What runs here | `test:product-route` plus the Darwin-only proof suites via `scripts/ci-darwin-proof-lane.mjs` (fails the job if zero Darwin-only tests execute) — see `docs/testing.md`'s "Darwin proof lane and NOT RUN semantics" section. |

## Read-only re-entry checks

Run these to re-verify the current state before trusting any "LIVE"/"PLANNED" label above — this document is a snapshot, not a live source of truth:

```bash
# Runner registration + online/busy state (fills in the "Runner ID" row above)
gh api repos/CrashCartCapital/ccc-fusion/actions/runners \
  --jq '.runners[] | select(.name == "m2max-ccc-fusion-macos-arm64-1") | {id,name,status,busy,labels:[.labels[].name]}'

# Most recent jobs that actually landed on this runner (confirms "first accepted run")
gh api repos/CrashCartCapital/ccc-fusion/actions/runs --jq '.workflow_runs[0].id' \
  | xargs -I{} gh api repos/CrashCartCapital/ccc-fusion/actions/runs/{}/jobs \
  --jq '.jobs[] | select(.runner_name == "m2max-ccc-fusion-macos-arm64-1") | {id,name,status,conclusion,started_at}'

# LaunchAgent supervision state on the host itself
ssh m2max-omlx 'launchctl print gui/501/actions.runner.CrashCartCapital-ccc-fusion.m2max-ccc-fusion-macos-arm64-1 2>&1 | head -5'
```

These are read-only observations. Re-run them before relying on any claim in this document, and update the "Current truth" table with the observed result (including the date) rather than leaving a stale claim standing.

## Related

- `docs/testing.md` — "Engine slow tier", "Darwin proof lane and NOT RUN semantics", "Full Suite (non-blocking) heartbeat", and "Reading Full Suite logs" sections describe what actually runs on these lanes and how to read their output.
- `.archive/full-suite-restore-plan-20260911.md` — the work-package breakdown this configuration comes from (PR-A/W0 registers the workflow job; the host registration itself is a separate, non-PR SSH action).
- `.archive/full-suite-red-diagnosis-20260911.md` — the investigation that found the Linux shard lane's runner image does not match `.github/runner/Dockerfile` and that the semantic-v2 proof sandbox has no Linux backend at all.
