# 2026-09-06 - Horse daily audit for 2026-09-05: the league was starved, the tuner had the wrong ruler, and one critical was a deploy timestamp

Daily horse audit analysis (Dan's standing order, 2026-08-26), full tier, claim
`claude_daily_analysis` for 2026-09-05 won at 14:28 UTC. The panel row is
written with `fn_horse_audit_set_agent_analysis('2026-09-05', ...)`.

## Verdict

The brain is alive. 2,121,841 decides on 2026-09-05; every layer registered
in the ledger that existed on that day fired, V40 and V41 stepped up to full
volume on their first complete day, and V43/V44/V46/V48 all fired on
2026-09-06 after their build cut over at 23:55:30 UTC on the 5th. The fleet
was -32.15 bb/100 raw and -28.41 after rake over 338,638 hands, which a
self-playing fleet cannot be; the audit's own `drop_half_missing` says the
jackpot drop is not attributed, so the residual is still an accounting hole
before it is a poker one.

Three things were wrong and are fixed in this PR. Three more are recorded
for the people who own them.

## Fixed here

### 1. The league could not survive the hourly restart

`horse_league_results`: 33 matchups on 08-31, 14 on 09-01, 1 on 09-02, 0 on
09-03, 28 on 09-04, **0 on 09-05, 3 on 09-06**. Both 09-05 windows claimed
and produced nothing (`nightly_job_lost` x2). On 09-06 the first two matchups
were written 117 minutes apart for work whose recorded duration is 9-16
minutes.

Cause: the engine restarts at :55 every hour (CLAUDE.md 13). The run that
opens at ~04:00 dies at 04:55 with a matchup in flight. Its replacement
reaches `claimNightlyJob` at ~05:00 and the thirty-minute clock refuses it
twice over - the claim is under `CLAIM_STALE_MS`, and when it is not, the
dead process's last row is still "fresh". Up to half of every hour was spent
standing down in front of a corpse.

Fix (`server/src/benchmark/HorseLeague.ts`): a claim stamped more than two
minutes before THIS process booted was made by a process that no longer
exists - nothing survives the container being recreated - so it is taken
over at the boot check, and a row from before the boot is history, not a
heartbeat. The two-minute grace covers a leader/standby stagger. Six new
cases in `LeagueClaimRecovery.test.ts`; the existing clock cases pin the boot
a day back so they measure what they always measured.

### 2. The solver agreement had never been written

`horse_solver_agreement`: zero rows, ever. V47 scored it AFTER the matchup
loop, and the loop is killed before it returns on every attempt that does not
run out of budget first. The audit's `data_stale` and
`solver_agreement_missing` were both this ordering. It runs first now; it is
a few hundred synchronous decisions, and the RPC upserts on (run_date,
reference) so a resumed card re-scores harmlessly.

### 3. The tuner still tightened half the fleet after the floor fix

`horse_self_tune_log` 2026-09-06 (08:01 UTC, after #3246 deployed at 02:55):
123 of 259 tuned horses tightened for "too loose". Two inputs, both the floor
bug's shape - a blended number judged against an unblended band:

- `hu_cash` rows were loaded into the same accumulator as ring cash and
  judged by `BENCH`, whose first line says "6-max cash". Of the 123: 97 had
  heads-up rows in the window, 37 played more heads-up than ring, and **21
  were inside the band on ring play alone**. Fleet hu_cash VPIP is 41-45%; a
  winning heads-up player is 60-80%.
- every `horse_daily_play` row written before the floor flag's first true
  row (03:03 UTC 2026-09-06) says `floored = false` for play at floored
  tables. `.eq('floored', false)` cannot exclude play that was never
  labelled.

Fix (`server/src/services/HorseSelfTuner.ts`): the bands read ring `cash`
only (heads-up frequencies are the V16 heads-up overlay's job; hu_cash stays
in the real-nets loop and on the panel); the hand_history gap-filler drops
two-handed hands the same way; and the play-row window starts no earlier than
`FLOORED_TRUSTED_FROM_DAY = '2026-09-06'`, a constant that excludes nothing
once the window has rolled past it. Two new pins in
`TheTunerDoesNotFightTheFloor.law.test.ts`; the band itself is unmoved.

### 4. A critical that was a deploy timestamp

`data_unread: v44_second_look fired 0 times against 2,121,841 decide` was the
day's headline critical. V44 cut over at 23:55:30 UTC on the 5th, inside the
freeze, and fired 39,132 times on the 6th (3.1% of decide). The audit reads
the ledger the CURRENT engine synced, so a layer that boots after midnight is
judged for a day it did not exist on. #3249 diagnosed it as "a layer that has
never run once in production" and shipped decline receipts - harmless, and of
a timestamp.

Fix (migration `20260906150532`): a zero-fire receipt whose first telemetry
ever is on a later day is `receipt_deployed_after_day`, info, judged from its
first full day. No telemetry on any day stays critical. Probed with a
`pg_temp` copy against production for 09-04 and 09-05 before applying: the
only output is the v44 line, downgraded.

## Recorded, not changed here

- **Straddles are off platform-wide since the 2026-09-04 20:00 UTC cluster
  cutover.** Ruling R2 (OPORD 1.4: "no straddles on any cash game") closed
  the 92 straddle tables at 20:07 and Gate 5 forces `straddle_enabled` false
  every tick. Sampled cash hands with a straddle: 7.7% on 09-04, 0.7% on
  09-05, 0.0% on 09-06. So `v18_straddle` (-91%) is table mix, not a
  regression, and **V48's voluntary straddle (#3198) is dead on arrival**:
  its gate is `tableInfo.straddle_enabled`, which R2 pins false. A written
  ruling outranks a PR rationale; whether R2 stands or the fleet gets a
  straddle lane back is Dan's call, not an agent's.
- **Short deck, pineapple, plo8 and flh volume fell 70-85% at the same
  cutover** (short_deck 23,997 hands on 09-04 -> 3,878 on 09-05; today 3 of 8
  short-deck tables running). `decide_short_deck` (-80%) and `v17_short_deck`
  (-69%) follow the hands exactly. `fleet_seat_starvation` (584 of 725 cash
  seats empty) is the same fact from the seat side. This is the cluster
  programme's game planner, not the brain; Dan has separately ordered a
  line-by-line audit of the launcher against the feeder games, which is
  where it goes.
- **`v15_eq_capped` (-61%)** stepped down at the V40 deploy (09-04 18:55):
  the tiered aggressor sampler prices dominated flushes lower before the cap
  is consulted, so `eq15 < equity` is true less often. Today 0.81 per 1k
  decide_omaha, same as 09-05. The cap is a backstop that is needed less.
  Explained, not a regression.
- **`v17_positional` pooled -0.30 +/- 0.13 bb/100 over two runs** (24,000
  hands; -0.37 +/- 0.30 and -0.28 +/- 0.15 individually). 2.3 sigma on an
  effect of a third of a big blind. Flagged for ablation by the audit's own
  rule; one more clean run decides. Not tuned.
- **The GTO sweep.** 19 of the 20 biggest showdown losses of the day are
  early-level tournament hands at 25/50 blinds, 400-600bb effective, where
  the caps - written as equity ceilings - do not scale with depth: trips
  with a five kicker raising a 1.4x-pot turn barrel and calling off 600bb
  (241884, `weak_kicker_trips_stackoff`); A5s cold-calling a 3-bet and
  check-raising a c-bet with top pair five kicker into two players, then
  calling the river jam (255527); queens full of threes in PLO5 calling a
  500bb river check-raise (260088, `plo_underfull_stackoff` - V15 leaves
  full houses uncapped by design); 99 calling a river jam on 6-5-7-6-6 with
  the under-full (260213, **untagged** - the underfull detector does not see
  a board with trips). Proposals, all strategy and therefore flag + scenario
  test + league before they ship: extend the raised-after-aggression cap to
  non-nut full houses; a depth term in the V20/V21 stack-off caps above
  250bb; and a `board_trips_underfull_stackoff` detector.
- **Container logs die with the hourly restart** (`docker logs` holds 49
  minutes). Nightly-job forensics are impossible after the fact; the DB
  witnesses (`horse_job_runs`, `horse_league_results`) are the only record,
  which is why every finding above is drawn from them.
- **`daily_audit` has no claim row since 09-02** because agents pre-generate
  the audit row before the 06:00 window and the engine correctly stands
  down. Not a dead job; a job with nothing left to do by the time it wakes.

## Instrument liveness, 2026-09-05

| instrument               | state                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `horse_job_runs`         | league + league_pm claimed and lost (above); self_tuner ran; daily_audit stood down (row pre-generated) |
| `horse_self_tune_log`    | 383 rows; 77 of 80 horses with 1500+ hands have `real_bb100`; 321 leak-driven                           |
| `horse_daily_nets`       | 1,314,925 horse-hands vs 1,620,104 seat-hands (81%)                                                     |
| `horse_hand_reviews`     | 26,969 flagged hands                                                                                    |
| `horse_brain_telemetry`  | decide 2,121,841                                                                                        |
| `horse_solver_agreement` | 0 rows ever - fixed above                                                                               |
