# 2026-08-31 - The chip integrity report was permanently red, on a signup

## How this was found

Auditing the previous phase before starting the next one. Verifying that the
`fn_unaccounted_seat_exits` revoke had not broken `fn_chip_integrity_report`
meant running that report - and it came back:

```
legacy_wallets_frozen   CRITICAL
public.wallets holds 732591994.33 chips, last written 2026-08-31 14:34:39.
Dead pool; only a NEW write is news.
```

Written minutes earlier. CLAUDE.md section 11.5 says `public.wallets` has been
frozen since 2026-08-21 with exactly 732,591,994.33 chips stranded, and that a
money path writing to it is a broken money path.

## It was not a money path

```
public.wallets                       1,856 rows
sum(balance)                    732,591,994.33   <- unchanged, to the cent
rows with balance <> 0                 690
last write to a NON-ZERO row   2026-08-20 23:45:28Z
writes in the last 36 hours              3
```

All three recent writes are `balance 0.00`, `created_at = updated_at`, against
brand-new profiles. New signups still get an empty row in the dead table. The
check read `max(updated_at)` across **every** row, so one signup turned the
report critical for two days - and with signups arriving daily, that is a
permanent red on the one report whose whole job is to make chip loss LOUD.

A permanently red critical is worse than no report. It teaches everyone to
scroll past the line that will one day be true.

## What "news" actually means

1. **The total changed** - chips entered or left the dead pool. Exact, needs no
   timestamp, cannot be faked by a row appearing at 0.00.
2. **A row that holds chips was touched** - covers a credit into an existing
   balance even if the total happens to net out.

Either is critical. A zero-balance signup row is neither.

## Verified in both directions

Green:

```
legacy_wallets_frozen  ok
public.wallets holds 732591994.33 chips, last MONEY write 2026-08-20 23:45:28
```

Red, in a transaction that was **rolled back** (CLAUDE.md section 11.5 rule 1):

```sql
begin;
select set_config('app.bypass_wallet_guard', 'on', true);
update public.wallets set balance = balance + 1 where ...;
-- legacy_wallets_frozen  CRITICAL  holds 732591997.33
rollback;
```

Sum confirmed back at 732,591,994.33 and severity back to `ok` afterwards. No
chips were moved.

Worth recording from that probe: a direct `UPDATE` on `public.wallets` is
**refused outright** by `guard_wallet_balance_write()` - "all balance changes
must flow through the whitelisted SECURITY DEFINER RPCs that log to
chip_ledger". The dead pool is already defended; the total-changed arm of this
check is belt and braces.

## How it was edited

By string replacement against `pg_get_functiondef()`, never by retyping the
function. The other six checks are somebody else's work; retyping them is how a
transcription slip becomes a silent regression in a money report. Each
replacement asserts it changed something.

## Two applying incidents, recorded because they will recur

**The client timed out and the server committed anyway.** The post-apply block
calls the report four times, and the report runs `fn_unaccounted_seat_exits()`
over 7 days (~8.5s), so it blew the 60s client budget. The MCP reported a
timeout; Postgres finished and committed. A verification query run immediately
after still saw the old body - it had raced the commit. **After a timed-out
apply, verify twice with a pause before concluding anything.** One aggregated
call avoids the whole problem.

**The retry refused itself, which is the point.** Believing that negative check,
a second attempt was made. It aborted on its own `EDIT 1 matched nothing`
assertion because the edits were already present. The assertion written to catch
a drifted source also made a double-apply impossible.

Applied as `20260831144556_a_signup_is_not_a_movement_in_the_dead_wallet_pool`.
