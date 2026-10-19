# The unassigned rake row keeps AA contrast

Post-Deploy E2E client job 118153814498 (2026-10-19) passed 493 of 494 checks.
The one failure was the Club Data axe check in `tests/e2e/club-data-deep.spec.ts`.
The unassigned agent row is dimmed with `opacity: 0.7` on the whole row. That
took its role and count text (`#9aa5b3` on black) to 4.38:1 and its gold cost
to 4.36:1, both under the 4.5:1 AA floor. The check only fails when a club has
unassigned players, so it passed on other runs against the same client.

#7468 independently set `.rowMuted` to `opacity: 1`. This change keeps that
value and adds the regression it lacked:
`tests/unit/rakeSnapshotMutedRowContrast.test.ts` computes the bound from the
stylesheet, so a later colour or opacity change cannot slip under 4.5:1. It
fails at 0.7 and passes at 0.85 or above.
