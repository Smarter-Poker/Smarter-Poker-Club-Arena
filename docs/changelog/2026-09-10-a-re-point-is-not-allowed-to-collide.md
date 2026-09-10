# A re-point is not allowed to collide

2026-09-10. The drift board showed a new CRITICAL firing every few minutes:

```
[postHandTasks.step_failed.leave_pending]
duplicate key value violates unique constraint "cash_player_session_one_open"
```

**No chips moved. A player could not leave the table.**

## The statement

A cash seat move carries the player's open session to the destination by
re-pointing it:

```sql
UPDATE public.cash_player_session SET scope_id = dst.id, table_id = dst.id
 WHERE player_id = ... AND scope_id = m.from_table_id AND closed_at IS NULL;
```

`cash_player_session_one_open` is `UNIQUE (player_id, scope_type, scope_id)
WHERE closed_at IS NULL`. If the player **already** holds an open session on
the destination - a leftover from an earlier stay there that was never closed -
that UPDATE makes two rows with `(player_id, 'table', dst)` both open and
throws. The throw takes out the entire post-hand `leave_pending` step, so the
player stays seated.

## Measured, not guessed

- **1,091 of 4,751** completed seat moves in six hours had the destination
  already carrying an open session for that player. **23% of every move.**
- 34 hands across 6 tables failed this way in 83 minutes, still firing when
  the fix went in.
- 51 sessions have been open for over 12 hours; 5 belong to a player with no
  live seat at all. That is where the leftovers come from.

## What was NOT the cause

`fn_cash_session_open` was the obvious suspect and it is innocent - it already
carries `ON CONFLICT ... DO NOTHING` and falls back to reading the existing
row. It is the only function in the database that INSERTs into this table, and
it cannot throw this error. **The collision is created by an UPDATE, and no
`ON CONFLICT` covers an UPDATE.** Chasing the insert first cost three queries
and would have produced a fix that changed nothing.

## The fix

The SOURCE session is the live one - it carries the stay clock for the seat
actually being moved - so the leftover on the destination is closed with a
stated reason (`superseded_by_move`) immediately before the re-point. The swap
path re-points BOTH players, so both got the same guard, and the migration's
post-condition asserts the swap function contains the guard exactly twice.

Live result: applied 00:43:58, **zero failures since**, across 93 seat moves in
the following five minutes.

## Not a repair job

Nothing scheduled, nothing back-filled, no compensating write (10.12). The
statement that produced the wrong outcome is the statement that changed.
