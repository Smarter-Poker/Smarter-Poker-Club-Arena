# Satellite qualifier native inputs

`scripts/ci/test-satellite-qualifiers.py` reuses the maintained MTT accounting `Execution` owner and canonical fixture composer. Run it only against its newly owned local PostgreSQL 17 cluster:

```sh
python3 -B scripts/ci/test-satellite-qualifiers.py --root . --evidence /absolute/new/evidence-directory --pg-bin /absolute/postgresql-17/bin
python3 -B tests/operations/satellite-qualifier-results.test.py
```

There is no remote connection or existing database argument. The driver preserves the existing cancellation/deadline/cleanup implementation. Its result file is successful only after the actual SQL probes, exact output consumption, data/catalog rollback checks, source stability and cleanup pass.

The canonical schema is not duplicated. `financial-foundation-supplement.sql` is the exact suffix of the previously qualified `financial-fresh-0001/composed-foundation.sql` after the canonical MTT fixture prefix. `source-binding.json` binds the prefix, complete financial foundation, and every captured input. The composer refuses a changed or missing input and installs the captured current dependencies with owner, permission and catalog readbacks. These are real financial functions and tables, not payment stand-ins.

The fixture adds the captured current satellite successor, accounting/fee dependencies and entry-close terms. It retains the enabled survivor-ranking trigger and the actual disabled state of seven historical Stage-B guards. It does not qualify the separately proposed Stage-B activation, historical FIFO data, or every platform financial route. Private opening balances and accepted hand/causal witnesses are explicitly synthetic. Production is never touched.

The driver installs R46 preparation migrations `20260917060000` and `20260917061000`, followed by the version-3 satellite migration. It does not install the old unlimited-MTT migration or activate production. Native cases exercise the future contract inside the isolated fixture only. Current version-2 funded settlement is tested after the version-3 migration as a preservation control.

The cohort probe covers multiple equal qualifiers, a threshold overshoot with an actual eliminated ticket recipient, the distinct remainder recipient, target entry funding, replay, corrupted identity/standings, unresolved hand writers and causal candidates, plus authenticated own-result reads and permission refusals. Stock `isolationtester` observes two backend permutations behind the real financial lane; fixture-only removal of that lane must fail the exact wait proof. Race effects commit only in disposable private databases which are then dropped. They are not described as rolled back. The single-session probes prove full data/catalog rollback separately.

The completed manager-state and authenticated own-result readers also contend through the same financial lane before any receipt-header or tournament-row lock. Both manager commit and rollback releases are exercised. Two counterfactuals restore the exact original receipt body (MD5 `325ff2e2d0e588ccd6652ab7a1099a0b`) and must fail the advisory-lock assertion. All four reader cases compare complete data/catalog snapshots and prove the existing award remains unchanged; no reader may create a second payout. The current shared Execution owner imports the historical Free Buy module, so that code dependency is bound too; this satellite driver does not run the separate historical qualification.

The directly triggered existing accounting job must invoke this driver and retain its result/transcripts. Merely adding these files does not establish CI enforcement. Parent integration owns that job wiring; no new workflow or recurring observer is required.
