# tests/a-union-send-is-suppressed-only-as-a-retry.db.law.test.ts

The Union Wallet's send to a member suppresses a send as a duplicate only when the same actor sent the same kind and amount from the same union to the SAME member within 20 seconds, matched through the recipient-side chip_ledger leg that send journalled in its own transaction (migration 20261010004314, md5-pinned over production's live text; qualified by scripts/ci/test-union-send-db-postgres.py), so a send to a different member, or of the other kind, is paid instead of being answered success with nothing moved.
