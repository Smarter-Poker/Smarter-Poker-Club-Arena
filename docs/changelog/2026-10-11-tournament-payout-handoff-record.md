# The tournament payout handoff has its missing production record

The October 10 tournament payout handoff left migration 20261010061706 unrecorded. It declares tournament_players.zz_restriction_tourney_paid_guard, preventing a reviewed paid-entry guard from being reported as undeclared. Production already contains the declaration; this change does not replay it or move money.

Recovered the exact production SQL via public.fn_ca_migration_text as UTF8 base64: MD5 f7e1dfbfdbe3037d015a73255f58228d, 1882 bytes. Added the migration file and its recorded-migration manifest evidence. The existing recording, trigger and payout-rail law tests enforce the maintained record.

Read-only production verification October 11, 14:33-14:36 UTC: zero unpaid completed events, zero stuck completions, both deferred completion locks enabled, obsolete satellite batch guard disabled. Settlement-total mismatch, prize-disbursement, satellite-conservation and unpaid-Spin audits returned no rows over 48 hours; payout rows without money returned no rows over seven days. The 48-hour completed cohort contains 57,423 prize-pool events. The payout-guarantee and settlement-total definitions both read the Diamond ledger.

Eight handoff-required local test files passed: 1019 tests with zero skips. Protected CI and merge are separate pending evidence, retained in the task checkpoint. This is an already-installed migration record, with no new client or engine behavior.
