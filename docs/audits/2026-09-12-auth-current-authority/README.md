# G8 current Auth authority baseline 0094

Five current routine sources, prepared for independent review and future isolated fixture composition. This is a NEW catalogue-derived source baseline, not a claim that unrecovered historical migrations were found. No migration version is assigned. No activation or fixture application has occurred.

## Exact source contract

One bounded metadata SELECT captured these five definitions together at 2026-09-12 10:37:51.399106+00 from project kuklfnapbkmacvwxktbh. catalogue-query.sql is the exact read-only query. catalogue.json contains complete pg_get_functiondef, identity arguments, owner, configuration, raw ACL, security-definer, volatility, parallelism, strictness, leakproof and result type, plus effective EXECUTE/schema-USAGE for six relevant roles. No role password, token, user row or pg_authid was requested.

Each of the five named .sql files contains the exact pg_get_functiondef string plus only a final semicolon/newline statement terminator. SOURCE-MAP.json separately pins definition SHA256, complete file SHA256 and prosrc MD5. All five complete definitions match the prior 0091 capture byte for byte. No body normalization or behavioral rewrite was made.

These files are routine definitions ONLY: CREATE OR REPLACE does not establish the recorded owner or ACL. In a fresh fixture default PUBLIC execute may otherwise be granted; in an existing fixture prior ACLs persist. Therefore do not expose/use restored routines until Pipeline has separately composed and verified the exact effective authority from catalogue.json. This packet supplies no role/grant SQL and changes no grants.

## Historical comparison and honest limits

Protected comparison ref fa2cda1465be83a4b7b64be276fc2fc50d701a35. Reuse immutable 0091 SOURCE-MAP/authority evidence and 0086 catalogue evidence; neither was modified.

- fn_guard_profile_privileged_columns: current ea0e1846a0f6f6459eea336fbab0dc48. Protected September 8 catalogue/V8 body 9fc74ae3c14581296098e0cb2877baa5 plus the exact protected 20260910181625 boost patch explains one added allowance. Four current allowances remain historically unrecovered: fn_wheel_free_spin, fn_plinko_drop, fn_crash_start, fn_wheel_spin_core. This baseline preserves all current lines, rather than inventing their old migration.
- fn_join_club: current 58ceec3c4db67dffb8a7798459d0fa5b matches the protected September 8 catalogue. Protected 20260906091646 wrapper differs only in departed-membership rejoin limit 4 versus current 10 and corresponding message. The historical two-line edit remains unrecovered.
- fn_sync_mfa_required_on_club_role: current c25251b2e4f7929d38f4c3c80d34b31c matches protected catalogue; 20260831235996 includes the generic co_owner patch, but its original defining migration remains unrecovered.
- fn_sync_mfa_required_on_role_change: current 14c12589ddbaad544af6653847d7b666 matches protected catalogue; executable historical definition origin remains unrecovered.
- handle_new_user_v2_create_wallet: current 8965de467c9b1832823613e245dc7da1 matches protected catalogue. The original 20260429o migration logs a warning; the source origin of current nested signup_errors handling remains unrecovered.

The recovered exact handle_new_user chain is already in 0091 and intentionally not duplicated here. The candidate pre-request hook is NOT part of this baseline: its exact PR4037 source origin and later protected evolution remain owned by G8/Pipeline. No wallet money guard or financial helper is added.

## Deterministic isolated composition order

Prerequisite: independent acceptance of this new baseline, followed by Pipeline's established fixture composer. Pin the incoming fixture revision, existing object preimages and all five file hashes. Fail before making the fixture usable if any prerequisite is absent, divergent or not qualified. Do not fill missing dependencies with stubs or broaden privileges.

1. Establish existing canonical schemas, GoTrue-managed Auth structures, application relation row types/constraints and effective roles through Pipeline's owned foundation. SOURCE-MAP.json lists only direct dependencies actually observed in these bodies; it does not certify their transitive graphs or supply them.
2. Establish public.fn_is_service_context(), auth.uid(), and public.fn_join_club_membership_impl(uuid) from their independently qualified sources. Presence/name alone is insufficient. Preserve their existing role/security semantics.
3. Restore fn_guard_profile_privileged_columns, then fn_sync_mfa_required_on_role_change, then fn_sync_mfa_required_on_club_role, then handle_new_user_v2_create_wallet, then fn_join_club. This is a deterministic packaging order following profile guards before membership/seed entrypoints; it is not a claim that all five have direct SQL call dependencies on one another.
4. Read back complete function definitions, owner/configuration/ACL and effective role privileges after Pipeline's composition. Preserve the existing canonical trigger bindings and enabled states from 0086. Do not create or alter trigger bindings from guesses. Trigger invocation must be evaluated in its actual enclosing security context, not equated with permission to call a trigger routine directly.
5. Only after prerequisite and metadata parity passes may Pipeline use its existing isolated native runner to verify actual signup/profile/wallet/MFA/membership outcomes. These routines can swallow signup errors; Auth success alone is insufficient. No new test suite or fixture execution is provided here.

All owners are postgres. fn_join_club and handle_new_user_v2_create_wallet are SECURITY DEFINER; the three other routines are invoker-security. All six queried roles have public-schema USAGE. Only postgres/service_role have direct EXECUTE on the four trigger routines; authenticated additionally has EXECUTE on fn_join_club. Production postgres is non-superuser with BYPASSRLS; a local superuser owner cannot by itself establish production-equivalent privilege proof. Direct privilege observations are not a guarantee that downstream relation/RLS checks pass.

## Remaining gates

Independent baseline acceptance; Pipeline's protected recording; exact effective-role/owner/ACL composition; consumed downstream dependency qualification and actual native results. Unknown dependencies remain fail-closed. The source packet is complete, but neither historical-source recovery nor whole-fixture/funded-route certification is claimed.

No production mutation, fixture/shared source edit, role/grant change, broad helper audit, dependency install, copied source tree, outgoing tool or native execution occurred.
