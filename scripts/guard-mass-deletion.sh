#!/usr/bin/env sh
# ═══════════════════════════════════════════════════════════════════════════
#  A COMMIT MAY NOT EMPTY THE TREE
# ═══════════════════════════════════════════════════════════════════════════
#
# 2026-08-24. A commit authored `Guard Test <guard@test>`, message `base`,
# appeared inside a live agent worktree and deleted 3,708 of 3,710 tracked
# files. It was a guard SELF-TEST FIXTURE that built its scenario with real
# `git commit` calls in whatever repository it happened to be standing in,
# instead of in a temporary one. It was pushed to a feature branch before
# anyone noticed, because nothing objected.
#
# Every guard in .husky/pre-commit passed it, and all three were right to:
#   - check-canonical-clone.sh  — it WAS the canonical clone
#   - guard-shared-clone.sh     — it WAS a proper worktree
#   - guard-commit-identity.sh  — it had a name and an email
#
# None of them asks the only question that mattered: is this commit deleting
# essentially the entire repository? That is the gap this closes.
#
# WHY A RATIO AND NOT A COUNT. Deleting 200 files is a big refactor; deleting
# 200 files out of 210 is an accident. The threshold is deliberately loose so
# ordinary work never meets it — a vendored directory going away, a dead
# feature being ripped out, an archive being pruned all sit far below it.
#
# WHY IT IS OVERRIDABLE. Sometimes emptying a tree is the actual intent, and a
# guard with no exit is a guard people disable wholesale with --no-verify —
# which would also switch off the three above it, the ones that must never be
# skipped. Say so explicitly instead:
#
#     AGENT_MASS_DELETE_OK=1 git commit ...
set -e

[ "${AGENT_MASS_DELETE_OK:-}" = "1" ] && exit 0

# No HEAD yet (initial commit) — nothing to compare against.
git rev-parse --verify HEAD >/dev/null 2>&1 || exit 0

DELETED=$(git diff --cached --name-only --diff-filter=D | wc -l | tr -d ' ')
[ "$DELETED" -lt 100 ] && exit 0

TRACKED=$(git ls-tree -r --name-only HEAD | wc -l | tr -d ' ')
[ "$TRACKED" -eq 0 ] && exit 0

# Refuse once deletions reach a quarter of everything tracked.
PERCENT=$((DELETED * 100 / TRACKED))
[ "$PERCENT" -lt 25 ] && exit 0

cat >&2 <<BANNER

  ─────────────────────────────────────────────────────────────────────────
  COMMIT REFUSED - this deletes most of the repository.

    deleting: ${DELETED} tracked files
    of:       ${TRACKED} at HEAD  (${PERCENT}%)

  On 2026-08-24 a guard self-test fixture committed exactly this shape into a
  live agent worktree - 3,708 of 3,710 files, authored 'Guard Test
  <guard@test>', message 'base' - and it was pushed before anyone noticed. If
  that is what is happening now, you are in the wrong repository: build the
  fixture in a temp clone (mktemp -d && git init) and never in this one.

  If you MEANT to do this, say so and the commit proceeds:

      AGENT_MASS_DELETE_OK=1 git commit ...

  Do NOT reach for --no-verify. It also disables the canonical-clone,
  shared-clone and commit-identity guards, which is how unattributable and
  misplaced commits reach main.
  ─────────────────────────────────────────────────────────────────────────

BANNER
exit 1
