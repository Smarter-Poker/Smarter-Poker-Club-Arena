# Lightning horse scoreboard and opponent-read cost (2026-10-24, phase 2 of 9)

Phase 2 of Dan's Lightning horse programme: measure before tuning.

## What was wrong

- **No Lightning results anywhere.** A physical table files every hand through
  `recordHorseHandReviews` (horse_daily_nets, horse_daily_play,
  horse_hand_reviews). Lightning never called it. Production, 2026-10-24:
  7,535 Lightning hands in one hour, 0 horse reviews. Nothing could say whether
  the horses win in Lightning, by game or by stake.
- **The new opponent reads had no cost reading.** Phase 1 adds a post-commit
  profile read for every Lightning hand, on the same RPC whose cold path had to
  be contained for database CPU on 2026-10-24. Its outcome and latency were
  visible only as error reports.

## What changed

- `server/src/lightning/LightningHorseResults.ts` (new): builds the physical
  path's review input from the settled Lightning hand (committed hand id, every
  participant, settlement's exact contributions, winners, rake, jackpot drop,
  hole cards, actions, button, VPIP floor) and files it with
  `recordHorseHandReviews` the moment settlement commits. Never awaited by the
  hand, never throws.
- `HorseHandReview`: an input may name its results bucket (`format`) and skip
  the fleet seat touch (`seatTouch: false`; a Lightning host table is not where
  the horse sits). Lightning files under `lightning_<bb>bb`, one bucket per
  stake. The cash tuner reads only `cash`/`hu_cash`, so Lightning results never
  move it.
- `HorseOpponentMemory.readHorseOpponentProfiles` files every read into the
  horse telemetry (`horse_brain_telemetry`):
  `horse_opponent_memory_read_{ok|busy|timeout|failed|incomplete}`,
  `horse_opponent_memory_read_ms_{le50..le1000|gt1000}` and
  `horse_opponent_memory_read_cache_fallback`.
- Coverage counters: `lightning_hand_observed` / `lightning_hand_observe_failed`
  and `lightning_hand_scoreboard_filed` / `lightning_hand_scoreboard_failed`, one
  per settled hand, so observed / settled is the share of Lightning hands the
  horse mind actually learned.

## Reading the scoreboard

```sql
select game_variant, format as stake, sum(hands) hands,
       round(100 * sum(net_bb) / nullif(sum(hands), 0), 2) as bb_per_100,
       round(100 * sum(net_bb + rake_bb + bbj_bb) / nullif(sum(hands), 0), 2) as bb_per_100_before_drop
from horse_daily_nets
where format like 'lightning\_%' and day >= current_date - 7
group by 1, 2 order by 1, 2;
```

## Pins

- `server/src/lightning/aLightningHandIsOnTheHorseScoreboard.law.test.ts`
  (law, registered in `docs/laws.d`).
- `server/src/services/HorseOpponentMemory.test.ts`: latency buckets, failure
  kinds, and that every read outcome reaches the telemetry flush.

No migration and no money path. Engine runtime change: daily 04:00 window.
