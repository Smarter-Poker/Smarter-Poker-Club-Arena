# Fifty drained entries: returned to their events, or refunded where the board never filled (2026-10-07)

Follows `2026-10-07-four-stuck-spins-a-refused-finish-is-not-a-stalled-one.md`
(#6424), whose "Not settled here" section listed these rows.

## What the 15:33 drain left behind

At 15:33:04 UTC on 2026-10-06 a psql session ran the patterned-identity force
drain under `session_replication_role = replica`, marking every `registered` or
`playing` row of the retired horse cohort `eliminated` with no
`elimination_sequence` and no guard trigger running. #6424 fixed the stamp
(`ENABLE ALWAYS`) and settled the four running Spins. Measured at 15:07 to
15:35 UTC on 2026-10-07, the same UPDATE had also written:

| event                          | kind               | start            | drained | money state                                                                 |
| ------------------------------ | ------------------ | ---------------- | ------- | --------------------------------------------------------------------------- |
| 73ff3bdc Wednesday Feature     | MTT 18+2           | 2026-10-08 02:00 | 30      | each a satellite_seat or ticket entitlement of 20.00, no tranche, in escrow |
| 28515bbb Six-Card Feature      | MTT 18+2           | 2026-10-09 02:00 | 16      | same                                                                        |
| 2f906cbc 50 Chip Spin PLO4     | seat-first, 3 seat | 2026-10-06 15:33 | 2       | wallet_charge 50.00 each, chair closed holding 300                          |
| 0801e005 NLH Heads-Up 20       | seat-first, 2 seat | 2026-10-06 15:33 | 1       | wallet_charge 20.00 (19.00 + 1.00), chair closed holding 1000               |
| 4ddcf172 PLO4 Heads-Up 2 Turbo | seat-first, 2 seat | 2026-10-06 15:35 | 1       | wallet_charge 2.00 (1.90 + 0.10), chair closed holding 300                  |
| edd8525d, d1c6131c, 3aa67ff3   | cancelled 08-28    | -                | 1 each  | refunded at cancellation on 2026-08-28 (one credit per debit); nothing owed |

No other tournament, in any status, holds a row the drain wrote (every
`eliminated` row with a NULL sequence and an `eliminated_at` in that minute is
in the eight events above). No `financial_alerts` row names any of them.

All 38 identities are retired horses (profiles closed 15:41, `horse_status`
`disabled` since 15:07 on 2026-10-06). They are settled exactly as people
(CLAUDE.md 10.5).

## What was done

`20261007151627_drained_registrants_return_to_their_events_and_the_three_unf`,
one transaction, every number asserted before and after.

**Wednesday Feature and Six-Card Feature: the 46 entries are returned.** Each
entrant still holds its paid entitlement, the escrow bank and the pool still
count it, and none chose to leave. The roster row goes back to `registered`
with `eliminated_at` cleared, under the registration door's own lock order and
with every row trigger live; the count is republished by
`trg_sync_tournament_current_players`. No money moves.

The four-table limit (`fn_enforce_booking_game_cap`) treats this as a new
claim and refused it in the first probe: these identities hold four Spins at a
time almost continuously. The migration therefore takes each entrant's own
`table_cap:` lock first, so no new game can start for them, and waits, holding
nothing else, up to 240 s for a running game to end. If one is still at four
games it aborts with nothing written.

**The three seat-first boards are cancelled and every entry refunded in full**
through `atomic_cancel_tournament` as the service role (the call
`fn_spin_expire_unfilled` makes, and the path #5767 used for four unfilled
heads-up satellites). A seat-first board is paid when you sit and starts only
when it fills, and the platform's rule for one that does not fill is that the
seat gets its chips back (`spin_fill_policy`, 30 minutes). These were bought 24
hours ago and never filled; nothing was drawn or dealt, so cancelling undoes no
result (unlike the four Spins in #6424). Starting them would mean reviving a
closed chair on an unstarted board, and the only door that seats a player
there is a paid buy-in, which would charge the entry twice. Heads-up boards
have no expiry sweep of their own; the same seat-first rule was applied rather
than a new one invented. 122.00 is returned, fees 1.10 reversed, escrow closed
at zero.

**The three August events are left alone.** They were cancelled and refunded
on 2026-08-28; the drain changed a stale flag in an event that is over.

## The paragraph

The 15:33 drain took 50 paid entries out of five events that had not started.
In Wednesday Feature (starting 02:00 UTC on 2026-10-08) the 30 entrants, and
in Six-Card Feature (2026-10-09 02:00) the 16 entrants, were registered and
paid through satellites or tickets and never asked to leave; each gets the same
registration back and plays the event it paid for, so the fields return to the
counts their prize pools always reflected and nothing is charged or paid. In
50 Chip Spin PLO4 (flophawk and xXLegendXx, 50.00 each), NLH Heads-Up 20
(STRADDLEREG, 20.00) and PLO4 Heads-Up 2 Turbo (MUCKBANDIT, 2.00) the board
was never filled and no card was dealt; under the seat-first rule that an
unfilled seat gets its chips back, each board is cancelled and each entrant is
refunded the whole buy-in and fee once, to their own club wallet. The three
entrants of the August events that were already cancelled were refunded then
and are owed nothing. Nobody is paid twice and nothing is taken back.

## Proof

Self-aborting DO block against production at 15:32 UTC on 2026-10-07: 46
restored (Wednesday Feature 297 -> 327, Six-Card Feature 175 -> 191), 3 boards
cancelled, 122.00 refunded, 0 unsequenced eliminations in any open event,
`fn_ca_mint_register_attribution().register_drifts` 0,
`fn_ca_diamond_register_vs_supply().difference` 0.00; rolled back.

## Found and not fixed here

The retired identities are still being seated. Since the bench at 15:07 on
2026-10-06 the 38 have taken 9,690 seats in 24 hours (74 live at 15:20 on
2026-10-07), mostly Spins and heads-up boards, and 47 retired identities have
been seated since their profiles closed. `HorseFleetManager` excludes
`horse_status = 'disabled'`, so some other seat-first fill path is ignoring the
bench. That is a separate defect for the retirement's owner.
