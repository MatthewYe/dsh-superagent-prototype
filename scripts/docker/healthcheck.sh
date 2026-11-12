#!/bin/sh
# Container healthcheck (ticket #2).
#
# The management API is the readiness contract: it is asked through the relay, on
# the published path a browser uses, with the required orchestrator header. The
# container is healthy only when setup has no problem and every health entry is
# ready. A fresh, unconfigured volume is therefore correctly unhealthy.
set -eu

body=$(curl --silent --show-error --fail --max-time 4 \
  -H 'x-orchestrator-request: 1' \
  "http://127.0.0.1:${SUPERAGENT_RELAY_PORT:-13082}/orchestrator/api/state") || exit 1

printf '%s' "$body" | jq -e '
  (.setup.problem == null)
  and ((.health | length) > 0)
  and ([.health[] | .state] | all(. == "ready"))
' > /dev/null
