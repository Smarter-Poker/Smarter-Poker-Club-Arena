# tests/the-supply-meter-counts-a-late-commit-in-its-own-hour.law.test.ts

fn_ca_supply_snapshot reads every balance and its ledger window in one statement, and counts a transaction that started before a reading but committed after it in the hour it becomes visible (each reading records the range it saw; the next recounts it), so a late commit is never read as a leak (incidents 2e00634c / d9ebce90 / 035e55db, 2026-10-02); and a chip shop refund declares issuance_reserve under its purchase key
