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
  ${ESTATE_INJECT_REPO:+"$ESTATE_INJECT_REPO"}
  smarter-poker-workers
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
# Until 2026-09-22 this reported "N different versions" and listed a digest per
# repo. That is the finding, but it is not the repair, and nobody could get
# from one to the other: a digest does not say whether Club Arena drifted or
# the other six are simply carrying last month's copy. Issue #3931 sat open
# with eleven such files - Club Arena held the NEWEST copy of nine of them and
# a DIFFERENT copy of two - and no reader could tell those two cases apart, so
# nobody acted on either.
#
# So each variant now carries the date of the last commit that touched that
# path in that repo, and the newest one is named. That is strictly more
# information: nothing that blocked before stops blocking, and a drift is
# still a drift whichever way it points.
#
# The date is a WEAKER signal than the content and is labelled as such: a repo
# can commit an older file later. It orders the variants; it does not certify
# one. The rule remains "make the repos agree again", not "take the newest".
#
# FOUR OUTCOMES, NOT ONE (2026-09-23). CLAUDE.md 10.86 rules 1 and 2.
#
# `gh api .../contents/<path> --jq .content` does NOT go quiet on a 404. It
# exits 1 and prints the ERROR BODY on stdout:
#
#   {"message":"Not Found","documentation_url":"...","status":"404"}
#
# The previous code tested only `[ -z "$C" ]`, so that 127-byte error counted
# as a PRESENT file, `base64 -d` refused it and wrote nothing, and the digest
# came out `e3b0c442...`, the sha256 of the empty string. The audit then
# announced "is a ZERO-BYTE FILE" about a path that does not exist at all.
#
# Measured 2026-09-23: both of Diamond-Arena's reported zero-byte workflows
# were DELETED, deliberately, by that repo's own PR #64 (d70fcbcd1928,
# 2026-09-18), which in the same commit added tests/deployment-controls.test.mjs
# there to keep them retired. Restoring them would turn that repo's own test
# red. "Deleted on purpose", "emptied by accident" and "could not ask" are
# three different facts, with three different owners and three different
# repairs, and they had one name between them.
#
# Worse, the absent sentinel then joined the "most recently committed" ranking
# and WON it for agent-open-pr.yml, because `commits?path=` still returns a
# date for a deleted path: the date of the deletion. The report therefore told
# every reader that the newest authoritative copy of the estate's pull-request
# opener was nothing at all, and named the six repos that do have a working one
# as "carrying something else". Nothing that reads only digests can catch that.
#
# So: present, empty, absent and unreadable are four separate outcomes; only a
# real byte-carrying variant with a readable date may be ranked; and a
# deliberate difference is RECORDED below with its reason, exactly as the issue
# body instructs, so it is visible on every run instead of being re-raised for
# ever until people stop reading the report (10.83).

# DELIBERATE, OWNER-MERGED ABSENCES. A recorded path is expected NOT to exist
# in that repo. If it comes back, that IS a finding, because the record says it
# should be gone - the exemption cannot quietly become cover for a revert.
RETIRED_PATHS=(
  ${ESTATE_INJECT_RETIRED_PATH1:+"$ESTATE_INJECT_RETIRED_PATH1"}
  ${ESTATE_INJECT_RETIRED_PATH2:+"$ESTATE_INJECT_RETIRED_PATH2"}
)

# DELIBERATE DIVERGENCES. A record is <path>|<repo>|<reason>. It is printed
# under the drift finding so the next reader does not "correct" the wrong
# repo. On its own it does NOT change the verdict.
#
# EXPECTED VARIANTS (2026-10-05). A record becomes an expectation when the
# reviewed copy of that repo's file is stored in this repository at
#
#     .github/estate-variants/<repo>/<path>
#
# That repo's copy is then held to the stored copy instead of to the other
# repos: while the two are byte-identical the copy leaves the agreement set
# and is noted; the moment they differ the record is STALE, the audit says so,
# and the copy goes straight back into the comparison - fail closed, exactly
# like a reversed retirement in RETIRED_PATHS. The other repos still have to
# agree with each other, and a stored copy with no reason on file below is
# itself a finding.
#
# Why a stored copy and not a note. From 2026-09-23 every record here was a
# note, on purpose: "these do NOT suppress the drift finding". The result was
# issue #3931 open for 27 days over a divergence the owner had already
# accepted and this file already explained, re-raised every four hours until
# nobody read the report - the failure 10.83 names. A bare exemption would be
# the opposite failure, cover for anything that repo ever commits to that
# path. The stored copy is neither: it is the exact bytes that were reviewed,
# it diffs in the pull request that changes it, and it can be served back to
# this audit's own tests, which a digest typed into a shell array cannot.
VARIANTS_DIR=".github/estate-variants"

DELIBERATE_VARIANTS=(
  ".husky/reference-transaction|Smarter-Poker-Club-Arena|Club Arena's copy is preventive and read-only ON PURPOSE. CLAUDE.md 10.12 forbids recovery machinery, and tests/unit/resetGuardCannotSaveTheWorktree.test.ts fails on any \`git update-ref\` or \`refs/wip\` inside this hook. The newer World Hub variant writes rescue refs and adds an AGENT_REF_GUARD_OK bypass, which CLAUDE.md 12 rule 3 separately forbids here. Do not copy it into Club Arena; it would ship a red test and a banned band-aid."
  ".husky/reference-transaction|Smarter-Poker-World-Hub|World Hub keeps its own hook ON PURPOSE, reviewed 2026-10-05 when every other shared guard in the estate converged on Club Arena's copy. Its scripts/git-safe-push.sh rebases and force-pushes under the announced AGENT_REF_GUARD_OK hatch, and its __tests__/ref-guard-tells-the-truth-about-origin.test.mjs asserts the refs/wip/orphan-guard snapshot; Club Arena's read-only hook would wedge the first and fail the second. The reviewed copy is stored at .github/estate-variants/Smarter-Poker-World-Hub/.husky/reference-transaction: if World Hub changes the hook, re-read it and update that copy in the same pull request."
  ".github/workflows/agent-open-pr.yml|Smarter-Poker-Club-Arena|Club Arena moved to the split-privilege design in PR #4189 (2026-09-11): an unprivileged \`Agent Branch Proposal\` signal plus this trusted \`workflow_run\` consumer, which mints a short-lived GitHub App token and never holds a PAT. The rest of the estate converged on it on 2026-10-05. If a repo drifts from it again, converge it onto this one; do not reintroduce the create/push opener with its GH_PAT fallback, and do not take Club Arena back."
  ${ESTATE_INJECT_VARIANT_NOTE:+"$ESTATE_INJECT_VARIANT_NOTE"}
)

# Both records are <path>|<repo>|<reason>. Kept as plain arrays rather than
# associative ones so this runs the same on the bash the runners ship and the
# bash 3.2 on a Mac.
retired_reason() {
  local path="$1" repo="$2" e rest
  for e in "${RETIRED_PATHS[@]}"; do
    [ "${e%%|*}" = "$path" ] || continue
    rest="${e#*|}"
    [ "${rest%%|*}" = "$repo" ] || continue
    printf '%s' "${rest#*|}"
    return 0
  done
  return 1
}

deliberate_notes_for() {
  local path="$1" e rest repo
  for e in "${DELIBERATE_VARIANTS[@]}"; do
    [ "${e%%|*}" = "$path" ] || continue
    rest="${e#*|}"
    repo="${rest%%|*}"
    printf '  Recorded deliberate variant: **%s** - %s\n' "$repo" "${rest#*|}"
  done
}

has_deliberate_note() {
  local path="$1" repo="$2" e rest
  for e in "${DELIBERATE_VARIANTS[@]}"; do
    [ "${e%%|*}" = "$path" ] || continue
    rest="${e#*|}"
    [ "${rest%%|*}" = "$repo" ] && return 0
  done
  return 1
}

# Prints the stored reviewed copy's path when <path> in <repo> is an EXPECTED
# variant, and returns 1 when it is not.
expected_variant_file() {
  local f="$VARIANTS_DIR/$2/$1"
  [ -f "$f" ] || return 1
  printf '%s' "$f"
}

# A stored copy that names a repo or a path this audit does not compare is
# dead weight at best and a typo hiding a real drift at worst.
if [ -d "$VARIANTS_DIR" ]; then
  while IFS= read -r stored; do
    rel="${stored#"$VARIANTS_DIR"/}"
    repo="${rel%%/*}"
    path="${rel#*/}"
    ok_repo=0; ok_path=0
    for r in "${REPOS[@]}"; do [ "$r" = "$repo" ] && ok_repo=1; done
    for f in "${SHARED_FILES[@]}"; do [ "$f" = "$path" ] && ok_path=1; done
    [ "$ok_repo" = 1 ] || add "\`$stored\` is a stored expected variant for **$repo**, which is not a repo this audit compares. Remove it or fix the name; it expects nothing as it stands."
    [ "$ok_path" = 1 ] || add "\`$stored\` is a stored expected variant for \`$path\`, which is not a shared file this audit compares. Remove it or fix the path; it expects nothing as it stands."
    has_deliberate_note "$path" "$repo" || add "\`$stored\` is a stored expected variant with NO reason on file: nothing in \`DELIBERATE_VARIANTS\` says why **$repo** is allowed its own \`$path\`. Record the reason there in the same pull request, or remove the copy."
  done < <(find "$VARIANTS_DIR" -type f | LC_ALL=C sort)
fi

# One shared file, one repo, ONE of four answers. Prints "<state>TAB<payload>";
# payload is the base64 content when present, and the first line of the error
# when unreadable. `present` with an empty payload is a real zero-byte file:
# GitHub returns `"content": ""` for one, which is not the same as a 404.
read_shared_file() {
  local repo="$1" path="$2" body rc
  body=$(gh api "repos/Smarter-Poker/$repo/contents/$path" --jq '.content' 2>/dev/null)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'present\t%s' "$body"
    return 0
  fi
  case "$body" in
    *'"status":"404"'*|*'"message":"Not Found"'*) printf 'absent\t'; return 0 ;;
  esac
  printf 'unreadable\t%s' "$(printf '%s' "$body" | tr '\n' ' ' | cut -c1-160)"
}

for f in "${SHARED_FILES[@]}"; do
  DIGESTS=""
  # Compare every repository's actual response. Identical consecutive bytes
  # need only one successful digest; do not restart Perl for the same content.
  # This bounded cache resets per file and never contains an absent/error read.
  LAST_PAYLOAD=""
  LAST_DIGEST=""
  PRESENT=0
  MISSING=""
  RETIRED_SEEN=""
  for r in "${REPOS[@]}"; do
    RESULT=$(read_shared_file "$r" "$f")
    STATE="${RESULT%%$'\t'*}"
    PAYLOAD="${RESULT#*$'\t'}"

    if [ "$STATE" = "unreadable" ]; then
      add "\`$f\` in **$r** — COULD NOT TELL. The contents read failed and did not say Not Found, so this path is neither confirmed present nor confirmed absent and nothing about it is verified here: \`$PAYLOAD\`"
      continue
    fi

    if [ "$STATE" = "absent" ]; then
      if RETIRED_WHY=$(retired_reason "$f" "$r"); then
        note "$f: absent from $r - recorded deliberate retirement, not drift"
        RETIRED_SEEN="$RETIRED_SEEN $r"
      else
        MISSING="$MISSING $r"
      fi
      continue
    fi

    if RETIRED_WHY=$(retired_reason "$f" "$r"); then
      add "\`$f\` is RECORDED AS RETIRED in **$r**, and it is back. Either the retirement was reversed there, or this record is now stale and belongs in the same pull request that restored the file. Reason on file: $RETIRED_WHY"
    fi

    PRESENT=$((PRESENT + 1))
    if [ -z "$PAYLOAD" ]; then
      add "\`$f\` in **$r** exists and is EMPTY - zero bytes. Not a drifted copy and not a deletion: the path is there and there is nothing in it, so whatever it is supposed to do is not happening in that repo. That is a third repair, distinct from copying a stale file forward and from restoring a deleted one."
      D="$EMPTY_SHA12"
    else
      if [ "$PAYLOAD" = "$LAST_PAYLOAD" ] && [ -n "$LAST_DIGEST" ]; then
        D="$LAST_DIGEST"
      elif D=$(printf '%s' "$PAYLOAD" | base64 -d 2>/dev/null | shasum -a256 | cut -c1-12) \
        && [[ "$D" =~ ^[0-9a-f]{12}$ ]]; then
        LAST_PAYLOAD="$PAYLOAD"
        LAST_DIGEST="$D"
      else
        add "\`$f\` in **$r** — COULD NOT TELL: could not decode or hash the returned content; no digest is verified for this repository."
        continue
      fi
    fi
    # An EXPECTED variant is held to its stored copy, not to the other repos.
    # Matching: noted, and out of the agreement set. Not matching: a finding,
    # AND back into the comparison, so a stale record is never cover. A copy
    # this cannot hash is COULD NOT TELL and exempts nothing (10.86 rule 1).
    if VF=$(expected_variant_file "$f" "$r"); then
      if VD=$(shasum -a256 < "$VF" | cut -c1-12) && [[ "$VD" =~ ^[0-9a-f]{12}$ ]]; then
        if [ "$D" = "$VD" ]; then
          note "$f: $r carries its recorded deliberate variant ($VD, stored at $VF), so it is held to that record rather than to the other repos"
          continue
        fi
        add "\`$f\` in **$r** is RECORDED AS A DELIBERATE VARIANT (stored copy \`$VF\`, \`$VD\`), and the repo now carries \`$D\`. The record is stale: either that copy changed without the record, or the record was never right. Re-read the file and update the stored copy in the same pull request, or converge it. Until then it is compared like any other copy."
      else
        add "\`$f\` in **$r** — COULD NOT TELL whether it matches its recorded deliberate variant: hashing the stored copy \`$VF\` failed. It is compared like any other copy until that reads."
      fi
    fi
    # A date this cannot read is reported as `unknown`, never as an old one:
    # an unreadable date must not make a current repo look stale (10.86 r2).
    WHEN=$(gh_ro "repos/Smarter-Poker/$r/commits?path=$f&per_page=1" --jq '.[0].commit.committer.date // empty')
    DIGESTS="$DIGESTS$D ${WHEN:-unknown} $r"$'\n'
  done

  UNIQ=$(printf '%s' "$DIGESTS" | awk 'NF{print $1}' | sort -u | wc -l | tr -d ' ')
  N_RETIRED=$(printf '%s' "$RETIRED_SEEN" | wc -w | tr -d ' ')
  EXPECTED_REPOS=$(( ${#REPOS[@]} - N_RETIRED ))
  DELIB=$(deliberate_notes_for "$f")
  if [ "$PRESENT" -eq 0 ]; then
    add "\`$f\` — **missing from every repo that should carry it**. A guard nobody has is a guard nobody runs."
  elif [ -n "$MISSING" ]; then
    add "\`$f\` — missing from:$MISSING. It exists in $PRESENT of the $EXPECTED_REPOS repos that should carry it, so the estate is not protected the same way everywhere. These are absent, not empty: the path is gone. If one of them was deleted on purpose, record it in \`RETIRED_PATHS\` in this script with the pull request that did it.${DELIB:+
$DELIB}"
  elif [ "$UNIQ" -gt 1 ]; then
    # ONLY A REAL VARIANT MAY BE RANKED. An empty file is not a version, and a
    # deleted one is not a version either; letting either win this sort is how
    # the report came to name "nothing at all" as the newest content of the
    # estate's pull-request opener, and to list the six working copies as the
    # ones that were behind.
    NEWEST=$(printf '%s' "$DIGESTS" | awk -v empty="$EMPTY_SHA12" 'NF && $2 != "unknown" && $1 != empty' | sort -k2,2r | head -1)
    NEWEST_REPO=$(printf '%s' "$NEWEST" | awk '{print $3}')
    NEWEST_WHEN=$(printf '%s' "$NEWEST" | awk '{print $2}')
    NEWEST_D=$(printf '%s' "$NEWEST" | awk '{print $1}')
    if [ -n "$NEWEST_REPO" ]; then
      BEHIND=$(printf '%s' "$DIGESTS" | awk -v d="$NEWEST_D" 'NF && $1 != d {printf "%s ", $3}')
      LEAD="Most recently committed: **$NEWEST_REPO** ($NEWEST_WHEN, \`$NEWEST_D\`). Carrying something else: $BEHIND"
    else
      LEAD="No variant carried both content and a readable commit date, so this cannot say which is newest. Compare them by hand."
    fi
    VARIANTS=$(printf '%s' "$DIGESTS" | awk 'NF{printf "    %s  %-22s %s\n", $1, $2, $3}')
    add "\`$f\` — **$UNIQ different versions** across the estate. These are supposed to be byte-identical; a fix applied in one repo and not the others is how a guard becomes true in theory only.
$VARIANTS
  $LEAD
  The date orders the variants, it does not certify one: a repo can commit an older file later. Make them agree; do not assume the newest is right.${DELIB:+
$DELIB}"
  else
    note "$f: identical in all $PRESENT"
  fi
done

# ── 3. Autopilot is alive ─────────────────────────────────────────────────
#
# A DELETED WORKFLOW IS NOT A LIVE ONE (2026-09-23). `gh run list` happily
# returns the last historical run of a workflow file that no longer exists, so
# Diamond-Arena read `autopilot completed/success` on every run after its own
# PR #64 deleted the file. "The last run succeeded" and "it still runs" are not
# the same claim, and only the second one is what this section is asserting.
#
# AND NEITHER IS A SWITCHED-OFF ONE (2026-10-02). That repair left the same
# trap one level up (10.86 rule 4): `gh run list` returns the last historical
# run of a workflow that is DISABLED just as happily as one that was deleted.
# Measured 2026-10-02 - commander-shared, smarter-poker-workers and
# PepNationLab each read `completed/failure`, and this section said of all three
# "while it is red, pull requests stop being queued and the failure is silent
# from the outside". Every clause of that was wrong. Their last runs were at
# 2026-09-16T04:06/04:35/05:24Z and GitHub records all three workflows as
# `disabled_manually`, set about an hour LATER and within eleven minutes of
# each other - one deliberate, coordinated retirement, not three silent
# failures. The September 17 owner instruction then wrote it down: a retired
# autopilot "remain[s] inactive" and is a prerequisite for nothing (CLAUDE.md
# 1.1, 1.2.5, 10.8 rule 3). A red run sixteen days ago is not what stopped that
# queue, nothing is waiting on it, and there is no repair to ask anyone for.
#
# So the workflow's STATE is read FIRST, and a run conclusion is only allowed
# to mean anything where the workflow can still run. The states are not one
# fact: `disabled_manually` is somebody's decision, recorded by GitHub itself
# at the moment they made it, while `disabled_inactivity` is nobody's - GitHub
# switches a scheduled workflow off after 60 idle days - so that one IS drift
# and gets said out loud. And a state that cannot be read is COULD NOT TELL,
# never folded into on, off or green (10.86 rule 1).
for r in "${REPOS[@]}"; do
  if RETIRED_WHY=$(retired_reason ".github/workflows/agent-autopilot.yml" "$r"); then
    note "$r: autopilot retired in that repo (recorded), so no liveness is claimed for it"
    continue
  fi

  WF_STATE=$(gh_ro "repos/Smarter-Poker/$r/actions/workflows" \
    --jq '.workflows[] | select(.path==".github/workflows/agent-autopilot.yml") | .state')
  if [ $? -ne 0 ]; then
    add "**$r** — COULD NOT TELL whether Agent Autopilot is switched on: reading that repo's workflow list failed. A last-run conclusion means nothing without it - a disabled workflow keeps reporting its final run for ever - so nothing is claimed here either way."
    continue
  fi
  WF_STATE=$(printf '%s' "$WF_STATE" | tr -d '[:space:]')

  case "$WF_STATE" in
    active) ;;
    "")
      # Section 2 already raises the absence of a shared guard file, with the
      # digest table saying which repos do have it. Saying it twice would teach
      # people to skim. What this must not do is claim liveness for it.
      note "$r: autopilot's workflow file is absent (section 2 reports the absence), so no liveness is claimed for it"
      continue ;;
    disabled_manually)
      note "$r: autopilot is switched off there (disabled_manually), so no liveness is claimed for it - the September 17 owner instruction retires autopilot and makes it no delivery's prerequisite"
      continue ;;
    disabled_inactivity)
      add "**$r** — Agent Autopilot's workflow state is \`disabled_inactivity\`, which nobody chose: GitHub switches a scheduled workflow off by itself after 60 idle days. It will not run again until somebody re-enables it, and its last run goes on reporting green or red as though it still did."
      continue ;;
    *)
      # A fourth state this audit has never seen. It is not on, not off by
      # anyone's decision, and not absent, so it is COULD NOT TELL (10.86
      # rule 1) rather than quietly sorted into the nearest known case.
      add "**$r** — COULD NOT TELL whether Agent Autopilot is switched on: its workflow state reads \`$WF_STATE\`, which this audit does not recognise. Nothing is claimed about its last run until somebody decides what that state means."
      continue ;;
  esac

  C=$(gh run list --repo "Smarter-Poker/$r" --workflow agent-autopilot.yml --limit 1 \
        --json conclusion,status --jq '"\(.[0].status)/\(.[0].conclusion // "-")"' 2>/dev/null || echo "")
  case "$C" in
    ""|"null/-")   add "**$r** — Agent Autopilot is enabled and has never run. Nothing in that repo auto-merges, so every pull request waits for a human." ;;
    completed/failure|completed/timed_out)
                   add "**$r** — Agent Autopilot is enabled and its last run is \`$C\`. While it is red, pull requests stop being queued and the failure is silent from the outside." ;;
    *)             note "$r: autopilot active, $C" ;;
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
