# DA10 rehearsed on production: a sealed rollback and a roll-forward (2026-10-17)

This continues [the Diamond launch gates](./2026-10-17-diamond-launch-gates-what-each-requires.md). DA08 and DA10 were both blocked because no controlled drill route existed. Two routes were built that day:

- the rollback route, [`engine-rollback-drill.yml`](../runbooks/engine-rollback-drill.md) (#7273, with the proof fix in #7304);
- the crash route, `engine-drill.yml` (#7272).

The rollback route ran on production inside scheduled breaks. Every money check below is read-only.

## DA10 rollback: sealed at the 17:55 UTC break (run 39050314819)

- **What moved:** the sealed high-water `1ac50f38` rolled back to `68f452ce`, which had served from 13:55 to 14:55 that day. Its engine doors were proved strictly first (`ROLLBACK_REQUESTED: 'false'`).
- **Receipt:** `/var/lib/club-arena/engine-rollback-drill-results/39050314819-1.json` records `mode=rollback`, `result=sealed`, `previousDesiredSha=1ac50f38…`, instance `1-60249c2e`. The release transaction reported `ENGINE_RELEASE_RESULT=sealed`.
- **Engine:** instance `1-60249c2e` on `68f452ce` became the `engine_leader` at 17:55:22, 22 seconds into the break. Local and public health served `68f452ce` as `ok`/leader.
- **Thaw:** the break ran 17:55:00 to 18:00:54 and thawed `thaw_ok`, with 353 tables resumed.
- **Custody:** inside 17:54:30 to 17:55:48, no Diamond custody movement occurred. The one wallet journal in that window was a pre-freeze wheel spin at 17:54:52. The rolled-back engine therefore served exactly the custody the platform froze with: 3,460 open rows holding 76,239 Diamonds.
- **Play:** Diamond hands settled on 7 tables in the first minute after the thaw.
- **Workflow defect:** the workflow's independent re-check failed on a shell quoting defect, so the run shows `failure`. #7304 fixes it, with a law that `bash -n` parses every step and remote script.

## DA10 roll-forward: the 18:55 UTC break

- **What moved:** the next ordinary release, `2e102bce`, moved production forward off the rollback through the normal deploy path and seal. This is the forward move any real recovery would make, so it stands in for a separate roll-forward drill.
- **Engine:** instance `1-98299457` on `2e102bce` became leader at 18:55:36.
- **Thaw:** the break ran 18:54:59 to 19:00:54 and thawed `thaw_ok`, with 326 tables resumed.
- **Custody:** no Diamond custody or wallet movement occurred inside 18:54:30 to 18:56:00. The last movement before the break was at 18:53:45. The new engine served 3,451 frozen open rows holding 79,915 Diamonds.
- **Play:** 15 Diamond hands settled on 9 tables, with 25 custody movements, in the first two minutes after the thaw.

## Attempt history and an incident

- **15:55:** the rollback stood aside for the waiting release `1d7d0ef6`, as designed.
- **16:55:** the engine host was unreachable for about two minutes. SSH closed, then timed out, then refused connections; this looks like a reboot. The engine came back unaided on the same release. The break still thawed `thaw_ok` with 369 tables, and the durable drill unit survived and resumed. The cause is unknown and needs host logs (issue #7305).
- **17:55:** the rollback sealed.

## DA08 crash drill

The crash route (`engine-drill.yml`, #7272) was dispatched for the 19:55 break (run 39060794768). Three ordinary releases were queued that hour. One of them, `24c44521`, took the break, and the drill stood aside as designed. The crash drill is re-dispatched for the next break that has no release waiting, and its result is recorded separately.

## Gate status after this

| Gate                                   | Status                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DA06 funded journey and recovery offer | Open: a real player still has to run the UI journey, and the certificate has to pass                                                                                    |
| DA08 failover                          | Route built (#7272); the crash drill has not yet had a break                                                                                                            |
| DA08 Spin/SNG                          | Not applicable: Diamond Arena does not offer them                                                                                                                       |
| DA10 rollback/restore                  | **Rehearsed and verified**: a sealed rollback and a sealed roll-forward on production, with custody carried across both, thaw clean, and Diamond play resumed each time |

The launch verdict is unchanged: **not launch certified** while DA06 and DA08 failover are open.
