# The mint register keeps its supply in shards (2026-10-03)

Migration: `20261003220304_the_mint_register_keeps_its_supply_in_shards`.
Law: `tests/the-mint-register-keeps-its-supply-in-shards.law.test.ts`
(`docs/laws.d/the-mint-register-keeps-its-supply-in-shards.md`).
Harness: `scripts/ci/test-the-mint-register-keeps-its-supply-in-shards.py`.

## Why (phase 7, availability)

`fn_ca_register_issuance_leg` stamped every register row with `supply_after`
by summing the whole `ca_mint_ledger` for the asset. With the register past
400k rows that read cost 508 ms mean over about 65k calls a day
(`pg_stat_statements`, 40 minutes after the 21:00 restart): roughly nine hours
of database time a day spent re-adding the same history, inside the money
path that registers every mint and burn leg.

## Change

- New table `ca_mint_supply_shards (asset, shard 0..31, net)`, seeded under a
  `SHARE ROW EXCLUSIVE` lock on the register with the exact per-asset sum.
- Three statement-level triggers on `ca_mint_ledger` (insert, update, delete,
  with transition tables) add each statement's net movement to one shard
  chosen from the transaction id, so concurrent writers rarely touch the same
  row and a bulk statement is one upsert per asset, not one per row.
- `fn_ca_register_issuance_leg` reads the supply as the sum of at most 32 shard
  rows. Nothing else in the function changes: same holder resolution, same
  adoption of an unlinked door row, same `ON CONFLICT (op_id) DO NOTHING`.
- `fn_ca_mint_supply_shards_agree()` (service role) compares shards to the
  register so drift is readable at any time; the migration refuses to commit
  unless they agree.

No balance moves. `supply_after` on new rows is the same number the old full
scan would have produced.

## Proof (local PG17, the live function as pre-image)

| case | result |
| --- | --- |
| fixture md5 equals live `8d3d5e1f...` | ok |
| shipped migration applies with its own pre and post checks | ok |
| `supply_after` identical old vs new over 21 mixed rows | ok |
| amount change, delete, link update keep shards exact | ok |
| 8 concurrent sessions, no deadlock, shards agree | ok |
| cost on 400k rows: old 52 ms / 7,274 buffers, new 0.066 ms / 5 buffers | ok |

## Applying

The migration body contains `ON CONFLICT ... DO UPDATE`, so it is applied by
the owner with **Apply Merged Migration**, outside the :50-:03 break window.
It briefly holds `SHARE ROW EXCLUSIVE` on `ca_mint_ledger` while seeding, which
pauses register inserts for the length of one full sum (well under a second).
