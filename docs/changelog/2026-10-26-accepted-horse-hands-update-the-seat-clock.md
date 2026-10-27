# Accepted horse hands update their physical seat clock

The accepted-hand facts route bypasses the legacy net accumulator. Seat touches
were still queued in memory, but only the bypassed accumulator starts their
flush timer. On October 26, 890 seated horses had no activity stamp in two hours;
the latest fleet action stamp was October 25 at 23:54 UTC.

The stats projector now advances a physical horse seat's activity timestamp in
the same transaction as its existing accepted-hand receipt and paired daily
counts. It uses the accepted fact's timestamp and current matching table
identity. Replays, concurrent projection, older hands, moved seats and Lightning
host hands cannot falsely advance a seat. Session counts keep their existing
owner. No timer, repair loop or historical backfill is introduced.

The maintained PG17 daily-count qualification now includes the seat clock.
The new regression failed against the original projector, then passed with this
migration. Fault injection at the seat update rolls back the counts and receipt;
recovery of the same accepted hand commits once. Existing permissions, payload
validation, paired counts and Lightning coverage remain tested. Installation and
natural production readback are tracked separately in the task evidence.
