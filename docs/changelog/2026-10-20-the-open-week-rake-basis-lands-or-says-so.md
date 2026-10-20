# The open-week rake basis lands, or says so once (2026-10-20)

Migration: `supabase/migrations/20261020010133_the_open_week_rake_basis_lands_or_says_so.sql`
Native proof: `scripts/qualification/union-rake-basis-lands.py` (evidence in
`docs/evidence/union-rake-basis-2026-10-20/run.json`)
Law: `tests/the-open-week-rake-basis-lands-or-says-so.law.test.ts`

## What happened

Midway Union's open-week rake basis snapshot (`union_rake_basis_snapshot`,
week of 2026-10-19) was last written at 22:35 UTC, through 15:43:12. Job 123
(`union-integrity-sweep`, `fn_union_integrity_sweep_all`) succeeded at 23:35
and 00:35, about 155 s each, and wrote neither a snapshot nor an alert. The
2026-10-12 week had stopped the same way on 2026-10-15 17:19 and never
refreshed again before the week ended: 56 two-hour windows saved, the last
ending 2026-10-16 21:00, under six different input stamps.

All reads below were taken read-only on production between 00:45 and 01:00 UTC.

### Why it wrote nothing

`fn_union_rake_basis_windowed` stops starting windows 120 s into the
statement and answers `in_progress`. The refresh turns that into
`success: true, skipped: true, reason: windows_in_progress`. At 00:35 the
money controls took about 31 s, then windows 07-09 (40.8 s), 09-11 (10.2 s),
11-13 (6.5 s), 13-15 (6.0 s) and 15-17 (61.7 s) were proved; at 156 s the next
window was refused and the refresh returned `windows_in_progress`.

The windows from 07:00 to 15:00 had been proved before. They were proved again
because every saved window's stamp carried `fn_accounting_clubs_scope_digest()`,
an md5 over every club on the platform, and a release certification had created
`Crest Cert Template d2916e44` (no union) at 00:34:16. So every saved window of
every union went stale, and the week was proved again from Monday 07:00. Once
the 15:43 owner move's 12,000-hand backlog accrued, that no longer fit an hour,
and with the next certification club it started over.

A window reads `clubs` in exactly one place: a union-house source must come
from a club that `is_union` and is this union (`id` or `union_id`). A club
anywhere else cannot change what a window proves.

### Why the windows were slow

`fn_accounting_union_earned_plan_window` joins materialized CTEs by equality.
The newest windows are read before ANALYZE has seen their rows, so the planner
estimates one row per CTE and picks nested loops that rescan one CTE per row of
another. `EXPLAIN ANALYZE` of the window's own statement on production, 15:00 to
17:00, warm: 104.9 s, of which q5 (37,172 sources x 9,409 receipts) took 78.9 s
and q3 (9,409 receipts x 9,409 accrual groups) 25.1 s. With
`enable_nestloop = off`: 8.9 s. With tour_keys also reading only the window's
recognitions (its equality already implies the range) instead of all 444,926:
3.0 s. 07:00 took 4.2 s and 19:00 6.5 s on the same plan.

### Why nobody was told

The sweep counted every skipped refresh as skipped. Only an exception or the
statement timeout raised a `financial_alerts` row. A refresh answering
`success: false` (`accrual_cursor_unknown`, `accrual_not_yet_in_window`)
matched neither branch and was dropped as well. And a repeated error added a
new row every hour, so there were four open `failed` rows for Midway from
07:35 to 14:35 on 2026-10-19 that nothing closed.

## What changed

1. `fn_accounting_union_earned_plan_window` sets `enable_nestloop = off` and its
   tour_keys recognition join states the window its equality implies. The six
   proofs, the conservation test and every output are unchanged. The weekly
   close proves its windows with this same function, so it gets the same plans
   and the same results.
2. `fn_union_rake_basis_windowed` stamps a window with the digest of the
   union's own row and every club whose `union_id` is the union. This is the
   same text that PR #7090 (held since 2026-10-16) proposed for the same cause,
   and it covers every club a window reads. Windows saved under the platform
   digest are still reused, and restamped, while that digest is unchanged, so
   installing this recomputes nothing.

   Every call now proves at least one window before the budget can stop it.

   The migration accepts either production's text or #7090's postimage, so the
   two can install in either order. If this one installs first, close #7090:
   its guard will refuse, and it is superseded.

3. `fn_union_integrity_sweep_all` counts a refresh as landed only if it wrote
   the snapshot or found its inputs unchanged. Any other outcome holds exactly
   one open warning per union and kind:
   - `not_landed`: the refresh answered without writing;
   - `out_of_time`: the statement timed out, including any union the sweep then
     could not reach;
   - `failed`: the refresh raised an error.

   A repeat bumps `repeats` and `last_seen_at`. A landed refresh resolves all
   three kinds for its union, including the older `failed` rows that have no
   kind.

No repair job, backfill or new schedule. `fn_union_rake_basis_refresh` is not
changed.

## Proof

`union-rake-basis-lands.py` builds its own PostgreSQL 17 cluster over the
accounting fixture and production's bodies (md5-verified), and runs the
migration file whole. Before and after:

- **Budget spent by the money controls.** Before: two hours prove nothing and
  raise nothing. After: each hour proves a window and keeps one open
  `not_landed` warning (repeats 0, then 1). The next free hour lands and
  closes it.
- **The refresh answers false, then raises.** Before: silent, then one new row
  per hour, still open after a landing. After: one warning per kind, closed by
  the landing.
- **The statement timeout fires inside the first union's refresh.** Before: the
  loop ends and the union after it is never told. After: both unions hold one
  `out_of_time` warning (the second marked not attempted), closed by a landing.
- **PR #7090 installed first.** This migration still lands on the same
  postimages and reuses #7090's windows (5 reused, 1 tail).
- **A club created outside the union.** Before: all 6 windows proved again.
  After: 5 reused, including windows saved by the old body. A union club
  joining the union still re-proves all 6, and the basis is identical.
- **A 5,000-hand window under stale statistics.** Before: CTE rescans
  (`cw`, `xw`, `tw`, `rw`, `fw` x5000). After: none. Every window's output and
  tour_keys rows are identical.

## After install

The next hourly sweep reuses the saved windows (07:00 to 17:00 were saved at
00:37), proves the rest at a few seconds each, and writes the snapshot.
