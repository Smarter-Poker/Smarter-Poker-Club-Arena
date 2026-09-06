# 2026-09-06 - Table Management Phase 4 Realtime And Observability Recertification

## Scope

Phase 4 was re-audited from the current production definitions after the first
three Table Management phases and the later scale work had landed. The audit
covered the scoped realtime feed, recipient invalidations, named client events,
operator health, content audits, publication membership, RLS, triggers, grants,
and the production query plan.

## Corrections

- Access invalidations now notify both the old and new user/scope when a club
  role, union administrator, or union membership row is reassigned.
- The union membership trigger now covers `UPDATE OF union_id, club_id`, not
  only inserts and deletes.
- Club ownership transfers now invalidate the old and new owner's Table
  Management page and hamburger capability immediately.
- Union membership invalidations include only active operators whose roles can
  actually manage games; the obsolete `host` role is no longer treated as a
  club role.
- Ticker, announcement, and club identity emitters ignore revision-clock and
  same-value writes, preventing false cross-device refreshes and audit noise.
- The operator health reader now obtains its latest marker independently and
  bounds event counters to the last 24 hours. A concurrent covering index keeps
  that read on the requested scope and time window.

## Production Baseline

Before correction, `game_management_events` contained 1,470,044 rows. The
largest union held 1,009,397 of them, and its health aggregate performed a
parallel sequential scan in approximately 1.26 seconds. The new index is built
concurrently so live invalidation writes are not blocked.

After correction, the authenticated production RPC returned the same complete
health shape in approximately 391 ms with a 24-hour event bound. Its live
result reported zero integrity alerts, and the new covering index was both
ready and valid.

## Verification Contract

- The transactional migration refuses to install unless the concurrent index
  exists and is both ready and valid.
- Migration tests pin both-sided invalidation, ownership coverage, role/status
  filtering, metadata no-op behavior, grants, and the bounded health query.
- Hook tests cover wrong-scope rejection, all named content events, degraded
  connection states, and authoritative resync after subscription recovery.
- Production verification uses read-only catalog checks, query plans, and an
  aborting database probe. It does not create games, register players, or move
  chips.
