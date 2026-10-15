# Errata E18: minimal composition corrections for BF, AU2 and the I2 target recipe

Date: 2026-10-15. Precedence: E18 > E17 > earlier errata > CONTRACT-v3.5 > PRD intent. These corrections preserve existing authority; they grant no live execution, provider, merge or publication permission.

## BF: receive the actual schema-bearing tool digest

The frozen `openCccPlanningLinkedWriterAttempt` input has no tool definitions or toolset digest, and the native campaign route stores only provider, model and transport. Core cannot derive the required five-field route's `toolsetDigest` from that data. A hash of tool names is wrong: C2 hashes the canonical sorted tool authorities including each parameter-schema hash.

Add a required `toolsetDigest: string` input to this helper. Validate 64 lowercase hexadecimal characters before any transaction or write; refuse a missing or malformed value with `CCC_PLANNING_INTERNAL_ERROR`. Return the supplied value unchanged in the existing five-field route. The other inputs and result fields stay unchanged; core never imports engine.

WR must build the same-process issued C2 writer policy first, pass its digest into BF, then attach BF's returned route with P1's native bound-route marker before creating the session. P1/C2 still validate the marker, binding, role and actual tool schemas before any provider effect. Recreated sessions derive the digest from the same admitted tool definitions and policy; they may not substitute a names-only digest. BF alone does not persist an additional digest pin; this correction does not claim otherwise or change the exact-key native campaign attempt scope.

Proof: missing/malformed digest is refused before writes; a valid digest returns byte-for-byte with exactly the existing five route keys. WR pins the return shape and the actual C2-policy-to-P1 chain in its integration tests.

## AU2: distinguish issuing a confirmation from approving execution

The AU2 card's MiniMax mismatch RED says “no approval row.” This contradicts ADR D Q3's native `issue → envelope check → approve` sequence and its `awaiting_operator` result, which includes an authorization id and operator confirmation. Native issue creates pending approval rows before there is an authorization to inspect.

Replace that phrase with: **no approved, claimed or consumed execution approval, no active action lease, no runnable release, no `live_execution_release` artifact, and no transition to `building`.** Idempotent issued/pending native rows and their operator confirmation may exist. The mismatched result remains `awaiting_operator` / `envelope_mismatch`. The envelope check remains pure and precedes native approval/claim. No new preview seam, callback authority or approval system is introduced.

## I2 step 2: explicit local target setup arguments

Section 4.2's `node scripts/lib/ccc-planning-disposable-target.mjs --root "$ROOT"` example omits required arguments. Use:

```sh
node scripts/lib/ccc-planning-disposable-target.mjs \
  --root "$ROOT" \
  --omniroute-base-url '<operator-verified loopback base URL>' \
  --provision-postgres \
  --pg-bin /opt/homebrew/Cellar/postgresql@16/16.9/bin
```

The base URL must come from the approved current route, never a guessed port or automatic gateway reconfiguration. PostgreSQL provisioning is explicit and owns only its fresh scratch data directory, verified-free loopback port and exact child process. This example is not proof that setup or a live run occurred. The typed-digest requirement for live authority is unchanged.
