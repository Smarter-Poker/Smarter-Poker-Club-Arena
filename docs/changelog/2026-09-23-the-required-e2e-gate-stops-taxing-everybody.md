# The required E2E gate stops taxing everybody, and the transport suite runs here

Two pieces of CI hygiene that were costing every delivery in the repository.

## The gate flaked on about one PR in ten

`CSS Beat E2E (multi-table + animations)` is required on every pull request.
Sampling 32 recent PR runs: 13 skipped, 19 executed, **2 failed** - and on
different specs each time. One of those was a branch that had only touched the
pot's chip pile, and it cost that delivery a full re-run of a job whose own
comment budgets twenty minutes.

The failing assertion was `real tiles repaint the real preview, persist, and
broadcast to a second tab`, and the file already knew about it. The comment at
that test records an identical loss on 2026-09-05, "a red check on a branch that
had not touched Table Studio at all". The fix applied then made the suite poll
all four debounced writes instead of one, which fixed the ORDER they land in. It
never fixed the BUDGET: those four polls still ran on Playwright's default five
seconds, while the purchase flow further down the same file has carried an
explicit `{ timeout: 20_000 }` ever since a native CI trace showed a save
landing after the old five-second dialog deadline.

So the four writes, and the one cross-tab attribute wait that depends on a
broadcast rather than on the click that caused it, now carry the same bounded
readiness budget the real Studio controls already use. Nothing else was
touched - the same-tab repaints stay on the default deadline, because those are
driven synchronously by the click and raising them would hide real regressions.

## The transport suite was never incompatible with Node 26

All twelve scenarios in `tests/legacyEngineCheckpointTransport.test.ts` failed
on the Mac that runs local prechecks. They failed in under a second, all twelve,
which is not what a real inspector problem looks like - and they passed in CI.
The cause was one line in the fixture:

    assert.match(process.version, /^v(?:20|22)\./);

The host is on v26.3.0, so the fixture asserted itself to death before any
inspector work ran at all. The failure was being written off as a Node
incompatibility that it never was, and it poisoned every local full-suite run,
which is exactly where a real regression would have been hiding.

Running the twelve scenarios on v26.3.0 with only that allowlist widened: all
twelve exit 0, with `sameProcessAliveAfterCleanup`, `portClosed` and
`normalExit` all true, including `timeout`, `disconnect`,
`cleanup_close_timeout`, `refusal_cleanup_timeout`, `preexisting` and
`malformed_refusal`. So the allowlist gets 26 and nothing below it is relaxed -
the `WebSocket`, `getBuiltinModule` and vm `USE_MAIN_CONTEXT_DEFAULT_LOADER`
assertions on the next lines are untouched, and CI stays pinned to 20 and 22.
