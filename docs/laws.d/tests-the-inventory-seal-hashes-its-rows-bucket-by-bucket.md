# tests/the-inventory-seal-hashes-its-rows-bucket-by-bucket.law.test.ts

The inventory seal hashes its rows bucket by bucket (2026-10-12): both fn_union_pnl_inventory_seal_advance and fn_union_pnl_inventory_checkpoint_seal take rows_md5 as the md5 of per-bucket hashes (one source and the first two hex digits of row_id, in row order), so no single text value ever holds every row of a week; a week sealed whole (up to 2026-10-05) is verified by its whole-string hash.
