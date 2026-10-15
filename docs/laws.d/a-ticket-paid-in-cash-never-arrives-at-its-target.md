# tests/a-ticket-paid-in-cash-never-arrives-at-its-target.law.test.ts

fn_tournament_conservation_delta and fn_tournament_conservation_deltas do not count a satellite ticket that the closed-target cash door paid out ('ticket:<id>:closed-target-cash') as a seat arriving at its target, so a ticket paid in cash never reads as money the target retained.
