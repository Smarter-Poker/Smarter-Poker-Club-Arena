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
One app-level account subscriber stays mounted on routes that hide the main
header, so table-tab header copies do not create duplicate subscriptions.

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
The existing production customization certification additionally requires an
authenticated edit in a third session to arrive as an actual private WebSocket
signal on both receiving devices, render the persisted portrait without a
reload, and leave the other reserved player's portrait unchanged. It uses the
existing isolated-account cleanup and does not touch a real player's account.

Source, database installation, protected publication and connected production
proof are separate evidence layers. No invoice savings or universal live health
is inferred from these tests.

Database installation: one qualified apply at 15:04 UTC, outside the DDL break
window. The filename follows provider-assigned version `20260926150415`; its
3,018 bytes match the recorded SQL MD5 `cfa751faf120e0880b764e741af141fe`.
Readback confirmed the enabled trigger, both SELECT-only private policies, no
anonymous/authenticated function execution and profiles still unpublished.
Client publication and connected browser proof remain separate.
