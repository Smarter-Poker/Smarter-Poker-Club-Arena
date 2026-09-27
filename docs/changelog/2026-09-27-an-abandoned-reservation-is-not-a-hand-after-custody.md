# An abandoned reservation is not a hand after custody (2026-09-27)

## What was frozen

No engine release had cut over since engine `f2e484a3` went live at 14:06Z on
2026-09-26. It was 61 commits behind `main` at 14:25Z on 2026-09-27.

Two separate facts produced that:

1. **The last release request was refused, and nothing asked again.**
   `stage-engine-release.yml` dispatches only when a push to `main` changes the
   engine runtime tree (`server/**` minus tests, sim, qualification). The last
   such push was `9e275e1c1a` (15:09Z, 09-26). Its receiver,
   `auto-deploy-hetzner.yml` run 36250934873, built and tested the image, then
   waited through the 15:55Z and 16:55Z breaks and gave up at 17:22Z:

   ```
   the restart certificate is also shut: unparkedTables=6
     unparkedReasons={'f06_preparation_stuck': 94, 'stopped_bank_custody_unwritten': 6}
   ```

   Every push to `main` after it touched only the database, the client or
   tests, so every stager run since reported `Engine runtime release required:
false` and dispatched nothing. The stager was working as designed. It was
   not being asked to do anything.

2. **The certificate was shut at every break by the same six tables.**
   `engine_maintenance_break_log` records `unparked_at_countdown = 6` and
   `ready_for_restart_at = NULL` for every break from 15:55Z on 09-26 to 13:55Z
   on 09-27. That is 26 breaks in a row. On `/health` the six show as
   `stopped_bank_custody_stuck: 6`. By design this refuses the restart. No bank
   or custody reason is allowed into the release allow-list.

## The six

These are the tables of six Spin/SNG events whose managers all lost their
tournament leases at 15:06:39Z on 09-26: 36f1dd0d, e9883efa, 357a379e,
28fad37d, 46331f63 and 9df7f1b5 (tournaments 579489da, bec2c908, c53d96df,
39cd2945, 14cde86e and 74042784). Every seat is a horse. Horses are players, so
these are six real events that have been frozen for 23 hours. `/health` lists
their managers under `quarantinedTournamentManagers`, each retried about 16,000
times.

The rows show the same pattern at every table:

- `hand_history` and `hand_atomic_commits` stop at hand N. Its F06 permit is
  `accepted`.
- There is exactly one other permit, at a hand number above N. Its state is
  `reserved` and its generation is the same as the table's lease.
- There is no `hand_history`, `hand_atomic_commits` or `hand_state_snapshots`
  row after N.
- `engine_presence_parked` still holds the 14:53-15:01Z break park, at a hand
  below N.

A probe rolled back inside one `DO` block ran `fn_park_stopped_time_bank_custody`
for each table at hand N with its lease generation. It returned this for all
six:

```
{"ok": false, "refused": "hand_after_custody", "evidence": "f06_hand_permits"}
```

## Cause

A tournament engine reserves the permit for its next hand under the rest,
before it deals. When the manager's lease was lost in that gap:

- The dealing loop exited with the hand never started.
- `dealHand`'s `finally` put `handCount` back to the last completed hand.
  The code comment there reads "a reserved number abandoned before start is
  not a completed boundary".
- The same block called `cancelF06PreparedHand()`. That runs under the
  manager's lease, and the lease was gone, so the call was refused. The permit
  stayed `reserved`.
- The engine then froze its stopped time-bank custody at hand N and asked
  `fn_park_stopped_time_bank_custody` to write it. It asked at the manager's
  stop and again at every :53 announcement, because the break fans out to
  terminal engines too.
- The function read the `reserved` permit above N as a hand dealt after the
  custody, and refused.

The permit could not change state while the lease stayed held by the failed
stop. The custody could not be written while the permit stayed `reserved`. The
engine could not be replaced while the custody was unwritten. That is a
"not yet" whose true answer was "never" (CLAUDE.md 10.86 rule 1).

## Why a retryable stop is not the fix for these six

The working theory was that `ServerTableEngineBase.stop()` caches its first
rejected `teardownPromise`. It does. The theory was that retrying the stop once
its cause clears would get the custody written. For these six the cause never
clears inside this process. The stop joins the same dealing-loop promise, and
that promise has already rejected for good. The custody write also does not
depend on the stop succeeding. `persistStoppedCustodyForRestart` runs at every
announcement whatever state the stop is in, and it was the database that said
no every time.

## Fix

Migration `20260927144106` changes one clause of
`fn_park_stopped_time_bank_custody`. A permit above the custody hand no longer
counts as a hand after custody when all of these hold:

- its state is `reserved`
- it belongs to the caller's own tournament
- it belongs to the caller's own non-null generation

The caller is the witness. It is the terminal engine of that generation, it
has joined its own dealing loop, and it names the last hand it completed. A
reservation above that hand in its own generation can only be its own
preparation that never started.

These still refuse `hand_after_custody`:

- any `hand_history`, `hand_atomic_commits` or `hand_state_snapshots` row after
  the custody
- a permit of any other generation or tournament
- a caller with a null generation
- a permit in any state other than `reserved` or `never_started`

Nothing else in the function changed: the lock-before-read order, the
`ON CONFLICT DO NOTHING` insert, SECURITY DEFINER, the ACL and every other
refusal are pinned by the postimage. The function writes no permit, seat or
chip row. The `reserved` permit is left for the successor generation's
abandoned-generation door to decide, exactly as it does for every dead
generation's reservation.

The fix is database-only, so the engine that is running now uses it. At its
next :53 announcement each of the six writes its custody. For the ten minutes
after that, each is counted as `f06_preparation_unresolved` because its
in-memory permit is still unresolved. From the following break it is counted
past the F06 bound, which reports the table but no longer holds the
certificate (#4909). A lease lost with a reserved next hand no longer strands a
time bank, because the manager's own stop now writes the custody straight away.

Law: `tests/an-abandoned-reservation-is-not-a-hand-after-custody.law.test.ts`
(planted regressions in `docs/laws.d/`).

## What the 95 `f06_preparation_stuck` are

These are counted past the bound (`neverHoldsGate: false`). They do not hold
the certificate, and the 09-26 15:09Z receiver log shows `unparkedTables=6`
next to `f06_preparation_stuck: 94`.

They come from `GameServer.mixedF06PreparationBlockers()`: the pending
originals of mixed F06 custody transfers this process loaded with
`findMixedF06Transfer` when it tried to admit their tournaments. In
`smarter_private.f06_manager_custody_transfers` there are 122 transfers,
covering 131 engines, created 09:33:39-09:34:24Z on 09-26 by the previous
instance `cd5892e8` during that morning's lease collapse. None has a row in
`f06_manager_custody_completions`. 71 of their tournaments are the RUNNING
events frozen since 09:32Z on 09-26. They have no lease row, a `reserved`
permit on the dead generation, and `/health` shows
`tournamentResumesFailing: 119`. A rolled-back probe shows
`claim_tournament_lease_v2` granting their successor generation, so admission
fails after the claim, in the mixed-transfer continuation. The count rose from
13 to 95 as successive admission attempts loaded more of these transfers. It
names a real, unresolved wedge (task 93, "committed-but-uncompleted custody
transfers"), not a count that invents one, and it is not what holds the
release.
