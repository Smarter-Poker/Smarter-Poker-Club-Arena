# Club Operations, Phase 1 of 8: the shell tells the truth

Date: 2026-09-03
Branch: `feat/club-operations-full-upgrade`
Scope: `/clubs/:id/operations`, `/clubs/:id/finance`, `/clubs/:id/control`, the
club operations rail, the registry both of them read, and the guard that reads
it too.

## What was wrong

**1. `anti-cheat` was advertised and unguarded.** `clubOperationsNavigation.ts`
carries two lists: `DEFINITIONS`, what the workspace advertises, and
`OPERATION_SUFFIXES`, what `ClubCapabilityGuard` and the rail recognise. Nothing
made them agree and they had drifted. `anti-cheat` was a definition with
`access: 'staff'` and a live route, and was absent from the suffix set, so:

- `getRequiredClubOperationAccess('/clubs/x/anti-cheat')` returned `null`, the
  guard checked nothing, and **any ordinary member could open the collusion
  console by typing the URL** (384 of the 417 members of the largest club on
  the estate are plain players);
- `getClubOperationContext` returned `null` for the same reason, so **the
  operations rail vanished on that page**. A staff member who clicked
  Anti-Cheat from the workspace had no way back but the browser.

**2. Three built, server-gated tools had no door at all**, reachable only by
typing the URL: `promo-vault` (the club's actual campaign inventory),
`bomb-pot-report`, `table-management`. And the Control group's "Promotions"
tile promised "Create And Manage Club Promotion Campaigns" while opening
`PromotionsPage`, the player-facing offer feed, which has no create path.

**3. The workspace was three link grids that made no query.** The page printed
"Live Permission Map" and "Live Systems Remain Authoritative" over panels with
nothing live on them. An operator could not tell whether anything was waiting
for them without opening all twenty-one tools and looking. `isStale`,
`isOffline` and `lastSyncedAt` were computed in `ClubWorkspaceContext` and
surfaced nowhere.

**4. Two `<main>` landmarks per page.** `AppLayout` renders `<main
id="main-content">` around the outlet; `ArenaWorkspacePages` rendered a second
`<main>` inside it, on all six pages that component serves.

**5. The rail could show nothing selected.** `getActiveClubOperationPath`
rewrote `/cashier-classic`, `/agent-dashboard` and `/promo-vault` onto items
that are not `rail: true`, so those rewrites could never select anything, and
standing on any non-rail tool left the whole rail blank.

**6. The group artwork bypassed `mediaUrl`**, hardcoding `/hub/club-arena/…`,
so setting `VITE_MEDIA_BASE` would leave three images on the origin.

## What shipped

**`ca_club_operations_overview(p_club_id uuid)`** - one staff-gated read behind
all three surfaces: the live floor (members, online, players seated, live
tables, tournaments, hands today), the money figures for finance roles only
(fees today, club bank, member wallets), eleven work queues, and an alert list
carrying its own severity and the **registry tool id** the work belongs to, so
the client owns the words and the routes and the database owns the truth.

Three deliberate choices in it:

- **Seats are counted as people.** `ca_club_dashboard_stats` counts seat rows
  and calls it "Seated Now" - 698 for a club with 221 distinct players seated,
  which is why that page and the members page have never agreed. This one
  counts `DISTINCT user_id`.
- **It does not open with `auth.uid() IS NULL`.** `ca_can_view_club` and
  `ca_can_view_club_finances` both do, and that predicate reads as "internal
  caller" while meaning "anyone with no user"; the only thing between anon and
  their answer is the EXECUTE grant. This one names the internal escape
  (a superuser SQL session, or a service_role JWT) and refuses everyone else
  twice. Verified live: anon over PostgREST gets `401 / 42501 permission denied`.
- **Horses count.** Every count is over every member and every seat
  (CLAUDE.md 10.5). The file contains no `is_horse`, and a test asserts that.

**The workspace now reads.** `/operations` carries a live reading strip, a
"Waiting For You" panel whose every row deep-links to the tool that owns the
work, a per-tool queue badge, a per-group rollup, and an honest freshness line
with a Refresh control. `/finance` and `/control` carry the same badges plus
their own headline numbers, and their "Live Systems Remain Authoritative" line
becomes "Read Live From This Club" only when something on the page actually is.
The rail badges every tool it lists and the workspace total on its identity
plate, so the number follows the operator into every page.

**A badge always means one thing: this many things are waiting for a person.**
Volume is not a signal - a club with 417 members does not need a 417 on the
Players tile - so every declared signal counts work, and a group rollup is
computed over the viewer's own permitted items, never over a queue they cannot
open.

**A failed reading never takes the doors away.** The tools render from the
registry whether or not the RPC answers; a failure costs the badges and adds
one honest line. A `42501` refusal is not shouted about at all.

Also fixed: `anti-cheat` added to `OPERATION_SUFFIXES`; three doors added;
the Promotions tile renamed "Player Offers" with a description that matches the
page; `<main>` to `<section>` in `ArenaWorkspacePages`; dead rewrites replaced
with a group-parent fallback so the rail always says where you are; group art
routed through `mediaUrl`; the mobile hero cut from 460px to 300px now that
there is live content under it, with every new block written mobile-first.

## How it was verified

- `bash scripts/ci/all-gates.sh` - tsc, fourteen house-rule gates, the whole
  vitest suite, production build and bundle size: all green.
- `check-migrations-applied`, `check-definer-authorization`,
  `check-phantom-tables`, `check-phantom-columns`, `check-route-targets`,
  `check-painted-text-case`, `check-maybe-single`: all green.
- The function was probed live against Deep Stack Society
  (`2a1132b9-5ba2-42e6-9f01-30a7fcffebe3`): 417 members, 226 live tables, 183
  players seated, 122,786 hands today, 126,140.93 in fees, 2,096,087.81 in the
  club bank, every queue at zero. Single-digit milliseconds.
- Anonymous PostgREST call refused: `401 {"code":"42501"}`.
- New tests: `tests/unit/clubOperationsRegistryIntegrity.test.ts` (103 cases -
  every advertised tool is recognised by the guard and the rail, guarded at
  exactly the access it advertises, points at a route App.tsx declares, and
  badge semantics), `tests/components/club-operations-page.test.tsx` (10 cases -
  the first test in this repo that MOUNTS the operations page: formatting,
  alert routing, badges, the finance withhold, and degradation on failure),
  `tests/unit/clubOperationsOverviewContract.test.ts` (44 cases - every key the
  SQL returns is read by the client, every alert routes to a real registry
  tool, the gate and grants are pinned, no `is_horse`).

The contract test exists because of `get_anti_cheat_stats`: it returns seven
keys, `AntiCheatPage` reads five different ones, not one of them matches, and
`fmt(undefined)` renders "0" - so that page has always shown a club six zeros
and the words "Club Is Clean". A payload contract kept in two people's heads
gets broken by the next migration. Phase 2 fixes that function; this test makes
the same class of defect impossible for the new one.

## What Phase 1 deliberately did not touch

The queues are now visible; several of them cannot yet be worked. Anti-cheat
flags all carry `club_id IS NULL` and have no staff read policy, so that badge
will read zero until Phase 2 backfills the writer. Dispute "Start Review" and
"Escalate" write nothing today. Both are Phase 2, and both are why the
alert list points at a tool rather than claiming the work is actionable.

Full programme: `docs/club-operations/OPERATIONS-UPGRADE-PLAN.md`.
