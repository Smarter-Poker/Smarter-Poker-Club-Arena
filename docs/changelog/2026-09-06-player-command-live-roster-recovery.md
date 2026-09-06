# Player Command Live Roster Recovery

2026-09-06. Release hardening for the retained hamburger route
`/clubs/:clubId/members` after the exact-current post-deploy gate exposed a
real cold-read failure on SHARK CLUB.

## Production finding

Post-deploy run `34023330596` loaded the Player Command shell and returned the
correct summary counts (595 members, 122 online, 121 seated, 67 agents), but no
directory row appeared within 45 seconds. The UI remained on `Connecting To The
Live Roster...`. The other 187 executed production checks passed, including the
174-test route, hamburger, and mobile sweep; the Club Members failure kept the
release open.

The summary and page RPCs are intentionally independent. The summary reads only
membership and presence. The page also groups per-player fee and hand facts.
Production held 990,903 `ca_hand_facts` rows without a club-first index, so a
cold roster read could scan the retained fact set before returning one club.

## Corrections

The database performance repair landed on main in
`20260906110500_player_command_fees_seek_by_club.sql`: a non-blocking,
club-first covering index for the existing roster aggregate. The companion
client repair gives that aggregate one uninterrupted 40-second request and
exposes the deliberate retry state instead of launching competing automatic
copies after a timeout.

This follow-up closes the remaining hostile browser and release-gate gaps:

- Browser-offline aborts cancel pending directory, load-more, and summary retry
  work and clear loading, refreshing, and slow-request flags.
- Offline state also moves summary freshness to stale or failed, so its
  `aria-busy` state and values cannot remain indefinitely on a cold abort.
- A successfully loaded zero-result search or filter remains a verified empty
  directory when connectivity drops; it is no longer mislabeled as a failed
  initial load merely because it has no rows.
- A realtime channel error marks the connection degraded without aborting a
  healthy roster read. The existing SUBSCRIBED path refreshes once the channel
  has actually recovered.
- The production test records request, response, completion, abort, and
  unexpected transport-failure timing for both roster RPCs. Its artifact
  remains allowlisted and count-only: no aliases, UUIDs, URLs, error bodies, or
  credentials are retained.
- Initial load plus search, search reset, filtering, filter reset, and sorting
  must each start and finish their own successful 2xx directory RPC. The
  zero-retry gate fails on HTTP errors, transport failures, roster-request
  aborts, page exceptions, and route/chunk/runtime console errors.

## Rejected shortcut

A candidate patch that replaced lifetime fee totals with
`ca_club_rake_daily_user` was rejected before production and removed from this
branch. That projection is the unsealed live edge: historical attributions
before 2026-09-02 retain table-host club ownership, older facts are absent, and
its trigger deliberately swallows write failures because the original consumer
can rebuild a live day. Summing it forever under a `Total Fees` label would
silently undercount history. The indexed, existing source is preserved until a
separate money-history design can define and backfill that boundary safely.

## Scope and route safety

No route, menu label, navigation handler, form, checkout path, realtime topic,
permission, public API signature, or money definition changes in this follow-up.
The retained Players route and every member-detail URL remain the same. No new
artwork is introduced; the established Player Command
`#SmarterCasinoRealism` presentation is preserved.

The broader before/after hamburger sitemap and compatibility-route record remain
in `docs/audit/2026-08-29-club-arena-hamburger-completion.md` and the subsequent
phase audit documents. This repair closes a live data-path and recovery defect
inside that retained architecture rather than changing the architecture again.

## Pre-publication evidence

- Client unit shards: 14,761 tests passed across four shards with the repository
  scans given a 30-second local timeout; shard 2 also passed the exact CI command.
- Focused and directly supporting Player Command suite: 117 tests passed after
  rebasing the upstream deadline, club-first-index, and certification changes.
- TypeScript `--noEmit`, changed-file ESLint, and `git diff --check`: passed.
- Production build: passed and stamped from the then-current main base.
- Playwright discovers both production Player Command checks.

Publication and a new zero-retry exact-current post-deploy run are required
before this repair can be called complete.
