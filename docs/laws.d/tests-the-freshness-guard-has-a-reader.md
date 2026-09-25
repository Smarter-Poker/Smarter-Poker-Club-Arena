# tests/the-freshness-guard-has-a-reader.law.test.ts

`scripts/check-checkout-freshness.sh` measures every clone of this repo on the
machine, and for nine days its only caller was `.husky/pre-push` - which cannot
run in `~/Documents/club-arena`, because `scripts/guard-shared-clone.sh` forbids
pushing from there. The one tree that rots was the one tree the check never ran
in, and on 2026-09-21 it was found 258 commits behind, serving the superseded
September 16 owner instruction to every agent that read it. This pins the
READER - `scripts/agent-workspace.sh`, the command every agent runs to claim a
workspace, which already wires the sibling `check-unpushed-work.sh` for the same
reason - and pins that the guard stays advisory in both callers (10.87 rule 1: a
freshness guard that can wedge every push is worse than the staleness), stays
read-only, and keeps exit 3 for "could not tell" (10.86 rule 1).
