# Retire blind clocks at verified tournament completion

A verified terminal receipt can exist while table shutdown or channel cleanup is
still pending. Those managers correctly retain their engines and leases, but their
blind timers kept attempting new levels against completed tournaments. The database
refused the transition, and the one-second retry kept repeating it.

Normal, satellite and final-table deal terminal tails now retire only the level
clock immediately after receiving their verified terminal receipt. A queued timer
or late publication reply cannot rearm the clock, announce another level, or change
the manager's level after that boundary. Physical engine cleanup, lease custody,
retained terminal receipts and payout behavior remain unchanged. The precommit
finish latch does not retire a live clock.

Validation covers all three terminal tails with cleanup still pending, queued
wakes, attempts to rearm, late success and refusal responses, and the precommit
latch. Existing maintenance/thaw, blind recovery and terminal cleanup cases remain
required. This source repair does not establish that all observed live blind
refusals or retained managers have the same cause.
