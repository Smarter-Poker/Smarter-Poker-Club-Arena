# A detector does not report what it already answered for

2026-09-10

## What happened

13:23 - incident `28119497` resolved. `correction_ref` named the two migrations
that fixed the tournament-lease churn this morning
(`a_hand_commit_does_not_hold_the_lease_against_its_own_heartbeat`,
`a_busy_manager_keeps_its_lease`), with the measurement: **zero** hand commits
refused for "lease proof expired" in the eleven hours since.

13:52 - the hourly conservation sweep opened `81150ce8`. Same source. The same
117 refusals across 99 tables, every one of them timestamped 02:xx, every one of
them from the cause that had just been fixed.

## Why

`fn_ca_hand_commit_refusals` reads a **rolling 24-hour window** with a floor of 25. The 117 stay inside that window until roughly 02:00 the next morning, so the
detector would have re-opened the same incident once an hour, twelve more times,
for a defect that no longer happens. Resolving one only lets the next sweep open
another.

This is the third time today the same shape has appeared. The append-only notice
did it forty minutes earlier - `0ad5625e` closed at 13:23, `d03c35bf` opened at
13:27 on the same dedupe key - and was fixed by
`a_maintenance_kind_registered_as_info_is_recorded_not_raised`. CLAUDE.md 10.84
already names the cost: an alarm that cannot be turned off by fixing anything is
an alarm people learn to scroll past, and it hides the ones that matter.

## The rule

A detector reports what has happened **since the correction that answered for
it**. Its window starts at the later of

1. `now() - p_hours` - its own rolling window, unchanged; and
2. the `resolved_at` of the most recent RESOLVED incident for that source whose
   `correction_ref` is non-empty.

(2) is not a mute. A `correction_ref` is a deliberate, written assertion that the
cause was fixed at that moment. Anything the detector sees after it still counts,
still has to clear the same floor of 25, and still raises. A resolution with no
correction_ref - `verified:`, `no-change-needed:` - does not move the window at
all, because nothing was corrected.

## The change

`20260910140538_a_detector_does_not_report_what_it_already_answered_for` - an
asserted text substitution on the live definition:

- the rolling-window clause must appear exactly ONCE, or the migration aborts;
- the floor of 25 must survive (this narrows WHEN it looks, never HOW LOUD it
  has to be before it speaks);
- the rolling window must survive;
- and after the change the detector must return **zero** findings - the
  measurement that says the cause is gone rather than merely hidden. If it
  returned anything, those would be new refusals and the migration would refuse
  to close the incident.

Written inline rather than as a shared helper because this is the first detector
to need it. The next one copies those six lines;
`tests/a-detector-does-not-report-what-it-already-answered-for.law.test.ts` pins
the shape so the copy is a correct one and nobody simplifies the watermark back
out.
