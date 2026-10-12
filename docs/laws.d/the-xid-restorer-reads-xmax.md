# tests/the-xid-restorer-reads-xmax.law.test.ts

fn_ca_xid8 restores a tuple xmin's epoch against the snapshot's xmax, never its
xmin, so the ledger replay judges "did the previous reading see this leg?"
correctly while an older transaction is still open (against xmin, every newer
xid came back as the future and a seen leg was counted twice). Migration
20261002171027, which also acknowledges supply reading 779 (-100,005.30 at
15:05 UTC on 2026-10-02, a certification retirement that committed after the
14:05 reading; restated to -5.30 with late_burn 100,000.00). Executed on
PostgreSQL 17 by scripts/dev/test-xid-restorer-reads-xmax.sh.
