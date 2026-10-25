# 2026-10-24 - A Flash Pool join never takes chips

## Found

`public.join_flash_pool(uuid,uuid,numeric)` is live in production, executable
by `authenticated`, and in no migration (20260723_sweep3_feature_backends.sql
records it as deliberately NOT created: it had to seat the player through the
engine before any debit). The live body debits the buy-in through
`atomic_deduct_wallet_and_log` (the frozen `public.wallets` pool), inserts a
`flash_pool_players` row nothing ever reads, and has no leave or refund path.
`/flash-pool` is a parked page but its route is still mounted behind AuthGuard,
and 4 pools are `active`. `flash_pool_players` had 0 rows on 2026-10-24, so no
player has lost chips.

## Fixed

- `20261024232449_flash_pool_join_never_takes_chips.sql`: revokes EXECUTE from
  PUBLIC, anon and authenticated (no PostgREST reload), with a `@live-proof`.
- `FlashPoolPage.tsx`: Join never calls the RPC; it says Flash Pools are not
  open and fast-fold play is in Lightning games (Lightning only, Dan
  2026-10-16/17). The page stays parked as Dan left it.
- `tests/unit/flashPoolJoinNeverTakesChips.test.ts` pins both.
