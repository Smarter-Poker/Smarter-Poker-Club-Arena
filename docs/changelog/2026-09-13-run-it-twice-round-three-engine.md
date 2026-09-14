# Run it twice, round three: the engine side (2026-09-13)

Follow-up to `2026-09-05-run-it-twice-ships-the-pot-per-board.md` and
`2026-09-05-run-it-twice-hardening.md`. Eight days on, the per-board fix was
re-verified live (`aa6b6387a` is an ancestor of the running engine; 285 of 285
multi-board hands in 24h conserve money per board) and the whole feature was
read again line by line, engine and client. This file is the engine half; the
client half is `2026-09-13-run-it-twice-round-three-client.md`.

## A heads-up table never offers the question

Dan, 2026-08-26: "run it twice or 3 times is a cash game only area. it should
never be in MTT, SPINS OR HEADS UP." The engine quoted that sentence in two
places and enforced two of its three parts. Every heads-up table on the
platform happens to be a tournament (the 2-seat heads-up SNG shapes), so the
tournament gate covered the third by accident; the first 2-seat cash table
would have offered it. `applyRunItTwiceConfig` now refuses a table whose
`max_players` is at or under `HEADS_UP_SEATS`.

A heads-up TABLE is a format. A two-way all-in on a full ring is the ordinary
run-it-twice hand (the reference recordings that shaped this feature are
exactly that) and is untouched. Pinned in `tests/unit/ritConsentIntegrity.test.ts`.

## The expiry says who was still silent

`RunItTwiceEngine`'s deadline callback was `decline(tableId, primaryOfferedTo,
'timeout')`: the FIRST responder in the offer list was stamped as `declinedBy`
on every timeout, whoever had actually answered. B accepts in two seconds, C
never answers, the event blamed B. No consumer read the name, which is the only
reason it was harmless.

An expiry has no decliner. `expire()` records `declinedBy: null` and
`unanswered: [...]` - every responder outside `acceptedBy`, plus the chooser if
they never picked a count. The host forwards a single silent seat to the felt as
`rit_single_run` with reason `no_answer` and their id ("Running It Once. Name
Did Not Answer In Time." on the client); two or more silent seats keep the
collective line. `RunItTwiceEngine.consent.test.ts` drives the scheduler callback
and reads the event.

## A horse does not answer in the same three seconds every hand

The 2026-08-31 fix stopped the horse's ANSWER being a tell. Its latency still
was: chooser 1.2-2.2s, responder 2.5-3.7s, every hand, against a 25-second
window humans use all of. Section 10.5 says timing is part of the treatment.

`horseRitThinkMs(playerId, role)` is deterministic in (player, hand) like the
verdict: the bulk lands between ~1.5s and ~9s, about one hand in six is a long
think of 10-19s, never past 20s so the DeadlineScheduler never discards a
horse's answer. Measured in `HorsesCanDeclineRunItTwice.test.ts`: p90 - p10 over
5s, fast taps and long thinks both present.

## `winners_by_board` keeps the pot axis

The row is one per (board, winner, half). A three-way all-in with a main pot
and a side pot pays a covering winner out of BOTH on the same board, and both
producers (the RIT path in `ServerTableEngineRunout` and the double-board path
in `HandController`) summed the pot axis away in that merge. The record could
say who won which board, never which pot - and `hand_history.pots` beside it
could not be crossed with it.

Each row now carries `pots: [{ index, amount }]`, main pot first, summing to
the row. Additive: older rows have no field, the client reads it when present.
It rides `pot_win.winners_by_board` too (with `low`, which the wire had been
dropping), so the felt and the record read the same row.
