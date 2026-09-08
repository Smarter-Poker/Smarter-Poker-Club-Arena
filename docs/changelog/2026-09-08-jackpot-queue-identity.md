# Queued Jackpots Preserve Their Operation Identity

A pending jackpot row carried its table, club and hand in both queue columns and its stored parameter object. The reader checked presence but never checked that the two agreed. A malformed or mismatched payload could therefore invoke a payout for another operation and close the original claim.

The reader now requires matching table/club identifiers and a valid positive safe-integer row hand number. A supplied payload hand number must match; legacy payloads without it still use the row value. Winner identities must be strings and distinct, roster entries must be nonempty strings, and the payout percentage must be finite and within range. Mini BBJ's intentionally zero Main-only percentage remains accepted; its existing tier requirement remains enforced.

Eleven actual-module regression cases reached the payout before correction. After correction, 112 tests across the queue, payout and real writer suites passed, as did server TypeScript. The Mini case now uses zero exactly as processMiniBBJPayout supplies it. A read-only production check found zero open jackpot claims and zero mismatched open identities, so no historical affected claim is asserted and no financial records were changed.

This closes the queue-reader validation gap. It does not certify the wider 216-requirement audit, recipient delivery persistence or engine deployment. The original source push/publish gates remain unchanged.
