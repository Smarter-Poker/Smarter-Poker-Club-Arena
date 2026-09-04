# tests/union-creation-is-an-allowlist.law.test.ts

Union creation is an allowlist (Dan 2026-09-04): `public.union_creators` plus `trg_union_creation_is_allowlisted` on `public.unions` is what refuses it - the API route runs as the service role and bypasses RLS, so hiding the page hides nothing; the uuid-taking check is service-role only and browsers ask `fn_can_i_create_a_union()` about themselves; `/unions/create` is guarded as a route; the menu, directory and rail ask first and fail closed; no person is named in the migration or the bundle.
