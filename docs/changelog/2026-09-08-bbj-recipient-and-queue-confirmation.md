# BBJ Recipient And Queue Confirmation

This batch corrects several connected defects in the existing jackpot flow:

- Notifications previously inferred wallet/seat delivery from engine memory. They now require readable credit and unpaid-share records for the payout, matching recipients and amounts. Missing, contradictory or incomplete records suppress payment notices and report an error.
- Parked recipients receive Payment Pending copy rather than You Got Paid. Confirmed-credit copy does not guess wallet or table placement, since recipient rows do not store that destination.
- A recipient is notified once per notification attempt even if the input roster repeats that user. The two principal winners are included even if absent from the dealt-in array.
- The critical alert previously marked queued:true whenever a writer was registered. Only an acknowledged insertion or confirmed single open-claim update now establishes that flag. Writer failure or an unacknowledged return says persistence is not confirmed.
- Duplicate queue-claim updates now check both the error and exact affected-row count. They cannot silently report success on a failed update or zero/unknown/multiple rows.

## Verification

Actual-module baselines reproduced five recipient-notification failures and three queue-acknowledgement failures. Recipient regression tests also cover duplicate input and avoid stale-seat destination assertions. Six direct tests exercise the real queue writer's inserted and duplicate-claim acknowledgements.

Server TypeScript passed. Full suite: 6,849 passing tests, with one old stub failing because it supplied no explicit write acknowledgement. After correcting that stub, the final targeted run passed 49 tests across the payout and real-writer suites. No test assertion was weakened to accept an unconfirmed write. Normal pre-push gates remain required.

## Limits

No production wallet changes, schema migration, forced restart, or manual notification was executed. These tests exercise actual engine modules with database boundaries mocked; they do not prove live delivery or database concurrency safety.

Notifications remain best-effort. Read/insert failures and replay notification delivery still need a durable delivery design. Credit rows do not prove a particular wallet/seat destination, and a parked share may redeem between the separate reads. Contradictory snapshots are reported instead of guessed. Queue durability acknowledgement does not eliminate the failure window when both database writes and alerts are unavailable. The existing pending outcome remains compatible with callers; its critical alert carries the explicit queued confirmation flag.

Database hand-destination fencing, weekly-close atomicity, historical satellite funding, Backup BBJ/promo accounting and the wider 216-requirement audit remain incomplete. Source verification is separate from deployed engine adoption.
