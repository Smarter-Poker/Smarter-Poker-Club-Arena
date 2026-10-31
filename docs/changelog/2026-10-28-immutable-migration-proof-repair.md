# Repair an immutable migration's malformed verification marker

PR #8486's default-branch migration-ledger audit failed on `20261028200033_v31_cell_build_uses_its_bounded_rpc_budget.sql`: its inline marker contains prose, which PostgreSQL rejects with SQLSTATE 42601. The installed migration itself is preserved byte for byte.

Extend the existing exact-SHA256 external-proof registry with a reviewed `replaces` list. Each item must match an actual inline marker in that exact immutable file. Empty, duplicate, missing, or drifted replacements refuse the audit. Only the named markers are replaced; all other inline proofs remain mandatory. Replacement proofs retain the existing validation and live-query verdicts, including unknown and false outcomes.

The V31 replacement verifies the complete current function definition, owner, ACL, SECURITY DEFINER, exact per-function timeouts/search path, execution grants and unchanged service-role 8-second default. This changes verification source only, with no migration replay, database mutation, function change or engine release.

Validation: the old reader rejects the new bound repair declaration; the corrected reader passes the retained law suite, including exact-byte drift, mismatched/duplicate replacement rejection and preservation of a second inline assertion. The replacement expression is also executed read-only against production.
