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

---

## Verification pass (same day, before phase 2)

Dan asked for a deep verification of everything phase 1 claimed before any of
phase 2 was started. Writing the tests that were missing found four real
defects in my own work, which is the point of writing them.

**1. A bus event could not refresh a badge.** The shared read cache serves any
answer under fifteen seconds old so the page and the rail cost one query
between them. The bus nudge went through that same cache - so approving a chip
request, which fires `BALANCE_UPDATED` and coalesces at 2.5s, was answered from
the cache written moments before, and the badge did not move until the next
sixty-second poll. `load` now takes `silent` and `force` independently: a bus
event forces, the poll and the first mount of a second consumer do not.

**2. The two sub-workspaces never received their alerts.** `alerts={alerts}`
was written into `ClubFinanceWorkspacePage` and `ClubControlWorkspacePage` by a
patch whose anchor no longer matched after Prettier had reformatted the line
above it. The patch reported success, TypeScript was happy (the prop is
optional), and both pages shipped with an alert list that was computed, passed
nowhere, and rendered never. Found by the first test that mounted them.

**3. The rail printed the workspace total twice.** The identity plate and the
Overview item are the same destination, six pixels apart, and both carried the
rollup. The plate keeps it.

**4. A failed refresh dropped the age of the numbers still on screen.** The
freshness line went from "Updated 3m Ago" to "Live Readings Unavailable",
leaving an operator reading figures of unknown age. It now says
"Live Readings Unavailable, Last Read 3m Ago", and a database refusal reads
"Live Readings Restricted For This Role" rather than being silent.

Two gaps closed at the same time:

- **The cashier badge counted one of its three queues.** Chip requests, cash-out
  requests and credit requests all land on that desk and all three raise their
  own alert; the tile read 4 with 9 things behind it. A registry item now
  declares `signals: [...]`, a list, and a contract test asserts every declared
  signal is a count the function actually returns - a signal naming a key the
  RPC does not return would badge zero forever and look exactly like a quiet
  club.
- **The reading strip had no resting state.** The page jumped down when the
  numbers landed. Six skeleton tiles hold the height, marked `aria-busy`.

Also surfaced now that they were being counted for nothing: outstanding
tickets on Finance, the exclusion ledger on Control.

New tests: `tests/components/club-operations-surfaces.test.tsx` (10 cases - the
rail's badges, its group-parent current state, its silence for a non-staff
viewer, and both sub-workspaces mounted for the first time), plus 4 more on the
operations page (the skeleton, the stale-age line, the restricted line, the
three-queue cashier badge) and 2 unit cases on the freshness helper. 182 cases
across the four files, all green.

Re-verified after the fixes: `all-gates.sh` (tsc, fourteen house rules, the
whole vitest suite, build, bundle) plus `check-migrations-applied`,
`check-definer-authorization`, `check-phantom-tables`, `check-phantom-columns`,
`check-route-targets`, `check-painted-text-case`, `check-maybe-single`,
`check-bus-wiring`, `check-db-copy` (live schema), `check-required-columns`,
`check-no-orphaned-work`, and `npm run lint`. The live function was re-read
from production and still carries every count key, the staff gate, no
`is_horse` filter, no `auth.uid() IS NULL` shortcut, and EXECUTE for exactly
`authenticated` and `service_role`.

**Deploy route, confirmed against `origin/main` rather than a stale local
copy:** this branch's `CLAUDE.md`, `AGENT-PLAYBOOK.md` and
`publish-club-arena.yml` are byte-identical to `origin/main`, so section 1.1 is
current. The route is push a branch, and stop: `agent-open-pr.yml` opened
PR #2853, `agent-autopilot.yml` holds squash auto-merge until the required
checks are green, and `publish-club-arena.yml` publishes on merge. Nothing in
this work touches Hetzner, rsync, SSH, a deploy hook, Vercel, the World Hub
repo, or the retired `public/hub/club-arena/` path - the diff is source, tests,
docs, one migration and one manifest fragment, and `grep` over the whole diff
for those terms returns nothing.
