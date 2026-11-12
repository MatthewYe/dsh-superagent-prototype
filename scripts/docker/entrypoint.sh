#!/bin/bash
# Root entrypoint for the DSH Superagent container (tickets #2 and #4).
#
# It seeds a writable DSH home from the baked profile template on first start,
# creates and owns the data directories, starts the loopback relay as the
# operator identity, and execs DSH as that identity (OPERATOR_UID / OPERATOR_GID,
# defaulting to the neutral build defaults). DSH itself never binds a wildcard
# address.
#
# The profile is selected with DSH_PROFILE (compose sets it per service); it
# selects the template, the seeded profile and the plugin link set. The port
# pair is selected with SUPERAGENT_RELAY_PORT / SUPERAGENT_TARGET_PORT.
set -euo pipefail

readonly PROFILE=${DSH_PROFILE:-superagent}
readonly HOME_DIR=${DSH_HOME:-/data/dsh}
readonly OPERATOR_HOME=${OPERATOR_HOME:-/home/operator}
readonly STATE_DIR=${SUPERAGENT_STATE_DIR:-${OPERATOR_HOME}/.dsh/state/superagent}
readonly TEMPLATE=${SUPERAGENT_TEMPLATE:-/opt/superagent-template}
readonly PRODUCT=${SUPERAGENT_PRODUCT:-/opt/dsh-superagent}
readonly LIVIS_PRODUCT=${SUPERAGENT_LIVIS_PRODUCT:-/opt/dsh-livis/packages/dsh-livis-source}
readonly RELAY=${SUPERAGENT_RELAY:-/usr/local/lib/superagent/relay.mjs}
readonly OPERATOR_UID=${OPERATOR_UID:-1000}
readonly OPERATOR_GID=${OPERATOR_GID:-1000}

case "$PROFILE" in
  superagent|livis) ;;
  *)
    echo "superagent-entrypoint: unknown DSH_PROFILE '$PROFILE' (expected superagent or livis)" >&2
    exit 2
    ;;
esac

if [ "$#" -eq 0 ]; then
  set -- dsh --profile "$PROFILE" --no-open
fi

mkdir -p "$HOME_DIR" "$STATE_DIR"

# The product locks `<stateDir>.lock` as a sibling of the state directory, so the
# parent directory must be writable by the operator identity too. The leaf is a
# mounted volume; its parent lives in the image layer and starts as root.
chown "$OPERATOR_UID:$OPERATOR_GID" "$(dirname "$STATE_DIR")"

# First start: the home on the volume is empty, so seed it from the baked profile.
# A later start keeps everything the instance wrote, including its settings.
if [ ! -f "$HOME_DIR/profiles/$PROFILE/package.json" ]; then
  cp -a "$TEMPLATE"/. "$HOME_DIR"/
fi

# Import the agent's DSH credential store once, from the read-only staging mount.
# It is copied rather than mounted because DSH rewrites the file when it refreshes
# credentials, and the recursive chown below must not touch a read-only mount.
if [ -f "${SUPERAGENT_CREDENTIALS_SOURCE:-/run/superagent/credentials.yaml}" ] \
    && [ ! -f "$HOME_DIR/.credentials.yaml" ]; then
  install -m 0600 -o "$OPERATOR_UID" -g "$OPERATOR_GID" \
    "${SUPERAGENT_CREDENTIALS_SOURCE:-/run/superagent/credentials.yaml}" "$HOME_DIR/.credentials.yaml"
  echo "superagent-entrypoint: imported DSH credentials from the staging mount" >&2
fi

# The template's plugin links were baked at a different depth; keep them absolute.
# Both profiles install the product as a profile layer; livis additionally links
# its SourceKind plugin (declared without a `dsh.bundle`, so it is inserted by the
# profile patch instead of being a bundle).
if [ "$PROFILE" = livis ] && [ ! -f "$LIVIS_PRODUCT/package.json" ]; then
  echo "superagent-entrypoint: livis profile selected but $LIVIS_PRODUCT is missing" >&2
  exit 2
fi
mkdir -p "$HOME_DIR/profiles/$PROFILE/node_modules"
ln -sfn "$PRODUCT" "$HOME_DIR/profiles/$PROFILE/node_modules/dsh-superagent"
if [ "$PROFILE" = livis ]; then
  ln -sfn "$LIVIS_PRODUCT" "$HOME_DIR/profiles/$PROFILE/node_modules/dsh-livis-source"
fi

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
echo "superagent-entrypoint: profile $PROFILE, relay pid $relay_pid on ${SUPERAGENT_RELAY_HOST:-0.0.0.0}:${SUPERAGENT_RELAY_PORT:-13082}" >&2

# If the entrypoint is signalled before DSH starts, do not leave the relay behind.
trap 'kill "$relay_pid" 2>/dev/null || true' TERM INT

as_user "$@"
