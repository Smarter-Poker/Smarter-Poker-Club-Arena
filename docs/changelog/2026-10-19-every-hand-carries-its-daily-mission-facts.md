# Every hand carries its Daily Mission facts (2026-10-19)

## What was wrong

`hand_history.daily_mission_events` is what Daily Missions
(`fn_enqueue_hand_daily_missions`) and the Royal Flush achievement
(`trg_hand_history_royal_flush_achievement`) read. Measured read-only over
the 24 hours to 22:20 UTC on 2026-10-19, 131,144 of 1,148,351 fresh hands
(11.4%, about 1 in 9) had it NULL. It looked like a horse-only problem only
because almost every hand in that window was horse-only (25 human hands).
The cause was two whole engine paths, not sampling, retention, timeouts or
the seat roster:

| Path                                                    | Hands (24 h) | NULL | Cause                                                                                                 |
| ------------------------------------------------------- | ------------ | ---- | ----------------------------------------------------------------------------------------------------- |
| Lightning fast-fold hands (`LightningHandHost.handRow`) | 25,485       | 100% | the row hard-coded `daily_mission_events: null`                                                       |
| Diamond Arena tournament hands                          | 84,636       | 100% | the settlement gate asked only "is this a Diamond table" (`isDiamondCash` without a tournament check) |
| Diamond Arena cash hands                                | 21,015       | 100% | intentional: the accepted-hand door refuses mission facts on Diamond cash                             |
| Every other chip cash and tournament hand               | ~1,017,000   | 0    | -                                                                                                     |

Horses and humans were treated identically on every path.

## What changed

- `LightningHandHost.handRow` builds the facts with the same
  `buildDailyMissionHandEvents` a physical table uses, from the settled
  winners, showdown, pots and per-pot awards, for every participant dealt in.
  `fn_lightning_settle_hand` already passes the row through to
  `fn_ca_commit_hand_settlement` unchanged, so no database change is needed.
- `handRecordsDailyMissionEvents` (in `dailyMissionEvents.ts`) mirrors the
  database door exactly: only a Diamond cash hand carries none. A Diamond
  tournament hand is judged as a chip tournament hand (Diamond Phase 8,
  `20260914024241`), and the live door accepts its facts.

## Not changed

- Diamond cash stays excluded. That exclusion is a Diamond programme design
  decision enforced in `fn_ca_commit_hand_settlement`
  (`diamond_chip_obligation_or_fractional_fact`), applies to humans and horses
  alike, and is the owner's to change.
- No back-fill. Past hands keep their recorded rows; Daily Missions are daily
  and the achievement migration pays no back-pay.

Tests: `dailyMissionEvents.test.ts`, `LightningHandHost.test.ts` (mixed and
horse-only Lightning hands), `DiamondAcceptedHandPipeline.test.ts` (Diamond
tournament records, Diamond cash does not).
