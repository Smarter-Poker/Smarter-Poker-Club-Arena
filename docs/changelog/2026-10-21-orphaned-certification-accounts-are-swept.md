# Orphaned Certification Accounts Are Swept

Owner instruction, October 21, 2026: remove lingering test accounts and stop them
from lingering again.

PostDeployf3622 (created 23:57 UTC, Oct 21) sat as an admin in KINGS CLUB and Deep
Stack Society for about two hours. Its certification run ended without its
always() cleanup, and the only other recovery, `cleanupStaleProductionE2EAccounts`,
runs inside the Club Create Certification job alone. It was removed through
`cleanup_reserved_certification_account` after confirming no certification run that
could own it was still running.

Migration `20261022014819_ca_orphaned_certification_account_sweep` adds
`fn_ca_sweep_orphaned_certification_accounts()` and the pg_cron job
`ca-orphaned-certification-account-sweep` (minutes 12, 27 and 42, outside the
:50-:03 break). It calls the same guarded door on identities older than 112 minutes
(`STALE_ACCOUNT_AGE_MS`), so a running certificate never loses its identity, and
skips identities that still own a club or union, which the CI recovery retires
first. Execute is revoked from PUBLIC, anon and authenticated.

Verified in production: installed version read back, cron job active, function
returns `{"swept":0}` with no stale candidates, anon and authenticated cannot execute.
