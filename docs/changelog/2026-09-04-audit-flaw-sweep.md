# 2026-09-04 - the audit's own flaws, swept

Follow-up to PR #2628. That fixed the recovery path for two nightly jobs; the
daily analysis then found the same defect shape in the third, plus four
detectors that were reporting things that were not true.

## 1. The league lost every night to the hourly restart

`nightly_job_lost` for 'league' fired on 2026-09-02 and 2026-09-03, the card
went stale, and each night recorded exactly ONE matchup out of 38.

Two interacting causes, both real:

**`alreadyRanToday` treated any row as a finished night.** Its own comment
(2026-08-27) explained why that was safe: with a rotating card the budget
legitimately leaves the tail unrun, so the ROTATION rather than a same-night
retry covers the rest. That reasoning depends on a run getting its full
90-minute budget, and it stopped being true on 2026-09-01 when the engine
began restarting at :55 of every hour (CLAUDE.md 13). The 04:00 window now
yields at most 51 minutes before the process dies, so the run is ALWAYS killed
mid-card - and this line then told the replacement the night was over.
Rotation cannot cover a tail when every night is one matchup long.

**`claimProducedRows` treated any row as proof of delivery.** For
`daily_audit` and `self_tuner` one row IS the night's whole output, so that is
correct. A league row is one matchup out of 38 - partial progress. The moment
the first matchup landed, the claim became permanently untakeable.

Fixed: a partial card is resumable again; for league the claim evidence is now
the FRESHNESS of the newest row rather than its existence (a live run writes a
matchup every 9-22 minutes, a corpse writes nothing), which keeps the
anti-duplicate protection the existence check was really providing; and the
per-attempt budget is clipped to the run window so resumption cannot bleed
past it or spend unbounded CPU on an engine that is already saturated. The
`lastLeagueDate` latch also moved to after a completed run - the same defect
#2628 fixed in the other two services.

## 2. Two league matchups measured nothing, forever

`v18_exploit_size` and `v31_gto_suit_aware` both reported 0.00 bb100 with
0.00 stderr. An exact zero with zero variance is not "no edge" - it means the
flag changed no decision at all.

- **v18_exploit_size is impossible by construction.** It scales a river raise
  by `(valueThinMod - 1)`, and `HorseMind.exploit` only moves `valueThinMod`
  off 1 when the opponent's fold-vs-aggression rate leaves the middle band.
  A league matchup is a MIRROR, so each arm's opponent folds at the brain's
  own middling rate, `valueThinMod` stays exactly 1, and the arms play
  identical poker. Retired from the card and pinned deterministically instead
  in `V18ExploitSizingIsMeasurable.test.ts`, which also covers the downward
  (nit) half that the V28 audit fix restored.
- **v31_gto_suit_aware is hopelessly underpowered.** `v31_gto_open` fired 195
  times against 924,871 decides on 2026-09-01, so at 6,000 pairs the matchup
  expects about TWO firings. Retired with the arithmetic written down.

Together that returns 24,000 hands a night to a card that was completing one
matchup.

## 3. layer_fire_collapse fired for a week after any deliberate change

All three of its 2026-09-01 findings were false. `icm_legacy` went
130.75 -> 23.18 -> 5.71 -> 0.84 -> 0.80 -> 0.46 -> 0.69 per 1k decides: a
planned migration to `icm_real`, not an event on the audited day.
`v16_reads_tell` and `v16_unblocker` both stepped on 2026-08-31 because V32
(deployed 08-30) returns early on facing-bet call and fold, exactly where those
heuristics used to run - and both layers' fires actually ROSE day-over-day into
09-01 (441 -> 641 and 2,428 -> 2,512) while being reported as collapsing,
because the detector compares today against a 7-day median that straddles the
deploy.

A step is news once, on the day it happens. Two conditions now say so:
yesterday must still have been near the median, and the raw count must actually
have fallen. Replayed against the real telemetry, this suppresses the two false
criticals on 09-01 and still reports each genuine V29-V32 displacement step on
the day it occurred.

## 4. bust_sweep_lag reported seat tenure as sweep lag

`oldest_minutes` came from `table_seats.joined_at` - how long the player had
been SEATED, not how long the bust had gone unswept - and it drove the critical
escalation. Proof from 2026-09-02: a flagged seat joined at 14:28:45 in a
tournament that started at 14:31:36, so the "lag" predated the tournament.

There is no bust timestamp in the schema to use instead (`eliminated_at` is
written only once elimination succeeds, which is the thing that has not
happened), so the metric is renamed to what it measures and the escalation
moves to an unambiguous signal: RUNNING tournaments already decided and unpaid.

## 5. The seven supply breaches: explained, absorbed, closed

3,290,063.53 chips across seven consecutive hourly snapshots on 2026-08-31 -
one event, not seven. Tournament play-chip stacks cashed out 1:1 into real
wallets: 2,590,879.93 over 412 ledger rows, verified independently for this
settlement rather than taken on report. Already fixed by the mint guards of
2026-08-31 19:29 and 19:40, and the flow stops dead inside that hour.

The chips already created are ABSORBED - CLAUDE.md 10.9 rule 3 forbids
clawing back overpay our own defect caused, and 10.5 means it does not become
clawable because the holders are horses. No balance was altered.

## Not fixed here, deliberately

- **The elimination sweep's real cause is capacity, not logic.** The engine
  carries 1,300+ table engines in ONE Node process at 60-98% CPU, with 2,621
  `elimination_sweep_overrunning` events in 5.5 hours of logs. The sweep
  cannot be scheduled. That is also why a league matchup takes far longer than
  the nine minutes its budget assumes. The fix is a process-wide scheduler
  with bounded concurrency instead of a 5s interval per tournament, and then
  sharding the engine across the box's cores - a capacity change that deserves
  its own PR, not a corner of an audit sweep.
- **The `fn_ca_supply_snapshot` read-window race.** Pool balances are read in
  one statement, mint/burn in a later one, and `taken_at` is a third time at
  INSERT, with the ledger window `created_at > prev.taken_at` left open at the
  top - so rows committing in between are counted in neither interval. This is
  the source of the ~+/-1k hourly residual drift alerts. Fixing it means
  rewriting a money-integrity function and is Tier 3 work; snapshot 96
  (2026-09-04, -5,620.91) is correctly left unacknowledged as its evidence.

## Verification

`npx tsc --noEmit` clean. Full server suite green. The two detector migrations
were applied to production and re-run against the real days they got wrong.
