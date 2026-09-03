#!/usr/bin/env bash
# WHO WATCHES THE GUARDS.
#
# Everything built on 2026-08-22 - the rulesets, the shared-clone guard, the
# reference-transaction hook, the stuck-work report, the publish watchdogs -
# has the same weakness: any of it can be reverted, edited or drift out of sync
# in one repo, and nothing would say so. A ruleset is a few API calls away from
# having no required checks. A guard script is one merge away from being a
# different file in five repos and the original in two.
#
# That is not hypothetical. Every single thing this estate has lost was lost
# because a protection existed somewhere and was not actually in force where it
# mattered: hooks that guarded one machine because they were untracked, an
# Autopilot rolled to seven repos that queued nothing in six, a required check
# that could not be required because the gate behind it was red for an unrelated
# reason.
#
# So this compares all seven repos against each other and against what they are
# supposed to be, hourly, and files one self-closing issue when they diverge.
#
# It asserts SHAPE, not content: that a ruleset still has its rules and no
# unexpected bypass actor, that a guard file is byte-identical everywhere it
# exists, that Autopilot is not failing. It deliberately does not diff the
# guards' text - that is what the pull request review is for. It answers one
# question: is the thing we agreed on still true in every repo.
#
# Env: GH_TOKEN (needs read on all seven repos, including Administration:Read
#      for rulesets), GITHUB_REPOSITORY. Optional GH_TOKEN_ISSUES.
set -uo pipefail

HOME_REPO="${GITHUB_REPOSITORY:?}"
TITLE="Estate integrity: a guard or a ruleset has drifted"

REPOS=(
  Smarter-Poker-Club-Arena
  Smarter-Poker-World-Hub
  smarter-poker-commander
  commander-shared
  smarter-poker-workers
  Smarter-Poker-Diamond-Arena
  PepNationLab
)

# Files that must be byte-identical in every repo that has them. Each is a
# guard the whole estate depends on behaving the same way everywhere.
SHARED_FILES=(
  AGENT-PLAYBOOK.md
  .agents/rules/00-agent-playbook.md
  .github/scripts/report-stuck-prs.sh
  .github/scripts/check-token.sh
  .github/scripts/queue-pr.sh
  .github/workflows/agent-autopilot.yml
  # agent-open-pr.yml joins 2026-09-03. It was already identical in all seven
  # repos by convention; now the check holds it there. The day it drifted it
  # would be one repo quietly force-pushing a `ci-marker/*` branch again, and
  # every push to that branch was a failed Vercel deployment.
  .github/workflows/agent-open-pr.yml
  # orphan-work-watchdog.sh joins 2026-09-03 with the same reasoning: it is
  # the only thing that reports stranded work, and five repos were running a
  # copy that could not see a conflicted pull request.
  .github/scripts/orphan-work-watchdog.sh
  scripts/guard-shared-clone.sh
  scripts/guard-commit-identity.sh
  scripts/check-unpushed-work.sh
  scripts/check-canonical-clone.sh
  scripts/ensure-hooks.sh
  scripts/agent-trees-snapshot.sh
  scripts/agent-trees-audit.sh
  scripts/agent-workspace.sh
  .husky/reference-transaction
)

# World Hub's `main` is written directly by the Club Arena bundle sync, which
# authenticates as GitHub App 4680372. That one bypass actor is the reason the
# branch can be protected at all. Any OTHER bypass actor, in any repo, is
# somebody having quietly turned a gate off.
ALLOWED_BYPASS_APP_ID=4680372

PROBLEMS=()
NOTES=()
add()  { PROBLEMS+=("$1"); }
note() { NOTES+=("$1"); echo "  $1"; }

gh_ro() { gh api "$@" 2>/dev/null; }

echo "estate-integrity: checking ${#REPOS[@]} repos"

# ── 1. Branch protection is still in force ────────────────────────────────
for r in "${REPOS[@]}"; do
  RS=$(gh_ro "repos/Smarter-Poker/$r/rulesets")
  if [ -z "$RS" ]; then
    add "**$r** — could not read its rulesets. Either the token lost \`Administration: Read\`, or the repo is gone. Until this reads, NOTHING here is verified for that repo."
    continue
  fi
  ID=$(printf '%s' "$RS" | jq -r '[.[] | select(.target=="branch")] | .[0].id // empty')
  if [ -z "$ID" ]; then
    add "**$r** — has NO branch ruleset at all. \`main\` is unprotected: it can be force-pushed, deleted, or pushed to directly."
    continue
  fi
  D=$(gh_ro "repos/Smarter-Poker/$r/rulesets/$ID")
  [ -n "$D" ] || { add "**$r** — ruleset \`$ID\` is listed but unreadable."; continue; }

  ENF=$(printf '%s' "$D" | jq -r '.enforcement')
  TYPES=$(printf '%s' "$D" | jq -r '[.rules[].type] | sort | join(",")')
  NCHECKS=$(printf '%s' "$D" | jq -r '[.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[]] | length')
  BYPASS=$(printf '%s' "$D" | jq -c '.bypass_actors')

  [ "$ENF" = "active" ] || add "**$r** — ruleset enforcement is \`$ENF\`, not \`active\`. A ruleset in evaluate mode reports violations and blocks nothing."
  case ",$TYPES," in *,non_fast_forward,*) ;; *) add "**$r** — no \`non_fast_forward\` rule. \`main\` can be rewound, which is how four commits already live in production were dropped on 2026-08-21." ;; esac
  case ",$TYPES," in *,deletion,*)        ;; *) add "**$r** — no \`deletion\` rule. \`main\` can be deleted." ;; esac
  case ",$TYPES," in *,pull_request,*)    ;; *) add "**$r** — no \`pull_request\` rule. Anyone can push straight to \`main\`, and no check has to pass first." ;; esac
  [ "${NCHECKS:-0}" -gt 0 ] || add "**$r** — ZERO required status checks. Autopilot then merges on \`CLEAN\`, which means \"nothing is failing\" — indistinguishable from \"nothing was checked\"."

  # Bypass actors, the quiet way to disable everything above.
  N_BYPASS=$(printf '%s' "$BYPASS" | jq 'length')
  if [ "$N_BYPASS" -gt 0 ]; then
    UNEXPECTED=$(printf '%s' "$BYPASS" | jq -r --argjson app "$ALLOWED_BYPASS_APP_ID" \
      '[.[] | select(.actor_type != "Integration" or .actor_id != $app)] | length')
    if [ "$r" = "Smarter-Poker-World-Hub" ]; then
      [ "$UNEXPECTED" = "0" ] || add "**$r** — has a bypass actor that is not App \`$ALLOWED_BYPASS_APP_ID\`: \`$BYPASS\`. Only the bundle sync may bypass this branch."
    else
      add "**$r** — has $N_BYPASS bypass actor(s): \`$BYPASS\`. No repo except World Hub should have any, and World Hub's is only the bundle-sync App."
    fi
  fi
  note "$r: enforcement=$ENF rules=[$TYPES] checks=$NCHECKS bypass=$N_BYPASS"
done

# ── 2. The shared guards are the same file everywhere ─────────────────────
for f in "${SHARED_FILES[@]}"; do
  DIGESTS=""
  PRESENT=0
  MISSING=""
  for r in "${REPOS[@]}"; do
    C=$(gh_ro "repos/Smarter-Poker/$r/contents/$f" --jq '.content')
    if [ -z "$C" ]; then MISSING="$MISSING $r"; continue; fi
    PRESENT=$((PRESENT + 1))
    D=$(printf '%s' "$C" | base64 -d 2>/dev/null | shasum -a256 | cut -c1-12)
    DIGESTS="$DIGESTS$D $r"$'\n'
  done
  UNIQ=$(printf '%s' "$DIGESTS" | awk 'NF{print $1}' | sort -u | wc -l | tr -d ' ')
  if [ "$PRESENT" -eq 0 ]; then
    add "\`$f\` — **missing from every repo**. A guard nobody has is a guard nobody runs."
  elif [ -n "$MISSING" ]; then
    add "\`$f\` — missing from:$MISSING. It exists in $PRESENT of ${#REPOS[@]} repos, so the estate is not protected the same way everywhere."
  elif [ "$UNIQ" -gt 1 ]; then
    VARIANTS=$(printf '%s' "$DIGESTS" | awk 'NF{print "    " $1 "  " $2}')
    add "\`$f\` — **$UNIQ different versions** across the estate. These are supposed to be byte-identical; a fix applied in one repo and not the others is how a guard becomes true in theory only.
$VARIANTS"
  else
    note "$f: identical in all $PRESENT"
  fi
done

# ── 3. Autopilot is alive ─────────────────────────────────────────────────
for r in "${REPOS[@]}"; do
  C=$(gh run list --repo "Smarter-Poker/$r" --workflow agent-autopilot.yml --limit 1 \
        --json conclusion,status --jq '"\(.[0].status)/\(.[0].conclusion // "-")"' 2>/dev/null || echo "")
  case "$C" in
    ""|"null/-")   add "**$r** — Agent Autopilot has never run. Nothing in that repo auto-merges, so every pull request waits for a human." ;;
    completed/failure|completed/timed_out)
                   add "**$r** — Agent Autopilot's last run is \`$C\`. While it is red, pull requests stop being queued and the failure is silent from the outside." ;;
    *)             note "$r: autopilot $C" ;;
  esac
done

# ── 4. Every hook is executable, so git will actually run it ──────────────
#
# 2026-08-23. This check exists because the entire hook layer was inert and
# nothing anywhere said so. Two silent faults:
#
#   core.hooksPath pointed at `.husky/_` in Club Arena - GITIGNORED, generated
#   by husky during npm install. A git worktree has no node_modules, so it was
#   never generated there: 38 of 47 agent trees ran NO hooks at all.
#
#   `.husky/pre-commit` was tracked mode 644 in Club Arena AND World Hub. git
#   SKIPS a non-executable hook and says so only as a hint buried in commit
#   output. So even in the main clones, pre-commit never ran - which meant the
#   one-worktree-per-agent guard and World Hub's merge-conflict-marker check,
#   both written after real incidents, were decorative for months.
#
# The mode is a property of the TREE, so it is checkable from here, remotely,
# for every repo at once. A hook committed 644 is a hook that will be skipped
# in every clone and every worktree made from that commit, forever.
for r in "${REPOS[@]}"; do
  TREE=$(gh_ro "repos/Smarter-Poker/$r/git/trees/main?recursive=1" \
           --jq '.tree[]? | select(.type=="blob") | select(.path|startswith(".husky/") or startswith(".githooks/")) | "\(.mode) \(.path)"')
  [ -z "$TREE" ] && { note "$r: no hook directory"; continue; }
  BAD=$(printf '%s\n' "$TREE" | awk '$1!="100755" && $2 !~ /\.(md|txt)$/ {print "    " $2 "  mode " substr($1,4)}')
  if [ -n "$BAD" ]; then
    add "**$r** — hook file(s) committed non-executable. git skips these WITHOUT failing, so they are guards in name only in every clone and worktree made from this commit:
$BAD
  Fix in that repo with \`bash scripts/ensure-hooks.sh\`, which also repoints core.hooksPath at the tracked hook directory."
  else
    note "$r: all $(printf '%s\n' "$TREE" | grep -c .) hook file(s) executable"
  fi
done

# ── Report ────────────────────────────────────────────────────────────────
find_issue() {
  GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" \
  gh issue list --repo "$HOME_REPO" --state open --limit 100 --json number,title \
    --jq "[.[] | select(.title == \"$1\")] | .[0].number // empty" 2>/dev/null
}
gh_write() {
  local what="$1"; shift; local out
  if out=$(GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" gh "$@" 2>&1); then echo "  $what"; return 0; fi
  echo "::error::estate-integrity could not $what -- the finding is real but nobody was told."
  printf '%s\n' "$out" | sed 's/^/    /'; return 1
}

EXISTING=$(find_issue "$TITLE")
echo
echo "estate-integrity: ${#PROBLEMS[@]} problem(s)."

{
  echo "### Estate integrity"
  echo ""
  if [ "${#PROBLEMS[@]}" -eq 0 ]; then
    echo "All ${#REPOS[@]} repos agree."
  else
    printf '%s\n' "${PROBLEMS[@]}" | sed 's/^/- /'
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null

if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  echo "OK — every repo has its ruleset, every shared guard is byte-identical, Autopilot is alive."
  if [ -n "${EXISTING:-}" ]; then
    gh_write "comment on #$EXISTING" issue comment "$EXISTING" --repo "$HOME_REPO" \
      --body "Recovered. All ${#REPOS[@]} repos agree again: rulesets intact, shared guards byte-identical, Autopilot alive." || true
    gh_write "close #$EXISTING" issue close "$EXISTING" --repo "$HOME_REPO" || true
  fi
  exit 0
fi

BODY="Something that is supposed to be true in all ${#REPOS[@]} repos is not.

$(printf '%s\n' "${PROBLEMS[@]}" | sed 's/^/- /')

---

Every loss this estate has taken came from a protection that existed somewhere and was not actually in force where it mattered: hooks that guarded one machine because they were untracked; an Autopilot rolled to seven repos that queued nothing in six; a required check that could not be required because the gate behind it was red for an unrelated reason.

A drifted guard reads as protection and is not. That is worse than no guard, because nobody goes looking.

**Fix by making the repos agree again, not by relaxing the check.** If a difference is deliberate, the guard belongs in this script's expectations — edit \`.github/scripts/estate-integrity.sh\` and say why in the commit, so the next person inherits the reason rather than the exception.

_Raised automatically by \`.github/workflows/estate-integrity.yml\`, hourly. It closes itself when the estate agrees again._"

if [ -n "${EXISTING:-}" ]; then
  gh_write "update issue #$EXISTING" issue edit "$EXISTING" --repo "$HOME_REPO" --body "$BODY" || true
else
  gh_write "open an issue" issue create --repo "$HOME_REPO" --title "$TITLE" --body "$BODY" || true
fi
exit 1
