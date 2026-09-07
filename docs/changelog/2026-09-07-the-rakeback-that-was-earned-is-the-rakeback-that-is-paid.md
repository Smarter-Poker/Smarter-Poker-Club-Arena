# The rakeback that was earned is the rakeback that is paid

2026-09-07. Phase 5 of the 8-phase union accounting programme: auto-rakeback.

**231,046.71 was paid to 987 players who had been owed it for up to seven
weeks.** The last player rakeback before today was on 2026-08-20.

## What was wrong

Nothing looked broken. The Monday cron fired on schedule, ran for 38 seconds,
and returned `http_500`. Nobody was paged, because a 500 from a cron is a line
in `cron_health_log` and nothing reads it.

### 1. The drain could not finish, and had not since 2026-08-20

`settle_club_rakeback` closed **every** pending period for a club in one
statement, and each close re-scanned `rake_records` with a per-record lateral
share allocation to recover one player's share.

Measured on production before anything was changed:

| measurement | value |
| --- | --- |
| one period close | 2,632 ms average, 4,070 ms worst |
| Midway's pending periods | 1,769 |
| therefore, one call | ~4,656 s (78 minutes) in a single statement |
| `service_role` statement_timeout | **8 s** |

Every server-side caller — the Open Claw Monday cron, the engine's
`RakebackSettlerService`, the browser `FinancialCronService` — authenticates as
`service_role`. Once the backlog outgrew roughly three periods per club the job
stopped being able to settle anything at all. It did not degrade; it was
cancelled, every time, and reported the cancellation as a 500.

Owed at the point of diagnosis: **443,513.92 to 1,005 players across 3,458
closed periods**, the oldest ending 2026-07-20.

The rake was never lost. `rakeback_daily_user` already held the same allocation,
computed **once per club-day for every player** by `fn_rakeback_recompute_day`
— 4,938 ms for the heaviest day in the backlog, covering 463 players. The
writer has read that rollup since 2026-08-31. The payer never did.

### 2. The payer ignored the rate policy

`fn_rakeback_recompute_periods` writes a rate from `fn_player_rakeback_rate`:
the player's negotiated deal, else their agent's standing offer, else the legacy
volume ladder, and never more than the upline earns less ten points.
`fn_close_settlement_period` threw all of it away and recomputed from the bare
ladder.

Measured across the 3,458 pending periods:

- 1,505 would have paid a different number;
- **95,645.93 underpaid** across 1,301 of them;
- **17,479.31 overpaid** across 204 — and every one of those 204 would have paid
  a player *more than their upline receives*, which is the exact margin
  violation `fn_club_rakeback_margin_violations` exists to detect and the payer
  never consulted.

### 3. It paid into the wrong club

The payer debits the earning club's treasury, then credited through
`atomic_credit_wallet_and_log`, which — given no table id — resolves the
player's **home** club, meaning the club they joined first. For **2,428 of 3,458
periods that is a different club: 327,117.23** funded by one club and handed to
another club's float.

### 4. The admin button was a no-op that reported success

`fn_run_pending_rakeback_settlement` gates on the caller being an admin profile,
then called `settle_club_rakeback`, which accepted only the engine or the club
**owner**. A platform admin owns no clubs, so *Settle Now* on the settlement
dashboard has always settled nothing and returned
`success:true, clubs_processed:0`.

### 5. Three smaller ones

- **No freeze guard.** Neither `fn_debit_treasury` nor
  `atomic_credit_wallet_and_log` consults `fn_platform_frozen`, so the rakeback
  path would move money inside the `:55` maintenance break (CLAUDE.md 13 rule 5).
- **The receipt lied.** `wallet_transactions.balance_after` was read from
  `public.wallets` — frozen since 2026-08-21, nothing reads it — while the chips
  went to `club_members.chip_balance`.
- **The warnings went quiet for the wrong reason.** 244 "Player rakeback
  deferred" warnings between 2026-08-24 and 2026-08-29, then silence — not
  because it improved, but because the job began timing out earlier in its loop
  and never reached the line that writes them.

## What changed

Six migrations, `20260907190300` through `20260907193146`.

- **The payer** reads the `rakeback_daily_user` rollup (falling back to the
  direct scan where the rollup does not reach, rather than paying somebody zero
  because a cache is cold), takes its rate from `fn_player_rakeback_rate`,
  credits the club the rake was earned at, checks the freeze, and records on the
  period itself why it deferred.
- **A credit can now say which club it belongs to.** `app.ledger_club_id` is a
  transaction-local hint read by `atomic_credit_wallet_and_log`. Unset — which
  is every existing caller — is exactly the previous behaviour.
- **The drain is bounded and resumable.** `fn_settle_club_rakeback_batch` takes
  a period cap and a wall-clock budget, warms uncomputed rollup days first, and
  reports what remains and why. `settle_club_rakeback(uuid)` keeps its exact
  signature and becomes a thin call into it, so all three existing callers
  became bounded without being touched and no PostgREST overload was created.
- **A platform admin can settle a club they do not own.**
- **`settle_club_rakeback` stopped answering `anon`.** The grant predates this
  phase — `CREATE OR REPLACE` preserves grants, so replacing the body carried it
  forward — but a `SECURITY DEFINER` money function reachable by a caller with
  no account is a hole whoever opened it. `authenticated` keeps it, because a
  club owner settling their own club and the admin dashboard both come through
  it.

### One thing I built and then withdrew

Migration `20260907193146` added `fn_rakeback_shortfall_watch`: one critical
alert per club per day when a treasury cannot cover what its players are owed,
wired into the hourly sweep. `check-no-new-band-aids.mjs` refused it, and the
refusal is right on the substance, not just the spelling.

> Dan, 2026-09-07: "IT IS NO LONGER ALLOWED TO CREATE ANYTHING THAT MONITORS AND
> BACK FILLS OR ADJUSTS A PAYOUT OR ANY OTHER ISSUE ... I WANT HARD CODED FIXES
> AT THE ROOT SOURCE."

The root cause *is* fixed — the drain could not finish and now can. What remains
is that Midway holds 0.50 chips and owes 280,142.41, which no code fixes. The
rule's own instruction for that case is to say so plainly and stop, not to ship
an alarm and call the shortfall handled. It was also already visible in two
places that are read rather than logged: `deferred_reason` on every affected
period, and `fn_rakeback_settlement_status()` with `fundable: false` and the
exact figure — which is what the settlement dashboard calls. A `financial_alerts`
row would have been the 174th unresolved critical alert on this platform.

Reverted in `20260907193607`, which is why `20260907193146` has no file here.

### Two corrections the probes caught, before any money moved

Both were mine, and both would have re-created the original failure.

1. **The membership check ran after the rake scan.** The first probe passed
   every assertion and then reported `elapsed_seconds: 8.045` for a batch with a
   4-second budget — one period, which it was never going to pay, cost eight
   seconds because it computed a full basis before asking whether the player was
   a member of the club. Midway has 792 such periods. A production batch would
   have been cancelled on its first period, for ever. Cheap refusals now run
   first: freeze, membership, then whether the treasury covers the period's own
   estimate, then the work.
2. **A deadlock aborted the whole batch.** `fn_debit_treasury` takes
   `SELECT ... FROM clubs FOR UPDATE`, which the union cascade and the
   tournament settler also take. One unlucky interleaving and every remaining
   player in that batch went unpaid, with an exception instead of a report. Now
   each period closes in its own subtransaction, a deadlock or lock timeout is
   retried twice, and anything else is recorded against that period while the
   loop continues — the same answer Phase 1 reached for the union cascade
   (`20260907162037`).

## What was paid

77 club-days of rollup were backfilled first, which took every period from a
~2.6 s scan to an indexed sum.

| club | periods | players | paid |
| --- | ---: | ---: | ---: |
| Club JAQK | 670 | 448 | 92,517.31 |
| Deep Stack Society | 416 | 416 | 87,568.61 |
| SHARK CLUB | 603 | 412 | 50,960.63 |
| Midway Union | 2 | 2 | 0.16 |
| **total** | **1,691** | **987** | **231,046.71** |

Paid amounts exceed the previous estimates because the policy rate is what the
players were actually owed; the ladder had been under-rating them.

Verified after the fact, on all 1,691 paid periods:

- 1,691 of 1,691 paid at exactly `fn_player_rakeback_rate` (0 mismatches);
- 1,691 payout rows, 1,691 player credits, 0 booked to a club other than the one
  that funded them;
- treasury debits, payout rows and player credits agree to the cent on every
  club;
- 0 negative treasuries; 0 `wallet_transactions` rows with a null balance.

The drain ran under a conservation guard that compared the rows each pass wrote
— not wallet balances, which live games move underneath you. The first attempt
tripped that guard and **rolled the whole thing back**, which is the guard doing
its job; the re-run measured the right thing and committed.

## What is left, and why it is not a bug

**Midway Union owes 280,142.41 to 589 players against a treasury of 0.50.** That
is a genuine shortfall, not a broken job. It is recorded on every affected
period (`deferred_reason = 'insufficient_club_treasury'`) and reported by
`fn_rakeback_settlement_status()` with `fundable: false` and the exact
shortfall.

Nothing was minted to cover it, and **funding Midway is Dan's call, not
something code can do.** The drain will pay those 589 players on its next pass
after the club has chips, with no further intervention.

## For Dan

**792 periods (123,453.91, 263 players, 789 of them horses) are at a club the
player has no membership row for** — all of them at Midway Union, all of them
sitting behind that treasury anyway. They are deferred with
`no_membership_at_earning_club` rather than quietly paid into SHARK CLUB, which
is where the old code would have sent them. Players generating rake at a club
they are not a member of is worth understanding before those are released;
horses are players (10.5) and they are owed this money, so the question is which
wallet it belongs in, not whether to pay it.
