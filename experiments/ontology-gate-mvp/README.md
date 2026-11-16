# Ontology-gated tickets (MVP)

Can [`open-ontologies`](https://github.com/fabio-rovai/open-ontologies) enforce the
rules of a multi-ticket spec: ticket B may not complete before ticket A, and a
ticket may only be `Done` when a whole-tree lint, the whole unit-test suite, and
a real git commit succeeded?

This directory is a runnable answer. It builds a real repository, runs real
commands, makes real commits, serialises the resulting facts as Turtle, and lets
the `open-ontologies` SHACL evaluator decide whether completion is legal. A
violation is reported as a nonzero process exit code.

**Verdict: yes for the policy layer, with one important boundary.** SHACL
expressly enforces dependency order and evidence requirements, and `shacl`
returns 0/1/2 as documented. The ontology does not run lint, tests, or git; a
collector must. That collector is therefore inside the trust boundary. Details
and the measured limitations are in [RESULTS.md](RESULTS.md) and
[docs/CLI-TRAPS.md](docs/CLI-TRAPS.md).

## What is enforced

| Rule | Shape |
|---|---|
| Exactly one of `Todo`, `Doing`, `Done`; contradictory state is rejected | `StateShape` |
| A `Doing`/`Done` ticket has no unfinished blocker | `BlockerDoneShape` |
| The `blockedBy` graph has no cycle | `NoCycleShape` (SPARQL property path `blockedBy+`) |
| A blocker belongs to the same spec | `BlockerSameSpecShape` |
| A `Done` ticket has exactly one commit record | `DoneTicketShape` |
| That commit is a real 40-hex SHA, the tree was clean, and it is an ancestor of `HEAD` | `CommitEvidenceShape` |
| Lint and unit tests both passed at the ticket's commit | `DoneTicketShape` |
| Lint covered the whole tree; unit tests covered the whole suite | `LintGateShape`, `UnitTestsGateShape` |
| No failing gate result is recorded alongside a `Done` claim | `DoneTicketShape` |
| A completed spec has at least one ticket and every ticket is `Done` | `DoneSpecShape` |

The policy is entirely in [`ontology/shapes.ttl`](ontology/shapes.ttl). The
vocabulary in [`ontology/tickets.ttl`](ontology/tickets.ttl) is deliberately
small; it also records state disjointness so an OWL reasoner can see a
contradiction, but the gate itself is SHACL because "the evidence must exist"
is a closed-world question.

## How it works

```
spec/spec.json
     |
     v
collect.py  -- applies ticket overlay, runs lint + unittest, makes a git commit,
     |         records exit codes, output digests, SHA, tree status
     v
model.py    -- serialises Spec / Ticket / evidence as Turtle
     |
     v
open-ontologies load tickets.ttl
open-ontologies load state.ttl
open-ontologies shacl shapes.ttl      # exit 0 conforms, 1 violation, 2 indeterminate
     |
     v
gate.py     -- propagates the exit code and surfaces skipped constraints
```

Each scenario uses a fresh persistent store. The gate command is the standalone
`shacl` command, not `batch` (see the measured trap below).

## Quick start

Requirements: Python 3.10+, git, and network access for the first download.

```sh
cd experiments/ontology-gate-mvp

# Downloads the pinned v2.1.0 binary and verifies its SHA-256.
scripts/fetch-open-ontologies.sh

# Runs all scenarios, rebuilds .runs/, rewrites RESULTS.md.
scripts/run-demo.sh

# Unit tests; scenario tests are skipped if the binary is absent.
PYTHONPATH=src python3 -m unittest discover -s tests -v

# The package lives under src/, so prefix direct module runs with PYTHONPATH=src.
# Gate a saved state file (exit 0 = conforms, 1 = violation, 2 = indeterminate).
PYTHONPATH=src python3 -m ontology_gate check --state .runs/happy/state.ttl

# Reproduce the CLI behaviours the design depends on.
scripts/probe-cli-traps.sh
```

`run-demo.sh` exits nonzero if any scenario's actual exit code or violation
message differs from its expectation. The expected results are not snapshots of
a happy path: 17 of 19 scenarios are deliberate failures that the ontology must
catch.

## Scenarios

The fixture is a four-ticket spec (`spec/spec.json`):

```
T1 add() ---> T2 mul() ---\
        \                 +--> T4 integration test
         \-> T3 pow() ---/
```

Each overlay is a real change to a small Python repository. `T4` adds an
integration test that imports both `mul` and `pow`, so its blockers are real.

| Scenario | What is wrong | Expected |
|---|---|---|
| `happy` | nothing | exit 0 |
| `blocker_not_done` | T2 is `Done`, blocker T1 is `Doing` | exit 1 |
| `missing_commit` | T1 is `Done`, no commit evidence | exit 1 |
| `missing_lint` | T1 is `Done`, no lint evidence | exit 1 |
| `missing_unit_tests` | T1 is `Done`, no unit-test evidence | exit 1 |
| `failed_evidence_present` | T1 is `Done` and also has a failing gate | exit 1 |
| `commit_mismatch` | lint ran at a different commit than T1's | exit 1 |
| `wrong_scope` | unit-test evidence is ticket-scoped, not whole-suite | exit 1 |
| `cycle` | T1 and T3 block each other | exit 1 |
| `spec_done_prematurely` | spec is `Done` while T4 is `Todo` | exit 1 |
| `cross_spec_blocker` | T2 depends on a ticket in another spec | exit 1 |
| `duplicate_commit_evidence` | T1 has two commit records | exit 1 |
| `stale_commit` | T1's commit is no longer an ancestor of `HEAD` | exit 1 |
| `empty_done_spec` | a spec with no tickets claims completion | exit 1 |
| `state_conflict` | T1 is both `Done` and `Todo` | exit 1 |
| `spec_active_all_done` | all tickets done, spec still `Active` (no claim) | exit 0 |
| `lint_failed` | the real lint command exits 1 on T1 | exit 1 |
| `unit_tests_failed` | one real unit test fails on T1 | exit 1 |
| `dirty_tree` | T1's commit record says the tree was dirty | exit 1 |

`lint_failed` and `unit_tests_failed` corrupt the worktree *after* the overlay
is applied, so the collector really records a failed command; the TTL is not
hand-written. `dirty_tree` dirties a real checkout, confirms `git status
--porcelain` is non-empty, then records `treeClean=false` for that commit.

## Measured CLI findings (v2.1.0)

These are reproduced by `scripts/probe-cli-traps.sh`; the full commands and
payloads are in [docs/CLI-TRAPS.md](docs/CLI-TRAPS.md).

1. **`batch` cannot be a gate.** `batch` runs `load` and `shacl` in one process,
   but exits 0 even when the embedded `shacl` result has
   `"conforms":false`. A caller that gates on `batch`'s exit code will admit
   broken specs. Use standalone `shacl`, whose exit code is 0/1/2.
2. **OWL reasoning is not a gate.** `reason --profile owl-dl` reports
   `"consistent":false` for disjoint classes asserted on the same individual,
   but exits 0. It is useful diagnostics, not a blocking check.
3. **Indeterminate is not conformant.** An unimplemented SHACL feature such as
   `sh:node` makes `shacl` emit `"conforms":null` with
   `skipped_constraints` and exit 2. This wrapper treats exit 2 as not passed
   and records the skipped constraints as warnings, so a silent "unknown" can
   never look like success.

## Trust boundary and limitations

- **Claims vs. reality.** The ontology checks the facts it is given. This demo
  runs lint, tests, and git in `collect.py` before writing the TTL. A caller
  that fabricates a conforming TTL would pass. For a production gate, either
  keep the collector inside the trusted process or re-run the commands at gate
  time and compare digests; do not accept a TTL from an untrusted worker.
- **Scope is a recorded string.** `scope: "all"` is enforced by shapes, but the
  collector is what certifies that the command really covered everything. The
  demo pins the commands in `spec/spec.json` rather than accepting them from a
  ticket.
- **Only SHACL is a gate.** OWL `reason` and `batch` were measured and rejected
  as exit-code gates.
- **Binary coverage.** The demo was run with the pinned macOS arm64 v2.1.0
  binary (`sha256 493f6db5…`). `fetch-open-ontologies.sh` also pins the
  published checksums for macOS x86_64 and Linux x86_64, but those two were not
  executed here.
- **Single spec.** Cross-spec blockers are rejected; multi-spec orchestration
  (a spec depending on another spec) is not modelled. The unit of composition
  is one spec at a time.

## Relation to `mattpocock/skills`

The `to-tickets` / `implement-spec` flow turns a plan into tracer-bullet tickets
with explicit "blocked by" edges and expects the implementer to work the
frontier. That flow does not reliably close or check off tickets, so completion
is a claim made by the agent. This MVP makes the claim machine-checkable:
`blockedBy` is the same graph, `Done` is a state class, and the evidence
requirements are SHACL constraints. `frontier` is a SPARQL query over the same
Turtle, so scheduling and gating share one representation:

```sh
PYTHONPATH=src python3 -m ontology_gate frontier --state .runs/happy/state.ttl --spec spec-mvp
```

## Layout

```
ontology/tickets.ttl      vocabulary + state disjointness
ontology/shapes.ttl       the completion / dependency policy
spec/spec.json            tickets, blockedBy edges, gate commands
src/ontology_gate/        model, collector, gate wrapper, scenarios, CLI
fixture/base/             tiny Python repo the tickets modify
fixture/tickets/T1..T4/   per-ticket overlays
tests/                    model tests + full matrix (skips without binary)
scripts/                  binary fetch, demo, CLI trap probes
RESULTS.md                generated by the last demo run
docs/CLI-TRAPS.md         measured CLI payloads and commands
```
