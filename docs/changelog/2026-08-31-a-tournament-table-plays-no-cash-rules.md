# A tournament table plays no cash rules

2026-08-31

Dan, quoted in `ServerTableEngineBase.applyRunItTwiceConfig`: **"run it twice or
3 times is a cash game only area. it should never be in MTT, SPINS OR HEADS
UP."** The gate exists in that one function. Every other cash-only money rule
had leaked past it — one of them all the way to the player's screen.

Measured against production the same day: **105,078** tournament table rows.

## 1. The Game Rules modal lied to tournament players (LIVE)

`TableModalsLayer` gated exactly one row on `!isTournament` — straddle. Its
neighbours were ungated, and one of them was worse than ungated:

- **RUN IT TWICE was lit on every table in the product.** The modal read
  `isRunItTwiceEnabled={runItTwice ?? true}`, and `runItTwice` was a
  `TableState` field **declared and never assigned** (`TablePage.tsx:609`). The
  fallback therefore won on every table, cash or tournament, whatever the
  columns said — advertising an offer the engine can never make on an MTT,
  Spin or Heads Up felt. The columns cannot stand in for it either:
  `run_it_twice` and `allow_run_it_twice` are true on **all 105,078**
  tournament rows and the legacy `run_it_twice_enabled` on **28,651**. So
  `TablePage` now computes the value with the ENGINE's own predicate —
  tournament gate first — and the modal applies the cash-only gate to every
  row at once from a single `isTournament` prop.
- **Rake read the cash schedule.** `displayRakeConfig` is keyed on stakes and
  fell through to the top cash tier on a tournament's level blinds, so the row
  printed e.g. "10% (Cap X)" while `ServerTableEngineDealing` passes
  `{ percent: 0, cap: 0 }` for every tournament table (`rake_percent > 0` on
  **0** tournament rows). It reads **None**. `useEffectiveRake`'s own header
  states the requirement: "The Game Rules modal must show the number the engine
  really uses."
- **Min/Max Buy-In printed "0 / 0"** — the literal columns every tournament
  table is created with (**105,078 of 105,078**). A tournament seat is bought at
  registration, so the rows are hidden.
- **The Straddle chip described the READER, not the table.** `TablePage` passed
  `isStraddleEnabled` — the hero's own auto-straddle enrolment — so a cash table
  that genuinely allows straddling showed the feature as unavailable until the
  player happened to enrol. It passes `tableStraddleEnabled`, the column the
  engine plays by.
- **The Insurance chip was DARK on every table** — the exact mirror of the
  run-it-twice lie. `GameRulesModal` takes `isInsuranceEnabled`, defaulting to
  false, and nothing ever passed it, so a cash table that really does offer
  all-in insurance (its lobby card says so, off the same column) denied it at
  the felt. Now fed from `insurance_enabled`.

## 2. Straddle had no server-side tournament gate (LATENT)

`ServerTableEngineDealing` posted a live 2xBB straddle on
`if (this.tableInfo.straddle_enabled)` alone. A straddle is a voluntary blind
ahead of a level the structure sets, in a game whose point is that everybody
pays the same forced bets. Gated at four seams so they cannot drift: the deal
(`ServerTableEngineDealing`), the engine configuration (`ServerTableEngineBase`),
the enrolment endpoint (`ServerTableEngineSeating.toggleStraddle`) and what the
horse brain is told (`ServerTableEngineTurns.straddleActive`).
`straddle_enabled` is true on **0** tournament rows — one UPDATE makes it live.

## 3. The seven-deuce bounty had none either (LATENT)

`ServerTableEngineSettlement` gated on `seven_deuce_enabled` + saw-flop + NLH,
never on tournament. The bounty is a player-to-player transfer of table chips;
in a tournament those chips are what the elimination model, the bubble and the
payout ladder are computed from, and the transfer is a side pot the structure
knows nothing about. `seven_deuce_enabled` is true on **0** tournament rows.

## 4. The bomb pot had none either (LATENT)

A bomb pot takes a forced ante from every seated player and skips preflop. In a
tournament the forced bets ARE the structure, and a bomb ante is a second,
unscheduled one that no level owes — differing table to table inside the same
event. Gated inside `bombPotSettingsFromTable`, the single normalizer, so the
deal-time decision and the snapshot pill refuse together, plus an explicit gate
on the MANUAL claim (which reads the column directly, because a host may keep
bombs manual-only with no viable schedule) and on the manual-bomb subscription.
`bomb_pot_enabled` is true on **0** tournament rows.

## 5. Expansion tables were not the same table (LATENT)

`TournamentManager` builds late-reg/rebuy expansion tables; `TournamentManagerBase`
builds the ones at the start. Field-by-field diff of the two `tables` inserts:
**exactly one column differed** — `allow_rabbit_hunt`, added to the start payload
on 2026-08-25 so a tournament host's own rabbit-hunt setting reaches the tables
it plays on, and missed on the expansion payload for six days. An expansion
table took the column default instead, so one tournament could seat one player
at a table honouring the setting and another at a table ignoring it. All other
18 keys matched. Latent: no tournament currently has `allow_rabbit_hunt` false.
`tests/tournament-plays-no-cash-rules.law.test.tsx` now compares the two
payloads' KEY SETS, so the next field to be added to one and not the other is
caught at once.

## Law

`tests/tournament-plays-no-cash-rules.law.test.tsx` (22 pins) renders the modal
both ways — every cash-only chip dark on a tournament and lit on a cash table,
rake None vs the schedule, buy-in rows hidden vs shown — and pins each engine
gate. `server/src/engine/BombPotScheduler.test.ts` pins the bomb-pot refusal
behaviourally, across every trigger mode.

## Not touched

The CASH run-it path. Its three-board headroom is deliberate and pinned by
`tests/table-seating-caps.test.ts`.
