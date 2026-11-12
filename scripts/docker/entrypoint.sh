#!/bin/bash
# Root entrypoint for the DSH Superagent container (ticket #2).
#
# It seeds a writable DSH home from the baked template on first start, creates and
# owns the data directories, starts the loopback relay as the operator identity,
# and execs DSH as uid 501 / gid 20. DSH itself never binds a wildcard address.
set -euo pipefail

readonly HOME_DIR=${DSH_HOME:-/data/dsh}
readonly STATE_DIR=${SUPERAGENT_STATE_DIR:-/Users/matthewye/.dsh/state/superagent}
readonly TEMPLATE=${SUPERAGENT_TEMPLATE:-/opt/superagent-template}
readonly PRODUCT=${SUPERAGENT_PRODUCT:-/opt/dsh-superagent}
readonly RELAY=${SUPERAGENT_RELAY:-/usr/local/lib/superagent/relay.mjs}
readonly OPERATOR_UID=501
readonly OPERATOR_GID=20

if [ "$#" -eq 0 ]; then
  set -- dsh --profile superagent --no-open
fi

mkdir -p "$HOME_DIR" "$STATE_DIR"

# The product locks `<stateDir>.lock` as a sibling of the state directory, so the
# parent directory must be writable by the operator identity too. The leaf is a
# mounted volume; its parent lives in the image layer and starts as root.
chown "$OPERATOR_UID:$OPERATOR_GID" "$(dirname "$STATE_DIR")"

# First start: the home on the volume is empty, so seed it from the baked profile.
# A later start keeps everything the instance wrote, including its settings.
if [ ! -f "$HOME_DIR/profiles/superagent/package.json" ]; then
  cp -a "$TEMPLATE"/. "$HOME_DIR"/
fi

# The template's plugin link was baked at a different depth; keep it absolute.
mkdir -p "$HOME_DIR/profiles/superagent/node_modules"
ln -sfn "$PRODUCT" "$HOME_DIR/profiles/superagent/node_modules/dsh-superagent"

chown -R "$OPERATOR_UID:$OPERATOR_GID" "$HOME_DIR" "$STATE_DIR"
chmod 0700 "$STATE_DIR"
chmod u+rwx "$HOME_DIR"

as_user() {
  exec setpriv --reuid="$OPERATOR_UID" --regid="$OPERATOR_GID" --clear-groups \
    env HOME="$HOME_DIR" DSH_HOME="$HOME_DIR" USER=superagent LOGNAME=superagent "$@"
}

# The relay is the only wildcard listener in the container; DSH keeps its own
# loopback bind. It runs as the operator identity, not as root.
as_user node "$RELAY" &
relay_pid=$!
echo "superagent-entrypoint: relay pid $relay_pid on ${SUPERAGENT_RELAY_HOST:-0.0.0.0}:${SUPERAGENT_RELAY_PORT:-13082}" >&2

# If the entrypoint is signalled before DSH starts, do not leave the relay behind.
trap 'kill "$relay_pid" 2>/dev/null || true' TERM INT

as_user "$@"
