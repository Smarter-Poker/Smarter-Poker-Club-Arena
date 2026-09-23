#!/usr/bin/env bash
# WHO WATCHES THE GUARDS.
#
# Everything built on 2026-08-22 - the rulesets, the shared-clone guard, the
# reference-transaction hook, and the event-driven proposal/merge chain -
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
# supposed to be and files one self-closing issue when they diverge.
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

# An agent temporarily added this synthetic check to Club Arena without user
# authorization on 2026-09-11. It is not a CI job and can deadlock every PR.
# Keep the exact context globally forbidden; this audit is read-only and raises
# the existing integrity alarm if any repository ruleset ever contains it.
FORBIDDEN_REQUIRED_CONTEXT='Stage B Release Freeze'

# Files that must be byte-identical in every repo that has them. Each is a
# guard the whole estate depends on behaving the same way everywhere.
SHARED_FILES=(
  AGENT-PLAYBOOK.md
  .agents/rules/00-agent-playbook.md
  .github/scripts/check-token.sh
  .github/scripts/queue-pr.sh
  .github/workflows/agent-autopilot.yml
  .github/workflows/agent-open-pr.yml
  scripts/guard-shared-clone.sh
  scripts/guard-commit-identity.sh
  scripts/check-unpushed-work.sh
  scripts/check-canonical-clone.sh
  scripts/ensure-hooks.sh
  scripts/agent-trees-audit.sh
  scripts/agent-workspace.sh
  .husky/reference-transaction
)

# NO REPO MAY HAVE A BYPASS ACTOR (2026-09-06).
#
# This used to read: "World Hub's `main` is written directly by the Club Arena
# bundle sync, which authenticates as GitHub App 4680372. That one bypass actor
# is the reason the branch can be protected at all."
#
# True when written on 2026-08-22. THE BUNDLE SYNC WAS DELETED ON 2026-09-03.
# Club Arena publishes to its own origin now and commits nothing here;
# `public/hub/club-arena/` is gone from World Hub `main` and
# `tests/club-arena-is-a-rewrite.test.mjs` fails CI if it returns. Verified
# 2026-09-06: the directory is absent and the law is present.
#
# The writer the exemption was carved for no longer writes. What App 4680372
# still does is squash-merge pull requests, which needs no bypass - Club Arena
# runs the same app against an EMPTY bypass list every day.
#
# It matters even though nothing abuses it. `queue-pr.sh` merges directly only
# on CLEAN, never UNSTABLE, and that care is why nothing has gone wrong - but
# it means the guarantee lives in a shell script's `case` rather than in GitHub
# refusing. With no bypass actor the refusal is structural.
#
# Remove any unexpected bypass through a separately reviewed administration
# change. The audit never mutates a ruleset itself.

# sha256 of the empty string, truncated the same way the digests below are.
EMPTY_SHA12='e3b0c44298fc'

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

  FORBIDDEN_RULESETS=""
  PERM_BLIND=""
  D=""
  while IFS= read -r RULESET_ID; do
    [ -n "$RULESET_ID" ] || continue
    RULESET_DETAIL=""
    if ! RULESET_DETAIL=$(gh_ro "repos/Smarter-Poker/$r/rulesets/$RULESET_ID"); then
      add "**$r** — branch ruleset \`$RULESET_ID\` is listed but unreadable, so its required contexts are unverified."
      continue
    fi
    if [ -z "$RULESET_DETAIL" ]; then
      add "**$r**: branch ruleset \`$RULESET_ID\` returned an empty body, so its required contexts are unverified."
      continue
    fi
    # WHICH field is wrong, not merely that one is.
    #
    # 2026-09-19. This check reported "returned an empty or malformed detail"
    # for all eight branch rulesets in the estate, every run, from 2026-09-09
    # to 2026-09-19, and nobody could act on it, because one message stood for
    # an unreadable body, a wrong id, a changed API shape and a permission the
    # token no longer holds. Those are four different repairs.
    #
    # The one it actually was is the last. GitHub returns a WELL FORMED ruleset
    # to a caller without Administration: Read, with `rules` and `bypass_actors`
    # simply absent. That is a COULD NOT ASK, and calling it drift is how an
    # audit teaches people to stop reading it. Meanwhile the thing it could not
    # see was real: World Hub's main ruleset read bypass=0 on 2026-09-08 and
    # carries an Integration bypass actor with mode `always` today.
    if ! MISSING=$(printf '%s' "$RULESET_DETAIL" | jq -r --arg ruleset_id "$RULESET_ID" '
          if type != "object" then "not-an-object"
          else [ (if (.id | tostring) != $ruleset_id then "id" else empty end),
                 (if .target != "branch"                then "target" else empty end),
                 (if (.enforcement | type) != "string"  then "enforcement" else empty end),
                 (if (.bypass_actors | type) != "array" then "bypass_actors" else empty end),
                 (if (.rules | type) != "array"         then "rules" else empty end)
               ] | join(" ")
          end' 2>/dev/null); then
      add "**$r**: branch ruleset \`$RULESET_ID\` did not come back as JSON, so its required contexts are unverified."
      continue
    fi
    case "$MISSING" in
      "") ;;
      "bypass_actors"|"rules"|"bypass_actors rules")
        # Exactly the shape a non-admin caller gets. Reported once per repo,
        # below, rather than once per ruleset.
        PERM_BLIND="$PERM_BLIND $RULESET_ID"
        continue
        ;;
      *)
        add "**$r**: branch ruleset \`$RULESET_ID\` came back with \`$MISSING\` wrong or absent, so its required contexts are unverified. That is a malformed answer rather than a permission: read it with \`gh api repos/Smarter-Poker/$r/rulesets/$RULESET_ID\`."
        continue
        ;;
    esac
    [ "$RULESET_ID" = "$ID" ] && D="$RULESET_DETAIL"
    if printf '%s' "$RULESET_DETAIL" | jq -e --arg context "$FORBIDDEN_REQUIRED_CONTEXT" \
      '[.rules[]? | select(.type=="required_status_checks") | .parameters.required_status_checks[]?.context] | index($context) != null' \
      >/dev/null 2>&1; then
      FORBIDDEN_RULESETS="$FORBIDDEN_RULESETS $RULESET_ID"
    fi
  done < <(printf '%s' "$RS" | jq -r '.[] | select(.target=="branch") | .id')
  if [ -n "$PERM_BLIND" ]; then
    add "**$r**: the audit token cannot see \`rules\` or \`bypass_actors\` on branch ruleset(s):\`$PERM_BLIND\`. GitHub hands a caller WITHOUT \`Administration: Read\` a well formed ruleset with exactly those two fields absent, so enforcement, required checks and bypass actors are all unverified for this repo. This read worked on 2026-09-08 and has not since. Grant the audit App named by \`app-id\` in .github/workflows/estate-integrity.yml \`Administration: Read\`; do not widen this audit to guess."
    continue
  fi
  if [ -n "$FORBIDDEN_RULESETS" ]; then
    add "**$r** — unauthorized required context \`$FORBIDDEN_REQUIRED_CONTEXT\` exists in ruleset(s):\`$FORBIDDEN_RULESETS\`. Remove it; synthetic release freezes are forbidden."
  fi

  # The primary ruleset was validated in the all-ruleset pass above. Reusing
  # that exact document avoids a second API read disagreeing with the verdict.
  [ -n "$D" ] || continue

  ENF=$(printf '%s' "$D" | jq -r '.enforcement')
  TYPES=$(printf '%s' "$D" | jq -r '[.rules[].type] | sort | join(",")')
  NCHECKS=$(printf '%s' "$D" | jq -r '[.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[]] | length')
  BYPASS=$(printf '%s' "$D" | jq -c '.bypass_actors')

  [ "$ENF" = "active" ] || add "**$r** — ruleset enforcement is \`$ENF\`, not \`active\`. A ruleset in evaluate mode reports violations and blocks nothing."
  case ",$TYPES," in *,non_fast_forward,*) ;; *) add "**$r** — no \`non_fast_forward\` rule. \`main\` can be rewound, which is how four commits already live in production were dropped on 2026-08-21." ;; esac
  case ",$TYPES," in *,deletion,*)        ;; *) add "**$r** — no \`deletion\` rule. \`main\` can be deleted." ;; esac
  case ",$TYPES," in *,pull_request,*)    ;; *) add "**$r** — no \`pull_request\` rule. Anyone can push straight to \`main\`, and no check has to pass first." ;; esac
  [ "${NCHECKS:-0}" -gt 0 ] || add "**$r** — ZERO required status checks. Autopilot then merges on \`CLEAN\`, which means \"nothing is failing\" — indistinguishable from \"nothing was checked\"."

  # Bypass actors are the quiet way to disable everything above.
  N_BYPASS=$(printf '%s' "$BYPASS" | jq 'length')
  if [ "$N_BYPASS" -gt 0 ]; then
    add "**$r** — has $N_BYPASS bypass actor(s): \`$BYPASS\`. No repo may have any. Remove it through a separately reviewed administration change; do not teach this audit to repair its own finding."
  fi
  note "$r: enforcement=$ENF rules=[$TYPES] checks=$NCHECKS bypass=$N_BYPASS"
done

# ── 2. The shared guards are the same file everywhere ─────────────────────
# WHICH REPO IS AHEAD, AND WHICH ARE BEHIND (2026-09-22).
#
# Until today this reported "N different versions" and listed a digest per
# repo. That is the finding, but it is not the repair, and nobody could get
# from one to the other: a digest does not say whether Club Arena drifted or
# the other six are simply carrying last month's copy. Issue #3931 sat open
# with eleven such files - measured today, Club Arena held the NEWEST copy of
# nine of them and the STALEST of two - and no reader could tell those two
# cases apart, so nobody acted on either.
#
# So each variant now carries the date of the last commit that touched that
# path in that repo, and the newest one is named. That is strictly more
# information: nothing that blocked before stops blocking, and a drift is
# still a drift whichever way it points. It turns "eleven files disagree"
# into "copy repo X's 2026-09-19 version into these five", which is a repair
# somebody can carry out.
#
# The date is a WEAKER signal than the content and is labelled as such: a repo
# can commit an older file later. It orders the variants; it does not certify
# one. The rule remains "make the repos agree again", not "take the newest".
for f in "${SHARED_FILES[@]}"; do
  DIGESTS=""
  PRESENT=0
  MISSING=""
  for r in "${REPOS[@]}"; do
    C=$(gh_ro "repos/Smarter-Poker/$r/contents/$f" --jq '.content')
    if [ -z "$C" ]; then MISSING="$MISSING $r"; continue; fi
    PRESENT=$((PRESENT + 1))
    D=$(printf '%s' "$C" | base64 -d 2>/dev/null | shasum -a256 | cut -c1-12)
    # A date this cannot read is reported as `unknown`, never as an old one:
    # an unreadable date must not make a current repo look stale (10.86 r2).
    WHEN=$(gh_ro "repos/Smarter-Poker/$r/commits?path=$f&per_page=1" --jq '.[0].commit.committer.date // empty')
    DIGESTS="$DIGESTS$D ${WHEN:-unknown} $r"$'\n'
    # AN EMPTY FILE IS NOT A VERSION (2026-09-22). `e3b0c442...` is the sha256
    # of nothing at all, and on this date two of Diamond-Arena's workflow files
    # held it. Reported as "a different version" that reads as a drifted copy
    # worth diffing; it is a zero-byte file, so that workflow does not exist
    # and nothing in that repo queues or opens a pull request. Same bytes,
    # completely different repair, so it gets its own sentence.
    if [ "$D" = "$EMPTY_SHA12" ]; then
      add "\`$f\` in **$r** is a ZERO-BYTE FILE. Not a drifted copy - there is nothing in it. Whatever it is supposed to do is not happening in that repo, and a digest comparison alone reads this as an ordinary difference."
    fi
  done
  UNIQ=$(printf '%s' "$DIGESTS" | awk 'NF{print $1}' | sort -u | wc -l | tr -d ' ')
  if [ "$PRESENT" -eq 0 ]; then
    add "\`$f\` — **missing from every repo**. A guard nobody has is a guard nobody runs."
  elif [ -n "$MISSING" ]; then
    add "\`$f\` — missing from:$MISSING. It exists in $PRESENT of ${#REPOS[@]} repos, so the estate is not protected the same way everywhere."
  elif [ "$UNIQ" -gt 1 ]; then
    # The repo whose copy was committed most recently. Ties and unknowns keep
    # the first entry, so the line is deterministic rather than empty.
    NEWEST=$(printf '%s' "$DIGESTS" | awk 'NF && $2 != "unknown"' | sort -k2,2r | head -1)
    NEWEST_REPO=$(printf '%s' "$NEWEST" | awk '{print $3}')
    NEWEST_WHEN=$(printf '%s' "$NEWEST" | awk '{print $2}')
    NEWEST_D=$(printf '%s' "$NEWEST" | awk '{print $1}')
    if [ -n "$NEWEST_REPO" ]; then
      BEHIND=$(printf '%s' "$DIGESTS" | awk -v d="$NEWEST_D" 'NF && $1 != d {printf "%s ", $3}')
      LEAD="Most recently committed: **$NEWEST_REPO** ($NEWEST_WHEN, \`$NEWEST_D\`). Carrying something else: $BEHIND"
    else
      LEAD="Could not read a commit date for any variant, so this cannot say which is newest. Compare them by hand."
    fi
    VARIANTS=$(printf '%s' "$DIGESTS" | awk 'NF{printf "    %s  %-22s %s\n", $1, $2, $3}')
    add "\`$f\` — **$UNIQ different versions** across the estate. These are supposed to be byte-identical; a fix applied in one repo and not the others is how a guard becomes true in theory only.
$VARIANTS
  $LEAD
  The date orders the variants, it does not certify one: a repo can commit an older file later. Make them agree; do not assume the newest is right."
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

# ── 4. Shared file modes are part of the contract ─────────────────────────
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
  DEFAULT_BRANCH=$(gh_ro "repos/Smarter-Poker/$r" --jq '.default_branch')
  [ -n "$DEFAULT_BRANCH" ] || { add "**$r** — could not resolve its default branch, so file modes are unverified."; continue; }
  TREE_JSON=$(gh_ro "repos/Smarter-Poker/$r/git/trees/$DEFAULT_BRANCH?recursive=1")
  [ -n "$TREE_JSON" ] || { add "**$r** — could not read its default-branch tree, so file modes are unverified."; continue; }

  BAD=""
  for f in "${SHARED_FILES[@]}"; do
    MODE=$(printf '%s' "$TREE_JSON" | jq -r --arg f "$f" '.tree[]? | select(.type=="blob" and .path==$f) | .mode' | head -1)
    [ -n "$MODE" ] || continue
    case "$f" in
      *.sh|.husky/*|.githooks/*) EXPECTED=100755 ;;
      *)                         EXPECTED=100644 ;;
    esac
    [ "$MODE" = "$EXPECTED" ] || BAD="$BAD
    $f  mode $MODE, expected $EXPECTED"
  done

  HOOK_BAD=$(printf '%s' "$TREE_JSON" | jq -r '.tree[]? | select(.type=="blob") | select(.path|startswith(".husky/") or startswith(".githooks/")) | "\(.mode) \(.path)"' \
    | awk '$1!="100755" && $2 !~ /\.(md|txt)$/ {print "    " $2 "  mode " $1 ", expected 100755"}')
  [ -z "$HOOK_BAD" ] || BAD="$BAD
$HOOK_BAD"
  if [ -n "$BAD" ]; then
    add "**$r** — shared file mode mismatch. Executable guards are skipped when committed 100644, while docs/workflows must not masquerade as executables:
$BAD
  Fix in that repo with \`bash scripts/ensure-hooks.sh\`, which also repoints core.hooksPath at the tracked hook directory."
  else
    note "$r: shared file and hook modes match the contract"
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

_Raised automatically by \`.github/workflows/estate-integrity.yml\`. It closes itself when the estate agrees again._"

if [ -n "${EXISTING:-}" ]; then
  gh_write "update issue #$EXISTING" issue edit "$EXISTING" --repo "$HOME_REPO" --body "$BODY" || true
else
  gh_write "open an issue" issue create --repo "$HOME_REPO" --title "$TITLE" --body "$BODY" || true
fi
exit 1
