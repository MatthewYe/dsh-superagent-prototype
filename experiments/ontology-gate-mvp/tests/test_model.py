import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ontology_gate.model import (
    CommitEvidence,
    GateEvidence,
    Spec,
    Ticket,
)


def _gate(ticket: str, kind: str) -> GateEvidence:
    return GateEvidence(
        node_id=f"{ticket}-{kind}",
        kind=kind,
        outcome="pass",
        exit_code=0,
        command="python3 -m unittest discover -s tests",
        output_sha256="a" * 64,
        commit="b" * 40,
        scope="all",
        duration_ms=1,
        checked_at="2026-01-01T00:00:00+00:00",
    )


def _commit(ticket: str) -> CommitEvidence:
    return CommitEvidence(
        node_id=f"{ticket}-commit",
        commit="b" * 40,
        tree_clean=True,
        is_ancestor_of_head=True,
        subject=f"{ticket}: done",
        committed_at="2026-01-01T00:00:00+00:00",
    )


class TicketSerialisationTest(unittest.TestCase):
    def test_done_ticket_links_one_commit_and_two_gates(self) -> None:
        ticket = Ticket(
            id="T1",
            title="one",
            state="done",
            gate_evidence=[_gate("T1", "lint"), _gate("T1", "unitTests")],
            commit_evidence=_commit("T1"),
        )
        ttl = ticket.to_ttl("spec-mvp")
        self.assertIn("ex:T1 a ex:Ticket, ex:Done", ttl)
        self.assertIn("ex:inSpec ex:spec-mvp", ttl)
        self.assertIn("ex:hasGateEvidence ex:T1-lint, ex:T1-unitTests", ttl)
        self.assertIn("ex:hasCommitEvidence ex:T1-commit", ttl)

    def test_extra_commit_evidence_serialises_second_edge(self) -> None:
        ticket = Ticket(
            id="T1",
            title="one",
            state="done",
            gate_evidence=[_gate("T1", "lint"), _gate("T1", "unitTests")],
            commit_evidence=_commit("T1"),
        )
        extra = _commit("T1")
        extra.node_id = "T1-commit-extra"
        ticket.extra_commit_evidence.append(extra)
        ttl = ticket.to_ttl("spec-mvp")
        self.assertIn("ex:hasCommitEvidence ex:T1-commit, ex:T1-commit-extra", ttl)

    def test_ticket_lookup(self) -> None:
        spec = Spec(id="s", title="s", tickets=[Ticket(id="T1", title="one")])
        self.assertEqual(spec.ticket("T1").title, "one")
        with self.assertRaises(KeyError):
            spec.ticket("missing")


if __name__ == "__main__":
    unittest.main()
