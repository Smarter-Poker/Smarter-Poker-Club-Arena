# tests/the-hourly-sweep-reads-each-leg-once.law.test.ts

Migration 20261022162545 keeps the sums of ledger legs older than every open transaction (the journal is append-only) so the hourly conservation sweep adds only the legs after them, asks whether a hand was dealt instead of counting 1.48M, and reads payout claims and Spin overlays by key. The law pins those shapes, the pinned preimages, the advance running first in its own exception block, and that no check, job, repair or horse filter was added or removed.
