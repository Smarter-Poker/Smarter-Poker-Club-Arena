# A tournament with one player left is not still running

**2026-09-07** — branch `fix/a-tournament-with-one-player-left-is-not-still-running`

Found at 04:50 while measuring the engine-thread saturation. A real winner was
unpaid, thirty-five minutes after winning, and nothing on this platform could
see it.

## The tournament

`3e346d72` — "3 Chip Deep Stack Spin NLH", three entrants:

| player        | outcome                                | when     |
| ------------- | -------------------------------------- | -------- |
| hawkk         | eliminated 3rd                         | 04:05:09 |
| rookiee       | eliminated 2nd                         | 04:19:33 |
| **SlyViking** | **`playing`, 3,774 chips, prize 0.00** | —        |

One player left. Tournament still `RUNNING`. Prize pool untouched.

## Why nothing saw it

There are **fourteen** scheduled money checks on this database —
`ca-payout-sweep-hourly`, `ca-payout-guarantee-check-hourly`,
`tourney_money_conservation_hourly`, `ca-tournament-conservation-10m`,
`ca-pay-backed-payout-shortfalls-hourly`, and the rest. Every one of them
judges a **COMPLETED** tournament. `fn_tournament_payout_reconcile` refuses
anything else in its third statement:

```sql
IF COALESCE(t.status, '') <> 'COMPLETED' THEN
  RETURN ... 'skipped', 'not_completed'
```

That is correct — a reconciler must not settle a live event. But it means a
tournament that finishes **dealing** and never transitions to COMPLETED falls
through every net at once. `completed_24h_unpaid` was **0 of 9,942**: the
payout machinery is healthy. The gap is upstream of it.

The only reason this was found is that somebody happened to be reading the
engine tonight. That is 10.86 rule 3 one level down — not a guard without a
reader, a whole **class without a guard**.

## What was built

`fn_ca_tournament_finished_but_not_completed(p_minutes int default 15)`, and a
`*/5` pg_cron job in the same idiom as the fourteen checks already here. It
raises one `critical` row in `financial_alerts` — the operator surface those
checks already use — and settles nothing.

**Threshold derived, not guessed (10.84).** Across **4,242 tournaments
completed in twelve hours**, the gap between the final elimination and the
first `tournament_payouts` row:

```
p50    6 seconds
p95   11 seconds
p99   20 seconds
max   83 minutes   <- one outlier, almost certainly this same defect
```

**15 minutes is 45× p99.** It cannot fire on a healthy tournament, and it
catches both tonight's case and that outlier. Checked every five minutes, so a
stuck winner is named within twenty minutes at worst.

**One alert, not one per tournament.** An unresolved row from this source
suppresses the next insert; the message and context carry the current list. An
alarm that files a row every five minutes is an alarm somebody mutes.

**Satellites are excluded** — they award seats, not prizes, and finish on their
own terms. **At least one elimination is required**, so a tournament that has
not started dealing is never flagged.

## It found the real one on its first run

```json
{
  "ok": true,
  "stuck": 1,
  "threshold_minutes": 15,
  "tournaments": [
    { "name": "3 Chip Deep Stack Spin NLH", "entrants": 3, "alive": 1, "stuck_for_minutes": 35.2 }
  ]
}
```

One open alert raised. Post-checks: the function exists, **no browser role can
execute it**, `service_role` can, the cron job is active, and
`fn_ca_browser_reachable_telemetry()` still returns **0** — this new SECURITY
DEFINER function did not reopen the exposure class closed earlier today.

Grants are written down rather than left to the default, because
`CREATE FUNCTION` grants EXECUTE to PUBLIC and `authenticated` inherits it —
which is exactly how `fn_bbj_unclaimed_shares()` handed every unpaid jackpot
share to any account that could log in this morning.

## What this is NOT

**A detector is not a fix (10.11).** The cause is the elimination sweep
overrunning on a saturated single JS thread — 780 stuck sweeps in fifteen
minutes, measured, and recorded as P0/P1 in
`docs/HANDOFF_CURRENT_STATE.md` section 16 and in
`docs/changelog/2026-09-07-the-collapse-was-not-the-reload-storm.md`. That work
belongs to the engine-restart programme and needs its handoff read first.

This is the thing that makes the **consequence** visible while that happens, so
no winner sits unpaid and unnoticed again. When the cause is fixed, this alert
should go quiet and stay quiet — and if it starts firing again, the cause came
back.

## Why the stuck tournament was not settled by hand

10.9 grants the authority and sets five conditions. Condition 2 — _nobody is
paid twice_ — does not hold cleanly here: the platform's idempotent path
refuses a non-COMPLETED tournament, so settling it would mean flipping the
status by hand on a tournament a **live engine still owns and is recovering**.
If the engine's sweep then finished it too, two settlement paths would race on
the same prize pool. That is precisely the risk condition 2 exists to prevent.

So: the alert is raised, the winner is named in it, and the case is visible to
the operator surface rather than settled in a race. If it is still stuck once
the engine is healthy, `fn_tournament_payout_reconcile` is the right path and
it will work the moment the tournament reaches COMPLETED.

## Files

- `supabase/migrations/20260907045255_a_tournament_with_one_player_left_is_not_still_running.sql` (applied; job id 304)
