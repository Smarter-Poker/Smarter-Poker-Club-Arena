# Phase 3 — the definer surface: what was actually wrong, and what only looked wrong

2026-08-31. Supabase's advisor reported **852 security findings**. That number
is misleading in both directions, and the work of this phase was separating the
part that matters from the part that does not.

Result: **852 -> 732 lints, every `security_definer_view` ERROR cleared**, one
genuine information-disclosure hole closed, and — just as important — nothing
broken, because the money paths were left alone deliberately rather than by
accident.

## 1. A trigger function is not an API (173 functions)

342 functions in `public` return `trigger`; 175 carried EXECUTE for `anon`
and/or `authenticated`. A trigger function cannot be a legitimate RPC —
PostgREST does not expose functions returning `trigger` — so the grant bought
nothing and widened the surface for no benefit.

**The assumption that had to be tested first:** does trigger FIRING re-check
EXECUTE? If it did, revoking would have broken every trigger on the platform.
A rolled-back probe created a table, a trigger function and a trigger, revoked
ALL from PUBLIC, switched to the `authenticated` role, inserted a row — and the
trigger still fired and set its column. Tested, not remembered.

173 revoked. The other 2 (`checkauthtrigger`, `postgis_cache_bbox`) are owned by
`supabase_admin` and are not ours to re-permission — and the first run of the
migration **aborted on exactly that**, because a REVOKE issued by `postgres`
against a grant `postgres` never made is a silent no-op, not an error. The
post-apply assertion caught the shortfall and rolled the whole thing back. That
is what assertions are for.

**Verified live afterwards:** 163 `tables` rows stamped by their BEFORE UPDATE
trigger and all 58 new seats stamped with `club_id` by `fn_stamp_seat_club`,
after the revoke. Triggers fire.

## 2. The one real hole: fn_union_eco_adjustment

SECURITY DEFINER, takes a union id straight from the caller, and had **no
caller check of any kind** — no `auth.uid()`, no role test. It is `stable` and
writes nothing, so it could not move money, but it would hand any signed-in
player another union's economy figures. Zero call sites in either repo, so the
door is closed rather than fitted with a lock nobody uses.

## 3. Every view we own respects the caller

Three SECURITY DEFINER views, not two: the third (`v_spin_unfilled_waits`) was
created earlier the same day by another migration, which is exactly why the fix
sweeps every view we own instead of naming them. It carried three grants to
browser roles, so it read rows with the OWNER's rights on behalf of whoever
asked — the RLS bypass the advisor rates ERROR. All `security_definer_view`
errors are now clear.

## 4. What the remaining 568 warnings actually are

This is the part worth writing down, so nobody re-derives it.

565 browser-callable SECURITY DEFINER functions we own. **397 establish the
caller directly** (`auth.uid()` / `auth.role()` / JWT). Of the 168 that do not,
most are thin wrappers that delegate to one that does, and every high-risk
candidate was read individually:

- `promote_member` — looks alarming (takes `p_promoted_by` as a parameter) but
  delegates to `fn_club_set_member_role`, which sets `v_actor := auth.uid()`
  and only believes a caller-supplied actor for `service_role`.
- `ca_union_record_presettlement` — guarded by `ca_can_oversee_union`, raises 42501.
- `fn_save_leaderboard_reward_setup` — delegates to
  `fn_publish_leaderboard_reward_program`, which refuses a NULL `auth.uid()`.
- `increment_promotion_claim_count` — read-only despite the name.
- `recalculate_leaderboard_ranks` — writes, unguarded, but only recomputes
  `dense_rank()` from existing scores, so it cannot forge a position.

**Conclusion: the doors are exposed, and each has its own lock.** Revoking a
live RPC entry point to satisfy a lint would break the product to fix a
warning. The remaining warnings are hygiene, not a hole — but the two ERRORs
and the one unguarded reader were real, and those are fixed.

The last ERROR, `spatial_ref_sys` without RLS, is a PostGIS extension table
owned by `supabase_admin` holding public spatial-reference constants. Not ours,
no user data.

## Verification

- Advisor: 852 -> 732; `security_definer_view` 2 -> 0; anon-callable definers
  70 -> 22 (the remainder are deliberate pre-login lookups such as
  `check_username_available` and `fn_club_name_available`).
- Post-apply assertions proved BOTH halves: nothing we own is browser-callable
  as a trigger function, AND all 7 sampled money RPCs are still callable.
- Triggers verified firing in production after the change.
