#!/usr/bin/env python3
"""Every pinned source file still hashes to what its binding says.

WHY THIS RUNS ON EVERY PULL REQUEST (2026-09-20)
================================================
A `source-binding.json` pins the exact bytes of the files a financial
qualification was reviewed against. `scripts/dev/test-full-weekly-accounting-
activation.sh` verifies its own pins before it builds anything, which is
correct, and for a long time it was the only thing in the repository that did.

That runner lives in the `accounting_postgres` job, and `changes` gates that
job: it runs when the pull request touches `server/`, `supabase/migrations/`,
`scripts/dev/` or one of the accounting fixture directories. The pins do not
live only in those places. `tests/fixtures/full-weekly-accounting/
source-binding.json` alone pins 423 repository paths, most of them
`tests/unit/*.test.ts` under the protected application catalog, and a pull
request that edits one of those touches none of the gating prefixes.

So the pull request skips the only job that reads the pin, goes green, merges,
and the next full run on main refuses the bundle. That is what happened in
#4943: it retired the browser dispute escalator, changed two pinned test files,
skipped `accounting_postgres` (run 35478110801, job 105990868150), and main
went red on a step that the pull request itself never ran. Every pull request
opened afterwards inherited the same red step with no way to tell whose change
had caused it.

The answer is not to widen the gate so a forty minute PostgreSQL job runs on
every unit test edit. It is to check the pins where checking them is cheap.
This reads files and hashes them. It needs no database, no node_modules and no
network, it finishes in seconds, and it is deliberately ungated so that the one
pull request which needs it cannot be the one that skips it.

The protected runner keeps its own inline check. This is a second, earlier
reading of the same bytes, not a substitute for the qualification: a matching
hash proves the bytes are the reviewed bytes and proves nothing else.

WHAT IT REFUSES TO GUESS
========================
Sections are discovered rather than listed here, so a binding file added
tomorrow is covered on the day it lands instead of the day somebody remembers
to add it.

A section counts as a pin map when every one of its values is a 64 character
lowercase hex digest. Paths in different binding files resolve against
different roots, so the root is measured rather than assumed: whichever of the
repository root or the binding file's own directory resolves every path in that
section. If neither resolves every path, the absent paths are the finding. If
both do, the section is ambiguous and that is a finding too. Neither case is
guessed at, because a binding that silently verifies nothing is worse than no
binding at all.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SEARCH_ROOTS = ("tests", "scripts", "supabase")
BINDING_NAME = "source-binding.json"
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "coverage"}
DIGEST_LENGTH = 64
HEX_CHARACTERS = set("0123456789abcdef")


def binding_files() -> list[Path]:
    found: list[Path] = []
    for top in SEARCH_ROOTS:
        base = REPO_ROOT / top
        if not base.is_dir():
            continue
        for path in base.rglob(BINDING_NAME):
            parts = path.relative_to(REPO_ROOT).parts
            if any(part in SKIP_DIRS for part in parts):
                continue
            found.append(path)
    return sorted(found)


def is_pin_map(value: object) -> bool:
    if not isinstance(value, dict) or not value:
        return False
    for entry in value.values():
        if not isinstance(entry, str):
            return False
        if len(entry) != DIGEST_LENGTH:
            return False
        if not set(entry).issubset(HEX_CHARACTERS):
            return False
    return True


def absent_under(root: Path, section: dict) -> list:
    return [name for name in section if not (root / name).is_file()]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    findings = []
    verified = 0
    sections = 0
    files = binding_files()
    if not files:
        print(
            "No " + BINDING_NAME + " found under " + ", ".join(SEARCH_ROOTS) + ".",
            file=sys.stderr,
        )
        print(
            "A binding verifier that verifies nothing has failed, not passed.",
            file=sys.stderr,
        )
        return 1

    for binding_path in files:
        rel = binding_path.relative_to(REPO_ROOT).as_posix()
        try:
            document = json.loads(binding_path.read_text())
        except (OSError, ValueError) as error:
            findings.append(rel + ": unreadable binding (" + str(error) + ")")
            continue
        if not isinstance(document, dict):
            findings.append(rel + ": binding is not an object")
            continue

        for name, value in document.items():
            if not is_pin_map(value):
                continue
            sections += 1
            candidates = {
                "repository root": REPO_ROOT,
                "binding directory": binding_path.parent,
            }
            resolved = {
                label: root
                for label, root in candidates.items()
                if not absent_under(root, value)
            }
            if len(resolved) > 1:
                findings.append(
                    rel + " :: " + name + ": every path resolves under both "
                    + " and ".join(sorted(resolved))
                    + "; the intended root cannot be measured"
                )
                continue
            if not resolved:
                best_label, best_root = min(
                    candidates.items(),
                    key=lambda item: len(absent_under(item[1], value)),
                )
                absent = sorted(absent_under(best_root, value))
                findings.append(
                    rel + " :: " + name + ": " + str(len(absent)) + " of "
                    + str(len(value)) + " pinned paths are absent under the closest "
                    "root (" + best_label + "); first absent: " + ", ".join(absent[:5])
                )
                continue

            label, root = next(iter(resolved.items()))
            for pinned, expected in sorted(value.items()):
                actual = digest(root / pinned)
                if actual == expected:
                    verified += 1
                    continue
                findings.append(
                    rel + " :: " + name + " :: " + pinned + " (" + label + ")\n"
                    "    pinned bytes sha256 " + expected + "\n"
                    "    actual bytes sha256 " + actual
                )

    print(
        "Checked " + str(verified + len(findings)) + " pins across "
        + str(sections) + " sections in " + str(len(files)) + " binding files."
    )
    if not findings:
        print("Every pinned source file still hashes to its recorded bytes.")
        return 0

    print("", file=sys.stderr)
    print(
        "A pinned source file no longer matches the bytes it was reviewed as.",
        file=sys.stderr,
    )
    for finding in findings:
        print("  " + finding, file=sys.stderr)
    print("", file=sys.stderr)
    print(
        "If the change is correct, restamp the pin in the same pull request that "
        "changes the file and record what changed and why in that binding's own "
        "audit block. Never restamp a pin whose diff you have not read.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
