# Legacy engine final checkpoint entry

The running `2f4e33560bcd23bfb5cc731f31816b2c2e2847e5` engine can enter the
maintenance pause without saving its final time banks. Its countdown announcement
can also replace an earlier parked snapshot with a null snapshot. At 20:53 UTC,
a bounded read found 637 parked snapshots; after the 20:55 announcement the same
692 recent rows were announced records with no bank snapshots. Twenty tables
still refused native restart readiness. This prevented the already merged Horse
archive-read repair in PR 4766 from reaching the engine.

The permanent runtime repair is already merged in `468f1a4e3dd3a2e8b0491f3cd5c261f420b7f485`.
This change supplies only the first-install entry for that exact predecessor.
The existing protected publisher invokes the predecessor's existing
`persistPresenceForRestart('parked')` operation after its final countdown
announcement, under its existing release lock. It does not replace application
methods, assign readiness, replay accounting, restart a hand, or provide a second
publisher. Newer engines do not use this compatibility path.

Admission binds the sealed image, full source identity, process and single
existing GameServer instance. The guard checks the actual engine map, physical
pause, absent hand/settlement/post-hand activity, inactive complete time banks
and occupancy. It joins native checkpoint writes and reads the complete saved
rows back before returning an aggregate receipt. The temporary inspector stays
on container loopback and must close before success. Failed or disconnected
calls remain nonretryable under their original operation identity.

The normal native readiness predicate and the publisher's full 285-second
candidate/recovery reserve still apply after the helper. A late checkpoint does
not grant cutover. No maintenance window, proof reserve, frozen protocol, request
identity or rollback behavior is relaxed.

The legacy native checkpoint did not track acknowledgements of detached paid
bank RPCs. Calling that same operation does not add that guarantee; it belongs
to the newer runtime. This compatibility path neither replays nor claims to
reconstruct those historical outcomes.

Verification is recorded in the Horse task's existing delivery checkpoint.
Isolated protocol and guarded state tests are distinct from protected CI,
installation of this publisher generation, production cutover, and final Horse
behavioral proof. None of those later stages is implied by this source note.
