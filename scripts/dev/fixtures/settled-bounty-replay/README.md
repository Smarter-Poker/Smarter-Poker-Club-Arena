# Settled bounty replay qualification

Run `bash scripts/dev/probe-settled-bounty-replay-pg17.sh` from the Club Arena checkout.

The runner creates one private PostgreSQL 17 cluster with a private Unix socket and no TCP listener. It accepts no database URL and disposes the cluster on exit. It uses synthetic rows only.

The five functions in `current-functions.sql` are production definitions read on September 14, 2026. Their bodies are unchanged; semicolon statement delimiters are added for psql. The collection preimage is b684f48642dcaa9541a326eca06e7a2c; the repaired body is 6dcaf498835e691b15384aa5aabcfdfe. The actual marker and denomination functions validate each receipt for chips and Diamonds.

The fixture reuses September 11 captured table shapes, marker triggers and settlement-lane implementation from `../mystery-bust-phase/`. It adds the club fields needed by the actual denomination resolver. Those older shapes are a bounded fixture, not a full current production schema. Different seat-join times distinguish synthetic re-entry generations.

The financial payer is replaced with an explicit exception trap: any replay reaching a payment fails the test. Receipt, wallet, head, obligation and event rows are seeded test evidence, then compared before and after. Consequently this proves replay ordering, exact marker checks, generation selection, context restoration, concurrent replay and unchanged financial fixture rows. It does not prove original funded payments, production wallet/escrow/provider composition, initial pending settlement, live replay or recovery of historical missing bounty claims.

The runner first proves the defect using the captured old body, applies the exact migration, runs the fixed scenarios, tests concurrent replay, repeats the migration, and requires refusal for unreviewed metadata and source.
