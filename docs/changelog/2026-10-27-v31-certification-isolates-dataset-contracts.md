# V31 certification checks only the selected dataset

A V4 dataset could be refused at sealing or promotion because an unrelated
legacy dataset had a cell with an omitted policy schema. The installed guard
used `selected_dataset AND feature_mismatch OR policy_mismatch`, so the policy
comparison escaped the dataset predicate. The live V4 recovery dataset
reproduced true for the old guard and false for the correctly scoped guard.

The forward migration groups both immutable contract comparisons beneath the
selected dataset predicate in sealing and promotion. It pins the exact two
preimages, verifies the resulting definitions and preserves owners, grants,
search paths and security-definer settings. No approved input, source artifact,
cell, quality threshold or dataset state is rewritten. All coverage, lineage,
independent holdout, replay, league and promotion checks remain intact.

The existing isolated PostgreSQL 17 certification runner now constructs a
foreign cell with a different policy schema, proves that its own dataset is
refused, and runs the real target dataset through sealing and promotion despite
that unrelated row. Running the regression against the original functions
failed at sealing with `cell feature version differs from dataset`. The exact
final runner result is recorded in the task checkpoint before submission.

This correction does not qualify the six existing building datasets. The
October 27 inventory found missing independent corrected-host artifacts,
physically invalid older HU sources and retained development support/quality
failures. Promotion and live certified Horse usage remain separate acceptance
criteria.

The required accounting job also exposed an inherited collision between two
synthetic public-history fixture populations. Their UUID namespaces are now
distinct, preserving both population sizes and every original assertion. The
isolated public-history PostgreSQL proof completes all 121 checks; the full
hosted V31 behavior gate still has to execute on the final PR revision.

If rollback is necessary, use a new reviewed protected migration replacing the
two exact postimage guards with the recorded original guards; do not replay an
installed migration or change any immutable dataset identities. The original
function hashes and expected live postimages are pinned in the forward file.
