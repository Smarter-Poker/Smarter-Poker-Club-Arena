# Postflop migration live proof is a boolean expression

The unapplied interrupted-postflop migration declared a standalone SELECT with an alias and semicolon in its live-proof header. The existing ledger reader embeds that declaration as a scalar expression, so PostgreSQL rejected the proof with a syntax error.

Correct only the header; the entire BEGIN/COMMIT transaction and exact function postimage remain unchanged. The existing required F06 native qualifier now executes the actual declared header in the maintained reader UNION wrapper alongside another valid proof. With the old header this regression fails at the semicolon; with the corrected header it returns true for both rows. No ledger-reader tolerance, assertion, production record or historical qualification receipt is changed.

Migration installation remains a separate protected-main operation after both original-controller and played-clock-floor prerequisites are installed and verified. This change neither installs a migration nor replaces the engine.
