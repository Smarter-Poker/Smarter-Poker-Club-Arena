# Phase 15 exact replay: predeclared window on the serving release (2026-10-16)

Written 2026-10-16T18:45:54Z, before any journal record of the window was read or copied.
Engine /health releaseSha 4c3509e53d6465f2d13d286dd440e55ea501886b read 2026-10-16T18:45:18Z (uptime 2986 s).

Running source for every replay: a clean checkout of 4c3509e53d6465f2d13d286dd440e55ea501886b.
Child runtime: official Node v22.23.2 linux-x64 inside an x86_64 Linux guest (QEMU) on Dan's Mac Studio, x64 esbuild for the TypeScript loader.
Data custody: the journal segments are copied read-only (nice -n 19 ionice -c3, tar over ssh) from the engine host to the Mac main disk under $HOME/agent-work/hb-phase15-journal and into the guest disk image on the same Mac. Nothing goes to a cloud container, GitHub or a third party. Only aggregate counts are committed.

Copy: every segment file of archive, archive-shard-1 and archive-shard-2 whose mtime is at or after 2026-10-16T18:50:00Z, taken after 2026-10-16T19:04:00Z.

Store snapshots: the chart and open-node snapshots whose content identity equals the identity the window's records journal; a record naming another identity is refused by name (artifact), never substituted.

Batches (selection made from the copy by these rules only; one fresh child process per decision record):

- Batch A (population): the newest 400 decision records with atMs at or after 2026-10-16T18:55:00Z and before 2026-10-16T18:56:30Z.
- Batch V (every variant): for each body.snapshot.gameState.gameVariant present among decision records at or after 2026-10-16T18:52:00Z and before 2026-10-16T19:02:00Z, the newest 50 decision records of that variant in that window.
- Batch Q (qualified packs live): the newest 600 decision records at or after 2026-10-16T18:52:00Z and before 2026-10-16T19:02:00Z whose body.replayState.admission names any optional owner 'candidate' or whose body.decision carries a pack receipt (plo4Policy, omahaVariantPolicy, remainingVariantPolicy, jointPolicy, tournamentPostflop) with applied true.

Reported: outcome counts per batch and per (format, variant, street); every non-exact verdict explained by its firstDifference or refusal name; acceptance and durable receipt joins.
