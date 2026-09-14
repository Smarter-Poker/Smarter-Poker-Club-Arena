# The promo funding button is safe to press twice

**2026-09-11. Dan: "NOW TAKE EVERYTHING YOU JUST SAID NEEDED TO BE DONE, AND
BREAK THIS DOWN INTO PHASES AND BUILD THEM OUT ONE PHASE AT A TIME." Phase 1 of 6.**

Continues `docs/changelog/2026-09-11-the-welcome-spin-keeps-its-own-books.md`.

## The defect

`fn_diamond_game_fund_promo` is the console button that moves a host's chips
from its bank into the promo wallet, and the promo wallet is what pays every
chip prize in all three games. It was written on 2026-09-10 with this line:

    v_key text := 'diamond-games-fund:' || gen_random_uuid()::text;

A key the server mints per call is not an idempotency key. The journal's
`ux_chip_ledger_idempotency_key` index is a real unique index and it was doing
its job perfectly; it simply cannot refuse a key it has never seen. So a
double-tap on the console, or a request that succeeded on the server and lost
its reply on the way back, moved the chips twice and wrote two legs that both
looked entirely legitimate.

A rolled-back probe on production proved it before anything was changed: two
identical presses of 25 chips moved 50, under two generated keys.

`disabled={funding}` was never a defence. It is released the moment the promise
settles, and it never existed for the retry at all.

## The key now comes from the caller

The console mints one token per **intent** and sends the same one for every
retry of that intent, so the server can tell "the operator asked again" apart
from "the operator asked once and we did not hear the answer". The server
namespaces what it is handed, `'diamond-games-fund:' || p_key`, so a caller can
only ever write inside this function's own keyspace, and it checks the shape
before using it. A key it cannot trust is refused in words; falling back on a
generated one would be the bug wearing a validation check.

The keyless two-argument signature is dropped, not left open beside the new
one.

The guard is check-then-act, and it is safe because of where it sits.
`fn_diamond_game_cover_lock` has already taken the host's wallet row `FOR
UPDATE`, so two presses for the same host serialise on that lock: the first
writes the leg, the second wakes, sees it, and returns the balances with
`replayed = true` having moved nothing. The unique index stays behind it as the
hard stop.

And the guard is made load-bearing. The function now refuses to return unless a
leg actually carries the key, because replay protection that depends on a
journal row is worth nothing if the row can quietly not be written. It is the
same assertion `fn_diamond_game_pay_chips` already makes.

The browser half is pinned too, because one key per **press** would put the bug
straight back: both operations pages mint on a new amount, hold the key across a
thrown request, and clear it only where the server has actually answered.

## A standalone club owner gets their own wallet history

The old body wrote `union_wallet_transactions` inside `IF v_kind = 'union'` and
wrote nothing at all for a standalone club, even though
`club_wallet_transactions` exists and is what a club owner's wallet history
reads. The chip ledger always carried the leg, so the money was never untraced.
The operator just could not see their own money move on the surface built to
show them their money moving. Both host shapes write a row now.

`club_wallet_transactions_type_check` is a fixed vocabulary and none of its nine
other words mean "this club moved chips between its own two wallets", so the row
is booked as `other` with a reason that says what it was. That table also
carries `chk_amount_is_two_decimal_places`, which this function could previously
have thrown against, so the amount is checked at the door and answered in words
instead.

## Verified

A rolled-back probe on both host shapes, Club JAQK under Midway Union and Deep
Stack Society standing alone. For each it asserted that the keyless door is
gone and exactly one keyed door exists, that anon cannot execute it and
`authenticated` can, that the first press moves the chips and writes exactly one
leg and exactly one wallet-history row, that the same key again returns
`replayed` and writes no second leg and no second history row and leaves the
promo wallet where it was, that a different key is a different intent and moves
again, and that six bad requests are refused: a five-character key, a null key,
a key with spaces, 1.005 chips, more chips than the bank holds, and a plain
member asking.

The host's wallet row is taken `FOR UPDATE` at the top of the probe. Deep Stack
Society is a live club whose treasury takes rake while a probe runs, and without
that lock a balance assertion is a race with real players rather than a test of
this code.
