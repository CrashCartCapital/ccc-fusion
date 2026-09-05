---
"@runfusion/fusion": patch
---

summary: Give semantic-proof executable version probes a cold-start-safe timeout and a diagnosable failure message.
category: fix
dev: Under real concurrent proof-preparation load, a freshly-sealed executable's first `--version` launch (fresh ad-hoc code signature, no warm cache possible since every proof round uses a new temp root) could exceed the previous 10s probe bound on both the original attempt and its existing single retry, producing a bare "Command failed: <cmd>" custody refusal with no way to tell a timeout from any other single-line failure. Measured 2026-09-05: 20 concurrent seal+probe operations pushed several real cold-start probes past 10s outright (survivors up to ~9.9s), matching the shape and timing of a live Gate 3 halt. `EXECUTABLE_PROBE_TIMEOUT_MS` is raised to 30s (kept as one shared, now-exported constant; the existing single retry-on-timeout is unchanged, no new retries added), and probe failures now carry `exit=<code|null> signal=<sig|null> timedOut=<bool> after <ms>ms` plus up to 4KB of stderr in the thrown message, since campaign custody-refusal only ever surfaces `error.message`. otool/install_name_tool/git shellout timeouts are untouched.
