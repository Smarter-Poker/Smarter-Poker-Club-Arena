# The creation paths nobody had read

2026-08-31, phases 6 to 9 of the game-creation audit. The earlier phases went
through the create-table form. This one goes through the writers behind it —
the services that create most production games without a human ever opening
that form — plus two things the form offers that the rest of the platform
cannot price.

## A guarantee refusal told the owner to try again

`trg_tournaments_guarantee_affordable` refuses a tournament whose guaranteed
prize the funding bank cannot cover, and it raises a sentence written for the
person reading it:

> Club X cannot guarantee N chips: <bank> holds A, floor B, already promised C
> on live events — short by D. Add chips to the bank to cover the guarantee.

It raises with errcode `55000`. `TournamentService.createTournament` maps three
codes to friendly text and sends everything else to a default —
"Could not create the tournament. Please try again." — so the owner got a
transient-sounding message for a permanent, precisely fixable condition, and
retrying could never work. The migration that added the trigger even records
the assumption this broke: _"The UI already shows the raise verbatim as a
toast."_ It did not. `55000` now passes through as written; the Toast layer
applies the house style at render, so the raise text needs no massaging.

The same refusal on the SCHEDULED path had a second half the recurring path was
missing. `ScheduledTournamentService` catches the guard's signature and writes a
durable bell notification via `fn_notify_guarantee_bank_short`.
`TournamentRecurringService` did not: it retried three times, five seconds
apart, logged to the error reporter, and the hourly event silently never
happened. Every hourly config in that file carries a guarantee, and the
2026-08-29 migration records what that looks like at scale — _"Midway Union ...
was refused ~570 spawns/hour"_. It now notifies, and it stops retrying, because
a funding bank does not refill in ten seconds.

## Four copies of one map, three of them wrong

`TournamentRecurringService` mapped a config's variant key to
`tournaments.game_type` in four hand-kept copies. One had already been fixed,
and its comment stated the rule the other three then broke:

> `plo6` was missing from it — so a PLO6 Spin config would have been silently
> created as NLH, giving players a different game from the one on the tile.
> Every member of SPIN_GAME_TYPES must have an entry here.

The XMTT and MTT copies omitted `plo6`; the SNG copy omitted `plo6` and
`short_deck`; none of the four knew `flh` or `flo8`, which became creatable
tournament variants earlier today. The fallback is a silent `|| 'NLH'`, so
every gap produces the same failure: the tile advertises one game and the
players are dealt another. Latent rather than live — the current schedules only
use the four keys all copies share — but a one-line config edit shipped it.

One map now, and an unrecognised variant is reported instead of silently
becoming NLH.

## The bomb-pot constraint could not see the table it was on

`resolveBombPotVariant` was taught this morning that a bomb pot may not cross
the fixed-limit line: a `plo4` bomb on a Fixed Limit Hold'em table "handed
every seated player one hand of pot-limit poker at a table they had sat down at
for limit". The DB constraint that is supposed to mirror the engine's whitelist
was single-column and could not see `game_variant`, so it knew none of that.

Two consequences. The database would store `bomb_pot_variant = 'plo4'` on an
`flh` table — refused by the engine at deal time, correctly, but the row is a
lie, and a published one: `get_club_home` projects the column, so the lobby
advertised "PLO4 bomb pots" on a table that will only ever deal FLH. And the
whitelist omitted `flh`/`flo8` entirely, so the legal case — a fixed-limit bomb
on a fixed-limit table — was structurally impossible.

`20260831f_a_bomb_pot_may_not_cross_the_fixed_limit_line.sql` replaces it with
a two-column CHECK, applied to production and verified by re-reading
`pg_get_constraintdef`. Of 103,732 rows, exactly one has `bomb_pot_variant` set
at all (an `nlh` table with a `plo5` bomb, legal before and after), so nothing
existing changed. The rule was then probed three ways inside a transaction that
was ROLLED BACK (CLAUDE.md 11.5 — what you want from a probe is the error
message): a pot-limit bomb on a limit table is refused, a limit bomb on a
no-limit table is refused, and a fixed-limit bomb on a fixed-limit table is
accepted. Zero probe rows reached the table.

The ENGINE whitelist deliberately stays narrow: `flh`/`flo8` are admitted to
the constraint so the legal case is not structurally impossible, and withheld
from the engine because no control offers them. Adding an engine capability
nothing can reach is the shape this audit spent the day removing.

## The dormant orchestrator would have created tables no engine adopts

`HorseOrchestrator.launchCashTables` — exported, exposed on `window`, currently
with no callers — writes cash tables with three defects its server twin
`HorseFleetManager` does not have:

- **No seat clamp.** Raw `config.maxPlayers`, where the fleet manager writes
  `clampSeatsForVariant(...)` and comments that the law is enforced at the
  insert "so a future config edit cannot put an illegal table in the database".
  Seven configs in the file are over the law today (plo4 and plo8 at 9 seats
  against a cap of 8), so since this morning's creation guard they would be
  refused and silently skipped.
- **`status: 'active'`.** The engine finds cash tables through
  `cash_tables_needing_engine`, whose WHERE is `status IN ('waiting','running')`.
  `'active'` is a legal value no engine query has ever matched — this is the
  documented bug that made tables sit in the lobby, accept seats and never deal
  a hand. Every working writer uses `'waiting'`.
- **The buy-in helper never asked `rakeRateFor`.** `buyIn.ts` names "the client
  horse orchestrator" among six writers it says were routed through the shared
  helper. It was not. Harmless today because every config here is 6- or 9-max,
  but the guard was absent.

All three fixed, plus `variant: 'SNG'` written upper case where every reader
compares lower case.

## Two things left for Dan, with the numbers

**The rake schedule does not cover the ladder the form offers.** Six of the
twelve blind presets have no `RAKE_SCHEDULE` row, so `getRakeConfig` falls back
to a tier whose cap is an absolute dollar amount. In big blinds that fallback
prices the four cheapest games above `MAX_RAKE_CAP_BB`, the ceiling the same
file enforces on an explicit override:

| preset                      | source          | cap | in BB      |
| --------------------------- | --------------- | --- | ---------- |
| 0.01/0.02                   | tier Nano       | $3  | **150 BB** |
| 0.02/0.05                   | tier Nano       | $3  | **60 BB**  |
| **0.05/0.10 (the default)** | tier Nano       | $3  | **30 BB**  |
| 0.10/0.25                   | tier Micro      | $3  | **12 BB**  |
| 25/50                       | tier Nosebleeds | $20 | 0.4 BB     |
| 50/100                      | tier Nosebleeds | $20 | 0.2 BB     |

Every schedule-covered preset is 6 BB or less. Live exposure is small today —
2 cash tables at 0.05/0.10, both closed; of 972 cash tables, 794 are at 1/2 and
129 at 2/5, all covered — but the DEFAULT preset sits in the gap, so the next
owner who accepts the defaults creates one. The DB creation guard declines to
police this in as many words: _"NOT enforced here and left for Dan: the
official stakes schedule."_ Nothing was changed. The gap is pinned at its
current size so it cannot grow unnoticed, and the invariant that should hold
once Dan decides is written as a `.skip` to be un-skipped by that commit.

Also: `RAKE_SCHEDULE` contains `{ sb: 5, bb: 5 }`. The creation guard refuses
"big blind must exceed small blind", so no table can ever match that row. 5/10
already exists; 2.5/5 would fit the ladder. It is a money row, so it is
recorded and not touched.

## Fixed-limit tables can no longer be built on blinds their label cannot say

A limit game's whole bet ladder derives from the big blind, and `stakesLabel`
names the table by those bet sizes — blinds 1/2 is a "2/4" limit game. The
small blind is not a term in either. So on a preset where the big blind is not
twice the small blind, an FLO8 table stored as `small_blind 0.1, big_blind
0.25` was labelled "0.25/0.50" in `tables.stakes`, on its lobby row and in its
header, and the 0.10 a player actually posts appeared nowhere. The DB guard
accepts it — it only requires `bb > sb > 0`.

A limit game whose small blind is not half the big blind is not a structure
anyone plays, so the ladder is restricted rather than the label taught to carry
a blind the format does not have. Four presets (`0.02/0.05`, `0.10/0.25`,
`2/5`, `10/25`) are no longer offered for `flh`/`flo8`; the no-limit ladder is
untouched. Verified against production first: there are zero fixed-limit cash
tables, so nothing live is relabelled.

## Audited and found correct

- **Satellite seat awards.** The chain is complete and was traced end to end:
  `TournamentManagerEliminations` detects the finish, `processSatelliteAwards`
  runs the plan in `satelliteAwardPlan.ts`, and `fn_award_satellite_seat` seats
  the winner transactionally. `satellite_seats` is honoured as a floor, and a
  closed or missing target falls back to cash. Both writers set the columns. No
  gap.
- **`ScheduledTournamentService` buy-in fees.** It does call `rakeRateFor` now;
  the "money bug" `buyIn.ts` names it for is fixed.
- **Horses are players.** Every `is_horse` use in these creation paths is
  identification of the fleet or the fleet driving its own horses. No exclusion
  of a horse from anything a human gets. `check-horses-are-players` passes with
  9 registered exclusions, all justified.

## Reported, not fixed — for whoever takes this next

- `ScheduledTournamentService` writes `payout_structure` and `max_players`
  directly and checks only that payouts are non-empty. `fn_create_tournament`
  has a `more_paid_places_than_players` guard; this writer bypasses it. Not
  live (the only 2-seat seeded schedule uses `HEADS_UP`), but a schedule row
  with `maxPlayers: 2` and a five-place preset would create a two-handed game
  paying five.
- MTT and XMTT inserts never write `table_size`, which is `NOT NULL DEFAULT 9`
  — the same omission already found and fixed for SNG (10,315 rows) and Spin
  (28,731 rows). Rescued downstream by a clamp in `TournamentManagerBase`, so
  it is a consistency problem, not a dealing failure.
- That downstream clamp uses `maxSeatsForVariant`, the CASH cap, on tournament
  tables. `server/src/config/tableSeating.ts` says in its own header that
  nothing there "may be applied to a table with a tournament_id". It errs in
  the safe direction (a plo5 MTT table gets 7 seats instead of the deck-legal
  9), which is why it was left alone rather than loosened by an audit.

## Files

- `src/services/TournamentService.ts`, `src/services/HorseOrchestrator.ts`
- `server/src/services/TournamentRecurringService.ts`,
  `server/src/engine/BombPotScheduler.ts`
- `src/config/blindsPresets.ts`, `src/lib/tableTemplateRestore.ts`,
  `src/pages/TableConfigPage.tsx`
- NEW `supabase/migrations/20260831f_a_bomb_pot_may_not_cross_the_fixed_limit_line.sql`
  (applied to production and verified)
- NEW `tests/unit/theFormOffersStakesTheScheduleCanPrice.test.ts`

Client 483 files / 6,843 tests, non-unit 249 / 3,446, server 274 / 3,085 — all
green, `tsc` clean both sides, and every `scripts/ci` gate run locally.
