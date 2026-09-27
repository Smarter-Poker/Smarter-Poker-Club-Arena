# Certification ledger actors are retired without deleting history

The post-deploy browser account cleanup attempted to delete an Auth user still
referenced by immutable `chip_ledger.performed_by` rows. The foreign key correctly
refused the deletion, so subsequent browser certification failed during account
provisioning before it could exercise the product.

The existing service-only cleanup now distinguishes an isolated reserved ledger
actor from a disposable identity. It verifies the original Auth email namespace,
matching ordinary profile and absence of financial custody or privileged roles
under row locks. It removes only the pre-existing designated SHARK admin fixture
membership when its chip and promotional balances are zero. It retains the Auth
UUID, profile, welcome diamonds, wallets and every immutable financial row.
The calling helper uses the supported Auth admin `should_soft_delete` operation,
then requires both the database completion predicate and Auth readback. Ordinary
non-ledger cleanup keeps its previous hard-delete behavior.

The stale-account query remains limited to the reserved post-deploy namespace,
accounts at least forty minutes old, and twenty accounts plus a refusal row. It
excludes retained identities only when the actual Auth deletion, empty credentials,
revoked sessions and absence of custody all agree. Both new helpers are service
only, have an empty search path and an eight-second statement timeout.

Database preparation and the Auth HTTP operation are separate transactions. A
concurrent authority or custody change in that gap must leave cleanup failed and
the fixture visible; it must never delete the new custody to manufacture success.
Existing stateless JWTs can remain usable until expiry. This change does not claim
immediate application-wide revocation and does not change application auth policy.
An unknown Auth response retains the local account record; the next invocation
reads durable completion before considering another Auth operation.

Native PostgreSQL 17 qualification loads the exact captured cleanup definition.
The original fails on the production actor foreign key; the new branch passes
service/anonymous/authenticated permissions, nullable role refusal, reserved-name
spoofing, financial custody, duplicate calls, freeze refusal, a two-session FK
insertion race, the prepare/Auth gap, partial Auth retirement, bounded inventory,
unchanged ledger/diamond checks, replay refusal and preimage drift rollback.
The local Auth transition models the official GoTrue transaction; it is not a
production HTTP test. Unit tests cover the supported request sequence, unknown
acknowledgement recovery, identity mismatch and incomplete readback. The native
fixture runs in the existing required PostgreSQL accounting shard, with input
routing and byte bindings retained alongside the repair.

The Auth API contract is documented in Supabase's `auth` repository:
`internal/api/admin.go` uses `should_soft_delete` in its admin delete transaction,
and its admin user GET loads the user by ID without excluding `deleted_at`.
`internal/models/user.go` preserves the UUID while clearing credentials, recording
`deleted_at` and logging the user out; `deleted_at` is exposed in the user JSON.
See https://supabase.com/docs/reference/javascript/auth-admin-deleteuser and
https://supabase.com/docs/guides/auth/managing-user-data for the supported operation
and the surviving JWT lifetime limitation.

Production installation, exact provider history and protected delivery are
separate acceptance steps. No fixture financial mutation or live synthetic
custody race is needed to qualify this repair.
