# The deep-stack pair ladder had no detector

2026-09-27. Audit item (WARN, 2026-09-21): "in deep-stack (400-500bb)
tournaments, horses are stacking off with one pair or an overpair, and most of
these hands are untagged. A new detector is needed."

Both halves are true. This ships the detector and measures the leak. It moves
no strategy dial, and it argues against turning on the cap that already exists.

## Why they were untagged

`HorseHandReview.detectLeaks` has twenty-odd tags and not one of them reads
STACK DEPTH. On the hold'em pair ladder it carries exactly two:

- `top_pair_weak_kicker_stackoff` - top pair on an unpaired top board rank,
  kicker NINE OR WORSE, at showdown, on a five-card board.
- `weak_kicker_trips_stackoff` - trips through a board pair, kicker under an ace.

So an OVERPAIR carries no tag at any depth, top pair with a ten-or-better
kicker carries no tag at any depth, and a middle or bottom pair carries no tag
at any depth. `preflop_stackoff` fires on a preflop commit of 40bb or more but
never reads the hand at all. The V21 NLH block knows straights, flushes and
boats; the V24 block knows kickers. Nothing knew that 600 big blinds had gone
in.

## What is happening, measured

`fn_horse_stackoff_audit_step` over 2026-09-20 to 2026-09-26, seven complete
days, tournament hands only. A seat qualifies at an effective stack (the
smaller of the horse's own starting stack and the deepest opponent's) of 400bb
or more, with 60% or more of that effective stack committed.

2,959 candidate hands walked, 14,089 horse seats in them, 3,301 seats at 400bb
or deeper, 271 of those committed 60% or more, and 64 of the 271 held the
hand's own one pair or an overpair at the street the stack went in on.

| class                 | hands | won | bb per hand | total bb |
| --------------------- | ----- | --- | ----------- | -------- |
| one pair (hand's own) | 40    | 10  | -277.1      | -11,084  |
| overpair              | 24    | 9   | -109.2      | -2,621   |
| **the audit's class** | 64    | 19  | **-214.1**  | -13,706  |
| every deep stack-off  | 271   | 144 | +5.0        | +1,357   |

The last row is the point. Deep stack-offs as a whole are break-even
(+5.0 +/- 28.9 bb per hand, t = 0.17): the fleet is not generally bad at
getting stacks in deep. The pair ladder is where it loses, and the damage grows
with depth - -150.2 bb per hand at 400-450bb, -221.5 at 450-500, -255.1 at
500-600, -274.2 beyond 600.

**59 of the 64 (92%) carry no stack-off tag today.** Three have no
`horse_hand_reviews` row at all, 26 have a row with an empty `leak_tags`, and
the rest carry only outcome tags such as `river_aggr_lost`. Exactly one carries
`top_pair_weak_kicker_stackoff`. Every one of the 64 is an MTT.

Worked example, hand `215178b4-89ad-4809-b4a3-5be87635fc52` (2026-09-23): a
horse held QQ on 6d 4c Ts 5h, moved its whole 600bb stack in on the turn, and
lost 600bb. `leak_tags` is empty. Hand `96f8e38a-dde2-49c4-bfcf-3eb85657c91b`:
AJ on 6s 8d Ac 2c 7h, 596bb in on the river, lost - top pair with a JACK
kicker, one rung above the V24 gate, so it carried `river_aggr_lost` and
nothing else.

## The detector

Migration `20260927220637`, three tables and three functions, modelled on
`20260914161209_horse_committed_pot_daily_audit.sql`.

- `fn_ca_holdem_commit_pair_class(hole, board)` returns the made-hand category
  and, for one pair, whether it is the hand's OWN pair (`overpair`,
  `one_pair`) or the one the board makes for everybody (`board_pair`) - the
  same distinction the V24 detectors draw. It refuses rather than guesses: an
  unparseable card or four hole cards returns `{readable:false, reason}`.
- `fn_ca_hand_commit_street(actions, user, invested)` is the SQL mirror of
  `commitStreet` in `HorseHandReview.ts`, remainder-call rule included, so the
  hand is judged on the board the horse could SEE when the money went in. A
  preflop commit stands down: that is `preflop_stackoff`'s hand.
- `fn_horse_stackoff_audit_step(day)` sweeps one bounded batch and writes
  `horse_stackoff_reviews`.

Four tags, mirrored on both sides because the situation is outcome-independent
and `EveryLeakTagHasADenominator` requires it: `deep_one_pair_stackoff`,
`deep_overpair_stackoff` and their `_won` twins. Every other qualifying seat -
the sets, the boats, the preflop commits - is kept in the same table with a
NULL tag, so the denominator is never lost.

Money is read only from `hand_atomic_commits.post_commit_payload ->
accepted_hand_facts`, never reconstructed from action amounts. The starting
stack is derived as `final stack + net contribution - winnings`; that
derivation was checked against the first `publicNode` of 3,527 live tournament
seats and agreed on 3,527 of 3,527.

It says what it could not read. `unreadable_seats` counts seats whose cards or
commit street would not parse (4 over the seven days, all on 09-26),
`horse_stackoff_audit_gaps` names per-hand evidence failures, `out_of_scope_hands`
counts Omaha and multi-board hands rather than scoring them on the hold'em
ladder, and `source_coverage` is fixed at `not_established` by a CHECK
constraint, because the pot pre-filter and hand-history retention both bound
what a sweep can see.

It is idempotent and backfillable: `fn_horse_stackoff_audit_step(day)` re-runs
a finished day as a new pass and rewrites the same primary keys with the same
answers. Proved on production - a second pass over 2026-09-21 returned 57 rows,
0 of them different.

The sweep reads only hands where `pot_size >= 150 * big_blind`.
`hand_history` is 14 GB and its evidence columns are TOASTed, so filtering on
the inline columns first is what makes a daily sweep affordable: 2,959
candidate hands instead of 1.8M. The filter cannot hide a qualifying hand,
because a qualifying seat commits at least 400 \* 0.6 = 240bb and those chips
are in the pot. Checked directly on every one of the 20,614 tournament hands of
2026-09-21: no seat's accepted contribution ever exceeded `pot_size`, 63 hands
held a seat at 240bb or more, and the 150bb filter missed none of them.

Migration `20260927221321` gives it a driver, `horse-stackoff-audit-20m` on
pg_cron, three ticks an hour. pg_cron rather than the engine's adaptive-journal
loop because this is pure database measurement that writes only its own tables,
and the engine ships only through the announced :55 break; a detector should
not wait on an engine cutover to start measuring.

Both migrations are applied to production and recorded under those exact
versions. One disclosure: the repo copy of `20260927221321` carries a
`-- periodic-work:` comment block that the applied statement does not, because
`check-no-new-band-aids` requires a new schedule to argue for itself in the
file and that gate runs after the migration was applied. It is a comment; the
DDL either side of it is identical.

## Pushback: do NOT turn the commitment cap on

`v51CommitCap` and the `v51_commitment_cap` matchup exist on branch
`agent/cowork-claude-stratcap-0921/feat/one-pair-commitment-cap`, DEFAULT OFF,
waiting on the league. Three findings, in order of how much they matter.

**Its matchup has never measured anything.** `horse_league_results` holds zero
rows for `v51_commitment_cap` - not an inert 0.00 +/- 0.00, no row at all. The
branch was never merged, so the matchup is not in `LEAGUE_MATCHUPS` on main and
the nightly card has never dealt it. There is nothing to read and nothing to
promote on. (The league itself is running: 43 matchups wrote rows on 2026-09-27, three
of them inert at 0.00 +/- 0.00.)

**Its class is not this leak's class.** The cap covers one pair no better than
top pair with a kicker of nine or worse, a lower pair, an underpair, and
weak-kicker trips. It explicitly excludes overpairs and top pair with a
ten-or-better kicker. Against the 64 hands measured above:

| the cap's view                    | hands | total bb |
| --------------------------------- | ----- | -------- |
| top pair, kicker >= 10 - EXCLUDED | 35    | -8,795   |
| overpair - EXCLUDED               | 24    | -2,621   |
| underpair - covered               | 3     | -1,265   |
| lower pair - covered              | 1     | -596     |
| top pair, kicker <= 9 - covered   | 1     | -429     |

**59 of 64 hands and -11,416bb of -13,706bb are outside the cap.** Enabling it
would address 5 hands and 17% of the damage.

**Its matchup is dealt at the wrong depth.** `v51_commitment_cap` is
`{ pairs: 6000, a: { v51CommitCap: true }, b: {} }` on the standard NLH card,
where the leak it was written for was measured at 100bb. This leak is at 400bb
and deeper and gets worse with depth. The harness supports `stackBB` -
`v21_deep_250bb` and `v33_depth_ceiling_400bb` both use it - so a deep card is
available and simply was not used.

So: not merged, not measured, wrong class, wrong depth. Turning it on would be
a strategy change justified by a matchup that has never run, against a class
that covers 8% of the hands. It stays off.

### What should happen instead

1. This detector accumulates. It currently finds about nine tagged hands a day.
2. The two halves must stay apart, and this is why the detector ships two tags
   rather than one. Over seven days `deep_one_pair_stackoff` is
   -277.1 +/- 57.4 bb per hand (t = -4.82), a real finding. But
   `deep_overpair_stackoff` is -109.2 +/- 98.4 (t = -1.11) and **does not
   resolve** - 24 hands is not enough to say an overpair stack-off at 450bb is
   a mistake at all. The audit's phrase "one pair or an overpair" merges a
   significant leak with an unresolved one; a cap built on the merged number
   would be tuned partly on noise, which is the mistake the 2026-09-05
   denominator note was written about.
3. The cap that follows should take the class the evidence names - top pair
   with any kicker, and an overpair only once its own number resolves - and
   ship behind its own flag, DEFAULT OFF, with a matchup dealt at `stackBB: 450`
   rather than on the 100bb card. Promotion on the standing rule: three
   separate nightly runs with |bb100| > 2 x stderr.

### If Dan wants the existing cap on anyway

Merge `agent/cowork-claude-stratcap-0921/feat/one-pair-commitment-cap`, which
adds the matchup to `LEAGUE_MATCHUPS` and the flag DEFAULT OFF. The flag is
`v51CommitCap` in `HorseLogic`'s options; it turns on for the fleet by
defaulting it to true at its read sites in `HorseLogic.decidePostflop`, which
is a code change and a deploy, not a database setting. Nothing in this branch
enables it, and nothing here depends on it.

## Not established

Whether the same shape exists in CASH games at these depths. This sweep is
tournament-only, because that is what the audit asked about; the detector's
gate is `tournament_id IS NOT NULL` and widening it is a one-line change with
its own measurement.

`two_pair` is the largest single loser among deep stack-offs over the same
seven days - 76 hands, -13,442bb, -176.9 per hand - and carries no tag either.
It is outside this audit item and is recorded here so it is not lost.
