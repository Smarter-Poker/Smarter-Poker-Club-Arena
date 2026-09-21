# A manager that owns nothing is not a manager

**2026-09-21.** Six RUNNING tournaments had no row in
`engine_tournament_leases` and were not being dealt. The oldest had been that
way since **2026-09-14 - seven days**. Between them they held **49 live seats**
and **4,908,000 tournament chips**, and six finalized prize pools totalling
**1,613.80** with not one payout row written.

| tournament | name                         | live seats |     chips | last hand        |
| ---------- | ---------------------------- | ---------: | --------: | ---------------- |
| `5a387a75` | $100 Freeroll - 12:00 PM     |         13 | 1,755,000 | 2026-09-18 22:10 |
| `615783bf` | Afternoon Free Buy (NLH)     |         11 |   975,000 | 2026-09-18 22:12 |
| `99271c16` | Afternoon Free Buy (NLH)     |          4 |   880,000 | 2026-09-18 22:08 |
| `45126295` | Thursday Night PKO           |          2 |   792,000 | 2026-09-18 22:09 |
| `7c6277e7` | Morning Free Buy (NLH)       |         18 |   338,000 | 2026-09-19 14:29 |
| `bfcfaf17` | DSS Thursday $5.50 NLH Turbo |          1 |   168,000 | 2026-09-18 05:17 |

## What every number said

The engine was healthy and dealing 186 hands a window. `/health` read:

```
tournamentResumesFailing:   0
tournamentResumesInFlight:  0
tournamentResumeBudget:     25      (the maximum)
activeTournaments:          472
uptime:                     209942  (58 hours - NOT a fresh process)
```

Against the database at the same instant: **471 RUNNING tournaments, 465 lease
rows.** 472 managers, 465 leases. Seven managers owned nothing, and **nothing
in the estate compared those two numbers.**

## The chain

Every link is a correct component doing its job.

1. Each manager lost its lease and was asked to retire.
2. `stopOwnedTournamentManager` (`server/src/tournament/TournamentManagerOwnership.ts:96`)
   could not stop it - the shutdown path still held an unresolved seat-move
   UUID - so it returned `false` **without deleting the map entry**, on purpose,
   and it says so in the code: _"A failed teardown is still the owner.
   Releasing the slot here would let a replacement start while the old
   generation may still have live table engines or callbacks. Keep it
   quarantined for the next cleanup pass."_
3. The custody-transfer fallback (`GameServer.transferDrainedF06Custody` ->
   `TournamentManager.captureDrainedF06Custody` ->
   `readF06RecoveryAdmission`) **threw** `f06_drained_custody_unproven`.
4. The manager therefore stayed in `GameServer.tournamentEngines`: owning no
   lease, not running, unable to deal, unable to leave.
5. `discoverRunningResumes` selects through `selectRunningResumes`
   (`server/src/tournamentResumeBudget.ts:119`), whose first exclusion is
   `pass.hasManager(tournamentId)`, supplied at `server/src/GameServer.ts:8129`
   as `(id) => this.tournamentEngines.has(id)`. **A corpse answers yes.**

So the one loop whose entire job is to notice a RUNNING tournament that nobody
is dealing was structurally unable to see these six, and reported a clean board
while it failed to.

**There was no next cleanup pass.** Nothing in the process ever came back for a
quarantined manager. Only a restart cleared one - and the six were quarantined
by the process that restarted at the 2026-09-18 21:55 break, which is why five
of them stop dealing at 22:08-22:12 that evening and never resume.

## Why it excludes these six and not the other 465

The 465 adopted tournaments hold a live lease generation and are dealing;
`hasManager` is true for them and true is the right answer. For the six it is
also true, and it is the wrong answer, because the predicate answers _"an
object is in the map"_ when the question is _"is somebody dealing this?"_ That
is CLAUDE.md 10.86 in its purest form: a signal that answers confidently when
it cannot tell.

The predicate is **not changed here**, and deliberately. Making the lane select
a quarantined id would change nothing - `performTournamentManagerAdmission`
(`GameServer.ts:2404`) returns immediately while a manager is registered - and
releasing the slot instead would trade a stalled tournament for two dealers on
one table, which is the failure the lease exists to prevent. The missing piece
was never the predicate. It was the pass the quarantine was written to depend
on.

## What changed

**1. The quarantine is a named state with an age, a reason and a retry.**
New `server/src/tournament/quarantinedTournamentManagers.ts` (import-free, same
precedent as `tournamentResumeBudget.ts`). `stopTournamentManagerIfOwned`
records a quarantine **in its `finally`** whenever the manager is still in the
map - which catches the `false` return _and the throw_, and on 2026-09-21 it was
the throw that stranded all six. `settleQuarantinedTournamentManagers`, driven
by the existing five-second RUNNING lane and only on a board that was actually
read, re-offers each due quarantine to the **same physical stop** on a 10s->60s
backoff, identity-exact about which manager it is retrying.

It releases no slot, claims no lease and admits nothing. **This is not a repair
job under 10.12**: it does not compensate for, back-fill or work around a live
path. It supplies the continuation `stopOwnedTournamentManager` already says it
depends on, so a manager whose blocker has cleared leaves without waiting for a
restart.

**2. A custody read says which refusal it got.** `readF06RecoveryAdmission` was
one `if (error || !data || ...)` ending in one bare
`f06_drained_custody_unproven`, with the database's own message discarded.
Production logged that string **1,551 times in ninety minutes** and no reader
could tell which of the six named SQL refusals
(`F06_DRAINED_CUSTODY_NOT_PREMANIFEST`, `_LEASE_CHANGED`, `_SOURCE_CHANGED`,
`_EVENT_CHANGED`, ...) was firing, or whether the database had been reached at
all. It now has three outcomes (10.86 rules 1 and 2): `refused` carries the
database's own token, `unreadable` is "I could not tell", `malformed` is a reply
that is not a verdict. The legacy token stays at the head of the message.

**3. Numbers and alarms.** `poker_tournaments_running_without_owner`,
`poker_tournament_managers_quarantined`,
`poker_tournament_manager_quarantine_oldest_seconds` and
`poker_f06_drained_custody_outcomes_total{outcome}`, all zero-seeded. Four
alert rules in `infra/monitoring/alert-rules.yml`, every one carrying the
section 13 rule 6 break guard.

**Threshold, measured (10.84).** At 2026-09-21 08:12 UTC: 471 RUNNING, 465
leased with the newest heartbeat 2.7s old, 6 unleased. The lane runs every 5s
(`TOURNAMENT_DISCOVERY_INTERVAL`) with a budget of at most 25
(`ENGINE_START_BUDGET_MAX`), so offering all 471 takes ~95s after a restart or
a thaw, and a failing resume backs off to at most 5 minutes
(`RESUME_COOLDOWN_CAP_MS`). `for: 15m` is three times that worst legitimate
window; critical at `1h`. The six would have paged on their first hour, every
hour, for a week.

## The money

**Nothing was owed and nothing was paid.** Read from the rows, not assumed:

- 768 eliminated players across the six, **zero with a NULL finishing
  position** - the bust order is completely and correctly recorded;
- **zero** `tournament_payouts` rows and **zero** pending
  `tournament_bounty_obligations`. The 1,613.80 is undisbursed because the
  events have not finished, which is true: 52 players still hold 4,908,000
  chips in undecided fields (14, 12, 4, 2, 18 and 2 still playing).

**Decision under 10.9: do not settle. Restore adoption and let them play out.**
Against the five tests: (1) READ, not assumed - **FAIL for a settlement**, because
52 stacks are live and there is no recorded finishing order to read for them;
inventing one is exactly the reconstruction-against-the-witness that 10.9 warns
about. It PASSES for the 768 already eliminated. (2) Nobody paid twice - would
pass, moot. (3) Nothing clawed back - passes; there is nothing to reverse.
(4) Proved in a rolled-back transaction - not reached; no financial write is
warranted. (5) The paragraph - writable for the eliminated field, **not**
writable for why one live horse finished third and another fourth. A clear path
requires all five, so the correct action is to unblock the dealer, not to price
the result.

All 52 remaining seats are horses, and under 10.5 that changes nothing about how
they are settled, counted or paid - it only means no human was sitting at a
frozen table while this ran.

## What this does not fix, said plainly (10.11)

The stop these six are stuck on fails with _"retained an unresolved seat-move
UUID"_, whose root cause is being fixed in **PR #5003**. Retrying that stop does
not by itself make it succeed. What this change does is make the quarantine
visible, counted and alarmed, and make the retry exist at all - so when #5003
lands, the six leave their slots and are re-adopted by the ordinary lane
**without waiting for a restart**, and any future recurrence pages within the
hour instead of running for a week.
