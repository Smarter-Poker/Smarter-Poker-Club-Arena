# Current production preimages — fixture source only

These overlays compose the September 17 installed Alerts authority with Union37. They are **UNRUN**, are not production migrations, and do not establish installation or delivery. The original full-schema capture, correction captures, bootstrap files and standalone Alerts tests remain unchanged.

Load both files once per fresh full-schema cluster, **after every retained catalog/dependency bootstrap and before any legacy financial producer, negative-fixture mutation, or candidate component**:

1. `alerts-and-ledger.sql` requires the exact original bridge/raiser definitions and ACLs, replaces only those fixture definitions with the exact accepted current images, and creates the actual additional ledger index.
2. `owner-notification-coexistence.sql` supplies only the actual dependency closure needed by the current owner routing predicate and BEFORE capture: four functions, the two inbox/destination tables, their indexes/constraints/ACLs and identity sequence, plus the two current notification triggers. It preserves the existing deferred accounting constraint trigger and mirror function.

The parent owns runner registration and source-binding updates. This directory must not enter the production activation bundle. Component34 now demands the exact installed bridge hash; component36 demands the exact installed 21-argument raiser hash and ledger-index inventory. No old/new hash alternatives were added and neither Alerts business function is replaced by Union37.

## Actual provenance

`captured-authority.json` retains metadata-only results and exact query path/hash provenance from project `kuklfnapbkmacvwxktbh`. Every successful capture ran inside REPEATABLE READ READ ONLY with 10-second statement and 2-second lock timeouts, ending in ROLLBACK. No production user rows or business functions were read/invoked. Parent outputs retain raw tool responses and queries under `outputs/union-provider-preflight-20260917`. The sequence maximum is explicitly captured as text in capture16 because numeric JSON transport lost precision in capture15.

The two Alerts definitions match byte for byte the accepted `post` images of installed migration `20260917024440`, maintained in `supabase/components/production-alert-identity-and-rake-wording.sql` (SHA256 `6622531f15dc53dc532dcba4d7441f5907be06be62decca528baf8d94a235710`). The bridge preserves exact failed-leave table/hand identity and handles malformed table IDs safely. The raiser preserves the corrected detector-storm explanation. The later rake-wording escalator is neither changed nor required by these two overlays.

The ledger index is exactly `idx_chip_ledger_tournament_category`, a nonunique B-tree on `(tournament_id, category)` where tournament_id is nonnull. This is current metadata, not a new financial rule.

## Historical fixture omissions

The original schema already creates `operational_alert_events_id_seq` but omits its inbox table, identity dependency, recorder function and owner destination closure. The owner overlay refuses anything except that unused, unattached, owner-only PostgreSQL17 fixture sequence with the exact original sequence parameters. It removes that known orphan with RESTRICT and recreates the real identity-owned sequence as part of the captured table. It refuses preexisting tables, indexes and function names, and verifies the complete two-table shape, exact function definitions/access, sequence dependency/access and notification triggers before commit. This is isolated fixture restoration; no production sequence is dropped or adopted.

The original schema's generic notification trigger is unconditional. Current production instead has `WHEN NOT fn_is_owner_operational_notification(...)` plus `zz_capture_owner_notification_destination BEFORE INSERT`. The captured predicate excludes both accounting invoice types; the BEFORE function returns NEW unchanged. The existing mirror's TG_NAME branch defers accounting invoices until the genuine delivery link exists. These source facts do not replace a native producer/delivery/replay test.

## Qualification limits

The overlays do not add the personal feed view, administrative reader/retry routes, background jobs or any financial producer stub. They include the exact recorder dependency actually called by the BEFORE trigger, so a producer can exercise both preserved Alerts capture and genuine accounting delivery in the full-schema fixture. Native execution, failure rollback, owner and ordinary-recipient genuine invoice cases, authenticated APIs and provider/device delivery remain separate required evidence. Existing native suites must run against these overlays; source preparation is not a passing test result.
