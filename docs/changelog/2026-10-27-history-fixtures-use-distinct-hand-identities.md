# History fixtures retain distinct synthetic hand identities

The v3 equivalence fixture and sparse-context index fixture both used hand UUID
namespace 0004 for the same observer. Their combined accounting run failed on a
primary-key collision before reaching index qualification. The sparse fixture
now uses namespace 0005. Both datasets, all row counts, privacy canaries, context
comparisons and index-plan assertions remain unchanged. The existing real
PostgreSQL fixture reproduces the collision before this change and exercises the
combined datasets afterward. No production data or migration changes.
