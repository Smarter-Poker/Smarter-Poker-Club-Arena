# A successor drain keeps its pause until the event is handed over

On October 23, the dealing SLO alert at 18:49 UTC named 20 minutes without
progress. Eleven failing dealers belonged to Coffee Break Freeroll (PLO4),
event `a99d2838-aee6-4af5-bd79-318565f5ed93`. Its table movement guards correctly
refused unrecorded eliminations. The engine log records no elimination from
18:28:20 until the manager resumed at 18:53:12, then records the waiting busts
in a burst. A separate maintenance transaction was already active; this fix
does not start or change that transaction.

The successor drain itself had no pause owner. It armed `untilResumed` on
each live dealer, but the same dealer's real `onPauseReady` callback immediately
called `releaseManagedTablePauseIfUnowned`, which recognized tournament breaks,
add-ons and hand-for-hand, but not a successor request. Each table could resume
before the others finished, preventing the field from reaching the boundary
needed by the existing successor handoff. The existing tests mocked the pause
and boundary observations independently and missed their interaction.

The manager now owns an accepted successor drain through retirement. The
request reserves the existing handoff allowance once, lets every live hand
finish, and completes through the original exact-manager/lease retirement
owner at the last dealer's pause event. Duplicate requests and pause events
cannot submit another handoff. Replacement dealers inherit the hold, including
one whose asynchronous admission finishes after the drain request. Ordinary
break, mystery, add-on and bubble releases cannot lift this hold. A stopped or
expired manager cannot complete it.

The same owner serves a stalled elimination sweep, a missing tournament dealer
and a stopped original retaining an attempted hand. Existing per-table attempt
limits, event spacing, retained-hand receipts, lease release and financial
movement guards remain authoritative. No new timer, watchdog or repair loop is
added. Acceptance and completed handoff are logged separately.

The regression uses the real engine pause gate, real manager callback and two
dealers whose hands end at different times. It fails before the repair because
the first gate releases; it passes after the repair for all three successor
causes, overlapping break release, duplicate events, replacement holds and a
stopped manager. Existing tests retain the per-table handoff budget and original
retained-hand ownership coverage.

This establishes the cause of the prolonged failed handoff. The historical
promise that first stopped that eliminated-player stage was not captured before
the other release replaced the process, so its exact awaited call remains
unproven. Local tests, protected merge and production adoption are distinct;
the task checkpoint records their actual status. An alert suppressed by a
maintenance break is not evidence that the affected tables resumed play.
