# Chests-only pre-money knockouts do not block completion

Three decided PLO5 mystery tournaments could not finish because the terminal
coverage reader required a bounty obligation for every accepted knockout.
The chests-only producer intentionally creates no pre-money obligation. Live
readback found 533 such resolved generations across the three events, all
strictly before their immutable activation receipts; the engine reported
`unclaimed_bounty_candidate` on their first early knockout.

The maintained reader now visits every uncovered generation. It exempts only
an exact accepted hand of a chests-only, non-PKO event, resolved as eliminated,
rebought or winner, strictly before its sealed activation generation. Missing
or ambiguous evidence, pending generations, equal/later commits, regular
bounties and PKO still refuse. Skipping one generation cannot hide a later debt.
The original claim, collectors, terminal payers, immutable receipts and ACLs
remain unchanged. No historical row or wallet is rewritten by this migration.

The existing required Accounting shard 4 terminal-bounty native probe applies
the exact migration and runs the new fixture. The new positive case failed on
the original function. With the fix, the complete existing probe and new
cases pass, including real accepted-hand readers and terminal roots, full
coverage, exact funded inventory, no second residual payment and immutable
replay. Its inherited wallet is a documented pool-bounded stand-in; production
installation and natural terminal receipt/escrow readback remain required.
The runner now honors owned scratch paths; its existing cleanup-fault tests
also create their scratch under RUNNER_TEMP. TypeScript routing tests include
the new fixture in the existing accounting classification.

Separate restart investigation: retained engine logs identify an invalid horse
policy `route_gate` receipt reaching the fatal exception handler. Existing
active PR #7745 owns that exact producer/reference-gate fix and regression;
this change does not duplicate or take over its active operation.
