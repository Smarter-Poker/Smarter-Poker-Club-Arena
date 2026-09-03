# The create-tournament modal could not create most of what it offered

Dan, 2026-08-31: _"DO A DEEP DIVE INTO THE GAME CREATION CODE, FUNCTIONALITY AND
USABILITY TO INSURE THAT IT WORKS PROPLERLY... CHECK FOR ANY AND ALL BUGS, GAPS,
STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE."_

This is the first pass: the tournament creation path. Everything below was read
from the **live** `fn_create_tournament` and the **live** schema, not from the
migration files — three migrations define that function and the deployed body
differs from all three. Two findings that looked critical on the migration text
turned out to be already fixed in production; they are recorded at the bottom so
nobody re-fixes them.

## 1. CRITICAL — every MTT, bounty, satellite and XMTT failed before a row was written

```
v_max_players := COALESCE((p_config->>'maxPlayers')::int, 0);
IF v_max_players <= 0 THEN RETURN 'max_players_must_be_positive';
```

`CreateTournamentModal` sent `maxPlayers: 0` for **eight** of its ten formats —
freezeout, rebuy, re-entry, bounty, progressive bounty, mystery bounty,
satellite and XMTT — under the comment `0 = unlimited`. There is no unlimited
field: registration is refused once `current_players >= max_players`, so zero is
a locked door, and the insert never reached that point anyway.

`tournamentFromTableConfig` has said exactly this in a comment since 2026-08-19
and clamps with `Math.max(2, …)`. This screen never got the same fix, and it had
no Max Players control at all to reveal the problem.

Fixed: an explicit **Max Players** field for the MTT family, defaulting to 500
(live MTT caps run 30–500), and `fieldCapFor` floors whatever reaches submit.

## 2. CRITICAL — "Heads Up (2)" could not create a single Sit & Go

```
IF jsonb_array_length(v_payouts) >= v_max_players
  THEN RETURN 'more_paid_places_than_players';
```

The modal picks `sng6` for any field ≤ 6. `sng6` pays **two** places (65/35). A
two-seat field with a two-place ladder is `2 >= 2` — refused, every time. The
table-config path never hit this because `payoutEngine.payoutsForChoice` already
caps paid places at n−1.

Fixed: `capPaidPlaces` trims the ladder below the field and renormalises to
exactly 100 (unnormalised would just swap one refusal for another). Heads up
becomes winner-take-all, which is what a two-handed game is.

## 3. CRITICAL — every XMTT was refused by a database trigger

`handleFormatChange('xmtt')` ran `setIsMultiDay(true)` — "XMTTs are typically
multi-day". Multi-day is **not built**, and `trg_tournaments_refuse_unbuilt_multi_day`
RAISEs `0A000` on insert when the flag is set. The checkbox only renders for the
three `mtt_*` formats, so the operator could not see or clear it.

The same shape existed for every other format: `isMultiDay` was reset only in
the `sng` and `spin` branches, so a flag ticked on a freezeout survived a switch
to Bounty or Satellite — invisible, and fatal.

Fixed: the line is gone, and `isMultiDay` resets at the top of
`handleFormatChange`, so the flag can only ever be true on a format that shows
its control.

## 4. MAJOR — Spins created here ran the MTT turbo ladder

`effectiveBlinds` read `BLIND_STRUCTURES[blindSpeed]` for every format.
`blindSpeed` defaults to `'turbo'` and `handleFormatChange('spin')` never touched
it, so a Spin & Go — a hyper-turbo by definition — got the thirty-level MTT
turbo ramp. `SPIN_BLIND_STRUCTURE` is imported by `tournamentFromTableConfig`,
`TournamentService` and `HorseOrchestrator`, and was referenced **zero** times
in this modal.

Fixed: a Spin gets the spin ladder.

## 5. MAJOR — the fee quoted and the fee charged disagreed

`src/utils/buyIn.ts` states the law and why it exists:

> "The rule is keyed on SEATS, not on the word 'SNG'. A two-handed game is a
> duel whatever its label says, and a label is exactly the thing that varies
> between six writers."

Five writers follow it. `fn_create_tournament` keyed on the **label**:
`type = 'sng' → 5%`, else 10%. So a 6-max or 9-max Sit & Go was quoted 10% by
this modal and charged 5% by the database, and a two-handed game under any other
label paid the full 10%.

Migration `20260831_tournament_fee_is_keyed_on_seats_not_on_the_word_sng.sql`
rewrites exactly one CASE expression to `maxPlayers BETWEEN 1 AND 2 → 5%`. It
refuses to run unless it finds the old expression exactly once, and asserts the
result afterwards, because the function is ~300 lines of money path and
re-emitting it by hand to change one line is how transcription errors ship.
**Applied to production and verified** by re-reading the deployed definition.

No price a player pays moves: heads-up (12,755 of the last fortnight's 13,489
Sit & Gos) is 5% before and after, and no 6/9-max Sit & Go has been created
through this function since the rake cap landed on 2026-08-21. What changes is
that the quote and the charge agree.

## 6. MAJOR — `minPlayers` was hard-coded 3 for every format

An SNG starts only when it is **full**, so a 9-max Sit & Go stored with
`min_players: 3` advertises a threshold that means nothing. The RPC's own clamp
hid it only in the 2-max case. Now `minPlayersFor` mirrors
`buildTournamentConfig`: the cap for a game that starts when full, a real
threshold otherwise, never above the cap.

## 7. MAJOR — table size was not clamped by the deck

The modal clamped 2–10 and nothing else. PLO5 deals five cards a seat and PLO6
six, so a ten-handed table wants 50 or 60 hole cards plus a board out of one
52-card deck, and `PokerEngine.deal()` **throws** rather than dealing short — the
tournament starts and then sits there. `tournamentFromTableConfig` has applied
`maxSeatsTheDeckAllows` since 2026-08-24, so the same 10-seat PLO5 was creatable
from one form and refused by the other. Now clamped by the deck, and by the
field itself.

## Extracted so it can be tested

`src/lib/tournamentFieldRules.ts` holds `fieldCapFor`, `minPlayersFor` and
`capPaidPlaces` — the two numbers the database refuses on — so they can be
asserted without rendering a 2,000-line form. Same reason
`tournamentFromTableConfig` was extracted from `TableConfigPage`.

`tests/unit/tournamentFieldRules.test.ts` pins them, including the exact
combination the modal shipped: "Heads Up (2)" + `sng6`.

## Why this was reasoned about rather than probed

`fn_create_tournament` opens with `IF auth.uid() IS NULL THEN RETURN
'not_authenticated'`, so a service-role probe proves only the auth gate. Per
CLAUDE.md 11.5 rule 5 the refusals were read from the **deployed function
definition** and asserted in unit tests; the live creation path was not executed
and no chips were moved.

## Two findings that were already fixed in production

Recorded so they are not chased again. Both come from reading the migration
files instead of the database:

- **`round()` vs the rake cap.** `20260822100200` and `20260823103000` compute
  the fee with `round(v_total * 0.1)`, which exceeds the ≤10% CHECK for every
  buy-in whose tens digit is 5–9 (5, 15, 25 …, all on the published ladder). The
  **deployed** function uses `trunc(… * 100 + 1e-6) / 100`. Not a live bug.
- **The rake CHECK using `floor()`.** The live constraint is
  `fee <= (amount + fee) * 0.1 + 1e-9` — no `floor`. A later migration replaced
  the one in `20260821_tournament_rake_cap.sql`.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/` — 474 files, 6,732 tests, all passing.
- `npx vitest run tests/ --exclude 'tests/unit/**'` — 235 files, 3,305 tests, all
  passing.
- Migration applied via the Supabase MCP and re-read from `pg_get_functiondef`:
  the deployed fee line now reads
  `CASE WHEN COALESCE((p_config->>'maxPlayers')::int, 0) BETWEEN 1 AND 2 THEN 0.05 ELSE 0.1 END`.

## Still open from this audit

The cash-table path (`TableConfigPage`) has its own verified list, headed by one
that is live on 900 of 973 cash tables: choosing **Run It Multi-Times: None**
does not disable run-it-twice, because the page writes only
`run_it_twice_enabled` while the engine's gate is an OR over three columns whose
other two default to `true`. That is the next pass.
