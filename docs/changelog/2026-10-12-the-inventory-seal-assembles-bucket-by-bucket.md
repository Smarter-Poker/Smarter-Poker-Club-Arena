# 2026-10-12: the inventory seal assembles its week bucket by bucket

Follows `2026-10-12-the-weekly-close-never-holds-replication.md` (job 272 now
runs every tick on a 240 s statement budget, because Supabase Realtime shuts
replication down when one open writing transaction is more than 1.5 GB of WAL
behind).

## The step that was left over

fn_union_pnl_inventory_seal_advance computes a closed week's original inventory
six hours at a time (unlogged layers, no WAL), then wrote the WHOLE week into
union_pnl_inventory_checkpoint_rows in one statement:

| week sealed | rows      |
| ----------- | --------- |
| 2026-09-28  | 478,197   |
| 2026-10-05  | 1,846,384 |
| 2026-10-12  | 3,352,453 |

union_pnl_inventory_checkpoint_rows is ~3 GB for its 5.85M rows (~510 bytes a
row with its index), so the 2026-10-12 assembly alone wrote well over a
gigabyte inside one transaction, and next week's is past the 1.5 GB cutoff by
itself however fast it runs. It took ~90 s on 10-12 (771,495 ms seal minus
681,468 ms of layers), sealed at 11:40:53 while Realtime was already down.

## What changed (20261012135622_the_inventory_seal_assembles_bucket_by_bucket)

Outside a verify, the week is assembled one bucket (one source, the first two
hex digits of row_id: 5 sources x 256) at a time:

- each bucket reads exactly the rows the whole-week statement read (the
  week's latest layer image of every touched row, and every base row no layer
  touched; issues likewise), inserts them into the checkpoint tables, and is
  recorded in the new unlogged union_pnl_inventory_seal_buckets with its row
  count, rows hash, max event id and issue count;
- a call stops after 400,000 rows (~200 MB) or 75 seconds and returns
  `sealing`, and the next job 272 tick continues;
- the checkpoint row is written last, in a call of its own, from the buckets:
  rows hash = md5 of the bucket hashes in (source, bucket) order, empty buckets
  absent (the formula of 20261012113248); counts and max event id from the
  buckets; issues hash over the issues written. Then the staging is emptied.

Every reader finds a week through its checkpoint row (the base boundary is
always read from union_pnl_inventory_checkpoints), so a partial assembly is
never read. A week whose layers restart (absent or made for another base, as
after a crash, since both stagings are unlogged) deletes its partial assembly
first. A verify still rebuilds the week whole and writes nothing. The
migration refuses to install while a week is mid-seal.

## Equivalence

- Production, read-only: composing the sealed 2026-10-12 week bucket by bucket
  from its stored rows gives exactly its stored rows_md5 (5ae24d37...),
  row_count 3,352,453, max_event_id 63,116,879, and issues_md5 (94922459...)
  over its 245 issues. The per-bucket statement over the week's layers and the
  2026-10-05 base returned exactly the stored rows and issues in every bucket
  checked: 12 buckets across all five sources (edges 00 and ff, rows and
  issues), then every fourth bucket of tournaments and union_clubs (128
  buckets, rows hash), 0 mismatches.
- Local PostgreSQL 17 with production's exact preimage (md5 6deca796...) on a
  34,002-row synthetic week (base rows, rows touched in one to three layers,
  NULL images, base and layer issues): the old one-statement seal, the new seal
  in one call, and the new seal in 11 calls of 3,000 rows produce the same
  checkpoint row (row_count, issue_count, rows_md5, issues_md5, max_event_id,
  result_md5), byte-identical checkpoint rows and issues, and a verify of the
  bucket-assembled week returns `verified`.
