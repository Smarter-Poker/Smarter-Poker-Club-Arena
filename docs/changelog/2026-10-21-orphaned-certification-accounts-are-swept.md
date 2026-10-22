# A Busy Database No Longer Strands A Post-Deploy Test Account In Real Clubs

Owner instruction, October 21, 2026: remove lingering test accounts and stop them
from lingering again.

## What happened

PostDeployf3622 was created at 23:57 UTC by Post-Deploy E2E run 39694814807
(Client browser verification) and sat as an admin in KINGS CLUB and Deep Stack
Society for about two hours.

The root cause is in `scripts/ci/qualify-agent-boundary.mjs`. It makes the reserved
identity a super agent to prove the agent bank and private-data boundaries, then
removes that agent row in its `finally` block. In that run the DELETE was cancelled
by the 8 second service_role statement timeout (57014) and was asked exactly once.
The agent row stayed, so the account cleanup door
(`cleanup_reserved_certification_account`) correctly refused
`CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY` 47 minutes later and
the identity was left in both clubs.

## The fix

Why the DELETE was slow is fixed separately by #7647 (an agent row deletes without
scanning every rake attribution). That makes the timeout rarer; it does not make a
single-attempt teardown safe, because any busy moment produces the same 57014.

The teardown now runs through `retryTransient` (`scripts/ci/transient-retry.mjs`),
the same bounded retry the account cleanup already uses. Each teardown step re-reads
state before writing, so a statement that timed out (and therefore rolled back) is
safe to ask again. Only transient failures retry; a refusal such as 55000 still
fails at once. The qualification's own error is still reported after a successful
teardown.

`tests/unit/agentBoundaryTeardownRetries.test.ts` runs the real script against a
scripted database whose first agent DELETE times out. It fails against the old
script (one attempt, agent left behind) and passes against the new one (two
attempts, agent removed, admin role restored). A definitive refusal is proven not
to retry.

## A withdrawn sweep

Migration `20261022014819` first added a pg_cron sweep for orphaned certification
accounts. That is a band-aid under CLAUDE.md 10.12, so `20261022021302` removed the
cron job and the function 24 minutes later. Both files are byte-exact recordings of
what production ran, listed in `scripts/ci/recorded-migrations.manifest.json`;
production holds neither the job nor the function.

## Cleanup done

PostDeployf3622 was removed through `cleanup_reserved_certification_account` after
confirming no certification run that could own it was still running.
