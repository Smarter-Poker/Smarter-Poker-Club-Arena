# Diamond Phase 12, Lines 6 To 8: The Legacy Diamond Arena, Swept In Both Repositories

> "Delete all legacy Diamond Arena runtime modules, routes, API handlers,
> iframe assets, jobs, deployment targets, flags and obsolete configuration
> after dependency verification." / "Remove exclusive obsolete database
> functions, triggers and tables through new forward migrations ..." /
> "Search both repositories and deployment configuration for every
> inventoried legacy symbol/path; document each remaining match as shared
> infrastructure or historical evidence. Verify old URLs expose no Diamond
> Arena screen, API or redirect alias."

Date: 2026-10-04. Club Arena `main` at `ddccfa80` and World Hub `main` at
`f23bcfa` were searched for every symbol in the Phase 2 inventory
(`docs/audits/2026-09-08-diamond-phase-2-access-and-legacy-inventory.md`) and
the older lane inventory
(`docs/audits/2026-09-02-diamond-economy/lane4-diamond-arena-readiness.md`),
plus `diamond[-_ ]?arena`, `arena_deposit`, `arena_withdraw`,
`ClubArenaEmbed`, `diamond.smarter.poker`, `fn_arena`, and file names.

## Status of each line

| Line        | State on October 4                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6, runtime  | Club Arena held no legacy-only runtime code. World Hub's last seven leftovers are removed (World Hub #2112, merge `6a76ac23`, live: `smarter.poker/api/health` reports that commit). Three deployment targets outside both repositories remain and are owner actions (below). |
| 7, database | The forward migration is merged (Club Arena #6102, `20261004214251_the_legacy_diamond_arena_database_objects_are_dropped.sql`) and **not yet applied**. It needs one dispatch of `apply-merged-migration.yml`; the agent's token cannot dispatch workflows.                   |
| 8, sweep    | This file. Old URLs verified on production the same day.                                                                                                                                                                                                                      |

## Old URLs, read on production on October 4 (signed out)

| URL                                                                                                              | Answer                |
| ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| `smarter.poker/hub/diamond-arena` and its five sub-pages (history, leaderboard, schedule, stats, table-settings) | 404                   |
| `smarter.poker/hub/poker-arena`                                                                                  | 404 (no alias exists) |
| `smarter.poker/hub/club-arena`                                                                                   | 200                   |

`tests/e2e/an-old-bookmark-lands-somewhere-true.spec.ts` (Club Arena, daily
and post-deploy) and `e2e/06-smoke.spec.ts`, `e2e/020-hamburger.spec.ts`,
`__tests__/poker-arena-entry.test.mjs` (World Hub) pin these.

## Removed in this phase

World Hub (#2112): the `diamond.smarter.poker` image host in
`next.config.js`; stale comments in `WorldHub.tsx` and `hamburgerMenus.js`;
an empty heading in `inject-seo-round2.mjs`; the separate 'Diamond Arena'
mock result in `GlobalSearch.tsx`; assistant answer `ds-3`, which still
described the standalone product; one leaderboard claim in `wh-14`. Guarded
by a new case in `__tests__/poker-arena-entry.test.mjs`.

Club Arena database (#6102, once applied): `fn_arena_deposit(integer,text)`
and `fn_arena_withdraw(integer,text)` (stubs that only raised since
September 9); their two allowlist lines in
`fn_guard_profile_privileged_columns`; table `diamond_arena_events` (0 rows,
0 inserts ever); column `profiles.diamond_arena_preferences` (1,841 NULL and
3 `{}`). The migration refuses unless both switches are false, custody is
empty, and every function it edits is byte for byte the text read on
October 4. Proved on a disposable Postgres 16 cluster; production is 17.

## What remains, and why each match stays

Shared infrastructure:

- `fn_ca_arena_diamonds()`: repurposed September 9 to sum
  `poker_diamond_custody`; the supply identity closes on it. The Phase 2
  "retire" note is superseded.
- Journal kinds `arena_deposit` and `arena_withdraw`: written today by the
  custody doors (`fn_poker_diamond_reserve`, `fn_poker_diamond_release`, the
  top-up and tournament doors) and shown by both wallet modals.
- `ca_arena_settings`: holds the two switches and the settlement window.
- The system `clubs` identity, `src/components/arena/*`, `DiamondArenaCard`,
  `DIAMOND_ARENA_SLUG`, the Diamond artwork: the new skin.
- `src/components/table/HubFrame.tsx`: the one sanctioned iframe, for World
  Hub pages.
- World Hub wallet, store, VIP and rewards copy that names the Diamond Arena
  as the brand inside Poker Arena; `public/cards/diamond-arena.png` (approved
  artwork, pinned by a test).
- World Hub `src/state/worldStore.ts`: discards a cached
  `activeOrb === 'diamond-arena'`. A stale-storage guard that Phase 11 relies
  on.

Historical evidence: every migration file; the two `ca_money_rpc_registry`
rows, status `retired`; the Diamond `club_members` row; the Phase 2, 3 and 5
audits and changelogs; World Hub `.agent/` audits and the investor deck
slide.

## Open, and whose it is

Owner actions outside both repositories:

1. `diamond.smarter.poker` still resolves in the Vercel DNS zone and answers
   `DEPLOYMENT_NOT_FOUND`. The record should be deleted.
2. The GitHub repository `Smarter-Poker/Smarter-Poker-Diamond-Arena` is
   public and holds the old code. Archiving it is Dan's call; afterwards it
   leaves `.github/scripts/estate-integrity.sh` here and two CI repo lists in
   World Hub, together.
3. World Hub legal copy (`pages/terms.js`, `pages/legal/official-rules.js`)
   still describes the old product's hourly freerolls and tiers.

Owner decisions:

4. `fn_ca_arena_seat_is_same_asset()` and its trigger are the only consumer
   of rule DR15. Phase 2 called them legacy; they read the new arena
   identity. Do the P0810 to P0815 seat guards replace DR15?
5. The payout-freeze scope `arena_withdrawals` had one reader,
   `fn_arena_withdraw`. Freezing it today freezes nothing. Wire it into
   `fn_poker_diamond_release`, or retire the scope.

Found on the way, outside this programme:

6. `public.poker_hands`: 0 rows, no reader, not an arena object. Left.
7. `update_page_preferences` tests `FOUND` after `EXECUTE ... INTO`, which
   does not set `FOUND`. On the local cluster the unchanged production text
   answered `Profile not found` for a valid call. If production does the
   same, four World Hub preference services save nothing. Not confirmed on
   production and not changed.
8. World Hub assistant entry `ds-1` still says Diamonds buy "Diamond Arena
   tournament buy-ins", which is not open.
