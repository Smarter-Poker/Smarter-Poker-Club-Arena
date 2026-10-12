# A session result counts what was bought in (2026-10-06)

## What was wrong

On leaving a cash table the Session Summary, and the "Session Complete ... P/L"
notice saved with it, subtract "total bought in" from the chips returned. The
page kept that total in memory only. After any reload or remount it re-seeded
it with the stack at that moment, so a player who had bought in for 1,000, was
down to 700, and whose phone slept, left with a summary that read roughly
break-even instead of minus 300.

## The fix, at the cause

The platform already keeps the figure: `cash_player_session.baseline` opens
with the buy-in and is raised by every add-on and rebuy that lands. No browser
role may read that table, so migration `20261006062341` adds
`fn_my_cash_session_baseline(table)`, read-only and bound to `auth.uid()`: the
caller's own baseline for their open session at one table, nothing else.

`TablePage` still seeds from the stack (so the card never drops the stat) and
then asks the server once per table and uses its answer
(`src/utils/sessionBuyInTotal.ts`). Chips added in the tab between the ask and
the answer are carried over. A table with no cash session, a read that fails,
or a database that does not have the function yet leaves the placeholder
exactly as it was.

## Proof

Scratch PostgreSQL 16: the caller gets 1,010 for their open session, NULL for
another table and NULL with no user; another player's row is never returned.
`tests/unit/sessionBuyInTotal.test.ts`.
