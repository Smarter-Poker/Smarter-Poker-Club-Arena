# The tuner stops fighting the rake, and studies every horse

2026-09-05. Dan: _"there is absolutely no point to keep upgrading and enhancing
the logic of the horses if nothing reads the tags."_ The deep audit that
followed found the tags ARE read, narrowly - and that the thing carrying them
into the brain was undoing its own work every night.

## 1. The regression rule was reading the house edge as a personality defect

horse_daily_nets, 7 days, cash + hu_cash: 881 horses, 2,667,441 seat-hands,
fleet net **-32.0 bb/100**. On 2026-09-04 hand_history rake (198,206bb) plus
BBJ drop (23,954bb) equalled the horse loss (220,971bb) to within one percent,
and 40 of the day's 263,033 cash hands had a human in them. The horses play
each other; the fleet's loss IS the rake.

`HorseSelfTuner`'s V16 rule - `real bb100 < -15 -> regress every dial halfway
to neutral` - therefore fired on **221 of the 383 horses** tuned that night
(271 of 386 the night before). The +/-0.01 nudges the leak tags had made were
halved before the horse played another hand.

Two numbers fix it. `horse_daily_nets.rake_bb` is the horse's
weighted-contributed share of each pot's rake, accumulated at settlement with
`allocateWeightedShareCents` - the allocator `rake_attributions` and
`ca_hand_facts.rake_paid` already use, so every ledger agrees to the cent. The
rule now judges the **rake-adjusted** result (`net_bb + rake_bb`) and touches
only a horse that is ALSO under the fleet's first quartile of rake-adjusted
bb/100 among 1,500-hand horses. On a night when everyone pays the same rake,
nobody regresses. Before rake has accumulated, the fleet gate alone carries the
rule; with neither number (tests, a first night) the old raw threshold applies
unchanged. The log row records `rake_bb100`, `adjusted_bb100`,
`fleet_p25_bb100` and a `study_source` flag, so the panel can show what the
rule saw.

## 2. Only 383 of 1,000 horses were ever studied

`MIN_HANDS_TO_TUNE = 300` inside a sample capped at `MAX_HANDS_TO_STUDY =
120,000` hand_history rows, newest first. The fleet dealt 263,033 cash hands
on 09-04 alone, so the "7-day window" was the newest eleven hours; 744 horses
had 300+ cash hands in the week and 383 reached the bar.

The measurement (`accumulatePlayStats`) moved out of the tuner into
`HorsePlayStats.ts` - pure, no imports - and now also runs at settlement in
`HorseHandReview`, compiling `horse_daily_play` (per horse/day/format VPIP,
PFR, 3-bet, fold-to-3-bet, saw flop, WWSF, postflop aggression) and flushing
it additively on the same timer as the nets. The tuner reads seven days of a
horse in a handful of rows; the hand_history stream stays as the fallback for
a horse with no rows, so a night can never study fewer horses than before.
One accumulator, two readers: the panel and the tuner cannot disagree about
what a 3-bet is.

## 3. The leak gates were counts

`>= 6 stackoffs`, `>= 10 big-bet folds`, `>= 8 preflop stackoffs` - set
against a ~200-reviewed-hand window. A horse playing three times the hands got
three times the tags and three times the nudges for the same discipline. They
are rates per reviewed hand now (`LEAK_RATE_GATES`), the same bar at the
window they replaced, with the count gates kept for a caller that brings no
denominator.

## Migration

`20260905201812_the_tuner_stops_fighting_the_rake_and_studies_every_horse.sql`

- applied. `rake_bb` on horse_daily_nets, `fn_horse_daily_nets_add` adds it,
  `horse_daily_play` + `fn_horse_daily_play_add` (service_role only), retention
  on the existing prune. Manifests regenerated.

## What to watch

- `horse_self_tune_log.reasons` tonight: `regress` rows should fall from ~220
  to the worst quarter of the 1,500-hand horses, and "the game's edge, not a
  leak" should appear on the rest.
- `select count(distinct horse_user_id) from horse_daily_play where day =
current_date` should approach the seated fleet within an hour of deploy.
- Tomorrow night's tuner log line names how many horses came from play rows
  and how many from the stream.
