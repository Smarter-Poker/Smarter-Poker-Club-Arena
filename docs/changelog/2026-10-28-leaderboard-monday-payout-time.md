# Leaderboard payment time

The owner requested Monday at 02:00 America/Chicago for every leaderboard
payment, with monthly prizes on the first Monday after the month closes.
The existing settlement job ran daily at 00:20 UTC instead.

The existing job now uses two Monday UTC ticks (07:00 and 08:00), with a
Chicago weekday/hour check so exactly one invokes settlement across DST.
The original worker also excludes rounds whose individual Monday due time
has not arrived. Its canonical Sunday UTC weekly and calendar monthly ranking
windows, advisory locks, program selection, batch identities, funding and
per-player credit keys remain unchanged. Installation does not settle a round.

Native PostgreSQL qualification installs the real worker, applies the migration,
checks summer/winter and month boundaries, executes both scheduler ticks,
and verifies early refusal, weekly/monthly eligibility, replay no-op, atomic
rollback and preserved worker metadata. It runs in the existing directly
triggered weekly financial qualification workflow. Fixture payout dependencies
record calls in isolation; this is not a production-money test.

The financial audit separately reconciled all 15 recorded awards (2,500 Chips)
to exact wallet-credit keys and 15 wallet transaction credits. Recent zero
rounds and union attribution remain under investigation; this timing change
does not rewrite settled records or claim a corrective payment occurred.
