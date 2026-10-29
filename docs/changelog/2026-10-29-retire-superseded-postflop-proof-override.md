# Retire the superseded postflop proof override

PR #8526 corrected the migration’s inline boolean proof on protected main before #8532 merged. The older exact-byte external syntax override correctly refused those changed bytes, causing the main ledger report to fail. Remove only that obsolete override and qualify the corrected inline predicate through the maintained reader. The desired e416 postimage remains unchanged; no SQL migration or live database state changes.

The existing regression reproduced the byte mismatch before the correction and now requires the corrected inline declaration, absence of the obsolete override, and the original desired postimage.
