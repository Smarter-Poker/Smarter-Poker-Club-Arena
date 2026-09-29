# Diamond Phase 9: Cross-Format Conservation, The Closed-Arena Half

September 29, 2026. Phase 9 of the Diamond Arena build programme, the line
"Test prize-pool conservation, capped exposure, rounding and cancellation
recovery". This records what now runs in CI for that line, what does not and
why, and one defect the rounding cases found. **The line stays open.**

## What runs in CI now

Cases 9 to 13 in `tests/sql/diamond-tournament-lifecycle-cases.sql`, run by
`tests/sql/run-diamond-tournament-lifecycle.py` through
`scripts/ci/run-diamond-sql-acceptance.py`, against the installed doors and
with both arena switches closed:

- **One table of formats (case 9).** Plain MTT, sit-and-go, flat bounty, PKO
  (twice: a buy-in that does not divide by ten, and one too small to carry a
  fee) and mystery bounty, each created through the installed create door with
  a configuration the estate already committed. Each is priced at the Diamond
  unit: the fee is floored to a whole Diamond and the fraction a chip event
  would keep stays in the buy-in; one entry is prize + bounty + fee in whole
  Diamonds that sum exactly; the mystery chest range is whole, its fraction cut
  rather than paid. Every tournament type the estate names is either a row in
  the table or refused by the door by name, so **adding a format is adding a
  row** - satellites and spins fail that check the day the door admits them
  until their row is added.
- **Capped exposure (case 10).** For every format, one Diamond out of the prize
  or bounty bank is refused by name (`diamond_tournament_bank_short`), one
  Diamond drained from any bank is refused by name
  (`diamond_tournament_custody_short`), the pay door has no fee category to
  overdraw through, and the escrow reader answers from Diamond custody,
  enforced. Thirty-six refusals move nothing and burn no credit key.
- **The closed switch (case 11).** An exactly priced entry into every format is
  refused and locks no entry contract.
- **Cancellation before launch (case 12).** Every format cancels fully settled,
  owing nobody, every bank at exact zero; the same cancellation again returns
  the stored receipt byte for byte and writes no second one.
- **Rounding at unit 1 and at the Diamond unit (case 13).** Four pure pricing
  doors joined the lifecycle capture (26 doors now): the prize ladder the
  terminal prices every paid place with, both versions, and the final-field
  generator entry close commits. Their md5s were re-checked against production
  on this date. 144 committed ladders and 30,000 generated ones (fields 1 to
  40 at 10, 15 and 20 percent, banks of one to four Diamonds an entrant, both
  versions, both units) spend every bank exactly in whole units and never pay
  below zero; the version 1 residue lands on the last paid place; a bank
  smaller than the paid places pays one whole Diamond each from the top.

Run locally the way CI runs it (the wrapper, `--only
run-diamond-tournament-lifecycle.py`, PostgreSQL 17.11): passed.

## What this does not prove, and why

The funded half of the line is not in CI: an event's entries in equal to its
prizes, bounties and fees out with custody released, banks at zero and the
supply identity unchanged; cancellation after a launch, after a rebuy and after
a paid bounty; and replays of registration, unregistration, rebuy and payout by
request id. Two things stand in the way.

1. **The switch.** Every one of those cases needs a Diamond entry, and
   `fn_poker_diamond_reserve` refuses every tournament entry while
   `tournaments_enabled` is false. The lifecycle law forbids any file this
   runner loads from opening either switch. Whether a fixture may open
   `tournaments_enabled` inside its own disposable cluster is the owner's
   decision (`run-diamond-controlled-play.py` already opens
   `cash_games_enabled` in its own isolated database).
2. **Doors not captured.** The funded path runs through functions that are
   absent from the historical base or render differently there than in
   production today: `fn_register_for_tournament_request` and the rebuy money
   core `fn_ca_process_tournament_chip_purchase_money_v1` (absent),
   `fn_register_for_tournament(uuid, boolean)`, `process_tournament_rebuy`, the
   launch doors, `fn_collect_bounty`, the terminal
   (`fn_complete_tournament_terminal`, `fn_settle_tournament_places`,
   `fn_settle_tournament_rake`, `fn_credit_and_log`) and
   `fn_ca_diamond_register_vs_supply`, plus the UPDATE half of the
   `tournaments` trigger chain.

A rolled-back production rehearsal on 2026-09-21 drove the funded half for all
five formats through the installed doors and passed 620 of 620 assertions, but
it opened the switch inside its transaction, which this round's rules forbid,
and the estate has moved since. It is history, not evidence for this line.

## The defect the rounding cases found

**Version 1 of the prize ladder pays a lower place more than a higher one at
the Diamond unit.** A Diamond event is created with `payout_math_version` 1 and
entry close regenerates its ladder with `fn_ca_payout_structure`, so the
terminal prices its places through `fn_ca_prize_ladder` at a unit of 100 cents.
That function rounds each place above the last to the nearest whole Diamond and
gives the last paid place whatever remains. On the generated ladders the
accumulated residue can lift the last place above the one before it:

- 21 entrants paid at 20 percent, a 27-Diamond prize bank: exact shares
  10.40/5.98/4.32/3.43/2.87, paid **10/6/4/3/4** - fifth place is paid more than
  fourth.
- 51 entrants at the default 10 percent, a 55-Diamond bank: sixth place is paid
  6 and fifth place 5.
- 108 of the 7,500 generated ladders case 13 prices invert at the Diamond unit.
  None inverts at unit 1, and version 2 (largest remainder) inverts at neither
  unit: the same 21-entrant bank pays 10/6/4/4/3.

It should never pay a player more than a player who finished above them. The
failing assertion is kept out of the suite (it has no expected-failure
convention) and the case says so where it would have been.
