# BBJ Contribution Identity, 2026-09-08

The former NULL-hand path read its receipt before acquiring the pool lock and never rechecked it after waiting. Two sessions submitting the same 0.25-chip table/hand payment both returned distinct contribution receipts and banked 0.50 chips in the isolated reproduction.

Migration 20260908045746 serializes hand UUID and table/hand identities before acquiring the pool lock and reading the receipt. Replay identity is independent of the destination pool. A reused identity must match the recorded hand, pool, table, club, amount, blind and hand number; conflicting requests fail before changing money or allocation residue. Missing stable identity, nonpositive/nonfinite amounts and sub-cent amounts are refused. Caller-supplied split portions remain ignored because the existing database policy allocator owns the split.

The allocation, contribution receipt, all three pool balances and journal entries remain in one transaction. The function restores all five journal context settings it changes, so a nested caller keeps its original context. The existing service-role-only permission is preserved.

Validation: 28 sequential PostgreSQL cases and four two-session cases passed using the actual contribution function, residue allocator and journal writer with isolated table fixtures. Journal failures cover lock timeout, deadlock, constraint failure, uniqueness failure and internal error. The original body independently reproduced the double credit. The complete database suite passed 198 cases on PostgreSQL 17.11. The migration was applied to production with an exact previous-definition hash guard and a three-second DDL lock timeout.

A production query found no duplicated non-null hand UUIDs in bbj_contributions at audit time. This does not establish the absence of historical NULL-hand duplicates or prove that the reproduced race caused a particular incident. No historical balances or incident states were changed.

Open work: engine pool selection still caches by club and ignores private-table scope; stack settlement and fee banking remain separate transactions. The pre-existing fn_bbj_repair_unbanked path still writes directly and can advance allocation residue before finding that another writer already inserted the contribution. This change adds no repair path and does not certify those outstanding paths as correct.
