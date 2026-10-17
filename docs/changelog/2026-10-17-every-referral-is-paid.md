# Every referral is recorded and paid when the new player confirms (2026-10-17)

Dan: "YES PAY OUT DIAMONDS FOR ALL REFERRALS".

## What was wrong

- `public.referrals` had zero rows, ever, and `profiles.referred_by` was NULL on every account.
- The World Hub sign-up page kept the referrer only in that browser's localStorage.
- `/api/rewards/referral` looked the pair up in `public.referrals`, which nothing wrote.
- It also withheld payment until the referee had a verified phone, a seven-day-old account and five login days.
- Papa, Dinodollars and TomTomTamale all arrived on kingfish's invite link (`ref=1`) and nobody was paid.

## The fix

Migration `20261017223126_a_referral_is_recorded_and_paid_when_the_new_player_confirms.sql`:

- `fn_settle_signup_referral(referee)` reads the referrer from the account's own sign-up record. That is `referral_player_number`, or else the `ref=` in `club_join_path`.
- It records the referral and `referred_by`, then pays 500 to the referrer and 100 to the new player through `award_diamonds_v2`.
- It uses the reference ids the endpoint always used, so no door pays twice.
- Triggers on `auth.users` run it when an email is confirmed. They run in a savepoint, so a referral never blocks a sign-up.
- Backfill: Papa, Dinodollars and TomTomTamale get 100 each, and kingfish gets 1,500. This was proved first in a self-aborting probe. MrWick007 is paid when he confirms his email.

The World Hub side (PR #2482) does two things:

- The sign-up page writes `referral_player_number` and reads `ref=` from the invite redirect.
- The endpoint becomes a second live door to the same function, with no gate.

Pinned by `tests/every-referral-is-paid.law.test.ts`.

## Why the migration lives here

The database is shared. Three direct `apply_migration` calls from the cloud session returned `cancelled` and changed nothing. Apply Merged Migration is the reviewed route that sends a merged file's own bytes in one transaction.
