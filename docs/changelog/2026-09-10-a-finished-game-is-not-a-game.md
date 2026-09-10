# A finished game is not a game, and a cap is not a failure

**Date:** 2026-09-10
**Migrations:** `20260910022325_a_finished_game_is_not_a_game_and_a_cap_is_not_a_failure`,
`20260910023919_the_entry_is_charged_to_the_wallet_the_entry_is_stamped_with`,
`20260910024302_settle_the_friday_night_feature_satellite_heads_up`
**Law:** `tests/a-finished-game-is-not-a-game.law.test.ts`
**Incident:** `2688ef4c` (`Tournament.atomic_satellite_finish_refused`), resolved with its cause

## What was wrong

Friday Night Feature Satellite Heads-Up (`9fee70de`) sat RUNNING with 38.00 in
escrow after the engine had finished it. The atomic finish returned:

    FOUR TABLE LIMIT: user 9da2d0b7-... is already committed to 5 games and
    may not enter another   (retryable: false)

Two lines, read from the rows:

1. `fn_concurrent_game_load` counted the winner's own seat at the satellite
   that was finishing. Seats are vacated after settlement, so during
   settlement the winner still "sat" at the event he had just won, and that
   seat was counted against the target entry he was owed. A seat at a
   COMPLETING / COMPLETED / CANCELLED event is history, exactly like a seat
   at a closed table, which the same clause already excluded.
2. `fn_deliver_satellite_ticket_exact` never asked whether the seat could be
   taken. It already turned "target closed", "target full", "economics
   changed" and "seat held elsewhere" into cash through the exact obligation
   path; the cap was the same class of reason, but the function attempted the
   seat, the booking-cap trigger raised, and the whole settlement failed as
   non-retryable. The non-atomic gate path had checked the cap since it was
   written; the atomic path the engine calls did not.

And a third, found while proving the settlement in a rolled-back probe: the
wallet a tournament entry is **debited** from and the wallet the entry is
**stamped** with (`tournament_players.club_id`, where every prize and refund
is credited) were resolved by two different functions. The stamp used the
union-aware `fn_tournament_club_for_user`; the debit
(`atomic_deduct_wallet_and_log`, since `20260909212340`) read
`tournaments.club_id`, which for a union-hosted event is the union's house
club. Measured on the buy-in ledger for union events over 24h: **3,232 of
5,863 entries (73,659.00 chips)** were charged at one club wallet and would
be paid at another. Per player the chips conserve; per club the house-club
wallets drain by every buy-in and the member-club wallets fill by every
prize, until a house-club wallet hits zero and the next union entry is
refused.

## What changed

- `fn_concurrent_game_load` clause (1) excludes a seat whose table's
  tournament is COMPLETING, COMPLETED or CANCELLED. Every cap reader
  (`fn_enforce_booking_game_cap`, `fn_enforce_four_table_limit`, the
  satellite gate, the delivery function) reads this one function; the
  migration proves all four still do.
- `fn_deliver_satellite_ticket_exact` takes the cap triggers' per-user
  advisory lock, reads the count the booking trigger will read for the same
  target, and if the winner is at the cap delivers the frozen value as cash
  (`delivery_reason: four_table_cap`) before any write. Asserted text
  substitution on the live definition; the anchor must appear exactly once.
- `atomic_deduct_wallet_and_log` resolves the wallet for a tournament debit
  (and for a table debit at a tournament table) through
  `fn_tournament_club_for_user` with the declared ledger club as its
  preferred club - the same call the stamp makes. No wallet in the union
  resolves: refused out loud (`42501`), never charged at an unrelated club.
  Proven on the live horse path in a rolled-back probe: debit `a41434bb`,
  stamp `a41434bb`.
- One-time correction shipped with its cause: **746** in-flight entries
  (REGISTERING / RUNNING / COMPLETING, no settlement batch) whose stamp
  differed from the wallet their newest buy-in row proves was charged were
  re-stamped to the charged wallet, so their prize or refund returns where
  the buy-in left. Completed events were left alone (10.9 rule 3).
- The satellite was settled through `fn_settle_satellite_finish_atomic`
  under the engine's own `recovery` authority, after the fix, exactly as
  probed: 30.00 to `9da2d0b7` (position 1, cash, four_table_cap), 8.00 to
  `a2bd256e` (position 2), 2.00 rake to the union, both credits to the
  `fade0000` wallets the 20.00 buy-ins left, escrow 0.00 / 0.00 / 0.00,
  event COMPLETED, seats vacated. The winner is a horse; per 10.5 that
  changed nothing about what he was owed.

## Corrections to my own earlier reading

- The satellite was not "16 hours" old: its buy-ins are timestamped 01:11
  UTC and the refusal 01:14. The incident card's age was the age of the
  first refusal chain, not the event. The migration header for `20260910022325`
  carries the "16+ hours" figure from the incident; the settlement migration
  and this changelog carry the correct one.
- The database went to `RESIZING` at 02:31 UTC while this work was in flight
  (Supabase compute resize, not anything I applied - migration 1 had
  committed at 02:23 and survived). Postgres was back at 02:34:36.

## Also in this branch

`#4073` and `#4074` (a closed table closes its sessions; a vacated seat closes
its session at commit) were red only because the nightly schema manifest had
not absorbed their two trigger functions. Re-landed on
`fix/a-session-cannot-outlive-its-seat-landing` with a fragment under
`scripts/ci/schema-manifest.d/`, the sanctioned path.
