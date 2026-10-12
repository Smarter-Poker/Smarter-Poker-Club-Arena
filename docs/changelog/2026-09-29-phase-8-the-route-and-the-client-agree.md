# Phase 8 of 8: the route and the client agree

2026-09-29

## What was missing

Phases 1-7 built a chain of contracts between Postgres and the diamond
wallet, and every link of it was pinned on ONE side only. The SQL laws read
the migrations. The component tests mock the RPC with a hand-written payload.
Both stay green while the two halves drift apart, because nothing ever
compared them.

Every drift this programme has already shipped is in that shape, and none of
them is a crash:

- a column dropped from a `select(...)` while the mapper still reads it: the
  whole ledger renders "Adjustment" because `type` was not asked for;
- a renamed jsonb key, which `Number(...)` turns into `NaN` and `|| 0` turns
  into a zero the player believes;
- a bucket key the map can emit that nothing on screen accounts for, so
  diamonds leave a breakdown that still adds up to a smaller total.

The only symptom is a blank or wrong figure on a money surface, and the
player is the detector.

## What now exists

`tests/the-route-and-the-client-agree.law.test.ts`, registered at
`docs/laws.d/the-route-and-the-client-agree.md`. It derives the ROUTE's shape
from the SQL production runs - the latest migration declaring each function,
chosen by version, never a hard-coded filename - and the CLIENT's shape from
the source that reads it, and it fails when either side moves without the
other. Every derivation throws when it cannot find what it is looking for,
rather than resolving to an empty set that reads as agreement (CLAUDE.md
10.86).

1. **The ledger reads.** The exact column list of all three
   `diamond_transactions` selects (`useDiamondLedger`, `DiamondWalletModal`,
   `VIPPage`), the columns the mapper beside each one reads, and the two
   failures between them: read-but-not-selected, and selected-but-never-read.
2. **`player_line`.** A PostgREST computed column, absent from every
   stored-column snapshot of the table, so only a law that knows it is a
   function can protect it. Its signature over the row type, its purity, its
   delegation to `fn_diamond_ledger_line` and its `authenticated` grant are
   pinned, and no migration may turn it into a stored column.
3. **The RPC keys.** For `fn_diamond_wallet_summary`,
   `fn_diamond_flow_by_kind`, `fn_diamond_arena_reconciliation` and
   `fn_diamond_lifetime_totals`: the key set the SQL builds against the key
   set `DiamondService` destructures, in both directions. A key the client
   reads that the SQL no longer emits is red. A key the SQL emits that
   nothing reads is red unless it is declared with a reason - today that is
   `user_id` on the three own-user functions, and `credits`/`debits` on the
   lifetime totals.
4. **The buckets.** All twenty-one buckets `fn_diamond_kind_bucket` can
   emit, each carrying a player-facing label, against a flow panel that is
   forbidden to name a bucket at all. The panel prints the label the SQL sent
   and the maths filters on the amount, so a bucket added in SQL reaches the
   screen with no client change. An allowlist in the client is exactly how a
   bucket would go missing, so the law refuses one.

## One defect it found on its first run

`src/pages/VIPPage.tsx` asked PostgREST for `description` on every diamond
ledger read and never read it: since phase 6 that surface prints
`player_line` and nothing else. Removed from the select, and the pinned
string in `tests/the-ledger-speaks-to-the-player.law.test.ts` updated in the
same commit. No behaviour changes; the query carries one less column.

## Discrimination

A guard that passes against a broken tree is not a guard. Each contract was
broken on purpose in a scratch copy and confirmed red, then restored. The
breaks and their results are recorded in the pull request.
