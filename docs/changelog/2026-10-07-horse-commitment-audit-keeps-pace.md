# The horse commitment audit keeps pace with the hands it reviews

## What was wrong

The daily gross >10BB horse commitment audit (`fn_horse_commitment_audit_step`) could not keep up with play. Measured in production on 2026-10-07: each call scans 256 hand_history rows (mean 241 ms, max 2.4 s, statement_timeout 5 s), and about 1.3 million hands are accepted a day. The audit only managed about 425,000 hands a day, so days fell out of the today-1 to today-3 window unfinished. 2026-10-04 had only reached 13:51 of its day after about 61 hours.

The database cost was never the problem. The cause was the cadence in `server/src/services/horseAdaptiveJournal/loop.ts`: a commitment step could only run after four ordinary journal turns, so the audit ran about once every 52 seconds no matter how much backlog it had.

## What changed

The audit now keeps its own clock, independent of journal turns:

- After a `recorded` receipt (exactly 256 hands scanned, so more backlog remains) the next step is due 5 seconds later (`COMMITMENT_AUDIT_BACKLOG_DELAY_MS`).
- After `pass_complete`, `idle`, `busy`, `disabled`, `unknown`, or a step that throws, it waits 60 seconds (`COMMITMENT_AUDIT_SETTLED_DELAY_MS`), the same slower behaviour as before.

5 s x 256 hands is about 4.4 million hands a day of capacity, more than three times the daily volume, at about 5% of one database backend while backlogged.

The step runs inside the pauses the loop already takes between its own cycles, so:

- journal, capture, discovery and model turns keep exactly the timing they had (the tests compare the journal claim times with and without the audit and require them to match);
- a long journal backoff (up to 60 s) no longer holds the audit back, and a busy journal cannot starve it;
- the loop is still a single serial consumer, so two audit steps never overlap and a step never overlaps journal work;
- each step still reports as its own started/completed cycle, which the supervisor in `HorseAdaptiveJournalWorker.ts` validates unchanged.

Unchanged: the `HORSE_COMMITMENT_AUDIT` kill switch (`off` still makes no query and settles at the one-minute cadence), the receipt parser in `commitmentReceipt.ts`, `HorseCommittedPotAudit.ts`, and the SQL.

This changes the speed of an existing diagnostic. It adds no repair job, sweep or new scheduled task.

## Tests

`server/src/services/horseAdaptiveJournal/commitmentLoop.test.ts` now pins: recorded receipts step every 5 s without waiting for journal turns (including while journal work is backed off for a minute), every other status waits 60 s, the kill switch issues no query, no step overlaps another step or journal work and journal timing is identical with the audit on (fake timers), and every step pairs its own started/completed cycle.
