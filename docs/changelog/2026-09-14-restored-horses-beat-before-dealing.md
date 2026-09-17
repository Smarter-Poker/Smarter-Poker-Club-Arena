# Restored horses beat before the first deal

Received HorseForcedSitOuts alert 39739 includes three heads-up sit-outs at
18:32:12-18:32:13 UTC on September 14. The exact tables were
3e5399d9-0239-40fb-b97f-4adc9f1b47dc,
55a5311e-931b-4529-a2d0-bf3c59e79c8b and
ff69d8af-463f-4c42-8f7e-3365ddf9e3a1. Their player identities were independently
confirmed as horses. Each table restored an older disconnect snapshot after
losing its tournament lease. A disconnect timer then expired within 4-76 ms
of starting on the sit-out turn; the server heartbeat arrived later. Subsequent
turns auto-folded those seats with `sitting_out` as the reason.

The periodic heartbeat refreshes server-driven horses before checking stale
presence. The dealing loop checked stale presence on its own, without that
refresh. Its first pass could therefore mark an old CONNECTED snapshot absent,
or retain an already expired DISCONNECTED snapshot, and deal several hands
before the scheduled heartbeat. The missing decision on reconnect is a separate
path, repaired in the preceding commit. Tournament lease loss still requires
its own installed root fix.

The dealing loop now refreshes the existing heartbeat for each horse in the
accepted roster before checking stale presence. It uses the same disconnect
engine method as the periodic tick. A removed roster, lost engine authority,
human absence, voluntary sit-out, existing strike state for a connected player,
and remaining time bank retain their existing rules. This does not disable
horse timeout detection or resolve old sit-outs in production.

The real dealing-loop regression failed for both restored CONNECTED and
DISCONNECTED horses before the fix, with the three original controls passing.
The final six-case fixture also checks both human states. Sixty tests across
six files pass with existing shared dependencies on macOS 26.5.2 arm64,
Node 26.3.0 and Vitest 4.1.11. The fixture stops after the actual presence
boundary; it does not deal a production hand or exercise database settlement.
Linux release qualification, installation provenance and natural post-release
behavior remain required before any incident is marked fixed.
