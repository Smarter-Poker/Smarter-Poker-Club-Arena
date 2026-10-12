# Post-Reset Certificate Accepts An Unmaterialized Board

The reserved Create Club certificate can reset its unused welcome package
before the engine's first Spin/SNG board tick. Board materialization is atomic:
the reset receipt can therefore contain either no board tournaments or the
complete twelve-game board. Cleanup previously required twelve and could not
retire the valid zero-board fixture.

The guarded forward-only migration admits exactly zero or twelve matching
board tournaments. It continues to refuse partial generations, duplicates,
unknown tournaments, receipt disagreement, nonterminal games, activity and
live custody. It changes no product club, player, game, wallet or chip row.

Validation covers migration replay, source/config tamper refusal, function
ownership and ACLs, zero-board/zero-schedule cleanup, full-board/zero-schedule
cleanup, and the retained partial, duplicate, extra, malformed and receipt
mismatch refusals on native PostgreSQL 17.

Policy receipt: owner policy 2.9,
`a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
