# CI fast-gate plan — Gate reuses Build's dist (2026-09-03)

Work package WP-A of a CI speed plan scoped to `.github/workflows/pr-checks.yml` only (a sibling work package, WP-B, is a read-only slot-count proposal package and touches nothing here). Branch `agent/ci-fast-gate-20260903`.

## Ground truth (measured, run 33738197262 on 9ed3acc02)

All five PR jobs (Lint, Typecheck, Build, Gate, Desktop packaging) run on the M2 Max inside the Colima `ci` VM. 12 runner containers share the VM; fusion runners are capped at 2.5 GiB / 2 CPU each (runner processes idle at ~640 MiB inside that cap), the bwrap runner at 4 GiB / 4 CPU. A host-level admission service holds every job in "Set up runner" until one of two global FIFO slots frees, shared across four repos — so "Set up runner = 8 min" was queue wait, not container boot.

Per-job slot time before this change:

| Job | Slot time | Notes |
|---|---|---|
| Lint | ~1.5 min | |
| Typecheck | ~4 min | builds core+engine itself |
| Build | ~8 min | `pnpm build`, 408 s; desktop vite build ran inside CLI full packaging and OOMed once at the 1664 MB heap cap |
| Gate | ~8 min | ~5 min of it was a redundant `pnpm build` — its dist-cache key missed on every PR whose sources differed from main, and its path list omitted `packages/cli/dist` anyway |
| Desktop packaging | ~6 min | separate advisory workflow, same slots |

Slot-minutes ≈ 27.5 over 2 slots → ~14 min floor; observed 15 min.

## What changed

1. **Build saves its full dist set; Gate restores it instead of rebuilding.** Build's "Build" step (`pnpm build`) already runs the identical build Gate used to repeat. Build now runs `actions/cache/save@v4` afterward under key `fusion-pr-dist-v1-${{ runner.os }}-${{ runner.arch }}-<source-hash>` over the same 10 package/plugin dist paths `scripts/ensure-test-artifacts.mjs`'s `REQUIRED_BUILD_PACKAGES` needs (this is the same set `full-suite.yml`'s `fusion-dist-v2-` cache already publishes — mirrored mechanics, separate key prefix so the two workflows can never hand each other a partial path list). Gate gets `needs: build` and replaces its old `actions/cache@v4` step (an 8-path list that omitted `packages/cli/dist`, so a hit could never make boot-smoke's `packages/cli/bin.mjs` valid) with `actions/cache/restore@v4` on the identical key and path list. Exact-match key only, no `restore-keys` (stale dist is the known failure mode, FN-4232/FN-4605); never `node_modules`.
2. **Gate keeps `pnpm build` as a graceful fallback**, not a hard failure: no `fail-on-cache-miss`. Unlike `full-suite.yml`'s shard/slow consumers (which have no fallback and must hard-fail on a miss), Gate is a merge-blocking PR check with no acceptable "block every PR because a cache row expired" failure mode. On a hit, the restored dist plus the existing "Seed artifact hash-cache on cache hit" step make `pnpm build` a fast content-hash skip; on a miss, it's a full build, same as before this change.
3. **Lint and Typecheck stay independent** (no `needs`). They're short, and the shared host-level admission service already globally serializes runner slots across repos — an added `needs` edge there would only add latency, not save a redundant build.
4. **Desktop OOM: built as its own step, not a raised heap.** PR Checks run 33704433491 OOMed the Build job — `[desktop:build] vite build --base ./` hit "Ineffective mark-compacts near heap limit" inside `@runfusion/fusion build: build:tsup:serial`. Root cause: CI always runs the CLI's tsup build in "full package" mode (`wantsFullCliPackage()` treats `CI=true` as an implicit `--full`), and full-package mode stages the desktop Electron runtime by spawning `pnpm --filter @fusion/desktop build` as a **child of the still-live CLI tsup process** (`packages/cli/tsup.config.ts` `ensureDesktopRuntimeAssetsBuilt`, invoked from its `onSuccess` hook). Both processes inherit the job's `NODE_OPTIONS=--max-old-space-size=1664` and can be resident at once inside the runner's 2.5 GiB container cap, whose own processes already use ~640 MiB.

   `desktop-packaging.yml` runs the exact same command (`pnpm --filter @fusion/desktop build`) with the exact same 1664 MB cap, **alone**, and passes — proving the desktop build itself doesn't need more heap; it needs to not run concurrently with another live Node process holding a comparable heap in the same container. `packages/desktop/scripts/build.ts` (via `workspace-tools.ts`) is already self-contained — it builds `@fusion/core`, `@fusion/engine`, and the dashboard runtime itself, so it needs nothing pre-built. The fix: add a standalone "Build desktop runtime (staged ahead of CLI full packaging)" step — same command, same 1664 MB cap — **before** the `pnpm build` step. `ensureDesktopRuntimeAssetsBuilt()` short-circuits on `existsSync(packages/desktop/dist)`, so the nested spawn — and the two-process memory contention that caused the OOM — never happens. The job-wide heap is not raised above the already-proven-safe 1664 MB ceiling; it's relocated to a step where nothing else is competing for it.

## Deviation from the initial plan text

The initial plan text listed `packages/i18n/dist` as a path to add to the cache list. `@fusion/i18n` has no `"build"` script and its `exports` map resolves directly to `./src/*.ts` (a source-only workspace package) — `pnpm build` never produces `packages/i18n/dist`. Verified by reading `packages/i18n/package.json`. Omitted from both Build's save list and Gate's restore list; including a path that's never created is inert (`actions/cache` just skips a missing path) but doesn't match what's actually on disk, so it's left out.

## Expected effect (not yet measured live)

Gate no longer pays its own ~5 min redundant build on a cache hit; the critical path becomes roughly Build (~8 min, now including the standalone desktop step) → Gate (restore + fast skip + gate tests, ~3 min), serialized by the new `needs: build` edge. This trades some job-level parallelism (Gate now starts after Build instead of alongside it) for less total slot-minute consumption across the two shared admission slots. A live PR run against this branch is the actual before/after measurement; this doc records the design and the pre-change baseline only. The measured live numbers belong in the PR description once this branch's own CI run reports, and should be pasted back into this doc as a follow-up edit at that point.

## Verification run in this worktree

- `corepack pnpm lint` — clean.
- `corepack pnpm --filter @runfusion/fusion test:ci-shape` — 87 passed (85 pre-existing + 2 new + 1 updated in place) in `packages/cli/src/__tests__/ci-workflow.test.ts`.
- `corepack pnpm typecheck` — clean, exit 0.
- Did NOT run `task gate`, `task ci`, or any live lane per the work-package boundary; the actual OOM fix and the cache-reuse mechanics are unproven against a real runner until this PR's own CI run reports.
