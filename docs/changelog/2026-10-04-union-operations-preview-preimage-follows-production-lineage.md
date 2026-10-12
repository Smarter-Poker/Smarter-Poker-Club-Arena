# Union Operations Preview Preimage Follows Production Lineage

## Change 1 - Bind The Migration To The Installed Preview

**File:** `supabase/migrations/20261004173704_union_ops_risk_and_preview_stay_inside_the_request_budget.sql`

**What Existed:** The unrecorded migration guarded the settlement-preview reader with fixture MD5 `67d01730fd29d53ba0c04fd2d2637c31`. Its first protected production apply refused with `UNION_SETTLEMENT_PREVIEW_PREIMAGE_CHANGED` and rolled the entire transaction back. Durable readback showed the installed definition remained `74919720de9fafe281e48f5d8bbd6572`, the same fingerprint already recorded in the maintained September 8 live RPC register.

**What Changed:** The fail-closed guard now accepts only the recorded and freshly read installed definition fingerprint and separately pins the installed function-body fingerprint. The optimized postimage preserves the installed engine-or-overseer authorization rule; owner, volatility, configuration, grants, indexes, and the one-transaction installation contract remain unchanged.

**Why:** The fixture had manually simplified the captured preview body. It omitted the live engine-or-overseer authorization expression, two retained Round comments, and the outer arena-name fallback. The migration correctly refused that inaccurate model; the correction makes the test predecessor byte-identical to production instead of weakening the guard.

**Verified:** YES. The exact source-bound PostgreSQL 17 fixture accepted definition MD5 `74919720de9fafe281e48f5d8bbd6572` and body MD5 `dc8328ed8286b5b48ba24db229c814d0` as the predecessor, produced hardened postimage MD5 `2ed8a11aa32de0f20a979c59244c946d`, and completed the production-scale Preview case in 96 ms under the eight-second request budget.

**TypeScript:** PASS from the unchanged merged client candidate; this recovery changes SQL, its SQL fixture, source binding, and documentation only.

## Change 2 - Reproduce The Exact Production Predecessor

**File:** `tests/fixtures/union-ops-financial-admin/bootstrap.sql`

**What Existed:** The fixture reproduced the preview's query semantics but not its exact catalog bytes, so it generated MD5 `67d01730fd29d53ba0c04fd2d2637c31` and could not catch the bad production anchor before merge.

**What Changed:** The fixture now preserves the captured production authorization guard, Round labels, and arena-name fallback. Its resulting `pg_get_functiondef` must match production fingerprint `74919720de9fafe281e48f5d8bbd6572` before the candidate migration can run.

**Why:** A production-lineage migration must be qualified from the actual installed predecessor, including security and catalog-visible source bytes, not a semantically similar retype.

**Verified:** YES. The fixture's catalog-visible body is 5,552 bytes with MD5 `dc8328ed8286b5b48ba24db229c814d0`, matching the maintained production inventory. Source binding verifies the exact fixture bytes before PostgreSQL starts.

**TypeScript:** PASS from the unchanged merged client candidate; no TypeScript source changed.

## Change 3 - Keep Anonymous Callers Out Of The Optimized Preview

**File:** `supabase/migrations/20261004173704_union_ops_risk_and_preview_stay_inside_the_request_budget.sql`, `tests/fixtures/union-ops-financial-admin/assertions.sql`

**What Existed:** The optimized postimage used `auth.uid() IS NOT NULL AND NOT fn_is_union_overseer(...)`. With a null user ID, that condition was false, so a direct non-engine caller with execute privilege could pass the in-function authorization guard. The installed predecessor instead permits only an engine caller or an authenticated union overseer.

**What Changed:** The optimized preview now retains the exact engine-or-overseer rule. Its postimage guard requires both `fn_caller_is_engine()` and the null-user refusal expression. The maintained PostgreSQL fixture proves that a null-user non-engine call raises `not_authorised`, an engine call succeeds, a different union overseer is refused, and the authorized union owner still receives the exact same preview values.

**Why:** Query optimization cannot weaken a security-definer function's authorization contract. ACL checks alone are not a substitute for the union-scoped guard because both `authenticated` and `service_role` intentionally retain execute permission.

**Verified:** YES. The exact PostgreSQL 17 run passed least-privilege ACLs, union scoping, null-user refusal, engine access, result parity, Risk at 801 ms for one million six-key rows plus 300,000 flows, and Preview at 96 ms for 2.2 million commission rows. Terminal marker: `union_ops_financial_admin_pg17_ok`.

**TypeScript:** PASS from the unchanged merged client candidate; no TypeScript source changed.
