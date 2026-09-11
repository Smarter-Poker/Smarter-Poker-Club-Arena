"""Resolve the one reviewed Stage-B contraction in staged or promoted form."""

import hashlib
from pathlib import Path
import re


MIGRATION_NAME = "stage_b_current_postimage_contraction"
SOURCE_SHA256 = "7ac02aa176bfc60f0985e366c771fe1f59e4f47ff2e66ecc2c5e54f9236403b0"


def resolve(root: Path) -> Path:
    migration_directory = root / "supabase/migrations"
    matches = sorted(
        path
        for path in migration_directory.iterdir()
        if path.is_file()
        and re.fullmatch(
            rf"[0-9]{{14}}_{re.escape(MIGRATION_NAME)}\.sql(?:\.pending)?",
            path.name,
        )
    )
    if len(matches) != 1:
        raise ValueError(
            f"expected exactly one staged-or-promoted {MIGRATION_NAME} migration; "
            f"found {len(matches)}"
        )
    path = matches[0]
    if hashlib.sha256(path.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("reviewed Stage-B contraction source changed")
    return path
