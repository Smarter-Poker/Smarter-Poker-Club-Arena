#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════════
 pr-supersession-scan — is this pull request's work already on main?
═══════════════════════════════════════════════════════════════════════════════

WHY THIS EXISTS

On 2026-08-31 this repo had 120 open pull requests, 95 of them opened by
agent-autopilot in a single burst on 2026-08-26. Every one was CONFLICTING and
between 800 and 1,100 commits behind main, so none could merge. The obvious
reading - "a hundred fixes are stuck one click from shipping" - was wrong.

The repo ships through two paths. `git push` moves the commit object; the
GitHub-MCP path (`push_files`) RE-CREATES the same content under a different
SHA. CLAUDE.md section 12 documents this as the reason `git pull --rebase`
strands the shared clone. It has a second consequence nobody had measured: a
pull request whose content landed via the other path stays OPEN FOREVER,
looking like unshipped work, because git can see no relationship between the
two commits.

Measured with this script across all 121 open PRs:

    100% already on main .......... 18   (plus 4 with an empty diff)
    80-99% .......................  29
    50-79% .......................  14
    20-49% .......................  12
    0-19% (genuinely unshipped) ..  44

So a fifth of the backlog was pure residue, and closing it was recovery of
attention, not loss of work.

HOW IT DECIDES

Git cannot answer this - the commits are unrelated by construction - so the
question is asked of the CONTENT. It samples up to 40 substantive added lines
(longer than 25 characters, comment openers excluded, deduplicated) and asks
how many appear verbatim anywhere in the current main checkout. Long exact
lines are a strong fingerprint: a 40-of-40 hit is not coincidence, and the
threshold for acting was set at 100% for that reason.

It is a TRIAGE INSTRUMENT, NOT AN ORACLE. A high score means "read this one
first", and a low score means "there is probably real work here". Every PR
closed on 2026-08-31 was additionally spot-checked by hand before closing -
#1149 by confirming AvatarCosmetics exists on main, #1014 by reading its diff
(a duplicate import of a line already two lines above it).

USAGE
    node/python3 scripts/dev/pr-supersession-scan.py <PR> [<PR> ...]

    Requires a checkout of main at the path in W below, and appends
    "<pr>\t<sampled>\t<hits>\t<percent>" to /tmp/sup.tsv.

Build the corpus first (30MB, a few seconds):
    find src server tests scripts -type f \( -name '*.ts' -o -name '*.tsx' \
      -o -name '*.css' -o -name '*.mjs' -o -name '*.sql' -o -name '*.js' \) \
      -print0 | xargs -0 cat > /tmp/corpus.txt
"""

import subprocess, sys
R="Smarter-Poker/Smarter-Poker-Club-Arena"
CORPUS=open("/tmp/corpus.txt",encoding="utf-8",errors="ignore").read()
out=open("/tmp/sup.tsv","a")
for n in sys.argv[1:]:
    try:
        diff=subprocess.run(["gh","pr","diff",n,"-R",R],capture_output=True,text=True,timeout=60).stdout
    except Exception:
        out.write(f"{n}\t?\t?\ttimeout\n"); out.flush(); continue
    if not diff.strip():
        out.write(f"{n}\t0\t0\tempty-diff\n"); out.flush(); continue
    added=[]
    for L in diff.split("\n"):
        if L.startswith("+") and not L.startswith("+++"):
            s=L[1:].strip()
            if len(s)>25 and not s.startswith(("*","//","/*")):
                added.append(s)
    added=list(dict.fromkeys(added))[:40]
    if not added:
        out.write(f"{n}\t0\t0\tno-substantive\n"); out.flush(); continue
    hit=sum(1 for s in added if s in CORPUS)
    out.write(f"{n}\t{len(added)}\t{hit}\t{hit*100//len(added)}\n"); out.flush()
out.close()
