#!/usr/bin/env python3
"""A dependency-free static check used as the fixture's lint gate.

It is intentionally simple and deterministic: tabs, trailing whitespace,
over-long lines, and syntax errors.  It is still a real command whose exit
code the collector records.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "__pycache__"}
MAX_LINE = 100


def python_files() -> list[Path]:
    files: list[Path] = []
    for path in sorted(ROOT.rglob("*.py")):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        files.append(path)
    return files


def check(path: Path) -> list[str]:
    findings: list[str] = []
    text = path.read_text(encoding="utf-8")
    try:
        compile(text, str(path), "exec")
    except SyntaxError as error:
        findings.append(f"{path.relative_to(ROOT)}:{error.lineno}: syntax error: {error.msg}")
        return findings
    for number, line in enumerate(text.splitlines(), start=1):
        if "\t" in line:
            findings.append(f"{path.relative_to(ROOT)}:{number}: tab character")
        if line != line.rstrip():
            findings.append(f"{path.relative_to(ROOT)}:{number}: trailing whitespace")
        if len(line) > MAX_LINE:
            findings.append(
                f"{path.relative_to(ROOT)}:{number}: line longer than {MAX_LINE}"
            )
    if not text.endswith("\n"):
        findings.append(f"{path.relative_to(ROOT)}: missing final newline")
    return findings


def main() -> int:
    findings: list[str] = []
    for path in python_files():
        findings.extend(check(path))
    for finding in findings:
        print(finding)
    if findings:
        print(f"lint: {len(findings)} finding(s)")
        return 1
    print(f"lint: {len(python_files())} file(s) clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
