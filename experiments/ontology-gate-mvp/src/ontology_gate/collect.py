"""Run the real lint / unit-test / git commands and record what happened.

The collector is deliberately dumb: it does not decide whether a ticket may
complete.  It executes the commands named in ``spec/spec.json``, captures
their exit codes and output digests, makes a real commit, and returns the
facts.  The ontology gate is what interprets those facts.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .model import CommitEvidence, GateEvidence, Spec, Ticket

COMMIT_NAME = "Ontology Gate MVP"
COMMIT_EMAIL = "ontology-gate@example.invalid"


@dataclass
class CommandResult:
    command: str
    exit_code: int
    output: str
    output_sha256: str
    duration_ms: int


def _git(
    repo: Path,
    *args: str,
    check: bool = True,
    capture: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "git",
            "-c",
            f"user.name={COMMIT_NAME}",
            "-c",
            f"user.email={COMMIT_EMAIL}",
            *args,
        ],
        cwd=repo,
        check=check,
        capture_output=capture,
        text=True,
        timeout=120,
    )


def init_repo(repo: Path, base: Path) -> str:
    if repo.exists():
        shutil.rmtree(repo)
    shutil.copytree(base, repo)
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "fixture: base")
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def apply_overlay(repo: Path, overlay: Path) -> None:
    if not overlay.exists():
        return
    for source in sorted(overlay.rglob("*")):
        if source.is_dir():
            continue
        relative = source.relative_to(overlay)
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def append_file(repo: Path, relative: str, text: str) -> None:
    path = repo / relative
    with path.open("a", encoding="utf-8") as handle:
        handle.write(text)


def run_command(repo: Path, command: list[str]) -> CommandResult:
    started = time.monotonic()
    completed = subprocess.run(
        command,
        cwd=repo,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
        env={
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    output = completed.stdout
    if completed.stderr:
        output += "\n[stderr]\n" + completed.stderr
    return CommandResult(
        command=" ".join(command),
        exit_code=completed.returncode,
        output=output,
        output_sha256=hashlib.sha256(output.encode("utf-8")).hexdigest(),
        duration_ms=duration_ms,
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def collect_ticket(
    repo: Path,
    spec: Spec,
    ticket: Ticket,
    gates: dict[str, dict[str, object]],
) -> None:
    """Run all gates against the current worktree, commit, and attach evidence.

    The caller applies the ticket overlay (and any deliberate corruption)
    before calling this, so the recorded facts are exactly what ran.
    """

    evidence: list[GateEvidence] = []
    for kind in ("lint", "unitTests"):
        gate = gates[kind]
        command = [str(part) for part in gate["command"]]  # type: ignore[index]
        result = run_command(repo, command)
        evidence.append(
            GateEvidence(
                node_id=f"{ticket.id}-{kind}",
                kind=kind,
                outcome="pass" if result.exit_code == 0 else "fail",
                exit_code=result.exit_code,
                command=result.command,
                output_sha256=result.output_sha256,
                commit="",  # filled after the commit exists
                scope=str(gate["scope"]),
                duration_ms=result.duration_ms,
                checked_at=_now(),
            )
        )

    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "--allow-empty", "-m", f"{ticket.id}: {ticket.title}")
    sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    subject = _git(repo, "log", "-1", "--format=%s").stdout.strip()
    committed_at = _git(repo, "log", "-1", "--format=%cI").stdout.strip()
    status = _git(repo, "status", "--porcelain", "--untracked-files=all").stdout
    ancestor = _git(repo, "merge-base", "--is-ancestor", sha, "HEAD", check=False)
    if ancestor.returncode != 0:
        raise RuntimeError(f"{ticket.id}: commit {sha} is not an ancestor of HEAD")

    for gate in evidence:
        gate.commit = sha
    ticket.gate_evidence = evidence
    ticket.commit_evidence = CommitEvidence(
        node_id=f"{ticket.id}-commit",
        commit=sha,
        tree_clean=status.strip() == "",
        is_ancestor_of_head=True,
        subject=subject,
        committed_at=committed_at,
    )
    ticket.state = "done"


def build_spec(
    spec_config: dict[str, object],
    repo: Path,
    overlays: Path,
    fixtures: Path,
) -> tuple[Spec, str]:
    """Run the configured ticket sequence and return the resulting spec."""

    spec = Spec(
        id=str(spec_config["id"]),
        title=str(spec_config["title"]),
        state="active",
        tickets=[
            Ticket(
                id=str(item["id"]),
                title=str(item["title"]),
                blocked_by=[str(b) for b in item.get("blocked_by", [])],
            )
            for item in spec_config["tickets"]  # type: ignore[index]
        ],
    )
    base_commit = init_repo(repo, fixtures / "base")
    gates = spec_config["gates"]  # type: ignore[assignment]
    for ticket in spec.tickets:
        apply_overlay(repo, overlays / ticket.id)
        collect_ticket(repo, spec, ticket, gates)  # type: ignore[arg-type]
    return spec, base_commit


def run_ticket_only(
    spec_config: dict[str, object],
    repo: Path,
    overlays: Path,
    fixtures: Path,
    ticket_id: str,
    append: list[tuple[str, str]] | None = None,
) -> tuple[Spec, str]:
    """Build a repo with just one ticket, optionally corrupting a file first."""

    spec = Spec(
        id=str(spec_config["id"]),
        title=str(spec_config["title"]),
        state="active",
        tickets=[
            Ticket(
                id=str(item["id"]),
                title=str(item["title"]),
                blocked_by=[str(b) for b in item.get("blocked_by", [])],
            )
            for item in spec_config["tickets"]  # type: ignore[index]
        ],
    )
    base_commit = init_repo(repo, fixtures / "base")
    gates = spec_config["gates"]  # type: ignore[assignment]
    ticket = spec.ticket(ticket_id)
    apply_overlay(repo, overlays / ticket.id)
    for relative, text in append or []:
        append_file(repo, relative, text)
    # Run the commands after the corruption, then commit whatever happened.
    collect_ticket(repo, spec, ticket, gates)  # type: ignore[arg-type]
    return spec, base_commit
