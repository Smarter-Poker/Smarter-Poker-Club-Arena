# A publish that lands mid-run is not a failed proof

2026-10-26. Production test only; no client, engine, migration or financial
change.

## What was wrong

Both proofs in `tests/e2e/production-notifications.spec.ts` read
`build-info.json` when they begin and assert the same release when they end.
Post-deploy run 40242809027 (client job 121318525896) failed the notification
proof with "Expected 09ea5c49... Received 96818b8b...": every product assertion
had passed, a newer publish landed while it ran, and the run reported the
notifications surface broken. Merges were landing every few minutes that
evening, so a 1-3 minute proof regularly spanned a publish.

## The fix

Each proof now records the release it ended on and attaches its live proof
only when that equals the release it began on. If a publish landed mid-run,
it stands down after its cleanup as a named non-verdict through
`support/nonVerdict.ts` (a `::warning::UNKNOWN:` line, a NON-VERDICT summary
paragraph, a `non-verdict` annotation and the two release ids as evidence).
It never counts as a pass and never as a defect. Cleanup failures are still
reported first. `assert-e2e-actually-ran.mjs` still fails the file if both
proofs stood down, so a run that verified nothing cannot report success.

## Tests

`tests/unit/aPublishMidRunIsNotAFailedProof.test.ts` (7 cases) pins the shape:
no end-of-run equality assertion, release read at both ends, proof attached
only for one release, stand-down after cleanup and after collected cleanup
failures, and a named non-verdict before the skip. Six of them fail on the
previous spec. The spec type-checks and both proofs still list.
