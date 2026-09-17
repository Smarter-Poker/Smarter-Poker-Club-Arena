#!/usr/bin/env python3
"""UNRUN protected payload: verify portable source custody, not DB behavior.

No database, subprocess or network access. Admission to the protected pipeline
is required before execution. Source hashes do not establish owner/ACL evidence.
"""
import hashlib
import json
from pathlib import Path


def main():
    directory = Path(__file__).resolve().parent
    binding = json.loads((directory / "source-binding.json").read_text())
    for name, expected in binding["files"].items():
        if Path(name).name != name:
            raise ValueError("binding paths must stay within the fixture")
        actual = hashlib.sha256((directory / name).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"source binding changed: {name}")

    captured = json.loads((directory / "captured-pnl-metadata.json").read_text())
    sql = (directory / "legacy-pnl-wrapper-preimages.sql").read_text()
    signatures = (
        "fn_union_settle_player_pnl_guarded(uuid,timestamp with time zone,timestamp with time zone,numeric)",
        "fn_union_settle_player_pnl_weekly(uuid,numeric)",
    )
    for signature in signatures:
        rows = [row for row in captured["writers"] if row["signature"] == signature]
        if len(rows) != 1:
            raise ValueError(f"captured wrapper missing or duplicated: {signature}")
        definition = rows[0]["definition"]
        if not definition.endswith("END $function$\n"):
            raise ValueError(f"captured terminator changed: {signature}")
        # pg_get_functiondef capture has a trailing newline and no command
        # semicolon. Only that outer terminator differs in the loadable SQL.
        loadable_definition = definition.removesuffix("\n") + ";"
        if sql.count(loadable_definition) != 1:
            raise ValueError(f"wrapper differs from exact captured definition: {signature}")
    if sql.count("CREATE OR REPLACE FUNCTION ") != len(signatures):
        raise ValueError("unexpected wrapper fixture function")
    print("Portable wrapper source matches captured definitions; this check does not validate access rights. The full activation fixture loads separately captured supplemental ACLs.")


if __name__ == "__main__":
    main()
