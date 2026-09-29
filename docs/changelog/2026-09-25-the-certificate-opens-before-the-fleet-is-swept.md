# The restart certificate opened 375ms too late, for 6.7 days

2026-09-25

## What was wrong

The engine cut over at 15:29 UTC after a 6.7-day freeze, onto `778075b4`, and
immediately could not be restarted again. Three `auto-deploy-hetzner` runs
followed and all three died on the same sentence:

    FATAL: the engine did not present a restart certificate with enough proof
    time remaining

The three receipts are **identical in shape**, not alternating, so this was one
static defect rather than a race against live state. Every poll in every run
reported the same refusal from `maintenance_certificate`'s exit 2:

    the durable table break has <N>ms remaining, below the 285000ms
    candidate-and-recovery budget; refusing before mutation and waiting for a
    later certificate

| run         | created | first complete-certificate observation                  |
| ----------- | ------- | ------------------------------------------------------- |
| 36155409978 | 15:37   | 283592ms remaining (16408ms late)                       |
| 36157652866 | 15:57   | 280154ms, 223131ms (19846, 76869ms late)                |
| 36157811057 | 15:59   | 284625ms and 3 more (15375, 15939, 18455, 19060ms late) |

**Seven consecutive breaks, seven entries, every one outside the window. The
floor missed it by 375 milliseconds.**

## The arithmetic

`MaintenanceBreak.BREAK_DURATION_MS` is 300000. `engine-release-transaction.sh`
admits a cutover only while `MIN_BREAK_REMAINING_MS` = 285000 remain (150s
candidate proof + 135s rollback reserve + 0s slack). So the certificate has to
exist within **15000ms** of :55:00.000.

`beginCountdown()` fired on time. But before `persistWithRetry` - the write that
sets `durableConfirmed`, without which no certificate exists at all - it ran:

    this.parkEveryEngine();          // ~324 engines, second pass
    const stragglers = this.unparkedTables();   // ~324 engines, census

on one core (the engine is ONE core; CLAUDE.md section 2), under a comment
calling them "Cheap". `breakStartedAt` is correctly pinned to the PROMISED :55 -
a slow event loop is never permission to extend a freeze - so every millisecond
of that was charged against the only 15000ms the release had.

This is **CLAUDE.md 10.86 rule 4**. #5026 found four gates demanding the same
285000ms of one break, correctly budgeted the PUBLISHER's entry cost, and wrote
that the remaining headroom was "today it is 0". Nobody budgeted the **engine's
own** cost of opening the certificate, and it consumed all 15000ms by itself.
The fix landed and left the same trap one level up.

## And the 137

The dominant straggler reason was `stopped_bank_custody_unconfirmed`, at **137**
of ~324 tables (`f06_preparation_stuck` was the other 13, and is a sibling's
surface). Those are TERMINAL tournament engines holding a frozen stopped time
bank. `hasUnretiredStoppedTimeBankCustody()` clears on one of three things: a
replacement engine adopting the custody, a confirmed session close, or a durable
F06 transfer receipt - and failing all three it compares
`acknowledgedTimeBankPark` against the custody's hand number.

`acknowledgedTimeBankPark` is set at `ServerTableEngineBase.ts` line 6284, and
only when `when === 'parked'`. **Every** `persistPresenceForRestart('parked')`
call site is inside the dealing loop (`if (this.maintenancePaused) await ...` at
Base 3407/3460 and Dealing 220/1005/1020/1037/1062). A terminal engine has no
dealing loop, so when the break's fan-out calls `pauseForMaintenance` on it the
only path it can take is `'announced'` - and `'announced'` passes
`timeBanks: undefined`, so the bank is never written and the acknowledgement is
never recorded.

So the gate answered **"not yet" to a question whose true answer was "never"** -
10.86 rule 1 - for 137 tables across 8 consecutive breaks
(`poker_maintenance_breaks_since_restart_certified` = 8). It is the same shape
#4909 bounded for the F06 class, whose own comment records it holding engine
`8825af51` shut for 70 breaks: _"The felt was healthy; only the restart was
impossible, including the restart that carried the fix."_

## What changed

**1. `MaintenanceBreak.beginCountdown()` certifies first, then sweeps.** The
second park pass and the straggler census move into a new
`sweepStragglersAfterCertificate()` that runs AFTER `persistWithRetry`. Nothing
here decided the countdown row's content: `persistedState()` carries phase,
`announcedAt` and `breakEndsAt` only, the counters are diagnostics, and the
first park pass already ran at :53 in `announceLastHand`. `breakEndsAt` is
untouched, so nothing resumes early.

Safety is unchanged in the direction that matters. `readyForRestart` still
requires `unparkedTables()` to be empty; `snapshot()` computes that census LIVE
on every `/health` read rather than from anything recorded at countdown; a table
with cards in the air is counted by `isRunning() && !isBetweenHands()` whether
or not `pauseForMaintenance` has reached it; and the release script demands its
own independent physical witness, `handsInFlightTotal === 0`.

**2. A terminal engine writes the bank it is holding.** New
`persistStoppedCustodyForRestart()` persists the frozen custody at the custody's
own hand number, in the exact shape `loadTimeBanksFromPark(tableId, handCount)`
reads back. **This is the write, not an exemption** - `hasUnretired
StoppedTimeBankCustody()` then clears on its own arithmetic and its own
evidence, with no allow-list and no relaxed threshold anywhere. It refuses to
write while `timeBankAccountingUnconfirmed` or any accounting event is pending
(an unknown debit must never be frozen into a snapshot), refuses over a live
engine's newer row (the upsert is keyed on `table_id`), and records no
acknowledgement unless the write actually succeeded - so a bank we could not
persist still holds the gate shut. Fail closed (10.86).

**3. Three named outcomes instead of two.** `maintenanceDurabilityReason()` no
longer answers one string for the whole class:

- `stopped_bank_custody_unwritten` - a real bank is not on disk. Refuses,
  exactly as `bank_park_write_incomplete` refuses, and for the same reason.
- `stopped_bank_custody_unreadable` - an accounting outcome this process cannot
  yet ask about. "I could not tell." Refuses.
- durable - no reason at all; the table is simply not a straggler.

Both refusing names are now **zero-seeded** in `GameServer.ts`'s scrape.
`stopped_bank_custody_unconfirmed` never was: it only ever reached `/metrics`
through the dynamic extension, so no alert rule could read it before it had
already wedged the fleet. That is why eight breaks went by.

## The reader

`poker_maintenance_breaks_since_restart_certified` is published by the running
build (verified on `/metrics` at `778075b4`, value 8) and two rules already read
it: `engine-freeze-rules.yml` at `>= 2` and `alert-rules.yml` at
`max_over_time(...[15m]) >= 6`. No new rule was added - an alert is never the
fix (10.11/10.12), and the existing one is sufficient once the cause is gone.
The two new reason labels are readable by
`recovery-rules.yml`'s `sum(poker_maintenance_unparked_tables{reason!="cards_in_air"}) > 0`
because they are seeded.

## Law

`server/src/maintenance/theCertificateOpensBeforeTheFleetIsSwept.law.test.ts`
(8 pins) and `docs/laws.d/server-src-maintenance-theCertificateOpensBefore
TheFleetIsSwept.md`. The pins include the one nobody had: the release script's
reserve and the engine's break duration are read together, so a change that
closes the admission window fails CI instead of freezing production.
