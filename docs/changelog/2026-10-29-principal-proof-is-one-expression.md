# Run the existing principal proof as one expression

The migration-ledger check embeds each declared proof inside its own SELECT. The legacy postflop migration supplied a complete SELECT with an output alias and semicolon, so PostgreSQL refused the audit with SQLSTATE 42601.

The existing external proof registry now replaces that exact malformed declaration with its original MD5 comparison as one boolean expression. The entry binds the complete original migration SHA256 and exact original marker. The migration SQL, function hash, financial safeguards, installation prerequisites, 24-hour grace and fail-closed audit remain unchanged. No migration is installed or replayed by this change.

Regression protection verifies the exact predicate, byte binding and refusal of changed bytes or mismatched markers. The new regression fails before the entry and passes afterward; the actual protected-main ledger result is recorded separately.
