# Two seat exits destroyed chips today, and two different bugs caused them

Date: 2026-08-26

`fn_unaccounted_seat_exits()` -- the detector added after the 2026-08-25
incident -- was returning rows and nobody had read it. Two exits on 2026-08-26
had stacks with no matching wallet credit. They turned out to have separate
causes, one in SQL and one in the engine.

## Exit 7458 -- 25.90 chips -- `atomic_table_addon`

    12:55:23.452  debit  25.90  'Table add-on (club wallet)'
    12:55:24.529  credit 19.10  'Cash-out from table'
    12:55:25.419  seat vacated holding 45.00   (19.10 + 25.90)

The player paid 25.90 for an add-on and was refunded 19.10.

`atomic_table_addon` read the seat without `FOR UPDATE`, so it did not serialise
against `atomic_table_cashout`, which does take that lock. Worse, its
`UPDATE table_seats SET stack = stack + p_amount ... AND left_at IS NULL` had no
`ROW_COUNT` check: when the seat was vacated between the read and that update
the statement matched zero rows and the function still committed the
`club_members` debit and wrote the `wallet_transactions` row. The chips left the
wallet and landed nowhere.

The engine already knew this shape. The comment above the call site in
`server/src/engine/ServerTableEngineSeating.ts` reads *"the chips while the
wallet stayed debited. The mid-hand branch has been covered by the
table_pending_addons ledger since the A2 fix; this branch had nothing."*
`p_apply_to_seat = true` is "this branch".

Fixed by migration `an_addon_that_cannot_apply_must_not_debit`, applied to
production. Three changes, nothing else in the body touched: an `auth.uid()`
guard matching `atomic_table_cashout`'s, `FOR UPDATE` on the seat read, and
`GET DIAGNOSTICS` on the seat update that RAISEs on zero rows -- which rolls back
the debit and the idempotency claim. A player now sees an error instead of
silently losing chips.

The same migration revoked EXECUTE from `authenticated`/`anon` on
`atomic_table_addon`, `resolve_pending_addon` and `atomic_table_cashout`. The
first two have exactly one call site each, both in the Hetzner engine on the
service role; the third has no call site in either repo.
`fn_leave_seat_and_refund` keeps `authenticated` -- it is called from
`src/pages/TablePage.tsx` -- but lost `anon`, which had no business leaving a seat.

## Exit 6522 -- 85.85 chips -- `markSeatAsLeft`

Cash table, `exit_kind = 'left'`, no credit anywhere near it.

`markSeatAsLeft` in `server/src/services/supabase/seats.ts` has a careful happy
path: every credit failure returns without vacating the seat. Its **catch block
vacated the seat unconditionally.** Any throw between reading the stack and
crediting it -- a transport error on the RPC, a timeout -- erased the stack.

`atomicCashout`, in the same file, has been guarded against exactly this since
SWEEP #4 P0-3 by its `safeToClearSeat` flag. `markSeatAsLeft` never received the
same fix. This PR mirrors it, and additionally scopes the `!seat` early-return
branch to `seat_number` -- it previously vacated every active seat the player
held at that table, including one holding a stack this call never read.

`server/src/services/supabase/seats.guard.test.ts` pins both. The guards were
verified against the pre-fix source: reverting the catch block fails 2 of the 6.

## Note on `fn_leave_seat_and_refund`

CLAUDE.md 11.5 says it "is the only path that refunds". That is true for
TOURNAMENT seats only -- the function returns `table_not_found` when
`tables.tournament_id IS NULL`. Cash seats refund through `atomic_table_cashout`
and through the two engine paths in `seats.ts`. Three paths, not one, which is
why two of them could drift apart.

## Still open

- 4,038 exits today carried `exit_kind = 'deleted'`. They have matching credits,
  so they are not losses, but CLAUDE.md 11.5 rule 3 says a seat row should be
  left, not deleted. Worth understanding which path deletes and why.
- The 130.85 chips from these two exits have NOT been returned. That needs a
  deliberate treasury decision, not an agent's.
