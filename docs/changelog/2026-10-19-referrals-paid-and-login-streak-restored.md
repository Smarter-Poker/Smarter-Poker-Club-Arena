# Referrals are paid, and the daily login streak counts again (2026-10-19)

Phase 1A of Dan's launch-day programme ("START PHASE 1."). Database only, no engine release.

## 1. Sign-up referrals

### What was wrong

- The 2026-10-17 fix (#7326, `20261017223126_a_referral_is_recorded_and_paid_when_the_new_player_confirms.sql`) merged but never installed. None of its functions or triggers existed, and no referral had ever been paid.
- It could not install as written. Its backfill accepted exactly three referees and aborted on anything else. ChaseOryan45 signed up on kingfish's invite link on 2026-10-18 and confirmed, which made four.
- ChaseOryan45 already had a `pending` referral row. `fn_club_invite_claim` wrote it 0.3 s after his email was confirmed. A confirmation trigger fires before that row exists, so on its own it would miss any referral whose sign-up record did not carry the invite link.
- The probe found a second defect in the 2026-10-17 body. A repeat settlement on the same day is refused `action_limit`, because `referral_referee` is one a day. The old body read that refusal as "unpaid" and flipped a completed referral back to `pending`.

### The fix

Migration `20261019092248_every_confirmed_referral_is_paid_once_and_the_pending_one_co.sql`:

- `fn_settle_signup_referral` is still the one place a referral is recorded and paid: 500 to the referrer and 100 to the new player, through `award_diamonds_v2` with the established reference ids.
- It settles at whichever of two facts comes last:
  - the email is confirmed (two triggers on `auth.users`);
  - the referral row is recorded (a new trigger on `public.referrals`).
- Each trigger runs the settlement in a savepoint, so it can never fail a sign-up or a claim. A guard stops the settlement's own insert from re-entering it.
- "Paid" is now read from the journal rows, not from a refusal's wording. A completed row is never downgraded, and a pending row is completed.
- The backfill settles every confirmed referral it finds at run time. Nothing is hard-coded.
- The old file's first line now reads `SUPERSEDED BY 20261019092248`, so it can never run and the ledger checks stop reporting it.

### Paid

| Player       | Paid                                         |
| ------------ | -------------------------------------------- |
| Papa         | +100                                         |
| Dinodollars  | +100                                         |
| TomTomTamale | +100                                         |
| ChaseOryan45 | +100 (his pending referral is now completed) |
| kingfish     | +2,000 (500 for each of the four)            |

That is 2,400 diamonds in total. All four referral rows are now completed. MrWick007 arrived on the same link but has not confirmed his email yet; he and kingfish are paid the moment he does.

## 2. Daily login streak

### What was wrong

- The reward is 10 on day one and 5 more for each consecutive day, up to 110.
- `award_diamonds_v2` counted the run with `WHERE d = v_today - rn`. `rn` is a bigint and `date - bigint` does not exist, so the query failed every time.
- An `EXCEPTION WHEN others THEN v_streak := 0` around it swallowed the error. So from 2026-09-07 every login paid 10.
- The same symptom appears on four of kingfish's consecutive days in the rule's first week (2026-08-07 to 08-15).
- The live body matched no file in the repo.

### The fix

Migration `20261019092327_the_daily_login_streak_counts_consecutive_days_again.sql`:

- The query now counts with `v_today - rn::int`.
- The exception handler is removed, so a failure is loud instead of a silent underpayment.
- The pre-image md5 is asserted, and the new body's md5 and its ACL are asserted after install.

### Settled once

- Every catalog-version-3 login was re-priced from the same rows the function reads, using the multiplier recorded on the row and capped by that day's and month's remaining allowance.
- The model was checked against the witness first. Every streak the function did count matches the derivation, and so does every amount it paid.
- Each player is paid once through `add_diamonds_to_balance` (type `adjustment`, reference `daily_login_streak_backpay:<player>`).

| Player       | Back-pay | Logins |
| ------------ | -------- | ------ |
| kingfish     | 620      | 20     |
| smarterpoker | 95       | 8      |
| danimal5022  | 40       | 6      |

That is 755 diamonds in total. All multipliers were 1.00 and no cap ever bound. No horse has a daily_login credit; the rule does not filter horses.

## Proof and pins

- Both migrations were proved first in self-aborting probes on 2026-10-19: one call, one transaction, ending in `RAISE EXCEPTION`.
- The pins are `tests/every-referral-is-paid.law.test.ts` and `tests/the-daily-login-streak-counts-consecutive-days.law.test.ts`.
