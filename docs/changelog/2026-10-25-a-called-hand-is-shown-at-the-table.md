# A hand that called the river is shown at the table

Dan, 2026-10-25: "show the hand at call down.. do all 6 of these." Phase 2 of 2
(engine; activates with the daily 04:00 America/Chicago engine release).

`HandController` now records, per seat, whether its last river decision was a
call - a plain `call`, or an `all_in` whose whole stack was no more than the
amount it had to call (read before any chips move). `applyShowdownRevealRules`
tables every such hand, win or lose, alongside the four-of-a-kind jackpot rule.
Everything downstream keys off the one `mucked` flag, so the table turns the
cards face up, the seat label shows the hand, `hand_history` stores the
holding as revealed, and the horses' showdown observations receive the same
hand name every human player sees.

Unchanged: a beaten hand that checked the river down may still muck; a call
on an earlier street does not count; tournaments and all-in showdowns already
show every hand. Hands from before the release keep using
`fn_ca_called_river_mucked_cards` for Previous Hand.

Tests: `HandController.showdownRules.test.ts` (three muck expectations updated
to "shown" because those hands called the river; four new cases: checked-down
muck, a called raise, an earlier-street call, an all-in call) and the law
`server/src/engine/ACalledHandIsShownAtTheTable.law.test.ts`.
