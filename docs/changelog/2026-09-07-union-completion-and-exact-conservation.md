# Union Completion And Exact Conservation

The original due runner reported already_settled after Round 1 rows existed, even when invoice issuance had failed. The executable original-function probe reproduced it. Completion now requires successful, non-skipped invoices and successful Round 2/3 outcomes without shortfalls, matched per eligible union. Re-running the original cascade refreshes invoice results and stores the latest financial-round retry outcome alongside its original record.

The arithmetic assertion accepted a one-cent difference and silently omitted checks when totals were missing. It now requires exact finite nonnegative whole-cent totals, rejects missing values and null checked wallets, and reads finalized Round 1 totals by exact union/period identity for already-executed replies. No player payment or clawback is issued by this migration.

Validation: actual cascade, due and assertion function bodies passed an isolated self-aborting pg_temp probe covering failed invoices remaining due, successful invoice retry, shortfalls remaining due, eligible-union completion, one-cent refusal, missing totals, finalized replay totals and null bank refusal. Financial-round, permissions, invoice and clock helpers were stubbed; actual ledger transfers, live scheduled execution and browser reports were not tested. The full journal and all-account conservation audit remains open.

Disabled invoice issuance remains visibly incomplete. This does not change invoice policy or regenerate historical statements. Legacy periods without authoritative finalized totals are unverified rather than presumed to conserve. No existing repair job or lockout is introduced.

Applied as database migration 20260907205211. The rollback probe passed again using the installed function definitions.
