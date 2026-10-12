# Union Risk Uses Pair-Keyed Commission Sums

## What Existed

The player-keyed chip-flow release removed the dominant cold scan from the
read-only Union Operations Risk report. A first truly cold production request
could still exceed the eight-second request budget because the commission CTE
read and globally aggregated 3.25 million exact-pair index entries.

## What Changed

Migration `20261004230841_union_risk_uses_pair_keyed_commission_sums.sql`
replaces that global commission aggregate with exact per-(agent, club) indexed
sums for the 111 authoritative report pairs. It preserves signed amounts, the
function signature, authorization, output, ownership, stable volatility,
function-local JIT guard and least-privilege grants. It moves no chips or
commissions and does not execute settlement.

The migration refuses a changed function preimage, security contract, source
shape or supporting index. Its postimage is independently pinned by definition
and body hashes.

## Verification

- Same-snapshot production comparison: zero differing agent/club pairs and
  identical old/new signed commission totals.
- The PostgreSQL 17 fixture exercises the complete six-migration lineage with
  production-scale commission and chip-flow facts under the eight-second budget.
- Source binding and focused contract tests pin the migration and assertions.
