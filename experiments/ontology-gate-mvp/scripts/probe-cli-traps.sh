#!/usr/bin/env bash
# Reproduce four open-ontologies v2.1.0 CLI behaviours that matter for a gate.
# Every case asserts the measured exit code, not just the JSON payload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${OPEN_ONTOLOGIES_BIN:-$ROOT/tools/bin/open-ontologies}"
[[ -x "$BIN" ]] || { echo "missing binary: $BIN" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/oo-traps.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export OPEN_ONTOLOGIES_STORAGE_MODE=persistent
fail=0

cat > "$WORK/data.ttl" <<'TTL'
@prefix ex: <https://example.org/probe#> .
ex:t a ex:Ticket .
TTL

cat > "$WORK/shapes.ttl" <<'TTL'
@prefix ex: <https://example.org/probe#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:TicketShape a sh:NodeShape ;
  sh:targetClass ex:Ticket ;
  sh:property [ sh:path ex:commit ; sh:minCount 1 ; sh:message "probe: commit missing" ] .
TTL

echo "== 1. batch ignores the shacl exit code =="
printf 'load %s\nshacl %s\n' "$WORK/data.ttl" "$WORK/shapes.ttl" \
  | "$BIN" --no-connect --data-dir "$WORK/batch" batch - > "$WORK/batch.json"
batch_status=$?
if [[ $batch_status -eq 0 ]] && grep -q '"conforms":false' "$WORK/batch.json"; then
  echo "PASS: batch exit 0 while shacl result has conforms:false"
else
  echo "FAIL: batch exit=$batch_status, expected 0 with conforms:false" >&2
  fail=1
fi

echo "== 2. standalone shacl returns a usable exit code =="
"$BIN" --no-connect --data-dir "$WORK/standalone" load "$WORK/data.ttl" > /dev/null
if "$BIN" --no-connect --data-dir "$WORK/standalone" shacl "$WORK/shapes.ttl" > "$WORK/shacl.json"; then
  echo "FAIL: standalone shacl exited 0 on a violation" >&2
  fail=1
else
  shacl_status=$?
  if [[ $shacl_status -eq 1 ]] && grep -q '"conforms":false' "$WORK/shacl.json"; then
    echo "PASS: standalone shacl exit 1 with conforms:false"
  else
    echo "FAIL: standalone shacl exit=$shacl_status, expected 1" >&2
    fail=1
  fi
fi

echo "== 3. reason reports inconsistency but exits 0 =="
cat > "$WORK/inconsistent.ttl" <<'TTL'
@prefix ex: <https://example.org/probe#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
ex:Open owl:disjointWith ex:Closed .
ex:thing a owl:NamedIndividual, ex:Open, ex:Closed .
TTL
"$BIN" --no-connect --data-dir "$WORK/reason" load "$WORK/inconsistent.ttl" > /dev/null
if "$BIN" --no-connect --data-dir "$WORK/reason" reason --profile owl-dl > "$WORK/reason.json"; then
  if grep -q '"consistent":false' "$WORK/reason.json"; then
    echo "PASS: reason exit 0 with consistent:false"
  else
    echo "FAIL: reason exited 0 but did not report consistent:false" >&2
    fail=1
  fi
else
  echo "FAIL: reason exited nonzero; the trap is that it exits 0" >&2
  fail=1
fi

echo "== 4. an uncompilable sh:node constraint makes the verdict indeterminate =="
cat > "$WORK/node-shapes.ttl" <<'TTL'
@prefix ex: <https://example.org/probe#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:Inner a sh:NodeShape ;
  sh:property [ sh:path ex:commit ; sh:minCount 1 ; sh:message "probe: commit missing" ] .
ex:TicketShape a sh:NodeShape ;
  sh:targetClass ex:Ticket ;
  sh:node ex:Inner .
TTL
if "$BIN" --no-connect --data-dir "$WORK/node" load "$WORK/data.ttl" > /dev/null; then :; fi
if "$BIN" --no-connect --data-dir "$WORK/node" shacl "$WORK/node-shapes.ttl" > "$WORK/node.json"; then
  echo "FAIL: shacl exited 0 for an unevaluated constraint" >&2
  fail=1
else
  node_status=$?
  if [[ $node_status -eq 2 ]] && grep -q 'skipped_constraints' "$WORK/node.json"; then
    echo "PASS: shacl exit 2 with skipped_constraints (must be treated as fail-closed)"
  else
    echo "FAIL: shacl exit=$node_status, expected 2 with skipped_constraints" >&2
    fail=1
  fi
fi

if [[ $fail -eq 0 ]]; then
  echo
  echo "all CLI trap probes matched the measured behaviour"
else
  echo
  echo "one or more probes diverged from the measured behaviour" >&2
fi
exit "$fail"
