# Expired Maintenance Ownership Cannot Block Future Releases

Date: 2026-09-09 UTC. Scope: the existing Club Arena maintenance-save RPC.

## Production Evidence

Deployment run 34290558940 completed with a green job but skipped the actual
cutover and all version-verification steps. Its 2026-09-08 log observed last_hand
at 23:53:12, 23:53:28 and 23:53:43, then idle from 23:53:58 onward. It never
observed readyForRestart. At 23:59 the running engine was still 276faa64.

At 00:09:54, the durable singleton still contained the 22:53:00 announcement
from engine 54ed5bc1, phase last_hand, with neither countdown start nor end.
The latest completed break/thaw record was the 21:55 break ending at 22:00.
The database outage overlapped the subsequent 22:53 announcement and restart.

The engine can finish startup unpaused after exhausting its persisted-break
reads. If that happened while an old row remained, its new process token never
owned the row. The prior save function allowed only equal ownership tokens.
Consequently a later fresh announcement could never replace the expired old
record. Cancellation re-armed the next hour, but that hour faced the same
ownership refusal. This is a permanent release-blocking condition in the old
code, regardless of whether any particular request also timed out under load.

## Root Correction

The same atomic upsert retains equal-token updates and admits a different token
only for a fresh last_hand announcement when all of these hold:

- It carries no countdown start or end.
- Its announcement is no more than two minutes old or five seconds ahead of
  database time, sampled after the maintenance advisory lock is acquired.
- The prior announcement is older than eight minutes, matching the engine's
  maximum adoption age, and predates the incoming announcement.
- The prior recorded end has passed. A last_hand row without an end uses its
  seven-minute announcement-to-resume window.

An active break cannot be shortened or replaced. A stale countdown write cannot
pretend to be a new hour. The exclusive maintenance lock still orders new
announcements after already-admitted entries. Both the row conflict and expiry
predicate are evaluated after that boundary, including when another writer
renewed the old token while this caller waited.

No control row was manually removed or rewritten. No engine was restarted.
The installed correction takes effect when the existing engine next makes its
normal scheduled announcement.

## Verification And Installation

The standalone PostgreSQL 17 probe first reproduces the old refusal, then tests
the replacement against actual transactions, roles and RLS. All 42 checks pass:
expired announcements/countdowns, active/future ends, adoption grace, malformed
or stale incoming phases, missing token, old exact cleanup, same-owner phase
advance, browser-role refusal, service execution, shared-lock ordering, and a
concurrent renewal that must defeat the waiting contender.

The probe runs only on an isolated Unix socket as journal_test or
maintenance_test, and is wired into the existing isolated CI entrypoint.
No production DDL was used as a diagnostic probe.

82 maintenance, adoption and serialization tests pass across three files.
The existing maintenance-save law now reads the latest migration, preserving
the lock, timeout and ownership assertions against the function being shipped.

Repository migration:
20260909001350_expired_maintenance_owners_cannot_block_a_new_hour.sql

Installed migration catalogue:
20260909002144, expired_maintenance_owners_cannot_block_a_new_hour.

Live function-body MD5: 1eeb21b2d8c1c15e15e925871b46d1c1.
The definer mode, public/pg_temp search path, 45s statement limit, 40s lock limit
and service-only execution are verified. Claim and exact-clear functions are
unchanged: cbe93f09bb0a5c5e815ca8faaa0cbb44 and
88d87f45e2adfc1e2c7ca5dfb71b9f77 respectively.

## Acceptance Still Pending

The next :53 announcement must replace the expired record, the :55 restart
gate must open only after tables park, and a normal deployment must actually
move the engine version. A green workflow alone is insufficient.

#3901 private-card batching merged as 9ef973e9657f051ef114ddb52006abeb6801d2fd;
its pre-push gate passed 517 tests with 18 existing skips. Its server change,
and #3897's departure-read overlap, still need running-engine adoption and
loaded-fleet timing measurements. See 2026-09-09-private-card-write-batch.md
for database CPU and PostgREST queue evidence. The whole hand-delay and
physical iPad reconnect acceptance remain open.
