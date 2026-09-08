#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# guard-merged-branch.sh — a push onto a branch whose pull request already
# merged is work that VANISHES, and git reports it as success.
#
# ── WHAT HAPPENED, 2026-09-06 ────────────────────────────────────────────────
#
# Three commits were pushed to `chore/public-sheds-its-dead-weight` in the World
# Hub. One of them reached `main`.
#
#   1. commit 1 pushed          -> agent-open-pr.yml opens PR #1387
#   2. required checks go green -> agent-autopilot.yml squash-merges it,
#                                  at head 93033afb1, `commits: 1`
#   3. commits 2 and 3 pushed   -> the branch updates, the PR is CLOSED,
#                                  nothing merges, nothing complains
#
# `git push` exited 0. The pull request read "Merged". The branch on GitHub
# genuinely contained all three commits. Every signal an agent normally checks
# said the work had landed, and two commits - a CI fix for a gate that had been
# red on main for two days, and the deletion of a component that fabricated
# player data - simply were not there.
#
# It was found only by asking whether the FILES were on main. That is the habit
# CLAUDE.md 1.4/1.5 already demands for deploys ("only production serving the
# sha counts"), and it turns out to apply to merges too.
#
# ── WHY IT IS EASY TO HIT ────────────────────────────────────────────────────
#
# Autopilot merges the moment the required checks pass, which on a docs-heavy
# or asset-only change can be under two minutes. Any agent that pushes, keeps
# working, and pushes again - the normal shape of a session - is racing it. The
# faster CI gets, the more often this fires.
#
# ── WHAT THIS DOES ───────────────────────────────────────────────────────────
#
# Before the push, ask GitHub what happened to the pull request for this
# branch. If it is MERGED or CLOSED, refuse, and say exactly what to do
# instead: a new branch. Nothing is lost and nothing is force-pushed.
#
# FAILS OPEN, deliberately. No token, no network, an API error, an unexpected
# response - all of them warn and allow. A hook that blocks work when GitHub is
# unreachable is a worse bug than the one it prevents. It only ever refuses on
# a definite, positive answer.
#
# Bypass, when you genuinely mean to add to a merged branch (a backup ref, say):
#   AGENT_MERGED_BRANCH_OK=1 git push ...
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

[ "${AGENT_MERGED_BRANCH_OK:-}" = "1" ] && exit 0
[ -n "${CI:-}" ] && exit 0

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
[ -z "$BRANCH" ] && exit 0
[ "$BRANCH" = "HEAD" ] && exit 0          # detached; nothing to look up
[ "$BRANCH" = "main" ] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$ROOT" ] && exit 0

# The repo to ask about, taken from the remote rather than assumed.
# Pure shell rather than sed: BSD sed (macOS) rejects the non-greedy form, and
# this hook has to work on the machine it actually runs on.
ORIGIN="$(git config --get remote.origin.url 2>/dev/null || true)"
case "$ORIGIN" in
  *Smarter-Poker/*) ;;
  *) exit 0 ;;
esac
REPO="${ORIGIN##*/}"        # Smarter-Poker-World-Hub.git
REPO="${REPO%.git}"         # Smarter-Poker-World-Hub
[ -z "$REPO" ] && exit 0
SLUG="Smarter-Poker/$REPO"

# Token: `gh` first (it is not installed on this Mac, but a CI box may have it),
# then .env.
#
# THE .env IS NOT IN THE WORKTREE. Every agent works in `git worktree add`
# checkouts under .agent-trees/, and .env is gitignored, so it exists ONLY in
# the primary clone. Looking at `--show-toplevel` finds nothing and the guard
# silently fails open - which is exactly how the first version of this file did
# nothing at all. `--git-common-dir` points at the primary clone's .git for
# every linked worktree, so its parent is the one directory guaranteed to have
# the .env.
# THE KEY IS NOT CALLED THE SAME THING IN BOTH REPOS (found 2026-09-06, the
# hard way). Club Arena's .env has GITHUB_TOKEN; the World Hub's has
# GITHUB_PAT_FINE_GRAINED and no GITHUB_TOKEN at all. The first version of this
# guard looked for one name, found nothing in the World Hub, and failed open on
# every single push - installed, running, and silent. It let a second lost-commit
# incident through within the hour, which is how it was noticed.
#
# So try every name either repo actually uses, and the environment first.
read_key() {
  [ -f "$1" ] || return 1
  line="$(grep -m1 "^${2}=" "$1" 2>/dev/null || true)"
  [ -n "$line" ] || return 1
  line="${line#${2}=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  line="${line%% *}"
  [ -n "$line" ] || return 1
  printf '%s' "$line"
}

# CANDIDATE tokens, plural, and each is TRIED rather than trusted. Stopping at
# the first one found is what broke this: the World Hub's .env yields
# GITHUB_PAT_FINE_GRAINED, that PAT has expired and answers "Bad credentials",
# and the working GITHUB_TOKEN sits in the sibling clone which was never
# reached. A guard that stops at the first plausible key is a guard that is
# inert whenever the first key is stale.
CANDIDATES=""
add_candidate() { [ -n "$1" ] && CANDIDATES="$CANDIDATES $1"; }

add_candidate "${GITHUB_TOKEN:-}"
add_candidate "${GH_TOKEN:-}"
add_candidate "$(gh auth token 2>/dev/null || true)"

COMMON="$(git rev-parse --git-common-dir 2>/dev/null || true)"
case "$COMMON" in /*) ;; *) COMMON="$ROOT/$COMMON" ;; esac
PRIMARY="$(cd "$(dirname "$COMMON")" 2>/dev/null && pwd || true)"
ESTATE="$(dirname "$PRIMARY")"
for CANDIDATE_FILE in "$ROOT/.env" "$PRIMARY/.env" \
                      "$ESTATE/club-arena/.env" \
                      "$ESTATE/Smarter-Poker-World-Hub/.env"; do
  [ -f "$CANDIDATE_FILE" ] || continue
  for KEY in GITHUB_TOKEN GH_TOKEN GITHUB_PAT_FINE_GRAINED GITHUB_PAT; do
    add_candidate "$(read_key "$CANDIDATE_FILE" "$KEY" || true)"
  done
done

[ -z "$CANDIDATES" ] && exit 0            # fail open: no token, no opinion

RESP=""
AUTH_FAILED=0
for TOKEN in $CANDIDATES; do
  TRY="$(curl -sS --max-time 12 \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$SLUG/pulls?head=Smarter-Poker:$BRANCH&state=all&per_page=10" 2>/dev/null || true)"
  [ -z "$TRY" ] && continue               # no network for this attempt
  case "$TRY" in
    *'"Bad credentials"'*|*'"Requires authentication"'*)
      AUTH_FAILED=1
      continue ;;                         # stale key: try the next candidate
  esac
  RESP="$TRY"
  break
done

if [ -z "$RESP" ]; then
  # Every candidate failed. Allow the push - this must never block on GitHub
  # being unreachable - but SAY SO, because inert-but-installed is the exact
  # state this guard exists to prevent, and a silent one teaches nobody.
  if [ "$AUTH_FAILED" = "1" ]; then
    echo ""
    echo "  WARNING: guard-merged-branch could not authenticate to GitHub."
    echo "  Every token it found was rejected, so the merged-branch check is"
    echo "  NOT running. Your push is allowed. Nothing is checking whether this"
    echo "  branch's pull request already merged - see CLAUDE.md on why that"
    echo "  loses commits while git reports success."
    echo "  Fix: put a working GITHUB_TOKEN in the primary clone's .env."
    echo ""
  fi
  exit 0
fi

VERDICT="$(printf '%s' "$RESP" | python3 -c '
import json, sys
try:
    prs = json.load(sys.stdin)
except Exception:
    sys.exit(0)                      # unparseable -> fail open
if not isinstance(prs, list) or not prs:
    sys.exit(0)                      # no PR yet -> nothing to say
# Newest first; the one that decides is the most recent.
prs.sort(key=lambda p: p.get("number", 0), reverse=True)
p = prs[0]
if p.get("merged_at"):
    print("MERGED %s %s" % (p["number"], (p.get("merge_commit_sha") or "")[:9]))
elif p.get("state") == "closed":
    print("CLOSED %s" % p["number"])
' 2>/dev/null || true)"

[ -z "$VERDICT" ] && exit 0

STATE="${VERDICT%% *}"
REST="${VERDICT#* }"
PR="${REST%% *}"

echo ""
echo "  ┌─────────────────────────────────────────────────────────────────────┐"
if [ "$STATE" = "MERGED" ]; then
  echo "  │  REFUSED: pull request #$PR for this branch is ALREADY MERGED.      "
else
  echo "  │  REFUSED: pull request #$PR for this branch is CLOSED.              "
fi
echo "  └─────────────────────────────────────────────────────────────────────┘"
echo ""
echo "  Branch: $BRANCH   (this is HEAD - see the note below)"
echo ""
echo "  == IS THIS A FALSE ALARM? IT IS, IF YOU ARE PUSHING A DIFFERENT REF =="
echo ""
echo "  THIS CHECK READS HEAD, NOT WHAT YOU ARE PUSHING. git sends the actual"
echo "  refspec on stdin, and this script cannot read it: .husky/pre-push"
echo "  consumes that same stdin later, in the loop that decides which tests to"
echo "  run, and stdin can only be read once. Reading it here would silently"
echo "  starve that loop - a worse bug than this one, and a quieter one."
echo ""
echo "  So if you ran something like"
echo ""
echo "      git push origin <sha>:refs/heads/<a-brand-new-branch>"
echo ""
echo "  from a worktree that happens to sit on an old merged branch, NOTHING IS"
echo "  WRONG: your target ref is new and this warning is about a branch you are"
echo "  not touching. Set AGENT_MERGED_BRANCH_OK=1 and push. That is the correct"
echo "  use of the override, not a way around a real refusal."
echo ""
echo "  (The real fix is for pre-push to read stdin once at the top and pass the"
echo "   refspec down. It needs care: piping the existing loop through a"
echo "   subshell would break its FAIL propagation and every gate below it."
echo "   Recorded in docs/DIAMOND-ACCOUNTING-ROADMAP.md as owed work.)"
echo ""
echo "  == IF YOU ARE GENUINELY PUSHING THIS SAME BRANCH AGAIN, READ ON =="
echo ""
echo "  This push would SUCCEED and change nothing. The branch would move, the"
echo "  pull request would stay $( [ "$STATE" = MERGED ] && echo merged || echo closed ), and your commits would reach no one."
echo "  git would report success, which is why this is worth stopping for."
echo ""
echo "  It has happened: World Hub #1387 squash-merged at commit 1 of 3 the"
echo "  moment its required checks went green. The two later commits were"
echo "  pushed to this exact state and were lost for hours."
echo ""
echo "  DO THIS INSTEAD - a new branch off current main, carrying your work:"
echo ""
echo "      git fetch origin main"
echo "      git checkout -b <new-slug> origin/main"
echo "      git cherry-pick <your commits>      # or re-apply them"
echo "      git push origin HEAD:refs/heads/<new-slug>"
echo ""
echo "  If you really mean to move a merged branch (a backup ref, say):"
echo ""
echo "      AGENT_MERGED_BRANCH_OK=1 git push ..."
echo ""
exit 1
