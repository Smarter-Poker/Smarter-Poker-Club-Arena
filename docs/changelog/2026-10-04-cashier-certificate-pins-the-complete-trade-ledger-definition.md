# Cashier certificate pins the complete trade-ledger definition

The production Cashier database certificate now pins the full
`pg_get_functiondef` fingerprint for `fn_club_trade_ledger`.

The function installed correctly and retained its ten-column result, metadata,
stable ordering, 251-row sentinel cap, ACLs, security-definer posture, search
path, lock timeout, OID, and dependent view. The first follow-up copied the
adjacent `md5(prosrc)` value from the native source-binding evidence instead of
the full-definition hash consumed by the production certificate. The canary
therefore rejected the correct installed function.

The same audit also corrected the stale body hash for the private
`fn_cashier_exact_intent_begin` helper. Its production body matches the final
native PostgreSQL evidence; the certificate had retained a pre-finalization
fingerprint.

Finally, the private-core checks now pin the two production successors that
were current when the launch migration retained them: the club-promo core and
the credit-reduction-safe agent-send core. Their older predecessor pins could
never certify the objects the migration actually preserved.

The corrected pin is backed by a source regression that forbids the body-only
hash from returning to this full-definition contract.
