# The September 8 Games Commit Their Lost Launch

Thirty events dealt on 2026-09-08 lost their engine before the launch's RUNNING
commit and stayed in REGISTERING for three weeks with 1,593.60 chips of
finalized pools in open escrow: 13 Spins (446.00), 13 heads-up Sit & Gos
(777.10) and 4 heads-up duel satellites (370.50). Every engine pass started a
manager, read "Only 1 of 2 player(s)" from a field that had already played, and
stood down. The played-game launch proof needs hand_history rows that
retention has since removed, so the launch could never complete. #5387's
archived-Spin admission is bound to one event (2aa4cba1) and was never
invoked; it cannot finish the others.

Migration `20261001225325` commits only the lost step for the 26 Spins and Sit
& Gos, through the launch's own door: an immutable `tournament_launch_receipts`
row plus the transaction-local `app.atomic_tournament_launch` marker,
REGISTERING to RUNNING with `started_at` at the moment the field was complete
(the retained first-hand witness for 2aa4cba1). Each event is refused unless
its md5 pre-image (status, pool, payout contract, roster with chips and places,
live seats, escrow banks) matches the 2026-10-01 read, and the post-image
proves roster, seats and escrow did not move. The file pays nobody.

The engine's own lanes then finish each event in its own transaction: the
seat-first finish sweep wakes the elimination sweep on the 24 decided events,
and the terminal authority pays each heads-up and 2x Spin survivor the whole
finalized pool, records the eliminated entrants in their places and holds the
pre-agreement entry fee in legacy custody (all 26 are in the 2026-09-21
custody cohort), as it did for the four Spins finished that day. The two
undecided Spins (6d359f61, 8904c10b) resume dealing and finish by play.
Nothing is taken back from anyone.

The four duel satellites (097e3601, 20c75b67, 92c93927, a4262ba0) are left
REGISTERING and untouched. Their outcome is recorded, but the satellite
authority refuses to finish while the 2026-09-08 entry fee cannot be
attributed (it predates every recorded agreement) and the legacy custody
cohort excludes satellites, so launching them would only strand them RUNNING
behind a refusal.
