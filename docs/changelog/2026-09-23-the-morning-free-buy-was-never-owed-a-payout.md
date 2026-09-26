# The Morning Free Buy was never owed a payout, and its stranded hand is voided

**2026-09-23**

`Morning Free Buy (NLH)` `7c6277e7-921d-4651-91bc-15071a3884be` had been `RUNNING`
since 2026-09-19 with 18 registrations seated on 338,000 chips and 283.80 of prize
money nobody could release, and its stranded hand permit was holding every engine
release on the platform shut. `auto-deploy-hetzner` run 35897820986 refused its
restart certificate with `f06_custody_not_drained` on table
`9e432569-5ebc-467a-9972-e450dfc0b296`, reporting `permitPhase=attempted` - "a hand
that may have started".

I went in to settle the money under CLAUDE.md 10.9 and came out having settled
nothing, because the rows say nothing is owed yet. This note is mostly about why
the obvious remedy was the wrong one.

## What actually happened to the event

The event dealt **283 hands** between 13:02 and 14:29 on 2026-09-19 across three
tables, and stopped dead at **14:29:08** when the engine generation driving it,
`29afae24-5415-458f-acca-778b4f14444f`, died. It holds no `engine_tournament_leases`
row, so nothing has driven it since.

| table              | accepted permits | hands dealt | seats | chips   |
| ------------------ | ---------------- | ----------- | ----- | ------- |
| `9e432569` Table 1 | 121              | 121         | 6     | 124,007 |
| `26c00afc` Table 2 | 88               | 88          | 5     | 114,503 |
| `244a2997` Table 3 | 74               | 74          | 7     | 99,490  |

Accepted F06 permits equal dealt hands on every table, with no remainder.

Chip conservation closes exactly: 24 entries at 3,000, plus 12 rebuys at 3,000,
plus 23 add-ons at 10,000, is **338,000** - the precise total on the felt, and the
precise total on the roster. `fn_unaccounted_seat_exits('10 days','1 hour')` returns
zero rows platform-wide, and `ca_seat_stack_exits` holds nothing for these three
tables. **No chips are stranded or destroyed.**

## No hand was ever in the air

`permitPhase=attempted` is ambiguous by design - it means a hand that _may_ have
started - so it was resolved from rows rather than assumed.

Two permits remained `reserved`, both of the dead generation: hand **13180949** on
`9e432569` and hand **13180944** on `26c00afc`. Both hand numbers are _higher_ than
the last hand their table actually dealt (13180877 and 13180796). For both:

- zero `hand_history` rows at or above that hand number
- zero `table_hole_cards` - no cards were dealt
- zero `hand_atomic_commits`, zero `hand_private_state`, zero `f06_hand_dispatch`
- zero `hand_submissions`

Each had exactly one `hand_state_snapshots` row, written at 14:29:12.951 and
14:29:07.147, `stage='preflop'`, `is_complete=false`: a hand staged with blinds and
antes posted into the snapshot and abandoned four seconds after the previous hand
ended. The snapshots reconcile to the felt to the chip - snapshot pot 3,450 against
`totalInvested` summing to 3,450 on `9e432569`, and 3,050 against 3,050 on
`26c00afc` - and **every one of the ten chairs named in them satisfies
`table_seats.stack = snapshot stack + totalInvested`**. The staged blinds never left
a chair. Voiding these hands returns nothing, because nothing was ever taken.

## Why nothing was paid

The obvious reading - a four-day-old `RUNNING` event is 10.9's "a tournament that
cannot end itself", settled by ruling on chip standard the way the 6:00 AM freeroll
was on 2026-09-09 - is wrong here, on three counts.

**1. There is no result to settle.** The event is not undecidable; it is un-driven.
Its 18 registrations were never eliminated and hold live equity in a pool that pays
three places (50.26 / 28.87 / 20.87 of 283.80 = 142.64 / 81.93 / 59.23). Ruling the
places from chips would have handed those three amounts to the top three stacks and
extinguished the other fifteen players' claim on the same pool - taking something
real from them to tidy up a release. A 12,451-chip stack with eight big blinds is
not a finished fifteenth place.

**2. The platform already has a remedy, and it names this event.**
`fn_f06_abort_abandoned_generation` was rewritten on 2026-09-22
(`20260922132318_a_late_chair_a_bought_addon_and_a_foreign_park_do_not_hold_an_event_frozen.sql`)
specifically for "24 frozen multi-table events (1,606 playing registrations - Prime
Time, Midday and **Morning Free Buy**, Lunch Rush, the $100 Freerolls, Friday Rebuy
Rush, Omaha Thursday; 201 reserved permits)". Its stated purpose is to void the hand
a dead generation left reserved so an adopting successor can take custody and the
event carries on, and its header says the void "still credits nothing and debits
nothing".

Measured on this database: **452 events took that door on 2026-09-22 between 12:40
and 13:23 UTC. 412 have since COMPLETED and 40 are RUNNING with live leases, and 447
of the 452 dealt hands after their abort.** The remedy demonstrably unfreezes events.
Morning Free Buy was named in the cohort and missed by the sweep -
`smarter_private.f06_generation_aborts` held no row for generation `29afae24`.

**3. A ruling was not reachable through any platform path, and the only routes to
one were forbidden.** Table `244a2997` carries an open `f06_operations` row in state
**`begun`** (break `dce8ddb0`, manifest written, 8 members, 8 attempts, origin and
custody generation `29afae24`) - a table break that was one move into eight when the
engine died. MiaPoker `3b7caeb9` completed hers at 14:29:14 and sits on `26c00afc`
seat 3 with her 13,510 intact; the other seven attempts are still `active` and those
players never moved.

While that operation is open, `smarter_private.f06_source_guard` refuses every
`UPDATE OF status` on `tournament_players` and every `UPDATE OF left_at` on
`table_seats` for that table with `F06_SOURCE_EXCLUDED` - which blocks both the
roster stamp a ruling needs and the seat release `trg_release_seats_on_tournament_finish`
performs at `COMPLETED`. A probe confirmed it: the roster stamp died on the seventh
player, the first one seated on `244a2997`.

No function on this tip takes a `begun` operation with active attempts to a terminal
state. `fn_f06_close_break` requires every attempt to be a winner; every
`withdrawn_before_manifest` door is keyed to a park that never got a manifest.
Across the whole database, **no tournament has ever completed with a `begun`
operation** - 508 `acknowledged` and 90 `withdrawn_before_manifest` against zero
`begun` on COMPLETED events. Reaching a ruling would have meant hand-editing
`f06_operations` or fabricating an engine lease to impersonate a generation. Neither
is allowed, and neither is necessary.

So the money stays where it is. `tournament_escrow` still holds `prize_balance`
283.80 and `fee_balance` 1.20, enforced, exactly as since 2026-09-19, and it is paid
when the event finishes, to whoever finishes in the places.

## What shipped

`20260923205828` calls the platform's own door once, voiding the two staged hands of
the dead generation. It sets those permits to `aborted_unsettled` with the receipt as
evidence, marks their snapshots complete, and writes its receipts. Proved first in a
rolled-back probe (CLAUDE.md 11.5, one call, one self-aborting `DO` block), which
returned `ok: true`, `credit: 0`, `hands_aborted: 2`, and afterwards **0 reserved
permits, 18 seats, 338,000 chips on the felt, 338,000 on the roster, status still
`RUNNING`, prize 283.80, fee 1.20** - nothing moved. The migration asserts every one
of those after the call and aborts if any of them moved.

The blind clock needed no repair: the door's restore logic matched the evidence
blinds (750/1500) to the event's own `current_level` 15 and correctly declined to
move it (`level: {restored: false, matched_level: 15}`).

All 24 registrations in this event are horses. Nothing here treats them differently
for it (CLAUDE.md 10.5): they keep their seats, their chips and their claim on the
pool exactly as a human field would, and the settlement doors they will eventually
pass through contain no `is_horse` predicate at all - verified against
`pg_proc.prosrc` for all seven of them.

## What is still open, and whose it is

The `begun` break on `244a2997` is deliberately **left alone**. It is not this
migration's to close: an adopting successor takes custody through
`fn_f06_claim_custody`, which is how 58 acknowledged operations have already
completed.

The root cause underneath it is the `TournamentManagerBase` teardown throwing
`"retained an unresolved seat-move UUID"` before its `unregisterTournamentTableEngine`
loop, which leaves engines stopped-but-registered and produces the
`metaSeatedWithoutBank=6` census on this very table. That is owned by the agent
working F06 recovery, along with `F06_UNRESOLVED_GATE_MS` (`f85e90aa6b`, #5003),
the bounded gate that would age a stuck preparation out - and which is not an
ancestor of the running engine, so the fix for the wedge is behind the wedge. This
note does not duplicate that work and does not paper over it.

**There are 25 `begun` operations and 136 `park_requested` operations on RUNNING
events.** This change touched exactly one event - the one holding the restart
certificate shut, per `/health`'s `unparkedReasons {f06_preparation_unresolved: 1}`.
The rest of that backlog is real and is not fixed here.

A `financial_alerts` row records the finding and is resolved in the same transaction,
with a resolution note that says plainly that no money was paid and none is owed yet.

## What the void did NOT do, measured

**The release is still blocked, and this change did not unblock it.** An earlier draft
of this note was titled "one voided hand freed the fleet". It did not, and the title is
corrected here rather than left to be believed.

The durable blocker is gone - `smarter_private.f06_hand_permits` holds no `reserved` row
for this event, and `check-migrations-are-live` proves it from the repo. But the gate
`/health` publishes reads the RUNNING process's memory, not the database:
`ServerTableEngineBase.hasUnresolvedF06Preparation()` returns
`phase === 'unknown' || 'reserved' || 'terminated'` off `this.f06CurrentPermit`, a
process-local object that a durable void cannot mutate. Watched across the whole 21:53
break on engine `8825af51`: `cards_in_air` drained 36 -> 5 -> 0 as designed, every other
table parked, and `unparkedReasons` settled on exactly
`{f06_preparation_unresolved: 1}` with `readyForRestart: false` from `last_hand` through
`counting_down` and past the scheduled end. The break then timed out on its own at
22:01:47 and play resumed (`dealable` 51, `handsInFlight` 48), so players are served and
the freeze is bounded; but no cutover happened and `releaseSha` is unchanged.

So the deadlock is real and it is one level up from this change: the fix that would age
a stuck preparation out (`F06_UNRESOLVED_GATE_MS`, #5003) is not an ancestor of the
running engine, and it can only get there through a restart that the stuck preparation
refuses. A restarted engine will now start clean, because the durable state it reads is
clean - that is what this change bought, and it is all it bought. Clearing the running
process's hold needs the bounded gate or the terminal F06 operation state (#5037), both
owned by the F06 recovery work.
