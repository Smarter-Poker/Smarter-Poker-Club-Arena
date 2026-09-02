# The Spin treasury, and a stack a player can see

2026-09-01, second batch. Dan set the rules; this is what production actually
did against them, and what changed.

## 1. The treasury was funded by the draw, not by the buy-ins

Dan: "after all 3 buy ins are paid for, rake is taken out and sent to the rake
treasury, and all remaining funds from the buy in goes to the [spins] treasury,
in real time as soon as the 3rd buy in is paid for."

At buy-in the money went wallet -> ledger debit and `tournaments.prize_pool +=
buy_in`, and **nothing reached either treasury**. Both the rake record and the
reserve contribution were written by `fn_spin_settle_game`, which the engine
calls at `start()` immediately after the draw. Close in wall-clock time, and
structurally backwards: funding the treasury was a downstream consequence of the
WHEEL succeeding. When settle failed its three attempts the game still ran and
still paid, and the treasury had no record of either side of it.

`fn_spin_book_entry` now books the entry the moment the last seat is paid: rake
to `rake_records`, the remainder into the club reserve pool, idempotent on its
own contribution row. It hangs off `fn_sync_seat_first_player_count` rather than
off either caller, because that is the one function BOTH seating paths reach -
so a horse funds the treasury exactly as a human does (CLAUDE.md 10.5), and a
seating path written next month inherits it.

`fn_spin_settle_game` had to change with it or the fix would have done nothing:
its idempotency guard returned `already_settled` when EITHER a contribution or a
jackpot_draw row existed, so the new contribution row would have made it skip
the prize booking entirely. It keys on `jackpot_draw` alone now, and its
contribution and rake blocks are conditional - kept, not deleted, because
`fn_spin_sweep_unbooked` still repairs games that predate the hook.

**The first cut of this shipped broken and said nothing**, which is worth
recording. `fn_spin_book_entry` called `pg_advisory_xact_lock(bigint, bigint)`;
that overload does not exist, so every call raised 42883, and the caller's
`RAISE WARNING` swallowed it. 721 Spins went on booking at settle while the hook
read as installed. Both halves are fixed: the lock takes the single-key overload
that exists, and the caller now files a `ca_drift_incidents` row instead of
warning into a log nobody reads.

Verified live: entries booking at the seat, `ok: true`, collected 9.00 / rake
0.72 / reserve_in 8.28 on a 3-chip board, and zero booking incidents.

## 2. The stack depended on what the wheel landed on

Dan: "we used to award more chips depending on if its a higher multiplier... we
are no longer doing that... they either get 300 chips for a turbo, or 1000 chips
for a deep stack. as soon as they buy in 300 chips should appear in their action
box (not 0)."

`SpinTierSpec.startingStack` was 300/300/1000/1000/1000/1000/5000/5000, chosen
by the drawn tier and written onto the row at draw time. **The two sentences are
one problem**: a stack that depends on the draw cannot be known when the money
leaves the wallet, so `fn_take_seat_and_buy_in` wrote `stack = 0` and the real
number arrived ~14.8 seconds later on the chip-drop beat. The client papered
over the gap with the row's placeholder and rendered 0 whenever that read
failed.

- `startingStack` is gone from the tier table; `SPIN_STACKS = { turbo: 300,
deep: 1000 }` replaces it. The 5000 band is retired with it. This SUPERSEDES
  the 2026-08-23 stack bands, which are quoted in the spec so nobody
  reintroduces them.
- The board is now the cross product of stake x game type x **speed**: 64
  boards. Turbo boards keep their existing names deliberately - `ensureBoardOpen`
  identifies a board by config NAME, so renaming the 32 that exist would open 32
  more and strand the old ones in REGISTERING forever.
- `fn_take_seat_and_buy_in` and `fn_seat_horse_in_seat_first_game` both write
  the board's `starting_chips` onto the seat and the player row. Same number,
  same instant, horse or human.
- 76 seats already sitting on open boards were backfilled to the number the
  table build would have written moments later.

Three tests that pinned the old rule were rewritten rather than deleted, in the
same commit that replaced the behaviour, and each says what replaced it.

## 3. One law, not two

A law test drafted here as `seatFirstStartsOnSeatsNotAClock.law.test.ts` would
have been the second law pinning `GameServer`'s start gate -
`server/src/tournament/seatFirstStartsOnSeatsNotClocks.law.test.ts` landed on
main first and already owns that line. Per LAWS.md rule 3 the duplicate pins
were deleted rather than kept, and what remained - the CREATION guards - is
registered under a name that says what it actually guards.

## Still open, and stated rather than guessed

- **The payout is not yet atomic with the treasury debit.** Dan chose atomic.
  Today the pool is debited at the draw and the player is credited later by
  `fn_credit_and_log` at bust and at finish, so the two can still diverge - the
  exact shape that produced the 112 unbooked Spins. Joining them touches the
  prize-credit path every tournament format shares, so it is its own change, not
  a rider on this one.
- **The wheel is not yet inside Dan's 1-to-3 second window.** The design already
  is: `SPIN_REVEAL.LEAD_IN_MS` is 1000ms from the last buy-in. The delivery is
  not: p50 4.1s, p90 16.3s, and it tracks load rather than climbing. That is
  start-lane latency between the third paid seat and the draw, and it needs
  profiling of `start()` rather than a guess.
