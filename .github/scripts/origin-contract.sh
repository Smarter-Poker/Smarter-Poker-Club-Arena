#!/usr/bin/env bash
# origin-contract.sh - assert the ORIGIN still behaves the way its config says.
#
# WHY BEHAVIOUR AND NOT BYTES
# ---------------------------
# infra/ca-origin/Caddyfile lives in git, but NOTHING deploys it: writing
# /etc/caddy and reloading Caddy needs root, and there is deliberately no root
# key in CI. So the box and the repo can drift the moment someone edits either
# one, and until 2026-09-03 nothing would have noticed.
#
# Comparing the file byte-for-byte would need that same root access, and it
# would fail on a harmless comment while passing a config that serves the wrong
# thing. So this asserts the four things the config EXISTS to produce, from
# outside, over plain HTTPS through smarter.poker - which is the path a player
# actually takes, edge rules included.
#
# Every check below is a bug that was real:
#   1. a missing asset was answered `immutable` and cached for a YEAR (the
#      publish-window 404 that breaks one viewer silently until a hard reload);
#   2. hashed assets must stay immutable or every navigation refetches 1MB;
#   3. the shell must carry stale-if-error, which is what lets Vercel's edge
#      keep serving when this single box is unreachable;
#   4. build-info.json must never be cached, or "production is serving X"
#      becomes "an edge node remembers X" - both watchdogs read it.
set -uo pipefail

BASE="${BASE:-https://smarter.poker/hub/club-arena}"
FAIL=0
note() { printf '  %-46s %s\n' "$1" "$2"; }
fail() { echo "::error::$1"; FAIL=1; }

hdr() { curl -s -o /dev/null -D- --max-time 20 "$1" | tr -d '\r'; }

echo "origin contract against $BASE"
echo

# 1. a real hashed asset, discovered from the live index rather than guessed
# -L matters: `$BASE/` 308-redirects to `$BASE` (normal Next.js trailing-slash
# handling). Without it this reads the 15-byte "Redirecting..." body and
# concludes the shell is broken - which it did on the first run.
INDEX="$(curl -sL --max-time 20 "$BASE/?cachebust=$RANDOM" || true)"
# Vite emits root-absolute hrefs; accept a relative form too rather than
# assuming one shape of the build.
ASSET="$(printf '%s' "$INDEX" \
  | grep -oE '(/hub/club-arena)?/?assets/[A-Za-z0-9._-]+\.js' | head -1)"
case "$ASSET" in
  /hub/club-arena/*) ASSET_URL="https://smarter.poker${ASSET}" ;;
  /*)                ASSET_URL="${BASE}${ASSET}" ;;
  ?*)                ASSET_URL="${BASE}/${ASSET#./}" ;;
  *)                 ASSET_URL="" ;;
esac
if [ -z "$ASSET" ]; then
  fail "could not find a hashed asset in the live index.html - the shell may not be rendering"
else
  H="$(hdr "$ASSET_URL")"
  echo "$H" | head -1 | grep -q ' 200' || fail "hashed asset $ASSET did not return 200"
  if echo "$H" | grep -qi '^cache-control:.*immutable'; then
    note "hashed asset immutable" "ok"
  else
    fail "hashed asset $ASSET is not immutable - every navigation refetches it"
  fi
fi

# 2. a miss must NOT be cached. This is the one that bit us.
H="$(hdr "$BASE/assets/does-not-exist-$RANDOM.js")"
echo "$H" | head -1 | grep -q ' 404' || fail "a missing asset did not return 404"
if echo "$H" | grep -qi '^cache-control:.*no-store'; then
  note "missing asset no-store" "ok"
else
  # KNOWN-UNFIXED AT THE EDGE, so this warns rather than fails. The ORIGIN is
  # correct (ca-static returns no-store), but every player arrives through
  # smarter.poker and Vercel overwrites the proxied response using
  # "/hub/:orb*/assets/(.*)" in the World Hub's vercel.json. Vercel header
  # rules match on path only and cannot depend on status, so there is no
  # formulation of that rule meaning "immutable when found, no-store when
  # missing" - and simply excluding club-arena makes a blanket /hub/ rule
  # apply instead, which would revalidate a 525KB entry chunk on EVERY
  # navigation. See docs/changelog/2026-09-03-a-404-is-not-immutable.md.
  #
  # A watchdog that is permanently red teaches everyone to ignore it, so this
  # stays a warning until the edge can express it. Turn it back into `fail`
  # the day that changes - and check the ORIGIN directly, which this does not:
  #   curl -sI https://ca-static.smarter.poker/assets/nope.js | grep -i cache
  echo "::warning::a missing asset is cacheable THROUGH THE EDGE (origin is correct; Vercel overrides). Known-unfixed, see the 2026-09-03 404 changelog."
fi

# 2b. the ORIGIN itself must be right even while the edge is not. This is the
# part fully under our control, so it fails hard.
OH="$(hdr "https://ca-static.smarter.poker/assets/does-not-exist-$RANDOM.js")"
if echo "$OH" | grep -qi '^cache-control:.*no-store'; then
  note "origin miss no-store" "ok"
else
  fail "the ORIGIN is caching a missing asset - infra/ca-origin/Caddyfile has drifted from the repo, or was never deployed."
fi

# 3. the shell must survive this origin being down
H="$(hdr "$BASE/clubs")"
echo "$H" | head -1 | grep -q ' 200' || fail "the SPA route /clubs did not return 200"
if echo "$H" | grep -qi '^cache-control:.*stale-if-error'; then
  note "shell stale-if-error" "ok"
else
  fail "the shell has no stale-if-error - if this single box goes down, the edge cannot cover for it"
fi

# 4. the deploy's own proof must never come from a cache
H="$(hdr "$BASE/build-info.json")"
if echo "$H" | grep -qi '^cache-control:.*no-store'; then
  note "build-info.json no-store" "ok"
else
  fail "build-info.json is cacheable - every publish check would read a remembered sha"
fi

echo
[ "$FAIL" = "0" ] && echo "origin contract: OK" || echo "origin contract: FAILED"
exit "$FAIL"
