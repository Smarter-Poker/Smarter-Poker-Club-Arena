# Retention proof uses its existing required owner

The required actions-only PostgreSQL driver now unconditionally runs the retention-progress driver before reporting success. Both retain their existing assertions and cleanup; child failure fails the parent. Nested progress evidence is included in the existing parent artifact. This avoids adding a second workflow step and its shared workflow fingerprints. No financial SQL or production behavior changed.
