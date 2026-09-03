# 2026-09-02 - chip-std lane H: freerolls are Free Buy

**Dan, verbatim (2026-09-02):** "FREE ROLLS MUST ALWAYS BE SET AS 'FREE BUY'.
ITS FREE TO ENTER, $0 BUY IN, BUT REBUYS AND ADD ON'S COST $1. MAKE SURE THAT
IS BAKED IN HOW EVER ITS NEEDED."

Branch `fix/chip-std-free-buy`. Lane A (obligations) owns the money functions;
this lane owns the SETTINGS every freeroll carries and their enforcement.

## What production looked like (18:22 UTC, `tournaments` with buy_in_amount = 0, last 14 days)

| Shape                                                                      | Count |
| -------------------------------------------------------------------------- | ----: |
| is_rebuy=false, add_on_available=false, rebuy_cost NULL                    |   183 |
| is_rebuy=true, add_on_available=true, rebuy_cost 1.00, **addon_cost 0.00** |    58 |
| everything 0 (older)                                                       |    31 |

Zero of 262 followed the rule end to end. The 58 "nearly right" ones charged
1.00 for the rebuy and gave the add-on away free, and their add-on chips were
the 5,000 starting stack rather than the 10,000 the schedule asked for.

**Root cause of the 58:** `tournament_schedules.config` spells the keys
`addonCost` / `addonChips` / `addonLevels` and `ScheduledTournamentService.
buildInsertRow` read `addOnCost` / `addOnChips` / `addOnLevels`. The price fell
through to `split.total`, which is 0 on a freeroll.

**Root cause of the 183:** no creator passed rebuy/add-on settings for a
freeroll at all, and nothing in the database required them.

## The predicate (written down, all three copies agree)

A row is a freeroll when `buy_in_amount = 0 AND buy_in_fee = 0 AND
tournament_type = 'MTT' AND variant NOT IN ('spin','sng')`.

- Spins are excluded: a Spin's price is its multiplier ladder and the
  `tournaments_spin_*` constraints own that shape.
- SNGs are excluded: the 10 rows with `buy_in_amount = 0, buy_in_fee = 1.00`
  are misconfigured duels, not freerolls (the fee test excludes them twice).
- Satellites and bounty formats at 0 ARE freerolls: entry is free and the
  1-chip rebuys/add-ons feed the same pool.

## Every creator of freerolls found

| Creator                                                                                     | Kind               | Freerolls it makes                                                            | What this lane did                                                                             |
| ------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `server/src/services/TournamentRecurringService.ts` (XMTT insert ~L2620, MTT insert ~L2855) | engine, recurring  | "Early Bird Freeroll (NLH)", "Coffee Break Freeroll (PLO4)" templates         | spreads `freeBuyColumns()` LAST over both inserts                                              |
| `server/src/services/ScheduledTournamentService.ts` `buildInsertRow`                        | engine, schedules  | every `tournament_schedules` row with `buyIn: 0` (the 24 DSS freerolls)       | reads both add-on key spellings; spreads `freeBuyColumns()` LAST                               |
| `src/lib/tournamentFromTableConfig.ts` + `src/pages/TableConfigPage.tsx`                    | Club Arena form    | any MTT built with buy-in 0 ("0 = Freeroll")                                  | spreads `freeBuyConfig()` LAST; form shows the Free Buy badge and locks rebuy/add-on at 1 chip |
| `src/services/TournamentService.ts` `buildRpcConfig`                                        | Club Arena, all    | every creation surface funnels through it (form, modal, schedule editors)     | spreads `freeBuyConfig()` LAST; never sends a 0 rebuy cap for a freeroll                       |
| `src/components/club/CreateTournamentModal.tsx`                                             | Club Arena modal   | none - `isWholeBuyIn` requires buy-in > 0, so it cannot create a freeroll     | unchanged (goes through `buildRpcConfig` anyway)                                               |
| `src/services/HorseOrchestrator.ts` (browser-side, 4 FREEROLL configs)                      | Club Arena, legacy | "FREEROLL - Monday Kickoff (NLH)" etc. (singleton not referenced by any page) | spreads `freeBuyColumns()` LAST over its direct insert                                         |
| `public.fn_create_tournament` -> `fn_create_tournament_governed_legacy`                     | DB RPC             | whatever the client sends (writes rebuy keys through verbatim)                | unchanged; the client now sends the rule and the trigger backstops                             |
| `public.fn_ensure_upcoming_mtts`                                                            | DB function        | inserts `'Freeroll. No buy-in, no fee.'` rows with is_rebuy=false             | no callers, no cron; left as is - the trigger normalises its rows if it is ever called         |
| World Hub `pages/api/club-arena/horse-launch.js` (4 FREEROLL configs, direct insert)        | World Hub API      | "FREEROLL - Monday Kickoff (NLH)", "Daily Freeroll - NLH" etc.                | **FOLLOW-UP in World Hub** (not this repo); trigger backstops today                            |
| unknown - "Rolling Freeroll 77777 21 18:41" (18 progressive_bounty rows, no schedule_id)    | ?                  | 18 in the last 14 days                                                        | not found in either repo's source; trigger backstops                                           |

Recurring templates table: `tournament_schedules` (config jsonb; 24 active
freeroll schedules named `DSS <Day> $100/$150 ... Freeroll` and `$100 Freeroll
• HH:MM`). Most already say `isRebuy: true, rebuyCost: 1, addonCost: 1`; the
Turbo and PLO4 ones carry no rebuy keys at all. Both shapes now spawn compliant.

## Migrations (applied to production, one transaction each)

**`20260902183602_freerolls_are_free_buy`** (DDL, Tier 2):

- `fn_is_free_buy_event(buy_in_amount, buy_in_fee, tournament_type, variant)` - the predicate.
- `ca_freeroll_free_buy_log` - one row per normalised INSERT/UPDATE/BACKFILL with `{column: {from, to}}`; RLS on, revoked from anon/authenticated, service_role only.
- `fn_freerolls_are_free_buy()` + trigger `zz_freerolls_are_free_buy` BEFORE INSERT OR UPDATE OF the rule columns, `WHEN buy_in_amount = 0`. It NORMALISES and never RAISES: `is_rebuy = true`, `add_on_available = true`, `rebuy_cost = 1.00`, `addon_cost = 1.00`, `buy_in_fee = 0`, chips from `starting_chips` when 0/NULL, `rebuy_levels = 4` / `addon_levels = 1` when NULL **or 0** (a 0-level window reads as "never closes" in `process_tournament_rebuy`), `max_rebuys = NULL` when 0 (the RPC reads a NOT NULL 0 as "Rebuy limit reached (0 of 0)"). An UPDATE of a RUNNING/COMPLETED event is never rewritten.
- One-time backfill of every NOT-STARTED freeroll (ANNOUNCED/REGISTERING). 14 of the 28 already held registrations and `fn_guard_managed_game_lifecycle` refuses contract edits under registered players unless the caller is the engine, so the backfill sets `request.jwt.claim.role = service_role` transaction-locally. `fn_capture_managed_game_contract` recorded all 28 as `system_revision` in `managed_game_contract_versions`.
- Post-apply assertions: zero violators, trigger present, normaliser contains no `RAISE EXCEPTION`, backfill touched nothing that had started. All ran green.

**`20260902184500_the_free_buy_log_records_the_whole_backfill`** (DML only):
the backfill UPDATE set the four headline columns directly, so the trigger saw
them already compliant and logged only the 9 rows it still had to fill (chips
and windows). The other 19 - whose only defect was the 0.00 add-on - left no
log row. This migration derives each row's diff from its contract revision
(version N-1 -> N) and reconciles the log. Asserts every backfilled freeroll
has a BACKFILL row naming `addon_cost`.

## Before / after

```sql
select count(*) from tournaments t
 where fn_is_free_buy_event(buy_in_amount, buy_in_fee, tournament_type, variant)
   and status in ('ANNOUNCED','REGISTERING')
   and (not coalesce(is_rebuy,false) or not coalesce(add_on_available,false)
        or rebuy_cost is distinct from 1.00 or addon_cost is distinct from 1.00);
```

| Measure                                                    | Before |       After |
| ---------------------------------------------------------- | -----: | ----------: |
| not-started freerolls                                      |     28 |          28 |
| ... violating the rule                                     |     28 |           0 |
| ... with registered players (rewritten as system_revision) |     14 | 0 violating |
| RUNNING freerolls touched                                  |      - |           0 |
| `ca_freeroll_free_buy_log` rows (op BACKFILL)              |      0 |          28 |

The one RUNNING freeroll ("$100 Freeroll • 12:00 PM", addon_cost 0.00) was
deliberately left alone: its players entered under that contract.

## Engine

- `server/src/config/buyIn.ts`: `FREE_BUY_*` constants, `isFreeBuyEvent`, `freeBuyColumns` (returns `Partial<FreeBuyColumns>` so it can be spread over an insert literal that already names the keys).
- `TournamentRecurringService`: both MTT inserts spread it last.
- `ScheduledTournamentService.buildInsertRow`: reads `addonCost|addOnCost`, `addonChips|addOnChips`, `addonLevels|addOnLevels`; spreads it last.
- Rebuy eligibility audit (`server/src/tournament`, `ServerTableEngineDealing`): every gate keys on `is_rebuy` / `add_on_available` / the level window, none on `buy_in_amount > 0` or `rebuy_cost > 0`. `TournamentManagerBase` L4795 `addonCost = addon_cost || buy_in_amount || 0` now resolves to 1.00 on a freeroll. The only denial found was `max_rebuys = 0` in `process_tournament_rebuy` (Lane A's function), which the trigger and both creators now avoid by writing NULL.

## Client

- `src/utils/freeBuy.ts`: constants, `FREE_BUY_LABEL = 'Free Buy'`, `FREE_BUY_HELPER`, `isFreeBuyEvent`, `freeBuyConfig` (camelCase), `freeBuyColumns` (snake_case).
- `TournamentService.buildRpcConfig` and `tournamentFromTableConfig`: spread last; no 0 rebuy cap for a freeroll.
- `TableConfigPage`: "Free Buy" badge under the buy-in when an MTT is at 0; rebuy and add-on controls render locked ON at 1 chip with the helper line; the add-on break length stays editable. `Toggle` and `NumberField` gained a `disabled` prop.
- Lobby / every buy-in cell: `formatBuyIn`, `formatBuyInShort`, the lobby `buyInLabel` and the freeroll medallion now read "Free Buy" (was "FREE" / "FREEROLL" / "Free entry").
- `HorseOrchestrator`: spreads `freeBuyColumns` over its direct insert.

## Tests

- `tests/law/FreerollsAreFreeBuy.law.test.ts` (21 pins; `docs/LAWS.md` row added). Negative controls, each RED then restored GREEN: migration `addon_cost := 0.00`; migration `RAISE EXCEPTION`; scheduled `addonCost` key removed; form Rebuy Cost unlocked; server `FREE_BUY_ADDON_COST = 0`; buy-in cell back to `'FREE'`.
- `tests/unit/freeBuy.test.ts` (12): form -> config, `buildRpcConfig`, `buildInsertRow` with the real DSS config shapes, lobby copy.
- Touched-area suites green: `TournamentFromTableConfig`, `TournamentService`, `ScheduledTournamentService`, `tournamentServiceAuditRound8`, `law-registry`, lobby suites. `npx tsc --noEmit` clean in both roots. `node scripts/ci/check-title-case.mjs` OK.

## Follow-ups (not this repo / not this lane)

1. **World Hub `pages/api/club-arena/horse-launch.js`** inserts freerolls with `buy_in_amount: 0` and no rebuy keys. The DB trigger normalises them today; the file should pass the rule explicitly like the Club Arena creators do.
2. **"Rolling Freeroll 77777 ..."** - 18 progressive_bounty freerolls in 14 days with no `schedule_id`, source not found in either repo. Whoever creates them should be found and made to pass the rule.
3. `process_tournament_rebuy` (Lane A) treats `max_rebuys = 0` as "limit reached" while the column DEFAULT is 0 - a paid rebuy event created without an explicit cap denies every rebuy. Out of this lane's scope; flagged.
4. `fn_ensure_upcoming_mtts` has no callers and inserts non-compliant freerolls; a candidate for retirement.
