# 2026-10-24: the horse capture queue drains in order

## What was wrong

The horse opponent-observation capture queue
(`horse_observation_capture_work`, phase 14) was losing about 60% of the horse
observations it was asked to capture. Hand sources can be read for 24 hours
only, so every lost window was lost for good. These numbers were read from
production on 2026-10-24 and 2026-10-25 with SELECT only:

- 256 of 256 capture slots were occupied, and 161 of those requests were part-done.
- 64 requests expired to `source_expired` in one afternoon.
- Every discovery epoch since 2026-10-17 was created with `skipped_epochs = 2`,
  and 45 of the 65 retained epochs ended as `source_expired` gaps.
- One serial consumer recorded 86 to 226 slices an hour against 13 to 95 new
  requests an hour, while the journal queue sat empty (`unfinished 0`).

Five lines caused it:

1. `fn_claim_horse_observation_capture` claimed `ORDER BY available_at`. Every
   successful slice reset `available_at`, so the claim round-robined one slice
   at a time across about 255 requests. No request finished and freed its
   slot, the oldest expired part-done, and discovery refused new work
   (`capture_queue_full`).
2. `fn_finish_horse_observation_capture` set the next slice to three times the
   last one (`last_ms + 2*(last_ms - first_ms)`). For an active horse that
   overshot the 512-hand budget, so the read was refused and the slice halved
   (`source_budget_refined`). About half of all reads were spent learning that
   a slice was too wide.
3. A read that hit the 5 s client timeout came back `source_unavailable` and
   was retried at the same width until the request expired.
4. `fn_discover_horse_observation_requests` began every new epoch at the newest
   5-hour boundary, so it skipped every window that had gone by in between.
5. `horseAdaptiveJournal/loop.ts` ran one slice, paused 1 s, ran a journal
   turn, then paused again, even when the journal was empty. That came to
   about 17 s per capture.

## The fix (root, no backfill or repair job)

The database side is migration `20261025042223_horse_capture_drains_in_order.sql`:
one transaction with `lock_timeout` set, an md5 pre-image guard on every
function it replaces, and a post-image check of each body, security mode,
volatility, setting and grant.

- **Oldest first.** A claim orders by `created_at, request_key`, so a request
  drains to the end and frees its slot.
- **The slice ends at a hand boundary.** The new function
  `fn_horse_capture_hand_budget_through` reads the snapshot's own overflow
  precheck: up to 513 per-player index rows whose hand still exists, oldest
  first. It returns the millisecond of the 512th hand, or the millisecond
  before the 513th when the two share one. The claim ends the slice there. If
  the request's previous slice shows hands dense enough that 512 of them would
  pass 7 MiB of the 8 MiB byte budget, the claim uses a proportionally smaller
  count instead. The snapshot's refusal itself is unchanged (more than 512
  hands); it now also reports `budgetThroughMs`.
- **No overshoot.** After a success, the next slice is the rest of the request,
  and the claim bounds it again.
- **A timeout narrows the slice.** `source_unavailable` is refined at once, the
  same way `source_budget_exceeded` is: to the hand boundary, or to half of the
  slice's hands, or to half of its time.
- **Discovery resumes.** A new epoch starts at the boundary after the previous
  epoch ended. The only windows it steps over are ones that would start within
  an hour of the 24-hour horizon; those are still counted in `skipped_epochs`.
- **Engine.** `HorseObservationCapture.ts` accepts the rest-of-request next
  slice and any strictly narrower refine. It also still accepts the old 3x
  shape, so an engine and a database on either side of the migration agree.
  `loop.ts` runs capture slices back to back while the journal has no work of
  its own: capture, the journal turn that records its batch, one journal turn
  that finds nothing, then the next capture, with no pause between them. The
  1 s fairness pause and the eight-turn rule now apply only when the journal
  has a backlog of its own. A zero pause still yields to the event loop once
  and still runs a commitment-audit step when one is due.

Horses are players (CLAUDE.md 10.5): this restores observation of every
seated player's hands. Nothing here filters anyone out.

## Proof

- `scripts/ci/test-horse-capture-drains-in-order.py` runs on a throwaway
  PostgreSQL cluster. The production pre-images reproduce from the repository
  by md5. The test then installs the migration, replays it, and covers: the
  guard refusing an unmeasured body, the oldest-first claim, the 512-hand
  boundary, a request draining in two reads with no refine, the timeout refine,
  the discovery resume, and the preserved security mode and grants. It runs in
  `horse-snapshot-overflow-precheck.yml`.
- `scripts/ci/test-horse-snapshot-overflow-precheck.py` now also holds the
  successor to the same index-only refusal.
- The law test `tests/horse-capture-drains-in-order.law.test.ts` has its entry
  in `docs/laws.d/horse-capture-drains-in-order.md`.
- `server/src/services/horseAdaptiveJournal/captureBackToBack.test.ts` covers
  back-to-back captures while the journal is idle. `captureLoop.test.ts` and
  `HorseObservationCapture.test.ts` were updated for the behaviour that was
  replaced.

## Not done here

The migration is not applied. It reaches production through the normal
merge-and-apply route. Windows already past the 24-hour source horizon cannot
be read and are not recovered; by design, no backfill exists.
