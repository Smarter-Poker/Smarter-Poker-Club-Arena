# Table Management — publication audit and the gaps it found

Date: 2026-09-01
Branch: `codex/club-table-management-20260901`
Pull request: #2567

The six phases were built, tested and applied to the production database, but
nothing had merged: the branch sat behind a red `CI — Build & Type Safety`.
This is the audit that closed it, and the three real defects it exposed.

## 1. The schema manifest fragment was never committed

`Supabase Invariants — Phantom References` failed because the frontend now
calls 16 management RPCs and reads 5 new tables that the committed schema
contract did not certify. The fragment declaring them
(`scripts/ci/schema-manifest.d/codex-table-management.json`) existed on disk
and was untracked, so every local run passed and CI could not.

Failing at that step also **skipped the eleven gates that follow it** —
migrations applied, migration version uniqueness, definer authorization,
required columns, phantom columns, bus wiring, route targets, embed
relationships, rake config parity, stranded writers, deprecated tables. All
eleven were run locally against production afterwards and all eleven pass.

## 2. Two modules landed in the bundle every player downloads

`Track Bundle Size` failed at 2403kB gz against a 2400kB ceiling. Measuring it
properly — building `origin/main` and this branch on the same machine — showed
the feature costs +27kB gzipped in total, but **+11kB of that was on the
INITIAL LOAD**, the bundle fetched before first paint by players who will never
open Table Management. Two static imports caused it:

| Where                          | What it pulled in                                                                                                                                                                                 | Why it is eager                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `TournamentStartingTicker.tsx` | `lobbyEntries.ts` (1,482 lines) plus `cashBuyIn`, `bettingStructure`, `tournamentFigures`, `spinReveal`, `parseJsonCached`, and `fast-json-patch` / `zustand` / `web-vitals` hoisted alongside it | Mounts at the app root, outside `<Routes>`     |
| `TableService.ts`              | `GameManagementService.ts` (the whole operator command gateway)                                                                                                                                   | Reached from `App` via `TournamentRankingHost` |

The ticker needed exactly one function, `lateRegEndMs`. It now lives in
`src/components/lobby/lateRegWindow.ts`, which imports only the blind-structure
parser; `lobbyEntries` re-exports it so no existing caller changed, and the row
type is imported type-only so nothing crosses back at runtime.

`TableService` uses the gateway in four operator-only methods, all already
`async`. They load it with `await import('./GameManagementService')`, so a
player who never closes, pauses or resumes a table never downloads it. Every
routed call keeps its exact shape, so `managedGameLifecycleAuthority` still
reads the same governed calls.

Result: the feature's entry cost fell from +11kB gz to +3kB gz (301kB against
the untouched 320kB hard limit). `tests/unit/entryBundleStaysLean.test.ts` pins
both, because nothing else in CI notices a module moving from a route chunk
into the entry — the bundle gate measures a total, not who pays it.

## 3. The total ceiling was exhausted by the product, not by this branch

With the real leaks fixed, the remaining +27kB is lazy route code, and no
vendor is duplicated: the ten heaviest chunks hold one copy each of react,
sentry, supabase, motion and the chart runtime.

Measured on one machine:

```
main                          2328kB gz / 388 files
same tree + table management  2355kB gz / 393 files
```

Every one of the 12 open pull requests in the repository measured within 25kB
of the 2400kB ceiling on this date, and `main` itself never measures at all
because `Production Build` only runs on `pull_request`. The ceiling set on
2026-08-21 with ~29% of deliberate growth headroom had run out, and the first
feature to arrive afterwards was failing for the product's accumulated history
rather than for anything it did.

Raised on Dan's explicit call to **2600kB gz / 9200kB raw** — about 8% of
headroom, a quarter of what the original author allowed, chosen so the comment
gets read again soon rather than never. `INITIAL_GZ_LIMIT` is untouched at
320kB; that is the gate that protects users, and this branch moves it in the
right direction.

## 4. The last door that could still evict a seated player

Auditing the shipped phases against the live database, rather than against the
source that claims them, turned up one authority gap the tests could not see.

`fn_admin_close_table` is SECURITY DEFINER and was still EXECUTE-granted to
`authenticated`. It does not trip `trg_tables_managed_lifecycle_guard`, because
it empties the table before it closes it:

```
credit every seated stack back to the wallet
UPDATE table_seats SET left_at = now() WHERE left_at IS NULL   <-- here
UPDATE tables    SET status   = 'closed'
```

By the time the guard looks for a seat with a null `left_at`, there is none.

Phase 1 revoked exactly this on the tournament side — `atomic_cancel_tournament`
is `service_role` only — and Phase 3 revoked `fn_close_managed_game` and
`fn_update_managed_game`. The table twin was missed. The frontend had stopped
calling it, but the point of Phase 1 was that the rule must not depend on the
frontend: any club admin could still call it directly and cash out a live table
mid-hand. Under section 10.5 that reaches horses exactly as it reaches humans.

Revoked from `authenticated` and `anon` in
`20260902223000_the_last_door_that_could_evict_a_player.sql`, applied and
verified live (only `postgres` and `service_role` retain EXECUTE). The function
stays for genuine service-role recovery. The supported operator path remains
`fn_execute_managed_game_command`, which refuses while anyone is seated and
says so. GRANT/REVOKE fires no PostgREST schema reload, so this was safe under
live traffic.

The same sweep confirmed there is nothing else of this shape: all five new
tables have RLS enabled with no INSERT/UPDATE/DELETE granted to
`authenticated`, and of the seven definer RPCs still reachable by an ordinary
caller that name a close, cancel or delete, two are Club Commander home games,
two are the Phase 6 schedule commands themselves, one removes a single
tournament player behind its own start-time guard, one cancels a ticket, and
`fn_delete_tournament_schedule` only deactivates a recurring template.

## Production database

All seven migrations are recorded in `supabase_migrations.schema_migrations`
and verified live, not merely committed:

- `20260902050100_managed_game_lifecycle_is_one_door` — note the version, not
  `...050000`, which collided with an unrelated daily-mission migration and
  would have made one silently mark the other as applied.
- contracts, exactly-once commands, realtime, content commands, scale and
  scheduling.

Live checks confirm the four lifecycle triggers, the union-scope authorization
correction in `fn_list_managed_games` / `fn_get_game_management_health` /
`fn_get_game_management_scale_health`, the `idx_tables_management_scope_club_page`
index, and the 35 contract rows written by the post-trigger catch-up pass that
closes the snapshot race.

## Verification

- Client: 828 files, 11,294 tests.
- All 12 previously-skipped Supabase invariants, run locally against production.
- Production build plus bundle measurement on `main` and on this branch.
