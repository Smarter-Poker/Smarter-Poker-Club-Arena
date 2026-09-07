# 2026-09-07 - The mint register's reference into the journal gets its constraint back

Phase 5, and it comes straight out of measuring roadmap 8.4's stated blocker.

8.4 says `chip_ledger` partitioning is "blocked on the
`ca_mint_ledger.chip_ledger_id` foreign key". Measured:

|                                                     |       |
| --------------------------------------------------- | ----- |
| foreign keys referencing `public.chip_ledger`       | **0** |
| foreign keys on `public.ca_mint_ledger` of any kind | **0** |
| `ca_mint_ledger` rows holding a `chip_ledger_id`    | 361   |
| of those, orphaned today                            | 0     |

**The blocker does not exist, and that is worse than if it did.** The column is
still there and still in use - 361 mint-register rows name a journal leg - but
nothing enforced that the leg was real. The constraint was lost at some point
and the reference outlived it.

Nothing is wrong today: all 361 resolve. This puts the guard back while that is
still true, which is the only cheap moment to do it.

## Why it matters more under Dan's ruling, not less

Dan ruled the same day that the journal keeps every leg **for ever**, and that
partitioning is for cheap reads and archiving, never for dropping. Under that
ruling this constraint can never fire - which is the point. It turns "we decided
not to drop legs" into "a leg with a reference cannot be dropped". If a later
agent writes a `DROP PARTITION`, this refuses it instead of letting the mint
register quietly start pointing at nothing.

`ON DELETE RESTRICT`, deliberately, not `CASCADE`: a mint-register row is
evidence that chips were issued or retired, and deleting it because a journal
leg went away would destroy the record of the thing rather than the pointer to
it.

## What is not proved here, and why

Two behavioural probes were written and the platform refused both:

- inserting a copied row - `cannot insert a non-DEFAULT value into column
"origin"`, because `ca_mint_ledger` carries a `GENERATED ALWAYS` column;
- updating the reference - _"UPDATE on ca_mint_ledger is forbidden: the mint
  register is append-only. A retirement offsets an issuance; neither is ever
  edited or removed."_

The second is the register working exactly as designed, and its maintenance
hatch (`app.ledger_maintenance` with an incident reference) would be an abuse to
use for a test. Deleting a referenced leg to exercise the RESTRICT half would
prove nothing either: `chip_ledger` is append-only too, so its own guard would
refuse first and the probe would pass whether or not the constraint existed - a
green light that means nothing.

So the migration asserts what can be asserted honestly, from the catalogue: the
constraint exists, it is **VALIDATED** (which is what makes it cover the 361
rows already there rather than only future ones), it points at
`chip_ledger(id)` from `chip_ledger_id`, and its delete action is `RESTRICT`.
The enforcement is Postgres's and does not need demonstrating (11.5 rule 5).
