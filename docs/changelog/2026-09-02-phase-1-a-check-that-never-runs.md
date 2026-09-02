# Phase 1 of 6 — a check that never runs looks like a check finding nothing

2026-09-02. First of six, and deliberately first: it is the one that decides
whether the other five mean anything.

## The problem with a clean bill of health

The payout audit ends with six money checks reporting zero. Every one of those
zeros is worth exactly as much as the evidence that the check ran, and there was
none. A detector wired into a code path nobody executes, a scheduler pointed at
a URL that 404s, an engine that has not restarted since the check was written —
all three produce the same output as a healthy platform, which is silence.

This is not a hypothetical, and it is not only mine:

- Open Claw fired `/api/cron/rakeback-period-settle` every Monday for weeks at a
  handler that had never been written. Every fire 404'd and reported nothing,
  and **281,108.01 chips** of player rakeback accrued behind that silence.
- `fn_spin_unpaid_check` timed out on every call before 2026-08-31 and said so
  to nobody.
- `fn_pay_backed_payout_shortfalls` ran hourly against a candidate query that
  excluded the very events it existed to pay.

## What shipped

**`money_check_heartbeat`** — one row per money check the engine is expected to
run, **seeded with the expected set**. That seeding is the point: without it, a
check that never fires has no row and no age, and reads as nothing rather than
as missing. A never-run check is stale from the moment the table lands.

**`fn_record_money_check_run(check, result)`** — stamped by the **driver**, not
by the check. Deliberately: a check that records its own run proves only that
somebody called it once, and what needs proving is that the engine's timer is
executing it. It never throws — a heartbeat that can break the pass it measures
is worse than no heartbeat, and this is the one place in this audit where
swallowing an error is right.

**`fn_money_check_health(stale_multiple)`** — the whole board in one call: when
each check last ran, how overdue it is against **its own** interval, and a
deduped critical per check that has gone quiet. It is also the single rollup
that was missing; there were seven instruments and no way to read them together.

Wired into `GameServer`: all six checks now stamp, and the board is read at the
**end** of the hourly pass, after every check above has stamped, so a stale row
means that check genuinely did not run rather than that the reader got there
first.

## Evidence

The recorder and the board were proved end to end against production on a
throwaway name — `zz_probe_heartbeat` recorded, `run_count 1`, read back as not
stale — and the probe row was then deleted. No real check was given a timestamp
it had not earned.

```
fn_money_check_health()
  checks      6
  stale       6
  never_run   6
```

**All six read stale right now, and that is the instrument working.** The engine
restarts on the 7am/7pm window and has not yet picked up the code that calls
them. This is the first time that fact has been visible anywhere.

- `tsc --noEmit` clean, 11 new pins in `MoneyChecksProveTheyRan.law.test.ts`,
  registered in `docs/LAWS.md` (registry now 67 assertions).
- The check moves no money, and the law test pins that it never can.
