# Why no engine release landed for 23 hours, and what the 95 F06-stuck tables are (2026-09-27)

These are findings only. The custody fix itself is #5409 (migration
`20260927142925`, see its own changelog). This file records the evidence
around it that #5409 does not cover, so the next agent does not have to
re-derive it.

## 1. Releases were refused once, then never staged again

`stage-engine-release.yml` dispatches `auto-deploy-hetzner.yml` only when a
push to `main` changes the engine runtime tree (`server/**`, excluding tests,
`server/sim/**` and `server/qualification/**`).

- The last such push before today was `9e275e1c1a`, at 15:09Z on 09-26.
- Its receiver, run 36250934873, passed preflight and then waited in the
  certified break gate through the 15:55Z and 16:55Z breaks. It exited at
  17:22Z. The log showed this line at every poll:

  ```
  the restart certificate is also shut: unparkedTables=6
    unparkedReasons={'f06_preparation_stuck': 94, 'stopped_bank_custody_unwritten': 6}
  ```

  It also printed `the serving engine reports 16 stopped-bank custody table(s)
past their bound ... Not asking`, meaning it declined the off-cycle recovery
  window.

- Every push to `main` from then until 15:03Z on 09-27 touched only the
  database, the client or tests. Twelve stager runs up to 14:17Z each printed
  `Engine runtime release required: false` and `Exact engine component SHA:
9e275e1c1a...`, and dispatched nothing.

So for about 22 hours the release lane was not failing. It had nothing to do.
The only request it had been given had already given up. Nothing re-sends a
refused request for an unchanged SHA. That is by design: a redelivery loop
would be a band-aid (10.12). It does mean a certificate that stays shut after a
receiver gives up leaves no trace in Actions until someone merges a server
change.

The certificate record in `engine_maintenance_break_log` shows the same thing.
From 15:55Z on 09-26 to 13:55Z on 09-27 there were 26 consecutive breaks with
`unparked_at_countdown` = 6 (7 or 10 at three of them) and `ready_for_restart_at
IS NULL`. The six were the stopped-bank custody tables that #5409 fixes. A
probe rolled back inside one `DO` block ran `fn_park_stopped_time_bank_custody`
against each at its last accepted hand, and all six returned `hand_after_custody`
/ `f06_hand_permits`.

Staging resumed at 15:03Z on 09-27, when #5412 and later #5413 changed the
runtime tree. Receiver 36328195568 was dispatched for `4946473bb6`.

## 2. Why "retry the stop" was not the fix for the six

`ServerTableEngineBase.stop()` does return its first rejected
`teardownPromise` for ever. For these six, though, the stop failed because the
dealing loop rejected. `dealHand`'s `finally` called `cancelF06PreparedHand()`
after the lease was lost, and the permit refused it
(`f06_prepared_cancellation_unproven`). A second stop would join the same
dealing-loop promise, which has already rejected for good.

The custody write never depended on the stop succeeding.
`persistPresenceForRestart('announced')` reaches `persistStoppedCustodyForRestart`
at every break fan-out, because `parkEveryEngine` and `resumeEveryEngine` cover
terminal engines as well. The refusal came from the database every time, and
the database is where #5409 fixed it.

## 3. What the 95 `f06_preparation_stuck` are

They do not hold the certificate. `UNPARKED_REASON_BOUNDS.f06_preparation_unresolved.neverHoldsGate`
is `false`, and the 15:09Z log above shows `unparkedTables=6` next to 94 of
them. The count is not a fabricated "not yet" either. It names a real wedge
that nobody has fixed:

- The count comes from `GameServer.mixedF06PreparationBlockers()`. That lists
  the pending originals of the durable mixed F06 custody transfers this process
  loaded with `findMixedF06Transfer` when it tried to admit their tournaments,
  and every one of them has passed the 10-minute bound.
- `smarter_private.f06_manager_custody_transfers` holds 122 transfers created
  between 09:33:39Z and 09:34:24Z on 09-26. The previous instance, `cd5892e8`,
  wrote them during that morning's lease collapse. They cover 131 table
  engines. None has a row in `f06_manager_custody_completions`.
- 71 of those tournaments are RUNNING and hold a `reserved` permit on the dead
  generation; 69 of the 71 have no lease row at all. Their tables last dealt
  between 09:31:32Z and 09:32:55Z on 09-26. They are mostly Spins and heads-up
  SNGs, plus MTTs such as `Friday Fight Night Opener` (32 players left) and
  `DSS Friday $5.50 NLH Turbo` (22 left). Together with one Spin frozen since
  04:39Z (41eb379e), they are all 80 reserved dead-generation permits in the
  database.
- A probe rolled back inside one `DO` block ran `claim_tournament_lease_v2`
  for three of them with the transfer's successor generation, and it granted
  all three. Admission therefore fails after the lease claim, in the
  mixed-transfer continuation, and `/health` reports
  `tournamentResumesFailing: 119`.
- The count went from 13 to 95 as successive admission attempts loaded more of
  these transfers into memory.

The completion door is `fn_f06_complete_mixed_manager_custody`, and its named
refusals include `F06_MIXED_RECOVERY_INCOMPLETE` and the
`F06_MIXED_PENDING_*_UNRESOLVED` family. The next step is to find which of
those these 122 transfers hit, from the engine log, which this session could
not read. That is the open task "unwedge the committed-but-uncompleted custody
transfers". An engine restart does not clear them, because the transfers are
durable.

## 4. Measured at 14:48Z on 09-27, before any fix reached the engine

| measure                                            | value                                                        |
| -------------------------------------------------- | ------------------------------------------------------------ |
| tournaments RUNNING                                | 697                                                          |
| RUNNING that dealt in the last 30 min              | 440                                                          |
| hands in the last 10 min                           | 6,105                                                        |
| quarantined tournament managers                    | 6 (the custody six)                                          |
| `reserved` permits on a dead or missing generation | 80                                                           |
| `unparkedReasons`                                  | `f06_preparation_stuck: 95`, `stopped_bank_custody_stuck: 6` |
