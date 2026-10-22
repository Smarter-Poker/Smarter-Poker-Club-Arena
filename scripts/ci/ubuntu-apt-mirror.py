"""Use Ubuntu's primary HTTPS mirror for browser dependencies on hosted CI."""
import argparse
from pathlib import Path
import re

AZURE_URI = re.compile(r"https?://azure\.archive\.ubuntu\.com/ubuntu(?=/|\s|$)")


def rewrite_sources(root: Path) -> int:
    paths = [root / "sources.list"]
    parts = root / "sources.list.d"
    paths += sorted(parts.glob("*.list")) + sorted(parts.glob("*.sources"))
    existing = [path for path in paths if path.is_file()]
    if not existing:
        raise RuntimeError(f"No APT sources found under {root}")
    changed = 0
    for path in existing:
        before = path.read_text()
        after = "".join(
            line if line.lstrip().startswith("#") else AZURE_URI.sub(
                "https://archive.ubuntu.com/ubuntu", line
            )
            for line in before.splitlines(keepends=True)
        )
        if after != before:
            path.write_text(after)
            changed += 1
    return changed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/etc/apt"))
    args = parser.parse_args()
    print(f"Ubuntu primary HTTPS mirror: updated {rewrite_sources(args.root)} source files")
