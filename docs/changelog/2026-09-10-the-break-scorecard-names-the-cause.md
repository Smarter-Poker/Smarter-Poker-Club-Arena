# 2026-09-10 - the break scorecard names why a break never started

At 00:00 and 07:00 UTC the engine could not save its :53 announcement, cancelled
the maintenance break, and the fleet dealt through it (750 and 2,476 hands). The
scorecard failed both hours and then pushed only symptoms: "It Dealt 2476 Hands
Inside The Break. The Thaw Did Not Run ... Shipped No". Nothing recorded that
the break never started, or why.

## Shipped

Migration `20260910132747_the_break_scorecard_names_why_a_break_never_started`
(applied 13:40 UTC, recorded in `schema_migrations`):

- `engine_maintenance_break_faults` (new). One row per break fault, inserted by
  the engine as service_role: `announced_at` (that hour's :53 instant), `stage`
  (`announcement` | `countdown` | `adoption` | `boot`), `outcome` (`cancelled` |
  `held_without_restart`), `error`, `engine_version`. RLS on; PUBLIC, anon and
  authenticated hold nothing; service_role holds SELECT and INSERT only (probed:
  update refused).
- `fn_ca_record_break_scorecard`:
  - the deploy-attempt lookup prefers an attempt that shipped. 10:00 read
    `shipped=false` for f1992eeb (cut over 09:57:08) because a no-op
    "coalesced or already serving this commit" attempt at 10:01:04 was newer.
    06:00 had the same defect (56962e04).
  - `gate_opened` is also true when a verified cutover happened inside the
    break: the replacement engine writes a restart hour's log row and never saw
    readiness itself (09:00, 10:00 read false).
  - no break-log row: `break_never_started` leads `detail->'reasons'`, and the
    newest fault against that hour's announcement goes into `detail`
    (`never_started`, `fault_stage`, `fault_outcome`, `fault_error`).
  - recovery is measured over the tables that dealt at :48-:53 and are still
    open: the first minute by which 80% of those same tables have a hand after
    :00. 10:00-12:00 read 420-480 s because closed tournament tables sat in the
    base; they now read 120, 60, 120 s.
- `fn_ca_break_scorecard_push` renders the fault ("The Break Never Started: The
  :53 Announcement Could Not Be Saved (<error>)", the boot and other-stage forms,
  or "...And The Engine Recorded No Reason") and "Recovery Not Applicable" for a
  break that never started. All five shapes were rendered in a rolled-back probe.

Every hour already scored today was re-scored inside the migration with a guard
that no verdict may move; none did, and no notification was re-sent (the push
dedupes on its key).

## Deliberately not changed

- The verdict. `tests/the-break-clocks-agree.law.test.ts` pins it, and none of
  these corrections changes whether a break passes.
- 00:00 and 07:00 carry `fault_stage = NULL`: the fault table did not exist
  when those breaks failed. Faults are recorded from the engine change that
  writes them, which ships separately.
- A re-score reads table status at re-score time, so a re-scored hour's recovery
  base is smaller than the one its :12 job saw.
