# The loop that renews every lease stopped, and nothing said so

**2026-09-12**

## What was happening

Every one of the 78 cash tables on the engine was being destroyed and rebuilt
every twenty seconds. In a five minute sample all 78 were killed, 15 or 16 times
each. Of 1,160 engine lives, 855 dealt no hands at all:

```
855 lives  Dealt 0 hands
141 lives  Dealt 1 hand
 92 lives  Dealt 2 hands
 69 lives  Dealt 3 hands
  3 lives  Dealt 4 hands
```

These were not idle tables. The log carries `presence restored from the park:
9/9 seats` and `8/8 seats`, and since the container started 2h10m earlier:

```
26,129  Engine self-terminating for restart: cash_lease_proof_expired
 1,483  CRASH RECOVERY: Found incomplete hand ... Marking hand complete
10,316  Disconnect auto-fold for <player> (timeout)
```

Per-table throughput fell from about 90 hands an hour to about 52, a 42% drop,
beginning in the 23:00 UTC hour.

## The cause

The ownership lease renewal loop had stopped calling the heartbeat. Measured at
the database, two readings 73 seconds apart:

```
                                 02:17:04    02:18:17    delta
heartbeat_table_leases_v4          27,886      27,886       0
heartbeat_tournament_leases_v4     27,765      27,765       0
claim_table_lease_v2              103,562     103,845    +283  = 233/min
```

Not one lease renewed; 233 re-claims a minute. Every table reached its twenty
second proof window unrenewed, its watchdog killed it, it re-claimed, dealt
nought to four hands, and died again.

Everything else that looked suspicious was a consequence of this, not a cause.
`heartbeat_at` equalled `acquired_at` on all 78 rows because no renewal ever
ran. There was not one `[lease]` log line because the loop was not erroring, it
was not running. `heartbeat_table_leases_v4` returns `kept` when called by hand,
because the database was never at fault. Claims outnumbering heartbeats almost
four to one is the whole story in one ratio: a lease should be claimed once and
renewed every five seconds for its life.

## Why nothing noticed

`runOwnershipLeaseRenewalLoop` is the only thing that renews every cash lease
and every tournament lease in the process. `launchServerLifecycleJob` does not
relaunch. It had two exits and both were silent:

1. **The wedge.** `renewOwnedEngineLeaseProofs` serialises on
   `ownershipLeaseRenewalOperation` and returns the in-flight promise to any
   later caller, which is correct while a pass finishes. If one never settles,
   the slot is never cleared, every later tick returns that same hung promise,
   and the loop awaits it forever. `performOwnedEngineLeaseProofRenewal` uses
   `Promise.allSettled`, which never rejects and also never resolves if a member
   never settles.
2. **The clean exit.** `while (directAdmissionIsCurrent(generation))` going
   false returns normally and nothing starts it again.

Neither writes a log line, calls `reportError`, or moves a metric. Nothing
failed. It simply was not running, and an engine that is not doing a thing looks
exactly like an engine with nothing to do. That is the same blindness as an
alert on a metric that has no series, which this estate spent 2026-09-11 fixing
in fifteen rules.

## What changed

**The wedge is closed.** A pass is abandoned once it has outlived the proof
window it exists to defend, releasing the slot so the next tick starts fresh and
counting it as `outcome="abandoned"`. Past that point its answer could not renew
anything anyway: `renewEngineLeaseProof` refuses a deadline that has already
passed. The in-flight request is left to finish or time out on its own and is
not cancelled, and it cannot do harm, because every result is re-checked against
the exact engine and generation captured at pass start before it is applied.

**The clean exit is closed.** Leaving is recorded, and leaving while the
admission generation is still current is a fault reported as
`GameServer.ownership_lease_renewal_loop_left_early`, because nothing will start
it again.

**The silence is closed.** `poker_lease_renewal_passes_total{outcome}` counts
every pass, zero-seeded across all three outcomes so a rule reading it is never
an empty vector, and `poker_lease_renewal_loop_running` answers the cruder
question directly: 0 means the loop left, 1 means it is wedged inside a pass.

`LeaseRenewalLoopStopped` (critical, sms) fires when no pass completes for five
minutes. A pass runs every five seconds, so that is sixty missed renewals
against a twenty second proof window, by which point every lease in the process
is already being lost and re-claimed.

## What is not claimed here

Which of the two exits actually occurred on 2026-09-12 was not established. Both
are silent by construction, both are permanent, and the evidence from outside
the process cannot separate them. Both are closed rather than one of them being
guessed at. If it recurs, `poker_lease_renewal_loop_running` names which in one
reading.
