# Union Risk Uses Player-Keyed Chip Flow Indexes

## What Existed

The read-only Union Operations Risk report used two set-based chip-ledger
range scans. They were exact and fast with warm cache, but a fresh signed-in
production load and the same direct eight-second RPC budget both timed out.
Production profiling isolated the remaining cold-read cost to those two scans.

## What Changed

Migration `20261004221303_union_risk_uses_player_keyed_chip_flow_indexes.sql`
adds two partial covering indexes ordered by club, player and time. It edits
only the installed `fn_union_agent_risk_report` definition, replacing the two
broad flow scans with exact per-(club, player) indexed sums.

The migration refuses a changed function preimage, security contract or source
shape. It preserves the function signature, authorization, output, rake and
commission accounting, signed flow arithmetic, ownership, stable volatility,
function-local JIT guard and least-privilege grants. It moves no chips and
does not execute settlement.

## Verification

- Same-snapshot production comparison: zero differing player/club pairs and
  identical old/new signed totals.
- The maintained PostgreSQL 17 fixture retains 300,000 signed chip movements,
  the production roster dimension and the eight-second budget.
- The fixture source binding pins this migration and its connected assertions.
