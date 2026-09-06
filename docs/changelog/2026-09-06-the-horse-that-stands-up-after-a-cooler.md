# The horse that stands up after a cooler

2026-09-06. The last persona behaviour whose hook actually existed.

## What was missing

A horse has never once stood up after a bad hand. It takes a 200bb cooler and
is in the very next hand, every time, forever. At a live table that is one of
the most visible tells there is.

`sitOutAfterLossRate` was drafted with `tilt` and `showBluffRate` on
2026-09-05 and all three were deliberately NOT shipped, with the reason
written where the fields would have gone: _"their hooks (session memory, the
show-cards path) are not in this branch. They go in with the hooks, not before
them."_

One of the three was wrong about its own hook. `ServerTableEngineSeating.sitOut`
is the same public method a human's Sit Out button calls, it has been there
the whole time, and settlement already knows every horse's net for the hand.

## What shipped

- `HorsePersonaV2.sitOutAfterLossRate`, bounded hard at 0.35 at the read
  boundary, with a deterministic per-horse default: about 55% of the fleet
  never walks, a third walk sometimes, a few nearly always.
- `ServerTableEngineSettlement.horsesTakeABreather` — after a hand that cost a
  horse 100bb or more, `wantsSitOutAfterLoss(horse, hand, rate)` decides, and
  the seat is sat out through the **same public `sitOut()` the button calls**,
  then booked back in 75 seconds later.
- Cash only. A tournament seat is bought and gets blinded off, so sitting out
  there is not a breather, it is a leak.
- Deterministic in (horse, hand): a replayed hand behaves the same way twice,
  and the distribution is asserted rather than hoped for. `Math.random` is
  banned anywhere near this, and the persona hash has already been caught
  twice by exactly that shape of test.

## Under CLAUDE.md 10.5

This reads `is_horse`, and it is the **input device** exemption — the same one
the voluntary straddle round carries. A human who loses a buy-in can click Sit
Out; a horse has no browser. It calls the same public method, so every rule
that governs a human sitting out governs this one: the play-one-hand gate, the
disconnect engine, the eviction clock. It withholds nothing. It **grants** a
horse a behaviour only humans had.

## The failure mode, watched from day one

The sit-out is not the risk. The sit-back-**in** is: it runs on a 75-second
`setTimeout`, and a timeout does not survive a container replacement —
`server/**` merges deploy, so replacements are routine. A horse whose breather
started thirty seconds before a deploy would sit out forever, holding a seat
nobody can use, and nothing would say so.

`fn_audit_breather_returns` compares `v48_sit_back_in` against
`v48_sit_out_after_loss` nightly: over 10% unreturned is a warning, over 25% is
critical, and the recommendation names the deploy as the first thing to check.
It is wired into the seat-clock step, which is where a reader already goes to
ask whether every horse seat is doing something.

## What is still deliberately not shipped

`tilt` needs a per-seat session memory that survives hands, and nothing in the
engine keeps one. `showBluffRate` needs a voluntary show-cards action for a pot
won **without** showdown; the engine has muck handling and an observer setting,
but no such action — building it is an engine and client change, not a persona
one. Both would be dead data today, and the ledger exists to refuse that.

## A mistake worth recording

I rewrote `fn_audit_seat_clock` from memory instead of reading it, and the
rewrite referenced `table_seats.last_action_at`, a column that does not exist.
It threw on the first call. The real check reads `ca_horse_fleet_state` and
asks a sharper question than mine did. Restored verbatim from its original
migration, with the breather check appended as the only change.

## Migrations

- `20260906095757_a_breather_that_never_ends_is_a_stranded_seat`
- `20260906095835_restore_the_seat_clock_and_append_the_breather`
