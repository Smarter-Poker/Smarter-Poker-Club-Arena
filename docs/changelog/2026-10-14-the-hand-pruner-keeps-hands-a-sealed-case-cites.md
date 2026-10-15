# The hand pruner keeps hands a sealed restoration case cites (2026-10-14)

Symptom: the Midway Union (fade0000...) weekly accounting scope failed every
hourly visit with `original_restoration_cash_flow_source_refused` (31 open
critical `union_accounting_scheduler` alerts since 10-12).

Cause, read from rows: `original_inventory_finite_witness` returns NULL when a
sealed source ref no longer re-hashes. 19 of 33 sealed `returned_cash` cases hit
it, all through `atomic_economics` / `signed_economics` refs, whose source is
`public.hand_atomic_commits`. `sp_prune_hand_history` (eight day horse retention,
unchanged) deleted those commits at 2026-10-14 15:33 for hands played 10-06. It
never consulted `smarter_private.original_inventory_restoration_cases`.

Fix (migration 20261014231901): the pruner's candidate set now excludes any hand
that a sealed case cites. Applied 23:21 UTC: 71 cited commits are retained; the
pruner kept succeeding on its 30s schedule. Without it, the remaining cited
commits would have aged out by 10-15 04:07 UTC.

NOT fixed here: 22 cited commits were already deleted. Their original
`payload_hash`/`stack_result` are not recoverable (the compaction certificate
holds a different, compact result), so the sealed md5 cannot be re-proven.
Re-sealing them is a change to the evidence chain and is left as an explicit
open item, not worked around.
