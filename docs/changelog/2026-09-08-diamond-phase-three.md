# 2026-09-08 - Phase three: the bridge, the delete list, and a ruling that was inverted

Migration `20260908033824`, applied and registered. Nothing here moves a diamond.

## 1. Ruling 7 was inverted; Dan's row is the correct one

Ruling 7 read "1 diamond = 100 chips". The live `ca_bridge_rate` row, set 2026-09-07 with Dan's own pricing in its note - "1 diamond = 1 cent, 1 chip = 1 dollar. 100 diamonds per chip" - says **100 diamonds buy one chip**. Prices for future events are Dan's alone (CLAUDE.md 10.9), so the row stands and the ruling is corrected in `docs/DIAMOND-RULINGS.md`. This matters more than a typo: an agent reading the old wording and "correcting" the live rate would have divided the price of a chip by ten thousand.

The rest of ruling 7 was already built by another agent the same day (`20260907233813`): `fn_mint_chips_from_diamonds` reads `fn_ca_bridge_rate()` rather than a literal, debits through `deduct_diamonds`, and mints the chip leg through the Mint.

## 2. The delete list, run against its own gate

The roadmap's gate for 3.2 is three checks: zero writes in `ca_diamond_dead_store_writes`, zero rows under that name in `ca_diamond_balance_audit.writer` over seven days, and zero references in either repo. Dropped, all three checks clean:

- `award_purchase_diamonds`, `fn_credit_diamonds` (both overloads), `increment_diamonds` - legacy credit paths that wrote `profiles.diamonds` with no journal reference, which is the shape DR4 exists to refuse;
- `create_user_progress_on_signup` and `user_progress.diamonds` - the function was attached to no trigger at all;
- `bot_profiles.diamonds` (ruling 9);
- `fn_purchase_time_banks(integer)` - the one-argument wrapper minted a fresh idempotency key inside the database on every call, so a retry was a second charge. Safe now and not before: the published bundle (`ca_sha` 2a8e4319c7) calls `_v2` with a per-attempt request id.

Ten names failed the gate and were left alone, each named in the migration header with its reason - `award_diamonds` (35 references), `fn_add_diamonds`, `purchase_vip_with_diamonds_atomic`, `complete_daily_challenge` with `diamond_ledger`, `initialize_user_diamonds`, `claim_reward`, `update_daily_streak`, `club_diamond_wallets`, and `club_members.diamonds`, which is a false positive: the 730,940 writes belong to its neighbours.

## 3. Two things the drop taught

`club_memberships` and `ca_diamond_dead_store_writes` are **views**, not tables. The first has no column to drop; the second recomputes itself, so the two dropped columns simply stop appearing in it. A record that is derived cannot drift from what it describes - which is the right shape for a register of dead stores, and worth knowing before writing an UPDATE against one.

## 4. Verified after apply

Five legacy functions gone; `bot_profiles.diamonds` and `user_progress.diamonds` gone; `fn_purchase_time_banks_v2` present; `fn_ca_mint_supply('diamonds')` 1,023,527 = `SUM(profiles.diamonds)` 1,023,527.
