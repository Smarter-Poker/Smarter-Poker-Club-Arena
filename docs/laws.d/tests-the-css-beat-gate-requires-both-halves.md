# tests/the-css-beat-gate-requires-both-halves.law.test.ts

"CSS Beat E2E (multi-table + animations)" is a required check on main, and
since 2026-10-01 its browser work runs as two jobs side by side:
`css-beats-e2e` (the beats, Table Studio and the decision gate on one shared
build) and `diamond-playfield-e2e` (the real Diamond scenes, which bundle
themselves and need neither the build nor the preview). The required name
belongs to `css-beats-gate`, which runs no browser and passes only when both
halves passed. The danger in any aggregator is the skip: a job skipped by
`needs:` reports SKIPPED, and a ruleset counts a skipped required check as
SATISFIED. This law holds that the gate alone carries the required name, waits
for both halves and `changes`, evaluates with `always()` so a failed or
cancelled half fails it rather than skipping it green, is admitted by exactly
the halves' own condition, fails unless both results are exactly `success`,
and that each suite runs in exactly one half.
