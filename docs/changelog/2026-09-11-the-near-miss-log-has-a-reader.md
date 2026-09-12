# The near-miss log has a reader

BBJ programme, post-audit phase 3 of 5. 2026-09-11.

## What was wrong

`bbj_near_misses` was built on 2026-09-07 to answer one question. The main
jackpot had paid nothing for seventeen days while `bbj_contributions` took the
highest volume in the platform's history, and nothing in this database could
say whether that was the rules working or the rules broken: **"no qualifying
hand occurred" and "a qualifying hand occurred and something refused it" were
the same observation.** The table's own comment cites CLAUDE.md 10.86 for it.

10.86 rule 3 is _"a guard must have a reader, and you must name them."_

Four days later the table had **three writers and, across both repos, not one
SELECT**. The main near miss, the mini near miss and `mini_refused:*` had
written 57 rows that nobody on this platform could see. The phase 2 sweep found
it and wrote it down rather than dropping it quietly:

> **`bbj_near_misses` is write-only.** Three features insert into it and
> nothing in the tree selects from it. Its own docstring cites 10.86's "a guard
> must have a reader". The four new counters give the refusal half a reader;
> the near-miss half still has none.

A log that cites the reader rule and then has no reader is worse than no log,
because the question reads as answered.

## What this changes

**`fn_bbj_near_miss_summary(p_pool_id, p_days)`** groups the log by the gate
that refused, for one pool, over 1 to 365 days, for a club admin of that pool
(or of any club in its union) or a platform admin. It moves no money, gates
nothing and schedules nothing.

**It lands under `days_since_last_hit` on `BBJAdminAnalytics`** - the number
that has sat on an operator's screen since 2026-08-18 posing the question with
nothing beside it to answer. That panel is already mounted on
`BadBeatJackpotPage` and already club-admin gated, so the reader is on a screen
an operator opens rather than in a function somebody might call.

## Three things read from the rows rather than assumed

### The reason vocabulary in the creating migration is fiction

`20260907201404` lists five gate names in a block comment: `pot_below_floor`,
`not_enough_dealt`, `no_ace_in_hand`, `both_cards_did_not_play`,
`winner_not_strong_enough`. **No writer emits any of the five.** The engine
emits four main gates from `RakeConfig.ts` - `not_enough_players`,
`pot_too_small`, `winner_not_quads`, `both_cards_must_play` - five `mini_`
gates, and `mini_refused:<reason>` from settlement.

All 57 live rows carry one of the four main names. A reader built from that
comment would have labelled five gates that never fire and had no label for the
four that do. The labels here are keyed on the engine; the truth goes on the
column with `COMMENT ON COLUMN`, in the database, where the next reader looks.
The applied file is left alone - its SQL ran and only its prose was wrong - and
the law pins the five ghosts by name so nobody re-derives a label set from them.

### `mini_refused:*` is not a near miss and is not counted as one

The other two writers mean _a hand did not clear the bar_. This one means a
hand **did** clear the bar and the platform turned the payout away: reserve at
floor, tier disabled, variant not eligible. A player made the hand and was not
paid. It is the one row on this table that is an incident, so it comes back
under its own `kind`, sorts to the top, and prints in red as "Mini Qualified
But Was Turned Away". Nothing has written one yet, which is now a fact an
operator can see rather than infer.

The classifier has to test `mini_refused:` **before** `mini_`, on both sides,
or a hand that qualified is filed as one that never did. The law holds the two
orderings against each other.

### The pool is derived, not recorded

The engine writes `club_id`; pools are owned by a club or by a union. The
mapping is the one `fn_bbj_analytics` already applies to the same screen, and
it was checked against production before it was written: pool `a7a65cfc`
(club-owned, Deep Stack Society) reaches 30 rows, pool `f9806a7f` (union-owned,
Midway Union, 3 clubs) reaches 27, and **30 + 27 is every row on the table**. A
club that changes union moves its history between pools. That is the honest
behaviour for the question being asked - "why is MY pool not paying", asked of
today's clubs - and it is written into the migration header rather than left to
be discovered.

## "Could not read" is not "nothing was refused"

10.86 rule 1: _"I could not tell" is a distinct outcome and must have its own
name._ An RPC that errors and a pool with no refusals both produce an empty
list, and the empty one reads like good news. So the panel carries three
states, not a boolean:

| state         | what it prints                                                         |
| ------------- | ---------------------------------------------------------------------- |
| `loading`     | Reading The Refusal Log...                                             |
| `unavailable` | The Refusal Log Could Not Be Read, So This Is Not An Answer Either Way |
| `ok`, empty   | No hand was refused in 30 days, beside the 7-day qualifying-hand count |
| `ok`, rows    | the gates, commonest first, incidents above them                       |

The empty-but-readable case is the one worth having: it says the rules are not
turning hands away, they are simply not being met - which is the original
question, answered.

The migration's own assertion block carries the same trap and the fix is
written into it. A `RAISE` that reports failure cannot live inside the block
that catches failure: written the obvious way, `EXCEPTION WHEN raise_exception`
swallows the migration's own alarm and the assertion passes whatever happens.
The outcome is recorded in a flag and judged after the handler returns.

## What it is not

Not a monitor standing in for a fix (10.11), and not a band-aid (10.12). It
moves no money, gates nothing, repairs nothing, schedules nothing, and no
payout can fail because of it. The near-miss writer's own docstring makes the
same declaration for the same reason. It exists so the strictness of the
jackpot rules is a question anyone can answer from rows.

## Proved, in a transaction that was rolled back

One MCP call, one `DO` block ending in `RAISE EXCEPTION` - the error is the
success case (CLAUDE.md 11.5).

| probe                                       | result                                                          |
| ------------------------------------------- | --------------------------------------------------------------- |
| club owner, own pool, 30 days               | 4 groups, **30 refusals**, matching the 30 rows measured        |
| `p_days = 0`                                | clamped to 1 day, **2 groups** - not an empty answer            |
| a member of neither club                    | refused: _club admin role required for this jackpot pool_       |
| union pool, same caller                     | **27 refusals** - correct: he owns all three Midway Union clubs |
| unauthenticated (the migration's own check) | refused on the **authorisation** gate, not "pool not found"     |

The live breakdown, for the record: `winner_not_quads` 15 (biggest pot 714.04),
`both_cards_must_play` 9, `pot_too_small` 5, `not_enough_players` 1. Nothing
was turned away after qualifying. The main jackpot's rules are strict and
working, and an operator can now read that off a screen instead of asking for
an audit.

## The law

`tests/the-near-miss-log-has-a-reader.law.test.ts` (9 tests), registered in
`docs/laws.d/the-near-miss-log-has-a-reader.md`. It pins that the reader exists
in a migration and is called by the panel - either half alone is the defect
again - that every gate the engine can name has a label, that an unlabelled
reason still reaches the operator as its raw string rather than a blank row,
that `mini_refused` is classified first on both sides, that the three outcomes
stay three, that the writer still cannot gate a payout or write a null reason,
and that none of the five ghost reasons becomes a label key.

## Still open, unchanged by this

- The near-miss log has no retention job. The creating migration reasoned that
  ninety days at the observed rate is under 400 rows; it holds 57 after five
  days, so nothing needs doing yet and a cron would be a band-aid looking for a
  problem. Worth revisiting if the mini's five gates start firing at the mini's
  measured 4.29 hits a day.
- Union pools still have no mini operator control, the drill is still main-only
  in `claimBBJDrill`, `BBJTicker` is still unmounted, and `fn_sweep_bbj_promo`
  still has no cron row in this repo and no entry in the band-aids register.
  Phases 4 and 5 of this programme.
