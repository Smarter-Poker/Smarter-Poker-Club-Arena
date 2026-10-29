# Weekly tournament fee fingerprints serialize economic fields once

The existing fingerprint aggregated 17 keys while converting the complete rake record to JSONB for each key. Fee validation calls it repeatedly during weekly close. The function now builds the same versioned 17-field JSONB object directly before hashing it. No field, numeric rule, timestamp representation, source generation, payout or ledger changes.

The installer replaces only this function and preserves its complete metadata and ACL. It refuses a changed admission ABI, reader, lock function, immutable guard or trigger; it leaves the completed unlimited-MTT activation guard byte-identical. Original source65 and generation witnesses run before and after the short DDL statement, and a failed postcondition rolls back replacement.

Required Accounting shard 1 runs the private PostgreSQL 17 regression through its existing floor. It covers complete JSON and hash equality across nulls, all populated fields, timezones, numeric/timestamp special values, Unicode, large JSON, unrelated columns and schema additions, plus actor/replay/authority/source/ABI failures and postcondition rollback. These isolated results do not establish production close capacity or completion; that requires installation and a successful original close with durable wallet and duplicate-payment verification.
