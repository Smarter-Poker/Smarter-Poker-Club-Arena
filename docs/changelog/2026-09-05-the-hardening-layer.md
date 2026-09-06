# The hardening layer: what the horse deep audit found cannot come back quietly

2026-09-05. Dan: _"then when you're done, add a hardening layer to prevent
them from breaking or regressing again."_

Every defect in the audit had the same shape: a thing that had silently
stopped mattering. Tags nobody read. A tuner rule that read the house edge
as a leak, every night, with a confident reason in the log. A fleet-state
column nobody wrote, under a state that said "seated". None of them went red
anywhere. This layer makes each of them go red the day it happens again, in
two places: a law test in CI (the code cannot merge in that shape) and a
detector in the nightly audit (the production data cannot drift into that
shape unreported).

## The tag registry

`HorseDataLedger.TAG_CONSUMERS` - a `tag` row for every leak tag the review
system can emit, naming the code that reads it (`HorseLogic.nlhStackoffLoad`,
`HorseSelfTuner (stackoff gate)`, ...) or `measurement` with a written
reason. Synced to `horse_data_ledger` at boot like every other ledger row.

- **Law:** `EveryTagHasAConsumer.law.test.ts` parses `detectLeaks` for every
  tag literal it can emit (`_won` twins collapse to the loss tag) and fails
  on a tag with no row, a row with no tag, a consumer that does not mention
  the tag by name in the module it names, or a measurement row without a
  reason. Today: 24 tags, 17 consumed, 7 measurement with reasons.
- **Audit:** `fn_audit_tag_consumers` raises `tag_unread` (warn) for a tag
  with 100+ rows this week and no registry row, `tag_measurement_only`
  (info, with the reason) for a measurement tag over 1,000 rows, and
  `tag_registry_missing` until the engine has synced a build that carries
  the registry. Run against today's data it says exactly that - the
  registry lands with the next engine boot.

## The tuner

- **Law:** `TheTunerDoesNotFightTheRake.law.test.ts` pins the rake-adjusted,
  fleet-relative regression rule at the pure function AND at the call site
  (`rake_bb` selected, `fleetQuartile` computed, both passed), the
  settlement accumulation with the money pipeline's allocator, and the rate
  gates.
- **Audit:** `fn_audit_tuner_health` - `tuner_regressed_the_fleet`
  (critical) when more than 40% of a night's tuned horses regressed;
  `tuner_studied_from_stream` (warn) when, with a week of `horse_daily_play`
  on file, under 60% of tuned horses came from it; `tuner_no_rows` when the
  night wrote nothing. Run against last night: **221 of 383 regressed** -
  the exact finding, from the night before the fix deployed.

## The seat clock

- **Audit:** `fn_audit_seat_clock` - `seat_clock_dead` (critical) when 50+
  horses are seated, the fleet decided 100,000+ times, and no seated horse
  has a `last_action_at` in the last two hours. Run against today: **686
  seated, none touched, 2,946,712 decisions** - again the exact finding,
  clearing when #3193 deploys.

## The bleed detector reads the fleet

`horse_big_pot_bleed` used to list the ten biggest daily losers under
-400bb as critical every day - "the daily tail of a rake-shaped distribution"
(09-04 analysis). It now requires the horse to be under the fleet's day p10
as well, patched in place in `fn_run_horse_daily_audit`.

## Wiring

All three new detectors are appended to `fn_run_horse_daily_audit` (patched
in place from the live definition so no other step is touched). Both law
tests are registered in `docs/laws.d/`. Migration applied; manifests
regenerated.
