# The watchdogs watch themselves (2026-09-02)

Session 3 on the hourly-break system: everything below was found by auditing
the previous phases' output against reality, not by building new surface.

## Silent Revert Guard: a finding only counts if it ships

The guard flagged PR #2537 for "undoing" f48c48216 (#2535's TablePage
hand-number fix) - a commit authored an hour AFTER the flagged commit, on a
lineage the flagged commit was never part of, while HEAD carried the fix
intact. The blob match exists because concurrent lineages here hold
byte-identical content under different shas (CLAUDE.md section 12), and
because the flagged commit's message did not say "revert", the human
`revert-approved` label could not clear it: the branch was permanently
unmergeable with zero code actually reverting.

Fix (`scripts/ci/detect-silent-revert.mjs`): a finding now also requires the
undone change to be ABSENT from HEAD - squash-only merges mean HEAD's tree is
the only thing that ships. Three tiers: HEAD equals the pre-state (revert
ships, fail); HEAD equals the prior's result (present, pass); diverged - the
prior's diff must reverse-apply cleanly, else the finding stands. Verified
both directions on the Mac: the branch passes with REVERT_APPROVED=false, and
a simulated stale-checkout clobber (TablePage restored to f48c48216~1 at
HEAD, the 902d8b2b shape) still exits 1 with correct attribution.

## Migration stamp collision with #2580

Main landed `20260902110000_published_game_contracts_are_promises` while this
branch carried `20260902110000_the_vault_door_closes_on_the_legacy_money_rpcs`.
Both the collision gate and migrationVersionUniqueness refused it, correctly.
The vault-door file moved to `20260902110500`. The LIVE ledger is unaffected:
apply_migration recorded these under apply-time versions, and
check-migrations-applied verifies objects against the live schema, not names.

## The freeze guard resolves names on a pinned path

Supabase security advisors on the new freeze objects: `fn_refuse_while_frozen`
(the trigger deciding whether money moves), `fn_freeze_bypass_active` and
`fn_db_now` were created without SET search_path, resolving each other and
`engine_maintenance_break` on the CALLER's path. No browser role can create
schemas here, so hardening rather than a hole - pinned to `public, pg_temp`
(migration `20260902110600`, ALTER only), applied to production and verified:
guard proconfig pinned, freeze/bypass/clock all still evaluate. The
`engine_maintenance_thaws` RLS-no-policy INFO is deliberate deny-all.

## The orphan watchdog tells someone, every time

Estate rollout (#2563 item 17) took the watchdog to all seven repos
(commander#80, commander-shared#42, workers#47, Diamond-Arena#45,
PepNationLab#134, all merged). Auditing its first live World Hub sweep found
it failing at its whole job: 249 "stranded" pieces, an issue body over
GitHub's 65536-char cap, the create refused, stderr swallowed - findings, a
green step, and nobody told. v2, byte-identical estate-wide:

1. Tree-sha dedupe - a branch whose head tree matches any of main's last 200
   commits' trees shipped under another sha (the squash/duplicate-sha
   topology) and is not stranded. This is what separates the truly lost work
   from history in a 249-branch repo.
2. The detail list caps at 40 items plus a counted overflow note, so the
   body always fits and always files.
3. Create/comment stderr lands in the log, and every finding is printed
   there, so the overflow note's promise is true.

Follow-up once #2537 lands: add the script to estate-integrity SHARED_FILES
so the seven copies stay locked byte-identical.
