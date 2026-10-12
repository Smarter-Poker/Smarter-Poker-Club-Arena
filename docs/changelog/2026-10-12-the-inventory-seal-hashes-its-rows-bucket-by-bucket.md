# The Inventory Seal Hashes Its Rows Bucket By Bucket (2026-10-12)

## What Happened

The week ending 2026-10-12 07:00 UTC is the first whose original inventory is too big to hash as one string. Its 28 six-hour layers were staged (1,590,639 touched rows) over the 1,846,384 rows of the 2026-10-05 checkpoint, and from 08:30 UTC every assembly in job 272 died with SQLSTATE 54000, "Cannot enlarge string buffer containing 1073741689 bytes by 442 more bytes". `rows_md5` was `md5(string_agg(<every row>))`: one text value, and a text value cannot pass 1 GB. Last week's 1.85M rows fitted at about 700 MB; this week's 3.35M rows need about 1.4 GB, and the inventory only grows.

Each failure wrote a critical `union_accounting_scheduler` alert ("The weekly original inventory checkpoint could not be sealed", 13 between 08:30 and 11:15 UTC), and because a seal was in progress job 272 rebuilt the 3.4M-row assembly on every five-minute tick, so the union week could not close and the database carried that read load all morning.

## Fix

Migration `20261012113248_the_inventory_seal_hashes_rows_by_bucket` (recorded as `the_inventory_seal_hashes_its_rows_bucket_by_bucket`):

- `fn_union_pnl_inventory_seal_advance` and the one-go `fn_union_pnl_inventory_checkpoint_seal` now take `rows_md5` as the md5 of the bucket hashes in order. A bucket is one source and the first two hex digits of `row_id`, hashed in `(source, row_id)` order. No value is larger than one bucket (about 13,000 rows today).
- A verify of a week sealed whole (up to 2026-10-05) still recomputes the whole-string hash it was sealed with. Nothing else reads `rows_md5`.
- Preimages pinned by md5; one transaction; `lock_timeout` 5 s.

## Proof

- Rolled-back trial against production: both bodies install, and the bucket hash over the sealed 2026-09-28 checkpoint (478,197 rows) runs in 6.4 s.
- Live: the 11:39 UTC tick sealed the week. `union_pnl_inventory_checkpoints` boundary 2026-10-12 07:00: 3,352,453 rows, `rows_md5` 5ae24d37326afb43bf598385c2ce24c5, sealed 11:40:53 UTC. No `union_accounting_scheduler` alert since 11:15, and the Midway Union week moved on to certifying.

Law: `tests/the-inventory-seal-hashes-its-rows-bucket-by-bucket.law.test.ts`.
