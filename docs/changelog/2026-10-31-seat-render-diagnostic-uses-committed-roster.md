# Seat Render Diagnostic Uses The Committed Roster

The snapshot application effect queues the mapped roster and its existing
`appliedExitSnapshot` witness. The later hero-seat invariant previously compared
the new snapshot with the previous render's roster before those updates committed,
reporting a missing hero that the actual mapper had already queued correctly.

Extract the existing invariant into `useEngineHeroSeatInvariant`, called at the
same TablePage location. Require the existing witness to match the exact snapshot,
table and user before comparing the committed roster. Preserve the diagnostic
payload, once-per-table/seat reporting, leave and observer guards, and bounded
reconcile behavior. No seat, stack, action or gameplay behavior changes.

The mounted regression uses the real snapshot mapper and extracted effect in their
actual order. It fails without the commit-witness gate and passes with it. A truly
missing committed hero still reports and runs the existing bounded reconciliation;
stale snapshot, table and user witnesses cannot qualify the comparison. A source
contract retains the TablePage wiring and ordering.

Real-time law: the existing engine snapshot supplies authoritative roster state;
this diagnostic adds no animation trigger, polling, timeout or snapshot diff.

Source reread: yes. Focused tests and TypeScript results are retained in the task
checkpoint. Protected delivery, publication and affected live proof remain
separate requirements.
