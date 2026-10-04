# tests/the-ledger-replay-knows-which-legs-its-snapshot-saw.law.test.ts

The nightly ledger replay records, per reading snapshot, the legs with xid at or above the snapshot xmin that the reading actually saw, and the window readers trust pg_visible_in_snapshot only below that xmin or for a recorded leg, so a leg written in a subtransaction of a transaction still running at the reading is counted in the next window instead of dropping out of both (the +190.00 / +10.00 / +-6.21 drift of 2026-10-04). Migration 20261004135607.
