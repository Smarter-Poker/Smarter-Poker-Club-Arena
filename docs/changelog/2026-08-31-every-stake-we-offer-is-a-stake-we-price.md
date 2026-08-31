# Every stake we offer is a stake we price

2026-08-31. Dan's ruling on the rake gap the game-creation audit surfaced,
verbatim:

> "WE HAVE A SCALE THAT WE USE FOR THE CASH GAME FOR RAKE AND BBJ, USE THE SAME
> PERCENTAGES WE USE FOR THE OTHER GAMES, IF YOU DON'T HAVE A RAKE OR BBJ
> SCHEDULE FOR A SPECIFIC GAME."

## What was wrong

`RAKE_SCHEDULE` had 14 rows and the create-table form offers 12 blind presets,
and only six of those presets appeared in it. For the other six
`findScheduleMatch` returned null and `getRakeConfig` fell through to
`getTierForBB` — a stakes tier whose cap is an **absolute dollar amount**
applied regardless of stake.

A dollar cap is a sane number at the stake its tier was written for and an
absurd one two rungs below it. Expressed as a share of a big blind, the
fallback was charging:

| preset                             | fallback        | cap | as BB      |
| ---------------------------------- | --------------- | --- | ---------- |
| 0.01/0.02                          | tier Nano       | $3  | **150 BB** |
| 0.02/0.05                          | tier Nano       | $3  | **60 BB**  |
| **0.05/0.10 (the default preset)** | tier Nano       | $3  | **30 BB**  |
| 0.10/0.25                          | tier Micro      | $3  | **12 BB**  |
| 25/50                              | tier Nosebleeds | $20 | 0.4 BB     |
| 50/100                             | tier Nosebleeds | $20 | 0.2 BB     |

against a published ladder whose most generous row (0.1/0.2 at $3) is 15 BB and
whose typical row is between 1 and 6 BB. The database creation guard had
declined to police it in as many words: _"NOT enforced here and left for Dan:
the official stakes schedule."_

## Both halves of the ruling

**The six missing rows now exist.** No rate was invented — every number is
derived from the ladder that was already published:

- `rakePercent` is **10**, which is what all fourteen existing rows already are.
- `rakeCap` for the three stakes below the schedule's bottom rung takes the same
  BB proportion that bottom rung charges (15 BB): $0.30, $0.75, $1.50.
  `0.10/0.25` sits inside the schedule's own flat-$3 band — 0.2, 0.4 and 0.5 are
  all $3 — and takes $3. The two nosebleed rows take the $20 the Nosebleeds
  tier already charges them, so publishing them moves no price at all; it just
  makes the price published rather than inherited.
- `bbjFeeBB` is the tier's own fee for that stake, unchanged: 0.6 at Nano and
  Micro, 0.03 at Nosebleeds.

**And the fallback itself is fixed**, which is the other half of what Dan
asked. A stake with no row can still arrive from a fleet config or a direct
writer, and it was being priced by a flat dollar figure. `unscheduledCapFor()`
now holds any unscheduled stake to `UNSCHEDULED_CAP_BB` — the most generous
share of a big blind any published row takes, **derived from `RAKE_SCHEDULE`
itself** rather than written down, so it cannot drift from the ladder it
describes. Today that is 15 BB. An unscheduled 0.03/0.07 game was capped at $3
(43 BB) and is capped at $1.05 (15 BB) now.

This binds the fallback only. A stake with its own row is charged that row, and
`MAX_RAKE_CAP_BB` continues to bind operator **overrides** — a separate ceiling
for a separate thing. An earlier note in this audit described the schedule as
pricing "above the ceiling the same file enforces"; that was imprecise and is
corrected here. The 10 BB constant never bound the schedule, and the schedule's
own bottom rung has always been 15 BB. What was genuinely broken is that
UNSCHEDULED stakes got a flat dollar cap — ten times the ladder's own bottom
rung at the cheapest preset.

## What this changes for players

Measured against production before committing. Of 972 cash tables, exactly
**two** sit on a stake whose price moves: the two at 0.05/0.10, whose cap falls
from $3 to $1.50. Both are closed. Every other live stake — 794 tables at 1/2,
129 at 2/5, and the rest — was already on the schedule and is untouched.

**No player pays more than before at any stake.** The only movements are
downward, and only at the bottom of the ladder where the flat cap was never
meant to apply.

## Still open, and still Dan's

`RAKE_SCHEDULE` contains `{ sb: 5, bb: 5 }`. The table-creation guard refuses
"big blind must exceed small blind", so no table can ever match that row. 5/10
already exists; 2.5/5 would fit the ladder. It is a separate question from the
coverage ruling and it is a money row, so it stays recorded and untouched —
pinned as a `.skip` naming what has to be decided.

## Files

- `src/config/RakeConfig.ts` and `server/src/config/RakeConfig.ts` — six rows
  and the proportional fallback, applied identically (the schedule lives only
  in these two files; there is no SQL copy, and
  `scripts/ci/check-rake-schedule-parity.mjs` pins them to each other)
- `tests/unit/theFormOffersStakesTheScheduleCanPrice.test.ts` — the gap pins
  become coverage pins; the `.skip` invariant now runs, against the correct
  constant
- `tests/unit/RakeConfig.schedule.test.ts` — the schedule-length pin updated in
  this commit, per CLAUDE.md rule 8

Verification: `tsc` clean both sides; client unit 483 files / 6,852 tests;
client non-unit 249 / 3,446; the thirteen server rake and BBJ suites (203
tests) green; `check-rake-schedule-parity`, `check-rakeconfig-parity` and
`check-rake-bbj-collection-law` all pass.

## Postscript: there are now THREE copies of the ladder, and one of them had holes

Hours before this change, the rake-law alarm shipped `public.ca_rake_schedule`
and `public.ca_rake_tier` — a SQL mirror of the same two tables, whose own
comment says "Mirror of RAKE_SCHEDULE in src/config/RakeConfig.ts". A mirror
that does not move when the thing it mirrors moves is worse than no mirror, so
`20260831160000_the_rake_alarm_learns_the_new_schedule_rows.sql` adds the six
rows there too and mirrors the proportional fallback into
`fn_effective_rake_cap`, deriving the 15 BB bound from the table itself exactly
as the TypeScript derives it from `RAKE_SCHEDULE`.

That earlier migration also recorded, in passing, "25/50 has no schedule row
and resolves through the nosebleeds tier. That is the design." Dan's ruling
supersedes that. The cap does not move either way: 25/50 was charged $20 by the
tier and is charged $20 by its new row, so its 139 audited hands are untouched.

**Probing the mirror found a second defect, in the alarm rather than the rake.**
`ca_rake_tier` carries `min_bb` and `max_bb` copied from each tier's
documentation, and `fn_effective_rake_cap` resolved on BOTH bounds. But
`getTierForBB` is an upper-bound cascade with no floor and no gaps. The seeded
minimums leave a hole between every pair of tiers — nano ends at 0.2 and micro
starts at 0.3, small ends at 3.0 and mid starts at 3.5, mid ends at 8.0 and
high starts at 9.0, high ends at 40 and nosebleeds starts at 41 — plus
everything below 0.1. A stake in any hole matched no tier and the function
returned **NULL**.

`fn_rake_law_violations` tests `over_cap` as `WHERE cap IS NOT NULL AND rake >
cap`. A NULL cap is not a caught violation, it is a skipped one — so the alarm
was reporting "no violations" for stakes it had never examined. Measured before
the fix, big blinds 0.07, 0.25, 0.9, 3.2, 8.5 and 40.5 all resolved to NULL,
and `getTierForBB` prices every one of them. No live table sits on those stakes
today, which is why nothing had gone wrong yet.

`20260831170000_the_rake_alarm_had_blind_spots_between_its_tiers.sql` resolves
the tier the way the code does — the narrowest tier whose ceiling still covers
the stake — and re-probes every hole. Both migrations are applied to production
and verified.

One process note worth keeping: the first version of that assertion used `<>`,
and `NULL <> 1.05` is NULL, so the check passed on the very NULL it existed to
catch. The assertions use `IS DISTINCT FROM` now. An assertion that cannot fail
is the same class of bug as an alarm that cannot fire.

## And the form now says the price out loud

The two rake sliders read "Schedule" by default, and the schedule is a
fourteen-row table in a config file. An owner could set a game up without ever
seeing what it costs to play — which is exactly why the gap above survived in
the product for months. Nothing on the authoring screen said the number.

The create-table form now shows, under the rake sliders, what the table will
actually charge: the percentage, the cap in both dollars and big blinds, the
Bad Beat Jackpot drop per flopped hand, and whether that came from the
published schedule or from the owner's own override.

The risk in adding such a panel is the other failure this repo has already had.
On 2026-08-15 the Game Rules modal told every player "Rake 5% (Cap $3)" at
every stake, because its props were never assigned and it fell through to
placeholder defaults — we understated the cap five-fold at 10/25. A price
display that can disagree with the engine is worse than none.

So the panel resolves through `getRakeConfig` with the overrides passed in —
the same function and the same precedence the engine applies, where an override
may only ever move DOWN from the published schedule. It hard-codes no
percentage and no cash figure of its own, and
`tests/unit/theFormSaysWhatTheTableWillCharge.test.ts` pins that: it asserts
the panel calls the resolver, passes the sliders in, contains no literal rate,
and that a greedy override (10 BB, worth $20 at 1/2) is still displayed as the
$5 the schedule allows.

## CORRECTION: 0.05/0.10 is a live stake, and this is a real price change

Written after another agent caught it, and it corrects the impact figures
above. **Both the direction and the reasoning stand; the size does not.**

This changelog said "of 972 cash tables, exactly TWO sit on a stake whose price
moves ... Both are closed", and concluded the change was near-dormant. That was
measured against the `tables` table — two rows at 0.05/0.10, both `closed` — and
`tables` is the wrong place to look for whether a stake is being played.

Measured against `hand_history` instead:

    0.05/0.10   1,185 raked hands in the last 48 hours
                top rake 3.00, exactly the nano tier cap
                60 of those hands took MORE than the new 1.50 cap allows

So 0.05/0.10 is an active stake, not a dormant one, and lowering its cap from
$3.00 to $1.50 reduces what the house takes on roughly sixty hands every two
days. Every movement is still downward and no player pays more than before —
but this is a live revenue change and it was reported as a rounding error.

**The lesson is the same one this audit keeps re-learning.** A count of
configuration rows is not a measure of activity. `tables` says what exists;
`hand_history` says what is being played. I checked the first and reported it
as though it were the second.

## Why the database mirror deliberately does NOT carry these rows yet

The two migrations that pushed the six rows and the proportional fallback into
`ca_rake_schedule` were applied ahead of the code that justifies them, and that
was a mistake — `20260831145500_the_alarm_measures_the_engine_not_our_opinion_of_it.sql`
reverses their effect on cap resolution and is right to.

`ca_rake_schedule` exists to mirror what the ENGINE charges, so the rake-law
alarm can tell whether a hand was raked above its cap. The engine's schedule is
`RAKE_SCHEDULE` in the deployed bundle. Until this branch merges and publishes,
that bundle still has fourteen rows and no proportional fallback — so a mirror
carrying twenty rows and a 15 BB bound would have answered 1.50 for a stake the
engine caps at 3.00, and filed **60 correct hands as `over_cap` criticals**. An
alarm that cries wolf on correct behaviour teaches whoever is on shift to
scroll past it.

The six rows therefore stay in the table flagged `source = 'proposed'`,
excluded from cap resolution and surfaced by `fn_rake_schedule_drift()` as a
question rather than an answer. The tier-cascade fix from the same batch was a
genuine bug fix and was kept.

### THE DEPLOY COUPLING THIS CREATES — do not lose this

When this branch merges and the new bundle is serving, the engine WILL cap
0.05/0.10 at 1.50 and the mirror will still say 3.00. The alarm then errs the
other way: too lenient, missing real over-cap hands rather than inventing fake
ones. So the flip is required, not optional:

1. Confirm production serves a bundle containing the twenty-row
   `RAKE_SCHEDULE` (check `/api/health`, then the club-arena sync commit).
2. `UPDATE public.ca_rake_schedule SET source = 'engine_mirror' WHERE source = 'proposed';`
3. Restore the proportional fallback in `fn_effective_rake_cap`
   (`LEAST(t.rake_cap, round(p_bb * public.fn_unscheduled_cap_bb(), 2))`),
   keeping the max_bb cascade.
4. Re-run `fn_rake_schedule_drift()` and confirm it reports no drift.

A schedule that lives in a deployed bundle AND in a database table cannot be
changed atomically. That is an argument for the database being the single
authority and the engine reading it, which is written up as the standing
recommendation.
