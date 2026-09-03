# Daily Missions Phase 1 - Economy Integrity

## Scope

Phase 1 of 7 secures the two currency-bearing Daily Missions operations before
any further dashboard or presentation work.

## Production state inspected before change

- `public.buy_streak_freeze(uuid, integer)` locks the streak inventory, but it
  passes the caller-provided `p_cost` directly to `deduct_diamonds`. The only
  validation is that the value is positive, so the displayed 5,000-diamond
  price is not server-authoritative.
- The live `public.claim_daily_challenge(uuid, uuid, numeric)` is substantially
  safer than the only version recorded in the repository: it locks the
  assignment and reads rewards from `daily_challenge_catalog`. However, that
  JSON-returning catalog-authoritative definition is absent from migration
  history, so a rebuilt environment would install the obsolete boolean RPC
  that trusts `p_reward_amount`.
- The live claim RPC catches and downgrades a diamond-ledger insert failure to a
  warning after crediting the profile. That permits balance/ledger divergence.
- The page protects claim and reroll requests with synchronous refs, but freeze
  purchases rely only on React state and then issue an additional balance read
  after the RPC succeeds.

## Planned replacement

1. Replace the freeze RPC with a backward-compatible three-argument signature
   whose price is a server constant, whose optional request UUID is replay-safe,
   and whose response returns the exact balance and freeze inventory.
2. Record the live claim contract as a migration, harden its authentication and
   compatibility checks, and make the diamond balance plus ledger write one
   atomic transaction.
3. Send one request UUID through every client retry, consume the authoritative
   receipt directly, and add a synchronous freeze-purchase guard.
4. Pin all security and wiring invariants with focused tests before applying the
   migration to production.

## Verification record

- Production schema was introspected before editing. The live definitions and
  grants for both RPCs were captured directly from PostgreSQL.
- The migration was compiled inside a production transaction and rolled back
  successfully before application.
- Migration `20260830235900_daily_challenge_economy_contracts` was applied in a
  single transaction and recorded in `supabase_migrations.schema_migrations`.
- A rolled-back hostile-price probe returned `success: false` and
  `expectedCost: 5000` for a caller-supplied price of 1; no currency moved.
- Production ACL verification shows only `postgres`, `authenticated`, and
  `service_role` can execute the two RPCs.
- Focused economy/reroll suite: 3 files, 18 tests passed.
- Full client suite after refreshing to current `origin/main`: 653 files,
  9,560 tests passed.
- `npx tsc --noEmit`: passed with zero errors.
- Production build: passed; Vite completed in 8.58 seconds, media optimization
  completed with zero failures, and provenance reported `behind-main=0`.

Merge, publish, served-bundle verification, and cold-load verification remain
required before Phase 1 may be reported complete.
