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

The existing production seat-move browser case also qualifies this diagnostic
against actual served code. After its original spectator assertions, it supplies
a captured snapshot template with one identity substituted to the reserved
account, downstream to that browser only. Every upstream socket message and
nonread HTTP request is refused before the stimulus; harmless PING and static-path
POST controls prove those refusals. It checks the real hero row, seat and committed
paint without the false diagnostic, then closes the isolated context while guards
remain armed. Raw frames, rows, cards and tokens are never retained. The evidence
explicitly labels synthetic browser input: it is neither an authoritative seat
receipt, natural seated gameplay nor a financial receipt. The real missing-roster
alarm remains covered by the mounted local regression.
