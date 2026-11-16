"""End-to-end scenarios: build a real repo, collect facts, run the ontology gate.

Every scenario below performs real git commits and real lint / unittest runs.
The negative scenarios either corrupt the real worktree (failed lint/test,
dirty tree) or mutate the collected state in a way a buggy orchestrator could
produce (false "done", missing evidence, stale commit, dependency cycle).
"""

from __future__ import annotations

import copy
import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .collect import build_spec, run_ticket_only
from .gate import GateResult, check, frontier
from .model import Spec, Ticket

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TBOX = PROJECT_ROOT / "ontology" / "tickets.ttl"
SHAPES = PROJECT_ROOT / "ontology" / "shapes.ttl"


@dataclass
class Scenario:
    name: str
    description: str
    expected_exit: int
    expected_messages: list[str]
    spec: Spec


@dataclass
class ScenarioResult:
    scenario: Scenario
    gate: GateResult
    failures: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.failures

    def to_dict(self) -> dict:
        return {
            "name": self.scenario.name,
            "description": self.scenario.description,
            "expected_exit": self.scenario.expected_exit,
            "expected_messages": self.scenario.expected_messages,
            "passed": self.passed,
            "failures": self.failures,
            "gate": self.gate.to_dict(),
        }


def load_config() -> dict:
    return json.loads((PROJECT_ROOT / "spec" / "spec.json").read_text(encoding="utf-8"))


def _check_expectations(scenario: Scenario, gate: GateResult) -> list[str]:
    failures: list[str] = []
    if gate.exit_code != scenario.expected_exit:
        failures.append(f"exit {gate.exit_code}, expected {scenario.expected_exit}")
    messages = gate.messages()
    for expected in scenario.expected_messages:
        if not any(expected in message for message in messages):
            failures.append(f"missing expected message: {expected!r}")
    if gate.warnings:
        failures.append(f"gate warnings: {gate.warnings}")
    return failures


def _fresh(workdir: Path, name: str) -> Path:
    repo = workdir / name / "repo"
    repo.parent.mkdir(parents=True, exist_ok=True)
    return repo


def _happy(config: dict, workdir: Path, name: str = "happy") -> tuple[Spec, str]:
    repo = _fresh(workdir, name)
    spec, base_commit = build_spec(
        config,
        repo,
        PROJECT_ROOT / "fixture" / "tickets",
        PROJECT_ROOT / "fixture",
    )
    spec.state = "done"
    return spec, base_commit


def _single_ticket_with(
    config: dict,
    workdir: Path,
    name: str,
    append: list[tuple[str, str]],
) -> Spec:
    repo = _fresh(workdir, name)
    spec, _ = run_ticket_only(
        config,
        repo,
        PROJECT_ROOT / "fixture" / "tickets",
        PROJECT_ROOT / "fixture",
        "T1",
        append=append,
    )
    spec.state = "active"
    return spec


def build_scenarios(workdir: Path) -> list[Scenario]:
    config = load_config()
    happy, base_commit = _happy(config, workdir)

    def clone(
        name: str, description: str, expected_exit: int, messages: list[str]
    ) -> Scenario:
        return Scenario(
            name=name,
            description=description,
            expected_exit=expected_exit,
            expected_messages=messages,
            spec=copy.deepcopy(happy),
        )

    scenarios: list[Scenario] = [
        Scenario(
            name="happy",
            description="all four tickets completed with real lint, tests and commits",
            expected_exit=0,
            expected_messages=[],
            spec=happy,
        )
    ]

    scenario = clone(
        "blocker_not_done",
        "T2 is Done while its blocker T1 is only Doing",
        1,
        ["active/done ticket has a blocker that is not done"],
    )
    scenario.spec.ticket("T1").state = "doing"
    scenario.spec.state = "active"
    scenarios.append(scenario)

    scenario = clone(
        "missing_commit",
        "T1 is Done but no commit evidence was recorded",
        1,
        ["exactly one commit evidence record"],
    )
    scenario.spec.ticket("T1").commit_evidence = None
    scenarios.append(scenario)

    scenario = clone(
        "missing_lint",
        "T1 is Done but the whole-tree lint evidence is missing",
        1,
        ["no passing whole-tree lint"],
    )
    scenario.spec.ticket("T1").gate_evidence = [
        g for g in scenario.spec.ticket("T1").gate_evidence if g.kind != "lint"
    ]
    scenarios.append(scenario)

    scenario = clone(
        "missing_unit_tests",
        "T1 is Done but the whole-suite unit-test evidence is missing",
        1,
        ["no passing whole-suite unit tests"],
    )
    scenario.spec.ticket("T1").gate_evidence = [
        g for g in scenario.spec.ticket("T1").gate_evidence if g.kind != "unitTests"
    ]
    scenarios.append(scenario)

    scenario = clone(
        "failed_evidence_present",
        "T1 has a passing lint run and also a recorded failing lint run",
        1,
        ["done ticket has a failing gate result"],
    )
    t1 = scenario.spec.ticket("T1")
    failing = copy.deepcopy(t1.gate_evidence[0])
    failing.node_id = "T1-lint-failed"
    failing.outcome = "fail"
    failing.exit_code = 1
    t1.gate_evidence.append(failing)
    scenarios.append(scenario)

    scenario = clone(
        "commit_mismatch",
        "T1's lint evidence ran at the base commit, not at T1's commit",
        1,
        ["a gate ran at a different commit than the ticket's commit"],
    )
    scenario.spec.ticket("T1").gate_evidence[0].commit = base_commit
    scenarios.append(scenario)

    scenario = clone(
        "wrong_scope",
        "T1's unit-test evidence claims ticket scope instead of the whole suite",
        1,
        ["unit-test evidence must cover the whole suite"],
    )
    scenario.spec.ticket("T1").gate_evidence[1].scope = "ticket"
    scenarios.append(scenario)

    scenario = clone(
        "cycle",
        "T1 and T3 block each other",
        1,
        ["ticket dependency cycle"],
    )
    scenario.spec.ticket("T1").blocked_by = ["T3"]
    scenarios.append(scenario)

    scenario = clone(
        "spec_done_prematurely",
        "the spec is Done while T4 is still Todo",
        1,
        ["spec is marked done while a ticket is not done"],
    )
    scenario.spec.ticket("T4").state = "todo"
    scenarios.append(scenario)

    scenario = clone(
        "cross_spec_blocker",
        "T2 is blocked by X1, which belongs to another spec",
        1,
        ["blocker must be a ticket in the same spec"],
    )
    scenario.spec.tickets.append(
        Ticket(
            id="X1",
            title="foreign ticket",
            state="todo",
            spec_id="other-spec",
        )
    )
    scenario.spec.ticket("T2").blocked_by.append("X1")
    scenarios.append(scenario)

    scenario = clone(
        "duplicate_commit_evidence",
        "T1 has two commit evidence records for the same commit",
        1,
        ["exactly one commit evidence record"],
    )
    t1 = scenario.spec.ticket("T1")
    assert t1.commit_evidence is not None
    duplicate = copy.deepcopy(t1.commit_evidence)
    duplicate.node_id = "T1-commit-extra"
    t1.extra_commit_evidence.append(duplicate)
    scenarios.append(scenario)

    scenario = clone(
        "stale_commit",
        "T1's recorded commit is no longer an ancestor of HEAD",
        1,
        ["recorded commit must be an ancestor of HEAD"],
    )
    t1 = scenario.spec.ticket("T1")
    assert t1.commit_evidence is not None
    t1.commit_evidence.is_ancestor_of_head = False
    scenarios.append(scenario)

    scenarios.append(
        Scenario(
            name="empty_done_spec",
            description="a spec with no tickets claims completion",
            expected_exit=1,
            expected_messages=["spec is done while it has no tickets"],
            spec=Spec(id="empty-spec", title="empty", state="done", tickets=[]),
        )
    )

    scenario = clone(
        "state_conflict",
        "T1 is asserted to be both Done and Todo",
        1,
        ["contradictory state classes"],
    )
    scenario.spec.ticket("T1").extra_states = ["todo"]
    scenarios.append(scenario)

    scenario = clone(
        "spec_active_all_done",
        "control: all tickets Done, spec left Active (no completion claim)",
        0,
        [],
    )
    scenario.spec.state = "active"
    scenarios.append(scenario)

    scenarios.append(
        Scenario(
            name="lint_failed",
            description="T1's overlay introduces a real trailing-whitespace lint finding",
            expected_exit=1,
            expected_messages=[
                "done ticket has a failing gate result",
                "no passing whole-tree lint at its commit",
            ],
            spec=_single_ticket_with(
                config,
                workdir,
                "lint_failed",
                [("mathlib/core.py", "# deliberate trailing whitespace    \n")],
            ),
        )
    )

    scenarios.append(
        Scenario(
            name="unit_tests_failed",
            description="T1's overlay introduces a real failing unit test",
            expected_exit=1,
            expected_messages=[
                "done ticket has a failing gate result",
                "no passing whole-suite unit tests at its commit",
            ],
            spec=_single_ticket_with(
                config,
                workdir,
                "unit_tests_failed",
                [
                    (
                        "tests/test_core.py",
                        (
                            "\n\nclass BrokenTest(unittest.TestCase):\n"
                            "    def test_wrong_sum(self) -> None:\n"
                            "        self.assertEqual(add(1, 1), 3)\n"
                        ),
                    )
                ],
            ),
        )
    )

    # Dirty-tree case needs the real repo, so it runs last.
    dirty = clone(
        "dirty_tree",
        "T1's commit was recorded while the worktree was dirty",
        1,
        ["the tree must be clean at the recorded commit"],
    )
    # Rebuild a private repo so the happy repo is not mutated.
    dirty_spec, _ = _happy(config, workdir, name="dirty_tree_base")
    dirty.spec = dirty_spec
    dirty.spec.state = "active"
    t1_commit = dirty.spec.ticket("T1").commit_evidence
    assert t1_commit is not None
    dirty_file = workdir / "dirty_tree_base" / "repo" / "mathlib" / "core.py"
    dirty_file.write_text(
        dirty_file.read_text(encoding="utf-8") + "# uncommitted\n",
        encoding="utf-8",
    )
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=dirty_file.parent.parent,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    if not status.strip():
        raise RuntimeError("dirty_tree scenario did not actually dirty the worktree")
    t1_commit.tree_clean = False
    scenarios.append(dirty)

    return scenarios


def run_all(workdir: Path) -> list[ScenarioResult]:
    results: list[ScenarioResult] = []
    for scenario in build_scenarios(workdir):
        gate = check(scenario.spec.to_ttl(), TBOX, SHAPES)
        failures = _check_expectations(scenario, gate)
        results.append(ScenarioResult(scenario=scenario, gate=gate, failures=failures))
    return results


def save_results(results: list[ScenarioResult], workdir: Path) -> None:
    for result in results:
        target = workdir / result.scenario.name
        target.mkdir(parents=True, exist_ok=True)
        (target / "state.ttl").write_text(
            result.scenario.spec.to_ttl(), encoding="utf-8"
        )
        (target / "report.json").write_text(
            json.dumps(result.to_dict(), indent=2) + "\n", encoding="utf-8"
        )


def frontier_for(spec: Spec) -> list[dict[str, str]]:
    return frontier(spec.to_ttl(), TBOX, spec.id)
