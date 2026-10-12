# Spins And Heads Up Connected UI Audit

The connected audit reproduced stale top-prize badges on club changes, two Quick Join query gaps, and winner-dialog keyboard and dismissal gaps.

- A live reload paired an unrelated standalone club with Midway Union. The masthead now reads and verifies the viewer club's union affiliation before printing the pair. An unverified club name is withheld while the verified union remains visible.
- Availability state carries its club identity. A new or missing club cannot paint the old club's 100x badge. Failed reads retain only the prior club-scoped cache and report their error.
- Spin candidates use the same variant-or-tournament-type classification as the active Spin. A missing club scope returns an unreadable result before any global candidate query.
- The winner dialog traps focus and handles Escape only on the active table. Its initial focus can scroll Continue into view on a landscape phone. The table's betting/rabbit shortcuts also stand down while the winner owns its keyboard.
- The prize remains at its last earned value during dismissal, rather than resetting to zero on the closing fade.
- Withdrawing a winner retires its pending dismissal timer, preventing an old callback from dismissing a replacement result.

Regression cases failed before each repair and passed afterward. The integrated client suite before the final dismissal-value correction passed 35,892 assertions across 2,612 files with one existing skip. Seventeen focused engine suites passed 243 assertions without skips. Forty-six card/table/footer geometry cases passed. Real component browser checks covered winner focus, Escape, restoration and background-table ownership at 375x667, 393x852, 852x393 and 1440x900, plus the actual wheel's rotation, 100x landing and chip currency. The final dismissal-value case and related winner checks are requalified separately. The masthead regression executes the real TablePage read continuation against matching and unrelated club rows. These local checks do not substitute for protected CI, publication or production proof.

The audit traced reveal clocks/deal holds, reserve-locked tiers, prize units, winner currency, PLO4/5/6 live/showdown cards, masthead reload recovery and the previous-hand/time-bank/rabbit controls. No server, database, payout-policy or wallet write is changed.
