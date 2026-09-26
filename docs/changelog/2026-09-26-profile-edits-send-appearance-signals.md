# Profile edits reach the header and seated players again

The profile WAL subscription has been unreachable since the high-write table
left the publication. Joining that channel was still labelled live, so edits
on another device could leave the header or seated avatars stale indefinitely.

A private named signal now originates only when one of seven appearance fields
actually changes. It carries the user ID alone to the owner's topic and the
currently occupied tables. Authenticated table access remains governed by the
existing table RLS policies; browser clients receive no producer permission.
Financial/statistical writes and unchanged appearance values produce no signal.
The existing private Broadcast hook supplies authentication and reconnect.

The table and header read their small authorized projections on the event,
rejoin and visibility return. Scope disposal, request coalescing, failure states
and optimistic-edit fencing prevent older reads from overwriting a newer edit.
Existing local and cross-tab picker events stay immediate. All formats use the
same table hook. No gameplay socket, money operation, profile column grants or
publication membership changes.

The actual migration is exercised in a socket-only PostgreSQL 17 fixture:
unchanged/financial writes, owner and occupied-table recipients, minimal payload,
other-account/anonymous denial, existing table RLS, malformed topics, forged
client sends and failed transport without source rollback. That finite check is
part of the existing required accounting job. The preimage fails the missing
signal assertion. Hook/store regressions also fail before the repair.

Source, database installation, protected publication and connected production
proof are separate evidence layers. No invoice savings or universal live health
is inferred from these tests.
