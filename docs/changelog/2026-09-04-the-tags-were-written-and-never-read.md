# The tags were written and never read, and the mutex was never called

**2026-09-04.** Two complete layers of Operation Stable Hand existed, were
covered by tests, and were unreachable from the running platform. This wires
both, and every gate in them fails open.

## What was inert

`horses:tag` wrote **1,580 membership tags and 1,000 horse-state rows** earlier
today. Grepping for a reader afterwards returned exactly one file: the tagger
itself. Meanwhile the seeding loop was still deciding all of it from a hash of
the horse's id, so:

- every horse played every variant - one horse sat in Omaha-8, short deck and
  pineapple interchangeably, because nothing anywhere restricted the variant;
- stakes came from a three-way band rather than the two blinds the horse was
  actually tagged for;
- every horse carried a ceiling of four tables, grinder and mixer alike;
- rest days and daily play caps were written and never consulted, so a thousand
  horses worked identical 24-hour shifts.

And `evaluateSit` - the single gate every Stable Hand seat is meant to pass,
75 tests deep - **had no callers at all.** The 20-buy-in licence, the 50%
session-commit cap, the per-key daily sit cap and one-body-one-club were all
unenforced on the live floor. `atomic_table_buyin` checks that the wallet can
cover the buy-in and knows none of the rest.

Every counter those rules read (`cash_sits_today`, `minutes_played_today`,
`two_hour_window`) had held its column default since the table was created, so
`maySitOnKey` was comparing 0 against a cap of 3-5 and always saying yes.

## The read side: a tag book

`StableHandTags.ts` caches both tables - tags for ten minutes, state for one
cycle - and hands the seeding loop three-valued answers. `false` refuses,
`true` allows, and **`undefined` means "no tag was read", in which case the
rule that was there before decides, unchanged.** That is the same contract as
the bankroll gate, for the same reason: a tag we could not read is not a horse
with no tag. A partial read is discarded rather than served, and the last good
book is kept rather than dropping to an empty one - an empty book reads as
"every horse is untagged", which is a decision.

**One bug found on the first live read.** The tag key is `(horse_id, club_id)`:
a horse in both JAQK and Shark has two rows sharing one `horse_id`, so keyset
paging on `horse_id` alone dropped a row at every page boundary landing between
them. Measured: **1,579 of 1,580**, and it reads as "this horse has no Shark
tag" rather than as an error. Paged per club now, where `horse_id` is unique.
1,580 exactly, and the mode split matches the tagger to the row.

## Measured before switching anything on

Two questions had to be answered from production, not assumed, because both
could have starved the floor:

**Can the tagged fleet still fill the tables?** Every cash horse has at least
one stake legal under the current $1/$2 phase clamp - 530 of 530 on Midway
Union, 292 of 292 on Deep Stack Society. Per variant, Union carries 438 NLH
horses, 110 PLO4 and 45 of the thinnest limit variant, against 20 NLH tables
and a limit board the exotic trim takes to two. No game key has zero supply.

**Would the mutex refuse everything?** Replayed against the live floor,
read-only, 5,202 horse/table pairs:

| verdict                                   | share |
| ----------------------------------------- | ----- |
| ok                                        | 64.4% |
| other_club (one body, one club)           | 12.3% |
| rest_day                                  | 10.7% |
| seat_cap (already at its own table limit) | 10.0% |
| brm (underrolled for that stake)          | 2.6%  |

Every refusal is the rule doing its job, `rest_day` lands on the 1-in-7 it was
designed for, and two thirds of pairs still pass. The floor cannot starve on
these numbers.

## A waiting human outranks every texture rule

Variant, stake, rest day and daily cap are all bypassed when a human at that
table needs the game rescued. A rest day is a texture; a person sitting
short-handed is not. The club rule is never bypassed - a horse plays inside its
own club, and that one is about whose money pays.

## The counters write themselves, and reset without a job

Mutations are collected in memory across the cycle and upserted as **one
array** - tens of seats a pass, and a jsonb increment per seat would be tens of
round trips inside a 30-second tick.

Seat exits are **diffed, not hooked**: the key set each horse held last cycle
minus the set it holds now is the exit list, whatever caused it. A stand, a
session end, a bust, a table closing underneath - only the paths somebody
remembered to hook would have fired a listener.

And there is deliberately **no midnight reset job**. Every row carries the
Chicago date its counters belong to, every reader returns zero when that date
is not today, and a fold that finds yesterday's date starts from zero. A
nightly job that has to run for a rule to be correct is a rule that is wrong
whenever the job does not run - this estate has already paid for that once,
when the Open Claw fleet returned 401 for every job after a secret rotation and
nothing noticed, because a job that stops does not fill a log with errors, it
stops filling one.

The two-hour window is **not** cleared by the new day: it is a rolling two
hours, not a daily allowance, and a horse that gave a seat up at 23:30 is still
inside it at 00:30. Entries older than a day are dropped so the column cannot
grow without bound.

## One pin moved, and it got stricter

`theFloorIsFull.law.test.ts` pinned `tablesForHorse.size >= MAX_TABLES_PER_HORSE`.
The ceiling is now that constant handed to `tagMaxTables`, which clamps the
horse's own tagged limit into it - a grinder carries four, a mixer one, and
nothing carries more than four. The pin moved in the same commit and now also
asserts that nothing anywhere raises the constant.

## Verified

Server typecheck clean, 5,187 tests across 358 files (41 new). Client typecheck
clean. The tag book, the supply fit and the mutex verdicts were all read from
production; nothing was written to it by any probe.
