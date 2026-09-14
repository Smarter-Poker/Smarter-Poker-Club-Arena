# Scheduled MTT launch discovery is independent of registration funding

The broad tournament discovery pass waits for a pre-start horse top-up and then drains its past-start top-ups before reading another board. A pending funding operation can therefore prevent an already-funded due MTT from reaching its start authority. The regression executes that actual old discovery method, holds its top-up pending, and demonstrates the blocked due event.

`GameServer.start()` now starts `discoverScheduledMttStarts()` under the existing discovery-job supervision. Every five seconds after the preceding read, it reads due scheduled MTTs through the existing keyset pager, validates completeness, orders by scheduled time, and offers eligible fields to the unchanged `ensureTournamentManagerAdmission` entry point. The existing one-minute pre-seat lead and minimum-field checks remain. Spin, SNG, heads-up and finalized played-event recovery retain their separate paths.

All pending start/resume admission operations count against the existing adaptive engine-start capacity until they actually settle. Repeated reads coalesce through the actual shared entry point. Existing manager ownership, retry timers, exact lease claims, launch receipts, shutdown generation checks and maintenance freeze remain authoritative. The new loop does not fund entrants, construct managers, write database rows or release retained work. The broad discovery pass remains a backstop and retains its pending operations.

## Source and verification

- `server/src/GameServer.ts`: bootstrap at original line2442; new method before original line7626. Original funding waits remain at5728,5776,5933,6641 in this candidate.
- `server/src/tournament/ScheduledStartDiscoveryIsolation.test.ts`: twelve executable/supervision cases, including actual old-pass blockage, actual admission coalescing, retained capacity, stale lifecycle/freeze, format/field exclusions, and oldest-event selection beyond the gateway's1,000-row page limit.
- `server/src/tournament/SpinStartsInOneSecondAndPlaysInFull.test.ts`: adjusts the existing source inventory from three to four five-second sleeps; the added MTT loop retains that cadence and Spin retains one second.
- Full affected service/tournament/admission/lease/boot/shutdown suites: **5,409 passed across359files**, zero failures/skips. Server TypeScript passes. Initial broad run preserved two test failures: unavailable assertion spelling and old sleep-count inventory; both corrected without runtime cadence changes.

These are local engine tests with mocked transport, not production launch/dealer/payout certification. There is no database migration in this change.

## Live boundary and release acceptance

At2026-09-14T01:15:16.549975Z, the production per-event reader reports84stalled running MTTs and29overdue breaks. Seven sampled MTTs scheduled at01:00 remainREGISTERING with enough entrants and no started_at. Three earlier sampled leases/launch receipts were absent. Production health still reportsb97e16802e6e535d294cc6c98c9b09004d75aa3b /instance1-31be09b4. This proves the live incident remains; it does not identify a particular pending top-up as the cause of every stalled event.

Normal source submission, required CI, exact served ancestry and actual launch/first-hand evidence remain required. Retained G8/Lease/M17/financial-provider and Pipeline owners continue their boundaries. The GameServer addition is explicit for G8 overlap review; it does not replace their admission, retirement, scheduler or cold-recovery implementations. No manual event mutation or deployment is included.
