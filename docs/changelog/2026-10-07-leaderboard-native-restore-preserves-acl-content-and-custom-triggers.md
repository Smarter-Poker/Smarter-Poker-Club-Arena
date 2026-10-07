# Leaderboard Native Restore Preserves ACL Content And Custom Triggers

## Cause And Maintained Repair

Actual isolated authorization run 37594328579 stopped at the strict catalog guard,
before authorization or financial qualification. Its safe diagnostics identified
ACL differences, one absent trigger and separate definition-text differences.
Native PostgreSQL 17 control fixtures reproduce grant-array reordering during
dump/restore and omission of custom triggers attached to extension-member tables.

The catalog compares sorted complete ACL items. Grantors, grant options,
duplicates and NULL-versus-empty distinctions remain exact. It does not replace
stored grants with defaults or omit security fields.

The existing restore captures custom extension-table triggers read-only before
and after export, refuses drift, and inserts their exact native definitions and
enabled state inside the same disposable restore transaction. An existing
differing trigger is refused, never replaced. The source database is not changed.
The native regression runs in accounting shard four and proves omission,
restoration, mismatch rollback and stopped-server cleanup.

Bounded diagnostics retain opaque identity and definition hashes and character
lengths, never private definitions or raw catalog data. Definition equality and
all original catalog/security checks remain mandatory.

## Verification Boundary

Focused source contracts and actual native control fixtures pass locally. These
controls do not qualify the complete current schema, actual authorization,
payouts, installation or publication. The separate view, constraint and trigger
definition differences remain unresolved until the corrected owning run provides
evidence. No production financial behavior, history, grants or schema is changed
by this tooling repair.

The normal pre-push check reproduced a connected local fixture-isolation defect:
the non-Git provenance fixture discovered the enclosing SSD worktree because
TMPDIR is task-owned inside it. Fixture-only Git discovery now stops at the
scratch parent. Production provenance behavior and every unknown-value assertion
remain unchanged; initialized fixture repositories retain their own Git identity.
