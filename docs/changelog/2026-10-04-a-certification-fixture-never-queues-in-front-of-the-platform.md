# A certification fixture never queues in front of the platform (2026-10-04)

Migration: `20261004002615_a_certification_fixture_never_queues_in_front_of_the_platfor`.
Law: `tests/a-certification-fixture-never-queues-in-front-of-the-platform.law.test.ts`
(`docs/laws.d/a-certification-fixture-never-queues-in-front-of-the-platform.md`).
Harness: `scripts/ci/test-a-certification-fixture-never-queues-in-front-of-the-platform.py`.

## Why (phase 7, availability and break throughput)

Advisory lock (530090,1) is the platform's entry and maintenance gate. Every
buy-in, add-on, rebuy, registration, seat acquisition, tournament launch and
blind publish takes it shared; the maintenance break (save, claim, clear,
thaw) takes it exclusive with a 32 s lock timeout. Four production
welcome-certification fixtures (run by the post-deploy certification through
`fn_ca_retire_welcome_certification_club`) also took it exclusive, with
`pg_advisory_xact_lock` and no timeout.

In Postgres a waiting exclusive request sits in the lock queue and every later
shared request queues behind it. So while a fixture waited, every purchase on
the platform waited for the fixture. Lock waits of 1 s or more on this key, 24 h
to 00:30 UTC 2026-10-04:

| waiter | waits | longest |
| --- | --- | --- |
| purchases and launches (shared), all paths | about 4,500 | 6.3 s |
| `fn_ca_prepare_unused_welcome_certification_board_leases` (exclusive) | 76 | 7.6 s |
| `fn_save_engine_maintenance_break` (exclusive) | 10 | 9.7 s |
| `fn_ca_prepare_post_reset_welcome_certification_fixture` (exclusive) | 2 | 1.0 s |
| `fn_thaw_platform` (exclusive) | 1 | 1.0 s |

The fixture waits fall in every part of the hour, one or more runs an hour,
because every merge deploys and certifies.

## Change

The four fixtures (`fn_ca_prepare_post_reset_welcome_certification_fixture`,
`..._board_leases`, `..._board_games`, `..._board_origins`) ask for the gate with
`pg_try_advisory_xact_lock` every 50 ms for up to 30 s. A try never joins the
lock queue, so no purchase waits behind it. Once a fixture has the gate it holds
it exclusively to the end of its transaction, exactly as before. After 30 s it
raises `CERTIFICATION_FIXTURE_GATE_BUSY` (55P03), the same class as a lock
timeout, and the certification fails rather than the platform stalling.

The maintenance break functions keep their queueing lock: they must not be
starved by a steady stream of purchases. No money path changes.

## Proof (local PG17, the shipped migration on stand-ins with the same fragment)

| case | result |
| --- | --- |
| the four substitutions apply, one occurrence each | ok |
| before: the next purchase waits 1.2 s behind a waiting fixture | ok (the defect) |
| after: the next purchase takes the gate in 9 ms; the fixture still completes | ok |
| the fixture holds the gate exclusively to its commit | ok |
| a gate held shared past 30 s: the fixture refuses at 30.1 s, purchases unaffected | ok |

## Applying

Every post-image md5 was computed read-only on production before the file was
written. The migration has no write keyword, so it is applied through the
Supabase MCP outside the :50-:03 break window.

## Applied

Applied to production at 00:29 UTC 2026-10-04 (recorded as `20261004002905`).
The four fixtures read back as their pinned post-images (`93be153c`,
`c0e56e2a`, `8202c73d`, `adc1f350`) with privileges unchanged
(`{postgres=X/postgres}`).
