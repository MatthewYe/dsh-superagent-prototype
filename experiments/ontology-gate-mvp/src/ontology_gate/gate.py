"""Thin, explicit wrapper around the open-ontologies CLI.

The gate is only trustworthy if it is the *standalone* ``shacl`` command:
the measured v2.1.0 ``batch`` command exits 0 even for non-conforming
shapes, while ``shacl`` has the documented 0/1/2 exit-code contract.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


class GateError(RuntimeError):
    """The gate could not reach a verdict (missing binary, load failure, ...)."""


@dataclass
class GateResult:
    exit_code: int
    conforms: bool | None
    violations: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    focus_nodes: int = 0
    data_ttl: str = ""
    stderr: str = ""

    @property
    def passed(self) -> bool:
        return self.exit_code == 0 and self.conforms is True

    @property
    def indeterminate(self) -> bool:
        return self.exit_code == 2 or self.conforms is None

    def messages(self) -> list[str]:
        return [str(v.get("message", "")) for v in self.violations]

    def to_dict(self) -> dict:
        return {
            "exit_code": self.exit_code,
            "conforms": self.conforms,
            "passed": self.passed,
            "indeterminate": self.indeterminate,
            "focus_nodes": self.focus_nodes,
            "violations": self.violations,
            "warnings": self.warnings,
            "stderr": self.stderr,
        }


def find_binary() -> Path:
    candidates: list[Path] = []
    env = os.environ.get("OPEN_ONTOLOGIES_BIN")
    if env:
        candidates.append(Path(env))
    candidates.append(
        Path(__file__).resolve().parents[2] / "tools" / "bin" / "open-ontologies"
    )
    found = shutil.which("open-ontologies")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise GateError(
        "open-ontologies binary not found; run scripts/fetch-open-ontologies.sh "
        "or set OPEN_ONTOLOGIES_BIN"
    )


def _run(
    binary: Path,
    data_dir: Path,
    *args: str,
    timeout: int = 120,
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "OPEN_ONTOLOGIES_STORAGE_MODE": "persistent",
    }
    completed = subprocess.run(
        [str(binary), "--no-connect", "--data-dir", str(data_dir), *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )
    return completed


def _load(binary: Path, data_dir: Path, path: Path) -> None:
    completed = _run(binary, data_dir, "load", str(path))
    if completed.returncode != 0:
        raise GateError(
            f"open-ontologies load failed for {path} "
            f"(exit {completed.returncode}): {completed.stderr.strip()}"
        )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise GateError(f"load did not return JSON for {path}: {error}") from error
    if not payload.get("ok"):
        raise GateError(f"load was not ok for {path}: {payload}")


def check(
    data_ttl: str,
    tbox: Path,
    shapes: Path,
    keep_data_dir: Path | None = None,
) -> GateResult:
    binary = find_binary()
    if keep_data_dir is not None:
        data_dir = keep_data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        temporary = None
    else:
        temporary = tempfile.TemporaryDirectory(prefix="ontology-gate-")
        data_dir = Path(temporary.name)

    data_path = data_dir / "state.ttl"
    data_path.write_text(data_ttl, encoding="utf-8")
    try:
        _load(binary, data_dir, tbox)
        _load(binary, data_dir, data_path)
        completed = _run(binary, data_dir, "shacl", str(shapes))
    except Exception:
        if temporary is not None:
            temporary.cleanup()
        raise

    if temporary is not None:
        temporary.cleanup()

    if completed.returncode not in (0, 1, 2):
        raise GateError(
            f"unexpected shacl exit {completed.returncode}: {completed.stderr.strip()}"
        )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise GateError(
            f"shacl did not return JSON (exit {completed.returncode}): {error}"
        ) from error

    warnings: list[str] = []
    if payload.get("warning"):
        warnings.append(str(payload["warning"]))
    for skipped in payload.get("skipped_constraints") or []:
        warnings.append(
            "skipped constraint: "
            + json.dumps(skipped, sort_keys=True, ensure_ascii=False)
        )

    return GateResult(
        exit_code=completed.returncode,
        conforms=payload.get("conforms"),
        violations=list(payload.get("violations") or []),
        warnings=warnings,
        focus_nodes=int(payload.get("focus_nodes") or 0),
        data_ttl=data_ttl,
        stderr=completed.stderr,
    )


def frontier(data_ttl: str, tbox: Path, spec_id: str) -> list[dict[str, str]]:
    """Return ready tickets (Todo, no unfinished blocker) as {id,title}."""

    binary = find_binary()
    with tempfile.TemporaryDirectory(prefix="ontology-frontier-") as name:
        data_dir = Path(name)
        data_path = data_dir / "state.ttl"
        data_path.write_text(data_ttl, encoding="utf-8")
        _load(binary, data_dir, tbox)
        _load(binary, data_dir, data_path)
        query = f"""PREFIX ex: <https://example.org/ontology-gate#>
SELECT ?t ?title WHERE {{
  ?t a ex:Todo ; ex:inSpec ex:{spec_id} ; ex:title ?title .
  FILTER NOT EXISTS {{
    ?t ex:blockedBy ?b .
    FILTER NOT EXISTS {{ ?b a ex:Done }}
  }}
}}
ORDER BY ?t
"""
        completed = _run(binary, data_dir, "query", query)
        if completed.returncode != 0:
            raise GateError(
                f"frontier query failed (exit {completed.returncode}): "
                f"{completed.stderr.strip()}"
            )
        payload = json.loads(completed.stdout)

    ready: list[dict[str, str]] = []
    for row in payload.get("results") or []:
        ready.append(
            {
                "id": _unquote(row.get("t", "")),
                "title": _unquote(row.get("title", "")),
            }
        )
    return ready


def _unquote(term: str) -> str:
    if term.startswith("<") and term.endswith(">"):
        term = term[1:-1]
        return term.rsplit("#", 1)[-1].rsplit("/", 1)[-1]
    if term.startswith('"') and term.endswith('"'):
        return term[1:-1]
    return term
