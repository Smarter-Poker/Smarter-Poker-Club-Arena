#!/usr/bin/env python3
"""Name a failed Spin expiry qualification where the check-run API can read it.

WHY (2026-10-05, CLAUDE.md 10.83 and 10.86 rule 3). When
`scripts/ci/test-spin-expiry-postgres.py` fails, its reason exists in only two
places: the job log and the uploaded `artifacts/spin-expiry/` evidence. Both
are served from blob storage, which a session that reads the GitHub API cannot
always reach. On 2026-10-05 this step went red on every server-touching pull
request and blocked every merge, and through the API it said only "Process
completed with exit code 1".

This reads the evidence the runner already writes (every `failures`,
`failure` and `cleanup_failure` entry in its JSON) and prints one `::error`
workflow command per finding. GitHub keeps those as check-run annotations.
GitHub keeps 10 per step, so the first 9 are named and the 10th says how many
more there are. Evidence that is missing or unreadable is named as well, so a
silent step never reads as "nothing failed".

It only reports. It never changes the verdict and always exits 0.
"""
import json
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/spin-expiry')
MAX_NAMED = 9
CHARS = 700


def escape(text):
    return str(text).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


def findings_in(value, where, out):
    if isinstance(value, dict):
        for key in ('failures', 'failure', 'cleanup_failure', 'verifier_cleanup_error', 'fast_stop_failure'):
            found = value.get(key)
            if not found:
                continue
            items = found if isinstance(found, list) else [found]
            for item in items:
                if isinstance(item, dict):
                    label = item.get('stage') or item.get('type') or key
                    message = item.get('message') or json.dumps(item, sort_keys=True)
                else:
                    label, message = key, item
                out.append((where, str(label), str(message)))
        for key, child in value.items():
            if key not in ('failures', 'failure', 'cleanup_failure'):
                findings_in(child, where, out)
    elif isinstance(value, list):
        for child in value:
            findings_in(child, where, out)


def main():
    lines = []
    if not ROOT.is_dir():
        lines.append(f'::error title=Spin expiry evidence::{escape(f"No evidence directory at {ROOT}: the runner failed before it wrote any.")}')
    else:
        found, unreadable = [], []
        for path in sorted(ROOT.rglob('*.json')):
            try:
                findings_in(json.loads(path.read_text()), path.relative_to(ROOT).as_posix(), found)
            except (OSError, ValueError) as error:
                unreadable.append(f'{path.relative_to(ROOT).as_posix()} ({error})')
        seen = set()
        unique = []
        for item in found:
            if item not in seen:
                seen.add(item)
                unique.append(item)
        for where, label, message in unique[:MAX_NAMED]:
            title = escape(f'Spin expiry: {label}'[:200]).replace(':', '%3A').replace(',', '%2C')
            lines.append(f'::error title={title}::{escape((where + ": " + message)[:CHARS])}')
        tail = []
        if len(unique) > MAX_NAMED:
            tail.append(f'{len(unique) - MAX_NAMED} more finding(s) are only in the uploaded evidence.')
        if unreadable:
            tail.append('Unreadable evidence: ' + '; '.join(unreadable))
        if not unique:
            tail.append(f'No failure entry in any JSON under {ROOT}; the reason is only in the job log.')
        if tail:
            lines.append(f'::error title=Spin expiry evidence::{escape(" ".join(tail))}')
    for line in lines:
        print(line)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
