# Phase 16 Mobile Acceptance Follow-Through

## Published Mobile Repair

PR4162 merged as cfcfa372509bdf37e30d4e6b8a7fe6645fe6ab50. Its publication was
initially blocked by shallow checkout history in publisher run 34483699791;
PR4163 repaired that independently, merged as
bb7a6ba30639fdfc5ae81df52d4e9f0b7c6afa9a.

At 2026-09-10 14:18:32 UTC, public and origin build-info agreed on
010183495722982bfa2f1c14a8bb6e6fa358d9b1. The HTML-referenced stylesheet
contained the 44 by 44 pixel ad target and the entry-referenced Arena boundary
stylesheet contained the coarse-pointer 44 pixel navigation target. Both
actual stylesheet bodies matched between public and origin. Build identity
was checked again after the asset reads. The machine receipt is
2026-09-10-realtime-phase16-mobile-publication.json.

## Production Acceptance

Post-deploy run 34486463620, job 102901893525, tested live release
bb7a6ba30639fdfc5ae81df52d4e9f0b7c6afa9a, observed at 14:03:57 UTC. Its trigger
SHA was 0101834957; trigger identity and tested identity are different.

- Both production Cashier cases passed at 14:04:44 UTC.
- The production mobile target test passed at 14:24:10 UTC: 48 checked,
  zero misses. Existing probe exclusions were retained; no exclusions were
  added for this repair.
- The complete run executed 290 tests: 284 passed and six failed, with four
  additional tests skipped and no flaky results. It was not an all-green run.
- Three tournament continuity cases stopped at the engine release prerequisite:
  observed engine version 6aee0b67 did not match the expected live release.
- The occupied cash selector and Daily Missions freeze interaction failed
  against their old code. PR4166 subsequently repaired these, merged as
  0a76896196c1bea84de06d14ff998b83ab921117 with CI green. This run predates those
  repairs and cannot certify them.
- The sixth failure was Club Data player pagination: Load More Players stayed
  at 100 Of 571 after the click for the 60 second assertion window. Despite
  the broad test title mentioning sorting, the failing assertion was line 185,
  player pagination. Its cause is not established by this log alone.
- Canary cleanup verified absence at 14:28:53 UTC. Retained artifact:
  10157020124, 10,527,653 bytes.

## Remaining Evidence

The next production verdict must exercise the published PR4166 code. Physical
iPad/PWA and natural reconnect evidence remain unavailable from this Mac-only
device session. The supported interactive browser timed out refreshing tabs.
Engine release sealing and Stage-B coordination remain with the owning task;
the exact engine release and pre-existing progressing-hand gates remain intact.

At 14:18:10 UTC, a read-only Supabase snapshot showed 97 connections,
30 cumulative deadlocks, zero conflicts, and 5,655 successful plus one running
cron execution in the preceding six hours, with no failed executions in that
window. Counter reset context was unavailable, so the deadlock count is not a
trend or attribution. Connected access still provides neither detailed
PostgreSQL caller logs nor per-service egress evidence.
