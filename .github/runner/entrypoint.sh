#!/usr/bin/env bash
set -euo pipefail

# RUNNER_TOKEN is a short-lived registration token supplied at run time.
# It is never written to disk here and never echoed.
: "${RUNNER_URL:?RUNNER_URL is required}"

# Registration state lives in .runner/.credentials inside the container, so it
# survives docker stop/start and a host reboot. config.sh refuses to run against
# an already-configured runner ("Cannot configure the runner because it is
# already configured"), so re-running it unconditionally made every restarted
# container exit 1 and stay permanently offline after a host reboot.
if [ -f .runner ]; then
  echo "[entrypoint] already configured - reusing existing registration"
else
  : "${RUNNER_TOKEN:?RUNNER_TOKEN is required for first-time registration}"
  ./config.sh \
    --url "${RUNNER_URL}" \
    --token "${RUNNER_TOKEN}" \
    --name "${RUNNER_NAME:-colima-arm64}" \
    --labels "${RUNNER_LABELS:-self-hosted,linux,ARM64}" \
    --work _work \
    --unattended \
    --replace
fi

# Shut down by signalling run.sh and waiting for it, so Runner.Listener gets a
# clean termination attempt. GitHub can still retain the server-side session
# briefly; run.sh then retries the reconnect instead of crashing the container.
#
# Deregistration is deliberately NOT the default: on a host that reboots, the
# registration must survive. Set RUNNER_DEREGISTER_ON_EXIT=1 when genuinely
# retiring a runner (draining a host), not when merely restarting one.
child=""
shutdown() {
  if [ -n "${RUNNER_DEREGISTER_ON_EXIT:-}" ] && [ -n "${RUNNER_TOKEN:-}" ]; then
    echo "[entrypoint] deregistering runner"
    ./config.sh remove --token "${RUNNER_TOKEN}" || true
  fi
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
  [ -n "$child" ] && wait "$child" 2>/dev/null
  exit 0
}
trap shutdown INT TERM

# run.sh forwards TERM to Runner.Listener only in its manual-trap mode. The
# entrypoint is PID 1, so enable that mode before managing run.sh as a child.
export RUNNER_MANUALLY_TRAP_SIG=1
./run.sh &
child=$!
wait "$child"
