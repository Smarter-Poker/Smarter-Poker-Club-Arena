# tests/a-list-that-stops-early-says-so.law.test.ts

Every rake breakdown takes `p_offset`, reports `total` (how many rows exist behind the page) and `total_direct` (the money sum over EVERY row, via a window evaluated before OFFSET/LIMIT); `ca_rake_snapshot` reads `total_direct` rather than summing the page, so a share does not change as the operator pages; and the old un-paged arities are dropped so no call is ambiguous
