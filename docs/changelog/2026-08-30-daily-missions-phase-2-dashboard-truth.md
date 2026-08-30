# Daily Missions Phase 2 - Dashboard Truth And Reward Vault

## Scope

Phase 2 of 7 replaces the page's independently assembled mission, career,
streak, and balance reads with one authenticated database receipt. It also
makes each assigned mission contract immutable and keeps completed rewards in a
persistent vault after their daily, weekly, or monthly period rolls over.

## Production state inspected before change

- The page performed four client operations during every refresh: active
  missions, career statistics, streak state, and spendable diamonds.
- Career totals stopped at a client query limit and recalculated historical
  payouts from today's mutable challenge catalog.
- The visible Reward Vault only counted the ten active-period rows. Completed
  rewards from older periods remained in PostgreSQL but disappeared from the
  page.
- Production contained 143 mission assignments. Twenty were complete and
  unclaimed, all belonging to expired or current periods that need durable
  claim access.
- The 100-day milestone was returned forever once reached, and the page filled
  every milestone bar with `streak % 7` even though the actual intervals are
  7, 14, 30, 60, and 100 days.
- Streak calculation stopped reading history after 400 days and read streak
  inventory without a row lock. Its freeze entitlement math also capped
  lifetime earned freezes at three instead of only capping held inventory.

## Replacement

1. Snapshot name, description, type, tier, requirement, chip reward, and
   diamond reward when a mission is assigned. A trigger rejects later snapshot
   edits, so catalog changes affect future contracts only.
2. Pay claims and calculate career earnings from the immutable assignment
   snapshot.
3. Add `get_daily_challenge_dashboard`, which returns active contracts, exact
   lifetime totals, streak state, spendable diamonds, milestone interval, and
   a persistent unclaimed Reward Vault in one authenticated receipt.
4. Add covering/partial indexes for Reward Vault, claimed totals, and daily
   streak access.
5. Lock streak inventory, remove the 400-day ceiling, account for every
   seven-day entitlement, and continue milestones every 30 days after day 100.
6. Wire the page to the single dashboard receipt, server-owned milestone
   percentage, and persistent vault claim source.

## Verification record

- Migration `20260830235963_daily_challenge_dashboard_contract` compiled in a
  production transaction and rolled back before application.
- The migration was then applied transactionally and recorded in
  `supabase_migrations.schema_migrations`.
- All 143 existing rows were backfilled; zero contract snapshots are
  incomplete.
- A rollback-only authenticated dashboard probe returned ten active missions,
  all twenty persistent vault rewards, exact career totals, spendable balance,
  a server timestamp, and a 12,298-byte receipt in 108.275 ms.
- A rollback-only claim probe paid both chips and diamonds exactly from the
  assigned snapshots; the wallet, profile, ledger, and claimed flag were all
  rolled back after verification.
- Production RPC grants are limited to `authenticated` and `service_role`
  (plus the owning PostgreSQL role); `PUBLIC` and `anon` have no execute grant.
- Focused Daily Missions suite: four files, 24 tests passed.
- `npx tsc --noEmit`: passed with zero errors.

Merge, publish, served-bundle verification, and cold-load verification remain
required before Phase 2 may be reported complete.
