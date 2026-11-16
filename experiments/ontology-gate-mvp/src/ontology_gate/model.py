"""In-memory spec model and deterministic Turtle serialisation.

Nothing in this module decides whether a ticket is allowed to complete.
It only turns the collected facts into RDF; the policy lives in
``ontology/shapes.ttl`` and is evaluated by the open-ontologies binary.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

EX = "https://example.org/ontology-gate#"
XSD = "http://www.w3.org/2001/XMLSchema#"

STATE_TO_CLASS = {
    "todo": "Todo",
    "doing": "Doing",
    "done": "Done",
}
SPEC_STATE_TO_CLASS = {
    "active": "ActiveSpec",
    "done": "DoneSpec",
}


def _escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )


def _iri(local: str) -> str:
    return f"ex:{local}"


def _literal(value: str) -> str:
    return f'"{_escape(value)}"'


def _boolean(value: bool) -> str:
    return "true" if value else "false"


@dataclass
class GateEvidence:
    """One real command execution, at one commit."""

    node_id: str
    kind: str  # "lint" or "unitTests"
    outcome: str  # "pass", "fail" or "error"
    exit_code: int
    command: str
    output_sha256: str
    commit: str
    scope: str
    duration_ms: int
    checked_at: str

    @property
    def class_name(self) -> str:
        if self.kind == "lint":
            return "LintGate"
        if self.kind == "unitTests":
            return "UnitTestsGate"
        raise ValueError(f"unknown gate kind: {self.kind}")

    def to_ttl(self) -> str:
        return "\n".join(
            [
                f"ex:{self.node_id} a ex:{self.class_name} ;",
                f"  ex:outcome {_literal(self.outcome)} ;",
                f"  ex:exitCode {self.exit_code} ;",
                f"  ex:command {_literal(self.command)} ;",
                f"  ex:outputSha256 {_literal(self.output_sha256)} ;",
                f"  ex:commit {_literal(self.commit)} ;",
                f"  ex:scope {_literal(self.scope)} ;",
                f"  ex:durationMs {self.duration_ms} ;",
                f"  ex:checkedAt {_literal(self.checked_at)} .",
            ]
        )


@dataclass
class CommitEvidence:
    node_id: str
    commit: str
    tree_clean: bool
    is_ancestor_of_head: bool
    subject: str
    committed_at: str

    def to_ttl(self) -> str:
        return "\n".join(
            [
                f"ex:{self.node_id} a ex:CommitEvidence ;",
                f"  ex:commit {_literal(self.commit)} ;",
                f"  ex:treeClean {_boolean(self.tree_clean)} ;",
                f"  ex:isAncestorOfHead {_boolean(self.is_ancestor_of_head)} ;",
                f"  ex:subject {_literal(self.subject)} ;",
                f'  ex:committedAt "{_escape(self.committed_at)}"^^xsd:dateTime .',
            ]
        )


@dataclass
class Ticket:
    id: str
    title: str
    blocked_by: list[str] = field(default_factory=list)
    state: str = "todo"
    spec_id: str = ""
    gate_evidence: list[GateEvidence] = field(default_factory=list)
    commit_evidence: CommitEvidence | None = None
    # Used only by negative scenarios: assert extra facts on purpose.
    extra_states: list[str] = field(default_factory=list)
    extra_commit_evidence: list[CommitEvidence] = field(default_factory=list)

    def state_classes(self) -> list[str]:
        classes = [STATE_TO_CLASS[self.state]] + [
            STATE_TO_CLASS[s] for s in self.extra_states
        ]
        return classes

    def to_ttl(self, default_spec_id: str) -> str:
        spec_id = self.spec_id or default_spec_id
        types = ["Ticket"] + self.state_classes()
        lines = [
            f"ex:{self.id} a " + ", ".join(f"ex:{t}" for t in types) + " ;",
            f"  ex:inSpec ex:{spec_id} ;",
            f"  ex:title {_literal(self.title)}",
        ]
        if self.blocked_by:
            lines[-1] += " ;"
            lines.append(
                "  ex:blockedBy " + ", ".join(f"ex:{b}" for b in self.blocked_by)
            )
        if self.gate_evidence:
            lines[-1] += " ;"
            lines.append(
                "  ex:hasGateEvidence "
                + ", ".join(f"ex:{g.node_id}" for g in self.gate_evidence)
            )
        commit_nodes = list(self.extra_commit_evidence)
        if self.commit_evidence is not None:
            commit_nodes.insert(0, self.commit_evidence)
        if commit_nodes:
            lines[-1] += " ;"
            lines.append(
                "  ex:hasCommitEvidence "
                + ", ".join(f"ex:{node.node_id}" for node in commit_nodes)
            )
        lines[-1] += " ."
        return "\n".join(lines)


@dataclass
class Spec:
    id: str
    title: str
    state: str = "active"
    tickets: list[Ticket] = field(default_factory=list)

    def ticket(self, ticket_id: str) -> Ticket:
        for ticket in self.tickets:
            if ticket.id == ticket_id:
                return ticket
        raise KeyError(ticket_id)

    def spec_ids(self) -> list[str]:
        seen: list[str] = []
        for ticket in self.tickets:
            spec_id = ticket.spec_id or self.id
            if spec_id not in seen:
                seen.append(spec_id)
        if self.id not in seen:
            seen.insert(0, self.id)
        return seen

    def to_ttl(self) -> str:
        spec_ids = self.spec_ids()
        chunks = [
            "# Generated by ontology_gate.model. Do not edit by hand.",
            "@prefix ex: <https://example.org/ontology-gate#> .",
            "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
            "",
        ]
        for spec_id in spec_ids:
            if spec_id == self.id:
                spec_type = SPEC_STATE_TO_CLASS[self.state]
                chunks.append(f"ex:{spec_id} a ex:{spec_type} ;")
                chunks.append(f"  ex:title {_literal(self.title)} .")
            else:
                chunks.append(f"ex:{spec_id} a ex:ActiveSpec ;")
                chunks.append(f"  ex:title {_literal(spec_id)} .")
            chunks.append("")

        for ticket in self.tickets:
            chunks.append(ticket.to_ttl(self.id))
            chunks.append("")
            for gate in ticket.gate_evidence:
                chunks.append(gate.to_ttl())
                chunks.append("")
            commit_nodes = list(ticket.extra_commit_evidence)
            if ticket.commit_evidence is not None:
                commit_nodes.insert(0, ticket.commit_evidence)
            for node in commit_nodes:
                chunks.append(node.to_ttl())
                chunks.append("")

        return "\n".join(chunks).rstrip() + "\n"


def tickets_in_spec(spec: Spec, spec_id: str) -> Iterable[Ticket]:
    for ticket in spec.tickets:
        if (ticket.spec_id or spec.id) == spec_id:
            yield ticket
