"""Resolve the one reviewed Stage-B contraction in staged or promoted form."""

import hashlib
from pathlib import Path
import re


MIGRATION_NAME = "stage_b_current_postimage_contraction"
SOURCE_SHA256 = "0e4de008290fd491c198779927433765149f4f42bb77efd32f4c61d9d4c93c1f"


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
