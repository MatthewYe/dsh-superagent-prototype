# Measured open-ontologies v2.1.0 CLI behaviour

These probes were run on macOS arm64 with the pinned release binary:

```
sha256  493f6db51550112528d19f3ca88caf133b46c2a9054a195a98bc588b57ba07b6
asset   open-ontologies-aarch64-apple-darwin
release https://github.com/fabio-rovai/open-ontologies/releases/tag/v2.1.0
```

`scripts/probe-cli-traps.sh` reproduces all four cases and checks the exit
codes. The JSON below is abridged; the command is the important part.

## 1. `batch` exits 0 on a SHACL violation

```sh
printf 'load data.ttl\nshacl shapes.ttl\n' \
  | OPEN_ONTOLOGIES_STORAGE_MODE=persistent \
    open-ontologies --no-connect --data-dir /tmp/trap-batch batch -
```

`data.ttl` contains `ex:t a ex:Ticket .`; `shapes.ttl` requires
`ex:commit minCount 1` on every `ex:Ticket`.

Observed:

```
{"command":"load","result":{"ok":true,...},"seq":0}
{"command":"shacl","result":{"conforms":false,"violation_count":1,...},"seq":1}
BATCH_EXIT=0
```

So the process exit code says success while the embedded verdict says
non-conforming. `batch` is not usable as a gate.

## 2. Standalone `shacl` gives the documented exit code

```sh
OPEN_ONTOLOGIES_STORAGE_MODE=persistent \
  open-ontologies --no-connect --data-dir /tmp/trap-standalone load data.ttl
OPEN_ONTOLOGIES_STORAGE_MODE=persistent \
  open-ontologies --no-connect --data-dir /tmp/trap-standalone shacl shapes.ttl
```

Observed:

```
{"conforms":false,"violation_count":1,"violations":[{"constraint":"minCount",...,"message":"probe: commit missing"}]}
SHACL_EXIT=1
```

`shacl --help` documents 0 = conforms, 1 = does not conform or failed,
2 = not determined. Measured behaviour matches for 0 and 1.

## 3. `reason` exits 0 even when the ABox is inconsistent

```sh
# Open owl:disjointWith Closed ; thing a Open, Closed
OPEN_ONTOLOGIES_STORAGE_MODE=persistent \
  open-ontologies --no-connect --data-dir /tmp/trap-reason load inconsistent.ttl
OPEN_ONTOLOGIES_STORAGE_MODE=persistent \
  open-ontologies --no-connect --data-dir /tmp/trap-reason reason --profile owl-dl
```

Observed (abridged):

```json
{"consistent":false,"abox":{"consistent":false,"individuals_checked":1},
 "description_logic":"SHIQ","profile_used":"owl-dl", ...}
REASON_EXIT=0
```

A gate that only checks the exit code would accept an inconsistent ontology.
If OWL consistency is required, parse `consistent` (and still treat a missing
field as failure).

## 4. `sh:node` makes the verdict indeterminate (exit 2)

A shape that uses `sh:node` to reference another shape was not compiled by
this evaluator:

```json
{"conforms":null,
 "skipped_constraints":[{"constraint":"http://www.w3.org/ns/shacl#node",
   "reason":"node-shape constraint not implemented; it was not evaluated",
   "shape":"https://example.org/probe#TicketShape"}],
 "warning":"1 constraint(s) were not evaluated, so conformance is undetermined. See skipped_constraints."}
NODE_EXIT=2
```

Consequences:

- `exit 2` must be treated as fail-closed, never as success.
- `skipped_constraints` must be surfaced; a shape that the evaluator silently
  skipped is not enforcement.
- The production shapes avoid `sh:node`; `ontology/shapes.ttl` uses
  `sh:class` + `sh:targetClass` and SPARQL constraints instead.

## Store-mode note

`load` defaults to in-memory storage and warns that the load did not persist.
Cross-invocation `load` then `shacl` requires
`OPEN_ONTOLOGIES_STORAGE_MODE=persistent` and a fresh `--data-dir` per gate
run. `gate.py` does exactly that.
