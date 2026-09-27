# The newest waiting release takes the break, and a shut certificate is named from its first read (2026-09-27)

## What was wrong

**The failing deploys of 2026-09-26 were not a timing window.** From 09:55Z to
12:55Z on 09-26 the engine reported 630 tables unparked at every countdown
(stopped-bank custody), and from 15:55Z on 09-26 to 14:55Z on 09-27 it reported
6 (the custody six that #5409 fixed in the database). `engine_maintenance_break_log`
shows `ready_for_restart_at IS NULL` for every one of those breaks. The restart
certificate was shut from the first second of each countdown.

It read as "the certificate arrives with 0-92 seconds left" because
`maintenance_certificate` refused a shut certificate silently while enough of the
break remained. The first line of each break in the journal was "the durable table
break has 256655ms remaining, below the 260000ms budget", about 40 seconds in
(run 36250934873, 16:55:43Z on 09-26). The shut certificate was only mentioned in
that line.

**Measured at the 15:55Z break on 09-27** (engine 4946473b, the first hourly
cutover since 09-26 14:06Z), the certificate was durable at 15:55:00.9 with
299121ms left. It was held only by bounded F06 preparations, and the database
confirmed no hand in the air. Three releases were admitted at 15:55:03-06:

| run         | target   | outcome                                                                    |
| ----------- | -------- | -------------------------------------------------------------------------- |
| 36328195568 | 4946473b | took the engine lock; replaced 15:55:08; started 15:56:01; sealed 15:56:44 |
| 36328946522 | 6b6eabb1 | locked read 194653ms, below 245000; waits for 16:55                        |
| 36329422702 | c8cbe6e6 | locked read 193966ms, below 245000; waits for 16:55                        |

The oldest target won the lock race. So the one window an hour shipped the least
code it could have, and #5413 and #5417 stayed off production for another hour.

## The fix (`server/scripts/engine-release-transaction.sh`)

1. Once its image is built, a release writes `<run>.awaiting-certificate` (its
   SHA) under the request root. It removes the file on entry and on every exit.
2. On admission, before the engine lock, an older target stands aside while a
   newer target is waiting at the same certificate. "Waiting" means a live unit,
   a marker naming exactly its durable request SHA, and a target that contains
   this one. When the newer release seals, the older one stands down through the
   existing stale-target check. If the newer release fails or rolls back, its
   marker goes and the older one gets its ordinary admission back.
3. Inside the admissible part of the break, a refused certificate is named on
   stderr: time left, unparked count and reasons, and `handsInFlightTotal`.
   Verdicts and exit codes are unchanged.

No reserve moves: 285000 strict, 260000 admission, 245000 locked, 135 s rollback.
The newer release still passes every certificate, lock, rollback, candidate and
database proof itself. Nothing is added that runs on a timer.

## Protection

`tests/the-newest-waiting-release-takes-the-break.law.test.ts` executes the real
reader against a disposable Git history and unit states, the real certificate
queue, and the real `maintenance_certificate`. It fails 10 of 13 on the previous
source.
