# Signup Never Freezes

**Date:** 2026-10-16
**Migration:** `20261016101008_signup_wallet_never_freezes.sql`
**Law:** `tests/signup-never-freezes.law.test.ts`

## What The Digest Reported

The Smarter.Poker daily digest for Oct 14 listed "2 signup errors".

## What The Rows Say

Every row in `public.signup_errors` for the previous 30 days was the same
failure: `handle_new_user_v2_create_wallet`, SQLSTATE `55006`,
`PLATFORM_FROZEN ... INSERT on wallets was refused`. Each one was an account
created between :55 and :00, during the hourly maintenance break.

The signup trigger on `auth.users` creates the player wallet once and never
again. The freeze guard refused that insert, the trigger logged the error and
let signup finish, and the account was left with no player wallet for good.
79 accounts were in that state, all certification, probe or QA identities; no
real player was affected.

## The Fix

`fn_refuse_while_frozen` now lets a `wallets` INSERT through when both
`balance` and `locked_balance` are zero, the same rule the zero-balance
`club_members` INSERT has had since 2026-09-02. A wallet holding nothing is
identity, not money. Every balance UPDATE, every DELETE and every nonzero
INSERT on `wallets` is still refused during the break. The rest of the guard,
including the chip_ledger journal exemption, is carried over unchanged from
production.

No backfill: the live path is fixed (CLAUDE.md 10.12), and no real account
was left without a wallet.
