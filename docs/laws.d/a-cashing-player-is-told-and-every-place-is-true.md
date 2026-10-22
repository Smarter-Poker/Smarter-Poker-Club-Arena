# tests/a-cashing-player-is-told-and-every-place-is-true.law.test.ts

Dan, 2026-10-21: a player who cashes in a tournament is told. One
`tournament_cash` notification is written exactly once, the moment a place,
Bubble Protection, satellite seat or satellite cash obligation becomes fully
paid (`zzz_notify_tournament_cash` on `tournament_obligations`), and the
existing notification to push mirror delivers it under its normal gates. The
notice runs in its own subtransaction and can never roll back the payment that
caused it; horses receive it exactly as humans do. Once the prize pool is
finalized, `fn_ca_pay_tournament_finishers_now` restamps every unpaid standing
to its true place on every bust, in the money or not, so no player sees the
engine's provisional place; before the pool is finalized nothing moves, a paid
place is never relabelled, and money still moves only through the obligation
doors.
