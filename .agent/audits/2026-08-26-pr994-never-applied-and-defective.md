# PR #994 was never applied, and would have been wrong if it had been

Date: 2026-08-26
Author: Cowork session, at Dan's instruction to verify another agent's report

## Summary

An agent reported the Club Arena time-bank work "updated, pushed, published to
production, and fully optimized". The code half of that was broadly true.
Underneath it, five SECURITY DEFINER economy functions were callable by any
logged-in user with no identity check, and had been all day.

## What was found

PR #994, `fix(db): add auth.uid() guards to 5 dangerous economy functions`,
merged to `main` at 09:04 on 2026-08-26. The migration file landed in the repo.
**Club Arena is a Vite SPA; nothing in its deploy pipeline runs migrations.**
Merging that PR published a text file and nothing else.

Verified against production the same day:

| function | guard present | `authenticated` had EXECUTE |
| --- | --- | --- |
| `add_diamonds_to_balance` | no | yes |
| `fn_purchase_chips` | no | yes |
| `fn_purchase_club_chips` | no | yes |
| `fn_pay_player_chips` | no | yes |
| `fn_bbj_promo_payout_atomic` | no | yes |

`fn_pay_player_chips(p_user_id uuid, p_amount numeric, ...)` is SECURITY
DEFINER, takes an arbitrary user id and amount, and contained no identity
check. Any authenticated user could call it over PostgREST and pay themselves.

Widening the search: **17 money-named SECURITY DEFINER functions in `public`
were executable by `authenticated` and never referenced `auth.uid()`.**

## #994 could not have been applied as written

1. Its `fn_bbj_promo_payout_atomic` block declares a 3-arg signature
   (`p_amount, p_event_type, p_reason`). The live function is 5-arg
   (`p_pool_id, p_amount, p_recipient_user_ids, p_reason, p_event_type`). It is
   not a replacement; it is a new function that ignores the caller's recipient
   list and credits every `status = 'eligible'` row in `promo_eligibility`.
2. Its last line GRANTs EXECUTE to `authenticated` on the **5-arg** signature,
   which it never guards. Net effect for that function: hole re-opened, stray
   mass-payout overload created.
3. Its `fn_pay_player_chips` and `fn_purchase_club_chips` bodies are shorter
   than the live definitions (1702 vs 1795, 2640 vs 2991 chars), so
   `CREATE OR REPLACE` would have silently dropped live logic.

## What was done

`20260826150000_revoke_authenticated_execute_on_five_economy_functions.sql`,
applied to production via Supabase MCP. It **only revokes** EXECUTE from
`authenticated`, `anon` and `PUBLIC` on all five. It replaces no bodies, so it
cannot regress live logic, and it carries a pasted ROLLBACK.

Call-site check performed first: `add_diamonds_to_balance` has ~30 call sites,
all in World Hub `pages/api/**` using `SUPABASE_SERVICE_ROLE_KEY`, which a
revoke on `authenticated` does not touch. The other four have zero call sites in
either repo. Comments in `pages/api/club-arena/purchase-chips.js` and
`src/pages/marketplace/marketplaceShared.ts` already assert EXECUTE "is revoked"
on these, so a later DROP/CREATE had reset the privileges. Post-apply state:
all five deny `authenticated` and `anon`; `service_role` retains EXECUTE on
`add_diamonds_to_balance`.

`20260826140045_fix_economy_auth_guards.sql` was neutralised in place with a
`RAISE EXCEPTION` so it cannot be applied by a later agent. Original content is
in git history at `5ca221eecd632be8c72365e6f4341ad43d948c2a`.

## Still open

- **The in-body `auth.uid()` guards.** Build each from live
  `pg_get_functiondef` output with the guard injected after `BEGIN`. Never from
  #994.
- **The other 12 exposed money functions**, including `fn_apply_credit_payment`,
  `fn_generate_credit_invoice`, `fn_generate_all_credit_invoices` and
  `fn_credit_stalled_seat_first_stacks`.
- **`fn_unaccounted_seat_exits()` returns live rows.** Two seat exits on
  2026-08-26 destroyed 85.85 and 45.00 chips (09:38 and 12:55 UTC, both
  PostgREST, SHARK CLUB). The detector added after the 2026-08-25 incident is
  firing and nobody had read it.
- **`profiles` RLS is `authenticated USING (true)` across 114 columns**, so any
  registered player can read every member's `kyc_status`, `birthday` and
  `diamonds`. Separately, an untracked `grant_anon.sql` in the World Hub tree
  had granted `anon` column SELECT on 105 of those columns; those grants ARE
  applied, and are currently inert only because no `anon` SELECT policy exists.
  One permissive policy turns that into a full PII leak.

## The rule this is evidence for

A migration file in a repository is not a database change. "Merged" is not
"applied". Verification for anything touching Supabase is a query against
production, not a green PR.
