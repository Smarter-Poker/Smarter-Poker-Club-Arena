# Why the engine releases aborted at the :55 break (2026-10-19)

## What players saw

Normal breaks today were exactly 300 s (`engine_maintenance_break_log`). Three were longer:
13:55 lasted 470 s (7 min 50 s), 16:55 lasted 316 s, 17:55 lasted 349 s. In each of those, the
new engine release was refused and the old one (41296ff3 at 13:55, 1370116c at 16:55 and 17:55)
was put back. No hand was lost, but the fixes waiting behind those releases did not go live.

## What happened, measured on engine-01

A release cutover has about 145 s from the certificate to its final database proof (the 300 s
break minus the 135 s rollback reserve and the 17 s the proof needs). The successful 06:55 cutover
used 96 s of it and 14:55 used 119 s.

| break | old engine stop    | outgoing log dump | candidate start -> proof                       | result          |
| ----- | ------------------ | ----------------- | ---------------------------------------------- | --------------- |
| 06:55 | 12 s               | 10 s (9 MB)       | 57 s                                           | sealed 41296ff3 |
| 14:55 | 21 s               | 8 s (6.5 MB)      | 67 s                                           | sealed 1370116c |
| 16:55 | 45 s (forced kill) | 28 s (15 MB)      | never started: the 75 s cutover budget ran out | abort 06b920c0  |
| 17:55 | 45 s (forced kill) | 8 s (7.6 MB)      | 81 s, final proof refused one second short     | abort 41deda4d  |

13:55 was different: an image build for a queued release was running on the same host during the
break, the candidate took 62 s to print its first line, and the cutover budget ran out.

The forced kills at 16:55 and 17:55 are the outgoing 1370116c engine logging
`graceful shutdown exceeded 40000ms before ownership release`. That engine was retrying about 400
decided tournaments a minute: since 15:43 UTC, 812 tournaments cannot finish because their fee
batches are `legacy_unverified` (`accounting_terms_not_observed`) after 1,717 memberships were
moved under an owner with no agent terms. That cause is owned by PR #7458 and is reported there.
A forced kill also leaves the lease stale, which cost the 17:55 candidate another 15 s at boot.

## What changed here

1. **The outgoing log is dumped after the replacement starts** (`server/scripts/engine-up.sh`).
   The stopped container is renamed out of the way with its restart policy cleared, the new
   engine is started at once, and the rename is dumped and removed in the background. The log is
   kept exactly as before. This takes 8-28 s of no-engine time out of every cutover and every
   rollback. A rename that cannot happen falls back to the old in-line dump; a dump interrupted
   by anything is redone by the next engine-up.
2. **The rollback proof keeps polling until its deadline** (`server/scripts/engine-supervisor.sh`).
   Its pause was `timeout 5s sleep 5`, which returns 124 every time on engine-01 (3 of 3), so the
   recovery gave up after one probe: at 16:57:12 and 17:58:02 it declared the restored engine
   failed five seconds after starting it, while the engine was live moments later.

Laws: `tests/the-outgoing-log-is-saved-after-the-replacement-starts.law.test.ts`,
`tests/a-recovery-poll-outlives-its-first-probe.law.test.ts`.

## Still open

- PR #7458 (owner deals): the 812 decided tournaments, and the cash rake refusals, need its
  producer fix and a re-capture of the batches written `legacy_unverified` since 15:43.
- The engine's graceful shutdown waits for the whole in-flight tournament discovery pass, which
  grows with the board. With 800 stuck events it no longer fits in 40 s. That engine fix can only
  help the cutover after the one that ships it, so it is not part of this change.
- A queued release's image build can run on the engine host during a break (13:55).
