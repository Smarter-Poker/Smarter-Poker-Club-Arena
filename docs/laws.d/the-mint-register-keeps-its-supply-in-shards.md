# tests/the-mint-register-keeps-its-supply-in-shards.law.test.ts

The mint register's running supply is read from at most 32 shard rows, never by
summing the register. `fn_ca_register_issuance_leg` used to recompute
`supply_after` with a full `SUM` over `ca_mint_ledger` on every leg (508 ms
mean, about 65k calls a day). The migration adds `ca_mint_supply_shards`, kept
exact by statement-level triggers on insert, update and delete of the register,
seeds it under a lock that blocks writers, and refuses to commit unless the
shards equal the register. The law pins: the register function no longer reads
`ca_mint_ledger` for its supply; the shard table exists with RLS on and no
grants to anon or authenticated; all three triggers are statement-level with
transition tables; the shard is chosen from the transaction id; and the
migration ends by asserting agreement. The CI harness replays the live
pre-image and the shipped migration side by side and requires identical
`supply_after` values, exact shards after updates, deletes and concurrent
writers, and a bounded read cost.
