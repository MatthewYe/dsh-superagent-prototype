#!/usr/bin/env bash
# Download the open-ontologies v2.1.0 binary used by this experiment and verify
# it against the checksums published in the same GitHub release.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/tools/bin/open-ontologies"
VERSION="v2.1.0"
BASE="https://github.com/fabio-rovai/open-ontologies/releases/download/${VERSION}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  ASSET="open-ontologies-aarch64-apple-darwin" ;;
  Darwin-x86_64) ASSET="open-ontologies-x86_64-apple-darwin" ;;
  Linux-x86_64)  ASSET="open-ontologies-x86_64-unknown-linux-gnu" ;;
  *)
    echo "no pinned open-ontologies build for $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac

case "$ASSET" in
  open-ontologies-aarch64-apple-darwin)
    SHA256="493f6db51550112528d19f3ca88caf133b46c2a9054a195a98bc588b57ba07b6" ;;
  open-ontologies-x86_64-apple-darwin)
    SHA256="d2aacac75b2301eb3ce8f49000a8cc0bc7dd7edbf01fa36ac422ffdf4aaf11ee" ;;
  open-ontologies-x86_64-unknown-linux-gnu)
    SHA256="ead03c7148a66ea0fe01cbdaa289d47361c2a4d54619a60f805a72a2c57e81bb" ;;
esac

if [[ -x "$DEST" ]]; then
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$DEST" | awk '{print $1}')"
  else
    ACTUAL="$(sha256sum "$DEST" | awk '{print $1}')"
  fi
  if [[ "$ACTUAL" == "$SHA256" ]]; then
    echo "open-ontologies ${VERSION} already present: $DEST"
    exit 0
  fi
  echo "existing binary has the wrong checksum; replacing it" >&2
fi

mkdir -p "$(dirname "$DEST")"
TMP="$(mktemp "${TMPDIR:-/tmp}/open-ontologies.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

echo "downloading ${ASSET} (${VERSION})..."
curl -fL --retry 3 --output "$TMP" "${BASE}/${ASSET}"

if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP" | awk '{print $1}')"
else
  ACTUAL="$(sha256sum "$TMP" | awk '{print $1}')"
fi
if [[ "$ACTUAL" != "$SHA256" ]]; then
  echo "checksum mismatch for ${ASSET}" >&2
  echo "expected: $SHA256" >&2
  echo "actual:   $ACTUAL" >&2
  exit 1
fi

chmod +x "$TMP"
mv "$TMP" "$DEST"
trap - EXIT
echo "installed $DEST"
