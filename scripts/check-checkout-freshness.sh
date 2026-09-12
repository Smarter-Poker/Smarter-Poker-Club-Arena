#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  READ-ONLY CHECKOUT FRESHNESS AUDIT
# ═══════════════════════════════════════════════════════════════════════════
#
# WHY THIS EXISTS (2026-09-12)
#
# `~/Documents/club-arena` is the canonical checkout and the folder every
# Cowork agent is pointed at. On 2026-09-12 it was found sitting at
# ec745dbb18, dated 2026-09-06, **759 commits behind `origin/main`**, with a
# clean-looking `git status` summary and a working tree that read as normal.
#
# Nothing was broken in a way anybody could see. `git fetch` worked, the
# remote was reachable, `origin/main` was current in `.git`. What had happened
# is smaller and quieter than that:
#
#   1. A commit was made DIRECTLY ON `main` at 18:18 on 2026-09-06 and never
#      pushed. Local `main` was then 1 ahead of `origin/main`.
#   2. Every `git pull --ff-only` after that could not fast-forward, so it
#      refused. The estate's tooling runs it as `pull -q --ff-only`, so the
#      refusal printed nothing anyone read.
#   3. The index was left holding an older tree, so 392 paths showed as
#      "staged", which made the checkout look busy rather than stuck.
#
# For six days, three agents read that checkout, believed it was current, and
# produced confidently wrong conclusions about production. One of them nearly
# shipped two regressions on the strength of it. Specifically, the on-disk
# copies of these were all six days stale and all four said something false:
#
#   - `.claude/skills/deploy-hetzner/SKILL.md` was still v1.0.0, naming VPS
#     `178.156.160.206` as the engine. That address is `club-arena-turn`, the
#     TURN server. The engine is `5.161.252.33`. The on-disk skill is what an
#     agent LOADS; `origin/main` had carried the corrected v2.0.0 for days.
#   - `CLAUDE.md` 10.82 still documented a fail-OPEN merged-branch guard with
#     an `AGENT_MERGED_BRANCH_OK=1` bypass. On `origin/main` that section and
#     `scripts/guard-merged-branch.sh` had already been reconciled to
#     fail-CLOSED with no bypass.
#   - `CLAUDE.md` still referenced `.github/scripts/engine-watchdog.sh`,
#     deleted upstream in #4189.
#   - `scripts/guard-merged-branch.sh` on disk was the old 201-line version.
#
# Every one of those is the same failure: a LOCAL COPY asserting something
# about the environment that stopped being true, with nothing checking. The
# fetch was never the problem. Nobody was measuring the distance.
#
# THIS IS THE MEASUREMENT. It is read-only: it never pulls, resets, prunes,
# checks out, or deletes anything. It reports, and it exits non-zero.
#
#     bash scripts/check-checkout-freshness.sh              # report
#     bash scripts/check-checkout-freshness.sh --quiet      # speak only if wrong
#     bash scripts/check-checkout-freshness.sh --no-fetch   # use refs as they are
#
#   exit 0  every clone is current
#   exit 1  at least one clone is stale, diverged, or wedged
#   exit 3  COULD NOT TELL - the remote was unreachable, so the distance is
#           unknown. This is deliberately NOT exit 0. CLAUDE.md 10.86 rule 1:
#           "I could not tell" is a distinct outcome and must have its own
#           name. A freshness check that reports "fresh" when it could not
#           reach GitHub is the bug it was written to prevent.
#
# Tunable: CA_FRESHNESS_MAX_BEHIND (default 25) commits behind origin/main
# before a CLONE is called stale.
set -uo pipefail

# ── RUN FROM A HOOK, THIS SCRIPT SAW ONE REPOSITORY EVERYWHERE ──────────────
#
# Git exports GIT_DIR (and GIT_WORK_TREE, GIT_INDEX_FILE, ...) to its hooks,
# and `git -C <dir>` does NOT override them: `-C` changes the directory, then
# GIT_DIR still names the repository. So every `git -C "$d" config --get
# remote.origin.url` below answered with the PUSHING repo's URL, every
# directory under ~/Documents with a .git in it "matched", and the first real
# pre-push run of this script announced 25 clones of Club Arena, listing
# Smarter-Poker-Arcade and identity-dna-engine among them. Every distance it
# then measured was measured against the wrong repository.
#
# That is this file's own subject matter: a confident answer from a component
# that had no business giving one (10.86). Clear the environment first, so
# `-C` means what it reads as.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX \
      GIT_NAMESPACE GIT_QUARANTINE_PATH 2>/dev/null || true

QUIET=0
FETCH=1
for arg in "$@"; do
  case "$arg" in
    --quiet)    QUIET=1 ;;
    --no-fetch) FETCH=0 ;;
    -h|--help)  sed -n '1,60p' "$0"; exit 0 ;;
  esac
done

MAX_BEHIND="${CA_FRESHNESS_MAX_BEHIND:-25}"

REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
REPO_KEY=$(printf '%s' "$REMOTE_URL" | sed 's#.*[:/]##; s#\.git$##')
[ -z "$REPO_KEY" ] && exit 0

FINDINGS=""
UNKNOWNS=""
NOTES=""

# ── Every CLONE of this repo under ~/Documents ──────────────────────────────
# A clone has a .git DIRECTORY. A linked worktree has a .git FILE, and is
# handled separately below, because a worktree is created at a point in time
# and is expected to age; a clone is not.
CLONES=""
for d in "$HOME"/Documents/*/; do
  [ -d "$d/.git" ] || continue
  U=$(git -C "$d" config --get remote.origin.url 2>/dev/null || echo "")
  case "$U" in *"$REPO_KEY"*) ;; *) continue ;; esac
  CLONES="$CLONES $d"
done

for d in $CLONES; do
  SHORT="${d%/}"

  # A stranded lock silently blocks every index write. The second clone on this
  # Mac carried a 0-byte .git/index.lock from 2026-09-09 for three days; every
  # `git checkout`/`git pull` in it failed, and the clone simply stopped moving.
  for LK in "${d%/}/.git/index.lock" "${d%/}/.git/HEAD.lock"; do
    [ -f "$LK" ] || continue
    AGE_MIN=$(( ( $(date +%s) - $(stat -f %m "$LK" 2>/dev/null || stat -c %Y "$LK" 2>/dev/null || date +%s) ) / 60 ))
    [ "$AGE_MIN" -lt 60 ] && continue      # plausibly a live git process
    FINDINGS="$FINDINGS
  STRANDED LOCK, ${AGE_MIN} minutes old - every index write in this clone fails:
      $LK
      Confirm no git process holds it (lsof \"$LK\"), then remove it."
  done

  if [ "$FETCH" = "1" ]; then
    git -C "$d" fetch -q --no-tags origin main 2>/dev/null || true
  fi

  if ! git -C "$d" rev-parse --verify -q origin/main >/dev/null 2>&1; then
    UNKNOWNS="$UNKNOWNS
  no origin/main ref to compare against: $SHORT"
    continue
  fi

  # Freshness is a property of the CHECKOUT, not of some branch it could have
  # been on. Measure what is actually checked out, which is what an agent reads.
  HEADSHA=$(git -C "$d" rev-parse HEAD 2>/dev/null || echo "")
  if [ -z "$HEADSHA" ]; then
    UNKNOWNS="$UNKNOWNS
  unreadable HEAD: $SHORT"
    continue
  fi
  BRANCH=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  BEHIND=$(git -C "$d" rev-list --count "$HEADSHA..origin/main" 2>/dev/null || echo "")
  AHEAD=$(git -C "$d" rev-list --count "origin/main..$HEADSHA" 2>/dev/null || echo "")
  if [ -z "$BEHIND" ] || [ -z "$AHEAD" ]; then
    UNKNOWNS="$UNKNOWNS
  could not measure distance to origin/main: $SHORT"
    continue
  fi

  AGEDAYS="?"
  CD=$(git -C "$d" log -1 --format=%ct "$HEADSHA" 2>/dev/null || echo "")
  [ -n "$CD" ] && AGEDAYS=$(( ( $(date +%s) - CD ) / 86400 ))

  if [ "$BEHIND" -gt "$MAX_BEHIND" ]; then
    FINDINGS="$FINDINGS
  $BEHIND commits behind origin/main (${AGEDAYS} days old), on '$BRANCH':
      $SHORT
      Agents read this tree and believe it is production."
  fi

  # A clone whose checked-out main is AHEAD of origin/main cannot fast-forward,
  # which is what silently wedged the canonical checkout for six days.
  if [ "$BRANCH" = "main" ] && [ "$AHEAD" -gt 0 ]; then
    FINDINGS="$FINDINGS
  local main is $AHEAD commit(s) ahead of origin/main, so every
  \`git pull --ff-only\` here REFUSES and (run with -q) says nothing:
      $SHORT
      Preserve those commits on a branch or tag before doing anything else:
        git -C $SHORT tag -m rescue rescue/\$(date +%Y-%m-%d) HEAD"
  fi

  # The index residue that made a wedged checkout look busy rather than stuck.
  STAGED=$(git -C "$d" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
  if [ "${STAGED:-0}" -gt 100 ]; then
    FINDINGS="$FINDINGS
  $STAGED paths staged but never committed - an index left behind by an
  interrupted pull, reset or stash. It masks the real state:
      $SHORT"
  fi
done

NCLONES=$(printf '%s' "$CLONES" | wc -w | tr -d ' ')
if [ "$NCLONES" -gt 1 ]; then
  NOTES="$NOTES
  $NCLONES clones of $REPO_KEY on this machine. AGENT-PLAYBOOK 1b allows ONE,
  at ~/Documents/club-arena. Each extra clone is another copy of every doc and
  skill that can go stale independently:
$(for c in $CLONES; do printf '      %s\n' "${c%/}"; done)"
fi

# ── Worktrees: advisory, because ageing is their normal condition ───────────
# A worktree is cut from origin/main at a moment and is expected to fall
# behind while its branch is worked. It is worth COUNTING, because a fleet
# that is mostly ancient is the same hazard at a different scale, and because
# `scripts/prune-stale-worktrees.sh` is the tool that acts on it.
#
# It is SKIPPED in --quiet mode. Counting 389 worktrees costs one `rev-list`
# per tree and about 75 seconds, and `.husky/pre-push` already takes minutes;
# a census that is context for a human must not be latency on every push. The
# clone checks above are the ones that block, and they are two subprocesses.
WT_TOTAL=0; WT_ANCIENT=0
CANON="$HOME/Documents/club-arena"
if [ "$QUIET" != "1" ] && [ -d "$CANON/.git" ] && git -C "$CANON" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  MAINSHA=$(git -C "$CANON" rev-parse origin/main)
  for t in $(git -C "$CANON" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}'); do
    [ -d "$t" ] || continue
    [ "$(cd "$t" 2>/dev/null && pwd -P)" = "$CANON" ] && continue
    H=$(git -C "$t" rev-parse HEAD 2>/dev/null) || continue
    B=$(git -C "$CANON" rev-list --count "$H..$MAINSHA" 2>/dev/null) || continue
    WT_TOTAL=$((WT_TOTAL+1))
    [ "$B" -gt 500 ] && WT_ANCIENT=$((WT_ANCIENT+1))
  done
fi
if [ "$WT_TOTAL" -gt 0 ]; then
  NOTES="$NOTES
  worktrees off the canonical clone: $WT_TOTAL, of which $WT_ANCIENT are more
  than 500 commits behind origin/main. A worktree ageing is normal; a fleet
  this old is not. See scripts/prune-stale-worktrees.sh and
  scripts/agent-trees-audit.sh."
fi

# ── Verdict ─────────────────────────────────────────────────────────────────
if [ -n "$FINDINGS" ]; then
  cat >&2 <<MSG

  ─────────────────────────────────────────────────────────────────────────
  A CHECKOUT ON THIS MACHINE IS NOT WHAT AGENTS THINK IT IS
$FINDINGS
$NOTES

  An agent reading a stale checkout does not get an error. It gets an ANSWER,
  and the answer is about a repository that stopped existing days ago. That is
  how three separate diagnoses came out wrong on 2026-09-12.

  Before you touch anything: inventory local and unpushed work first
  (scripts/check-unpushed-work.sh), preserve it on a branch or tag, and only
  then bring the checkout forward. Never reset over work you have not read.
  ─────────────────────────────────────────────────────────────────────────

MSG
  exit 1
fi

if [ -n "$UNKNOWNS" ]; then
  cat >&2 <<MSG

  ─────────────────────────────────────────────────────────────────────────
  COULD NOT TELL whether this machine's checkouts are current
$UNKNOWNS
$NOTES

  This is not "fresh". The distance to origin/main was not measurable, so
  nothing here has been verified. Restore network or ref access and re-run.
  ─────────────────────────────────────────────────────────────────────────

MSG
  exit 3
fi

if [ "$QUIET" != "1" ]; then
  echo "  every clone of $REPO_KEY on this machine is within $MAX_BEHIND commits of origin/main."
  [ -n "$NOTES" ] && printf '%s\n' "$NOTES"
fi
exit 0
