#!/usr/bin/env bash
# Reproduce the full scenario matrix against open-ontologies v2.1.0.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -x "$ROOT/tools/bin/open-ontologies" ]]; then
  "$ROOT/scripts/fetch-open-ontologies.sh"
fi

export PYTHONPATH="$ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m ontology_gate demo "$@"
