# REVIEWER 2 - Lanes C and D, and the World Hub

Scope: `add_diamonds_to_balance`, `deduct_diamonds`, `fn_ca_journal_profile_deletion`,
`fn_ca_journal_append_only`, `ca_diamond_journal_archive`,
`settle_diamond_card_purchase_atomic`, `reconcile_diamond_purchase_refund`,
`fn_diamond_purchase_dispute`, `diamond_packages`, `diamond_purchase_lots`,
`diamond_debts`, `diamond_purchase_disputes`, the unique indexes on
`diamond_purchases`, `stripe_webhook_events`, and the World Hub publish state.

Production: Supabase `kuklfnapbkmacvwxktbh`. Read-only pass, 2026-09-07 ~21:30 UTC.
No probe was executed: every claim below is a `SELECT`, a `git` read or an HTTP fetch.
Anything not established that way is labelled UNVERIFIED.

---

## 1. DEFECT TABLE

| id    | object                                            | sev                 | what is wrong                                                                                                                                                                                                                                                                                                                                                                                                    | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | exact proposed fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-01 | club-arena repo / lanes A, B, D, E, G             | CRITICAL            | Ten diamond migrations are APPLIED IN PRODUCTION but exist nowhere on `origin/main`. Only lane C landed. The production schema cannot be rebuilt from the repo, and the next agent reading `main` will believe lane D was never built.                                                                                                                                                                           | `schema_migrations` holds `20260903002248` (diamond*b), `002333` (diamond_b), `002841` (diamond_e), `003036` (diamond_a), `003128` (diamond_g), `003327` (diamond_d_purchase_clearing), `003403` (diamond_d_the_balance_cannot_go_negative), `003714` (diamond_g), `004002` (diamond_a), `010547` (diamond_p3). `git ls-tree -r --name-only origin/main -- supabase/migrations \| grep -i diamond` on club-arena returns, of the 09-03 set, only `20260903000735_diamond_std_foundation.sql` and `20260903031500_diamond_c*...sql`. GitHub API: PRs #2748 (B), #2750 (A), #2751 (D), #2745 (E), #2752 (G), #2756 (consolidated) and #2827 are all `state=closed, merged_at=null`; only #2744 (lane C) has `merged_at=2026-09-03T00:42:38Z`. `docs/changelog/2026-09-03-diamond-d-purchase.md`is MISSING from`origin/main`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | In `/Users/smarter.poker/Documents/.agent-trees/club-arena/diamond-reland` (branch `fix/diamond-p2-lanes-reland`, 15 commits ahead, `git branch -r --contains HEAD` is EMPTY so the tip is on no remote): commit the 4 modified and 5 untracked files (`docs/LAWS.md`, `scripts/ci/schema-manifest.d/diamond-{a,d,e}.json`, the five new `docs/laws.d/tests-law-Diamond*.md`), `git merge origin/main` (never rebase, section 12), then push a NEW branch off current `main` per section 10.82 and let `agent-open-pr.yml` + autopilot land it. Do not reuse the closed branches: their PRs are closed and a push to them lands nowhere.                                                                                           |
| R2-02 | `award_diamonds_v2`                               | HIGH                | Regression landed TODAY. The live body no longer writes `counterparty` or `issuance_class` at all, so every Diamond Rewards v2 award since 2026-09-07 05:00 UTC is an anonymous journal row. This is the exact DR1/"a diamond cannot move anonymously" violation lane C and `20260902040849` were written to end.                                                                                                | `prosrc like '%issuance_class%'` = false and `like '%counterparty%'` = false on the live `award_diamonds_v2(uuid,text,text,text,jsonb)`; its `INSERT INTO public.diamond_transactions` names only `(user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata, created_at)`. Rows with `description like 'Diamond Rewards v2%'`: 09-03 promotional 2, 09-04 promotional 3, 09-05 promotional 3, 09-06 promotional 5, **09-07 NULL 3**. The only migration matching `create or replace function public.award_diamonds_v2` is `20260907025144_award_diamonds_v2_serialized_family_caps` (file header `20260907005900_...`), and it does not contain the string `issuance_class`; its own comment says it was rebuilt from the `20260806120000` lineage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Re-add `counterparty` and `issuance_class` to that INSERT with the derivation the 09-03..09-06 rows carried (`'promotional'`, `'promo_budget:catalog_v2'`), in one migration produced by `node scripts/new-migration.mjs`, and backfill the three rows: `41ecf404-3d60-47df-b71a-5ac2e9f1dcb1`, `0aeff579-2ca6-4bcd-b192-0563d7c5f5d3`, `8802562f-fcbe-4c5b-8f8c-198fc4478304`. Add a `NOT NULL` (or a law test) on the two columns so the next rebuild-from-an-old-copy fails loudly instead of silently.                                                                                                                                                                                                                         |
| R2-03 | `fn_ca_journal_append_only` + `delete-account.js` | HIGH                | A player who has ever earned a diamond CANNOT delete their account. `diamond_transactions` cascades from `profiles`, the cascade fires the append-only trigger, and with `app.ledger_maintenance` unset the trigger raises P0403, which aborts the `DELETE FROM profiles`. The route then returns 500 "Your profile could not be removed". GDPR erasure is blocked and the failure is only visible as a 500.     | `pg_get_constraintdef`: `fk_diamond_transactions_user_id_profiles FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`. `trg_ca_append_only BEFORE DELETE OR UPDATE ON public.diamond_transactions` is enabled (`tgenabled='O'`). Live `fn_ca_journal_append_only` falls through to `RAISE EXCEPTION ... USING ERRCODE='P0403'` whenever `v_reason IS NULL`. The only BEFORE DELETE trigger on `profiles` is `trg_ca_profile_deletion_journal`, whose function contains no `set_config`. WH `origin/main:pages/api/auth/delete-account.js` line 213 deletes `diamond_transactions` and line 237 deletes `profiles`; `grep 'ledger_maintenance\|\.rpc(\|retire'` returns nothing. That route is unchanged since 2026-08-31 (#1139). Corroboration: `ca_diamond_journal_archive` rows with `deletion_reason IS NULL` = **0** of 14,173, and all 717 `DR5:deleted_with_balance` incidents carry `certification-cleanup` (699) or `test-account-sweep` (18) - no un-reasoned profile deletion has ever completed. No `retire_profile`-style function exists (`pg_proc` has only `fn_ca_retire_certification_club`, `fn_club_retirement_impact`, `fn_guard_retired_club_mutation`, `fn_reject_retired_solver_option_rpc_ddl`, `fn_retire_settled_club`, `retire_duplicate_poker_venue`). | Add `public.fn_retire_profile_for_deletion(p_user_id uuid)` SECURITY DEFINER that (1) `PERFORM set_config('app.ledger_maintenance', 'account-deletion:'\|\|p_user_id::text, true)`, (2) deletes the player's `diamond_transactions` (archive + DR5 row are then written by the existing trigger), (3) deletes the `profiles` row, all in one transaction, and grants EXECUTE to `service_role` only. Replace lines 213 and 237 of `delete-account.js` with one `.rpc('fn_retire_profile_for_deletion', { p_user_id: userId })` whose error keeps the existing "deletion was stopped before your login was destroyed" 500 path. Ship a WH `__tests__` law that the route contains no bare `.from('diamond_transactions').delete()`. |
| R2-04 | migration `20260906210000`                        | MEDIUM              | The migration that put the idempotency binding into the live `deduct_diamonds` was recorded with **zero statements**, and its file is not on `origin/main`. The live body is unreproducible from history.                                                                                                                                                                                                        | `select coalesce(array_length(statements,1),0) from supabase_migrations.schema_migrations where version='20260906210000'` returns `0`, `statements` text is NULL. `git ls-tree -r --name-only origin/main -- supabase/migrations \| grep 20260906210000` on club-arena: MISSING. The live `deduct_diamonds` prosrc contains `idempotency_conflict`, a string that appears in NO migration in `schema_migrations`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Land the file `20260906210000_deduct_diamonds_idempotency_binding.sql` on `main` with the exact SQL that produced the live body (recover it from `pg_get_functiondef`), and open an issue on whatever apply path records a migration with no statements: a migration row with an empty `statements` array is a hole in the audit trail, not a cosmetic problem.                                                                                                                                                                                                                                                                                                                                                                    |
| R2-05 | `ca_diamond_incidents` / DR5 volume               | MEDIUM              | `DR5:journal_row_deleted_under_maintenance` is 14,174 of 18,046 incidents (78.5%), all unresolved, growing ~2,800/day (~1.0M/year). It buries the findings that matter: 38 unresolved `DR11:trial_balance_break` warnings, 1,556 `DR6:balance_changed_without_journal`, 1,341 `DR2:balance_born_outside_the_mint`.                                                                                               | Per-day counts 2026-09-03..07: 2959, 3432, 2735, 2843, 2205. Incident table by rule: DR5 maintenance 14,174 (info, 14,174 unresolved), DR6 1,556, DR2 1,341, DR5 deleted_with_balance 718, DR11 summary 118, DR10 mirror_mismatch 94, DR11 break 39 (38 unresolved). `pg_total_relation_size('ca_diamond_incidents')` = 8872 kB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | See section 4 for the recommendation in full. Short form: keep archiving every row, but for a `v_reason` matching `^certification-cleanup:` raise ONE rolled-up incident per maintenance batch (key on the reason string, `occurrences` counted the way `fn_ca_raise_drift_incident` already does) instead of one per row. Storage is not the problem; the signal is.                                                                                                                                                                                                                                                                                                                                                              |
| R2-06 | `diamond_purchase_lots`                           | MEDIUM              | The two completed real purchases have no lot row, so a refund or a chargeback on either would reverse the balance and update ZERO lots. `diamond_purchase_lots` is empty.                                                                                                                                                                                                                                        | `select count(*) from diamond_purchase_lots` = 0 while `diamond_purchases` holds 3 rows: `fe35f19d-686d-441b-b170-39e6fb97ee96` (completed, 100 diamonds, $1.00, 2026-02-12) and `b82a2fe0-b19e-41ff-b3b1-52394bb3e115` (completed, 100 diamonds, $1.00, 2026-02-12), both `lots=0`; `beb4725e-...` is still `pending`. Lane D's lot insert lives in `settle_diamond_card_purchase_atomic`, which ran for those two in February, long before the lot table existed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | One backfill migration: `INSERT INTO diamond_purchase_lots (user_id, purchase_id, issued, settled_at) SELECT user_id, id, COALESCE(diamonds_amount,0)+COALESCE(bonus_diamonds,0), completed_at FROM diamond_purchases WHERE status='completed' ON CONFLICT (purchase_id) DO NOTHING;` with a `DO $$ ... RAISE EXCEPTION` assertion that exactly 2 rows were created.                                                                                                                                                                                                                                                                                                                                                               |
| R2-07 | `ca_diamond_journal_archive`                      | MEDIUM              | For a maintenance delete the archive sets `deleted_profile_id = user_id` even though no profile was deleted. Every one of the 14,173 rows therefore claims a profile deletion that did not happen, and the column cannot be used to answer "which rows left with an account".                                                                                                                                    | Live `fn_ca_journal_append_only`: `... v_j->>'counterparty', v_j->>'issuance_class', (v_j->>'user_id')::uuid, v_reason)` - the second-to-last value is `deleted_profile_id`. All 14,173 archive rows have `deletion_reason IS NOT NULL` (a maintenance delete) and `deleted_profile_id` non-null.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | In the maintenance branch pass `NULL` for `deleted_profile_id`, and read the owner from `user_id`, which is already stored. `deleted_profile_id` should be set only by `fn_ca_journal_profile_deletion`, where `OLD.id` really is a deleted profile. Backfill: `UPDATE ca_diamond_journal_archive SET deleted_profile_id = NULL WHERE deletion_reason LIKE 'certification-cleanup:%' OR deletion_reason LIKE 'test-account-sweep:%'` only after the code change, so nothing rewrites it.                                                                                                                                                                                                                                           |
| R2-08 | `correlateDiamondPurchase` (WH stripe.js)         | MEDIUM              | The Checkout Sessions fallback picks the FIRST session carrying a `purchase_id` and only THEN checks `metadata.type === 'diamonds'`. If that first session is a merchandise or VIP one, the function returns null and a genuine diamond dispute silently correlates to nothing. Both completed diamond purchases in production have a NULL payment intent, so this fallback is the ONLY path that can find them. | `origin/main:pages/api/store/webhooks/stripe.js`: `const checkoutSession = sessions.data.find((entry) => entry.metadata?.purchase_id); if (checkoutSession?.metadata?.type === 'diamonds' && ...)`. Production: `select stripe_payment_intent_id is not null from diamond_purchases` is false for all 3 rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Move the type test into the predicate: `sessions.data.find((entry) => entry.metadata?.type === 'diamonds' && entry.metadata?.purchase_id)`. One line, no behaviour change in the happy path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R2-09 | `fn_diamond_purchase_dispute`                     | MEDIUM              | `charge.dispute.created` files a critical incident whose `evidence_deadline` is the literal string `'UNKNOWN'`, while Stripe sends the real deadline as `evidence_details.due_by` on the same object the handler already has. The one field that decides whether the dispute is lost by silence is the one field not captured.                                                                                   | Live body: `'evidence_deadline', 'UNKNOWN'` and a note saying the deadline "is UNVERIFIED and is carried in the dispute object Stripe sent". `handleDispute` reads only `dispute.id`, `dispute.payment_intent`, `dispute.status` and `dispute.amount`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Add `p_evidence_due_by timestamptz DEFAULT NULL` to the RPC (new overload or a defaulted trailing parameter, never an in-place signature change - that is Tier 3), pass `dispute?.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString() : null` from the handler, and put the real timestamp in the incident detail.                                                                                                                                                                                                                                                                                                                                                                           |
| R2-10 | `fn_diamond_purchase_dispute`                     | MEDIUM              | A dispute WON after `funds_withdrawn` already reversed the grant leaves the player short the diamonds they paid for, and the only record is an `info` incident. Money owed to a player is filed below the severity of a mirror mismatch.                                                                                                                                                                         | Live body, `charge.dispute.closed:won` branch: `PERFORM public.fn_ca_diamond_incident('DR10:dispute_closed_won', 'info', ...)` with a note that the re-credit "is a HUMAN decision". Nothing raises the severity when a reversal exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | In the `:won` branch, look for a prior `charge.dispute.funds_withdrawn` row for the same `dispute_id` in `diamond_purchase_disputes`; if one exists, file at `'critical'` with the amount owed, so the daily incident sweep surfaces it. Section 10.9 makes the re-credit itself an agent decision, but it cannot be decided if it is filed at `info`.                                                                                                                                                                                                                                                                                                                                                                             |
| R2-11 | `diamond_packages` RLS                            | LOW                 | The policy named `diamond_packages_read_active` has `qual = true`. It does not filter `active`. Any authenticated client reading the table directly sees deactivated packages and their prices.                                                                                                                                                                                                                  | `pg_policies`: `diamond_packages_read_active`, cmd SELECT, roles `{authenticated}`, `qual = true`. Currently harmless because all 8 rows have `active = true` and the checkout path reads server-side: `src/lib/store/diamondPackageCatalog.mjs` line 90 `.eq('active', true)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `ALTER POLICY diamond_packages_read_active ON public.diamond_packages USING (active)`. The name already promises it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R2-12 | `diamond_purchases` constraints                   | LOW                 | `diamond_purchases_status_known` and `diamond_purchases_refund_progress_nonnegative` are both `NOT VALID`, so they guard new writes but were never checked against the 3 existing rows. `merchandise_orders_refunded_diamonds_nonnegative` is NOT VALID too.                                                                                                                                                     | `pg_constraint.convalidated = false` for all three; `profiles_diamonds_nonnegative CHECK (diamonds >= 0)` is `convalidated = true` (this one is healthy).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `ALTER TABLE public.diamond_purchases VALIDATE CONSTRAINT diamond_purchases_status_known;` and the same for the other two. Three rows and a small table; the validation scan is free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R2-13 | `reconcile_diamond_purchase_refund`               | LOW                 | The DR9 lot update is wrapped in `EXCEPTION WHEN OTHERS THEN NULL`. If the lot write fails, the refund still commits and nothing anywhere records that the sub-ledger is now wrong. `settle_diamond_card_purchase_atomic` files a `DR9:purchase_lot_write_failed` critical in the same situation; the refund path does not.                                                                                      | Live body: `BEGIN UPDATE public.diamond_purchase_lots SET refunded = ... EXCEPTION WHEN OTHERS THEN NULL; END;`. Compare the settle function, which has `PERFORM public.fn_ca_diamond_incident('DR9:purchase_lot_write_failed','critical',...)` in its handler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Replace `THEN NULL` with the same `DR9:purchase_lot_write_failed` critical incident, carrying `purchase_id`, `SQLSTATE`, `SQLERRM` and `v_target`. Still never roll the refund back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R2-14 | `deduct_diamonds`                                 | LOW                 | The idempotency lookup is `WHERE dt.reference_id = p_reference_id AND dt.user_id = p_user_id LIMIT 1` with no `ORDER BY`. `reference_id` is a shared namespace between `add_diamonds_to_balance` and `deduct_diamonds`, so if a credit and a debit ever share a reference the function can read the credit row, find `amount <> -p_amount`, and return `idempotency_conflict` on a first, legitimate attempt.    | Live body as quoted. `add_diamonds_to_balance` has the mirror of the same shape: `SELECT balance_after ... WHERE user_id = p_user_id AND reference_id = p_reference_id LIMIT 1` with no ordering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Add `AND dt.amount < 0` to the `deduct_diamonds` lookup and `AND amount > 0` to the `add_diamonds_to_balance` duplicate check, so each function is idempotent only against its own direction. Cheap, and it removes a whole class of false conflict.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R2-15 | `settle_diamond_card_purchase_atomic`             | LOW                 | The `UPDATE public.diamond_transactions SET counterparty='purchase_clearing', issuance_class='purchased' WHERE ... AND counterparty IS NULL` can never match: `add_diamonds_to_balance`, called four lines above, always sets both. Dead code sitting inside the block whose failure files a DR9 critical.                                                                                                       | Live bodies of both functions. `add_diamonds_to_balance` has an unconditional `ELSE` in its class derivation chain, so `v_issuance_class` is never NULL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Delete the UPDATE. It cannot help, and if it ever throws it destroys the lot insert that shares its `BEGIN` block and files a false `DR9:purchase_lot_write_failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R2-16 | `add_diamonds_to_balance` vs `deduct_diamonds`    | INFO                | The two functions report a replay in opposite directions: `add_diamonds_to_balance` returns `success:false, error:'duplicate_reference'`, `deduct_diamonds` returns `success:true, idempotent:true`. Every caller has to know which one it called.                                                                                                                                                               | Live bodies. `settle_diamond_card_purchase_atomic` already carries the workaround: `IF COALESCE(v_credit->>'success')::boolean IS NOT TRUE AND COALESCE(v_credit->>'duplicate')::boolean IS NOT TRUE THEN RAISE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Not a defect today because every caller handles it. Record it as a ruling rather than changing a contract 20-plus callers depend on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R2-17 | `award_diamonds_v2` metadata                      | INFO / out of scope | The three 09-07 rows carry `awarded: 10` beside `expected_diamonds: 11`, `25` and `5`. Three different expectations, one payout. Either the multiplier is not applied or `expected_diamonds` is computed from a different catalog than the one that paid.                                                                                                                                                        | The three rows quoted in section 2.1. All three have `is_vip: true`, `multiplier: 1`, `capped: false`, `catalog_version: 3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Out of my scope; flagged for whoever owns Diamond Rewards v2. It is the same function as R2-02, so both should be fixed in one migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## 2. PER-OBJECT FINDINGS

### 2.1 `add_diamonds_to_balance(uuid,integer,text,text,text)`

Live: `deflen` 5649, `defmd5` `61dd299a6680a1626ceb0afa35688fdc`, `prosrc` md5
`5d55a2f5a11276e8f9fb623bbe5f4e5e`, `SECURITY DEFINER`, `search_path = public, extensions`.

**Whose body is live.** Not lane C's. The function has been replaced five times; the
last replacement is `20260907070111 daily_mission_claim_receipts_account_for_every_diamond`,
applied TODAY.

```sql
with m as (select version, name, array_to_string(statements,'\n') txt from supabase_migrations.schema_migrations)
select version, name from m
where txt ~* 'function\s+(public\.)?add_diamonds_to_balance\s*\(' and txt ~* 'create\s+or\s+replace\s+function';
-- 20260501005245 consolidate_add_diamonds_to_balance
-- 20260815055031 go_live_guest_mgmt_thumbnail_gift_hardening
-- 20260823202529 pvp_refund_mint_leak
-- 20260827225945 trivia_phase6_atomic_economy
-- 20260903002317 20260903031500_diamond_c_...   <- lane C
-- 20260907070111 daily_mission_claim_receipts_account_for_every_diamond   <- live
```

**Lane C's intent survived intact.** The live body still carries the complete class and
counterparty derivation lane C added, in the same order and with the same branches:
`purchase` -> `purchased` / `purchase_clearing`; `refund` or any `*_refund` -> `refund` /
`revenue:<type>`; `transfer`, `diamond_gift_received`, `live_gift_received`,
`diamond_received` -> `transferred` / `player:unknown`; `adjustment` -> `admin`;
`union_grant`, `signup_bonus` -> `promotional` / `promo_budget:<type>`; a negative
amount -> `spend` / `revenue:<type>`; and an unconditional `ELSE` -> `earned` /
`promo_budget:<type>`. It also still carries the `DR4:credit_without_reference` warning.

**It cannot write a NULL class.** The chain ends in `ELSE`, so `v_issuance_class` and
`v_counterparty` are always set. Confirmed against production: every row it wrote since
09-03 has both columns populated.

**Every type it wrote since 09-03, grouped:**

```sql
select coalesce(transaction_type,type) ttype, issuance_class, counterparty, count(*) n, sum(amount) amt
from public.diamond_transactions where created_at >= '2026-09-03' group by 1,2,3 order by n desc;
```

| ttype                  | class       | counterparty                   | n     | sum    |
| ---------------------- | ----------- | ------------------------------ | ----- | ------ |
| daily_login            | promotional | promo_budget:catalog_v2        | 9     | 520    |
| **daily_login**        | **NULL**    | **NULL**                       | **3** | **30** |
| easter_egg             | promotional | promo_budget:catalog_v2        | 2     | 350    |
| training_reward        | promotional | promo_budget:catalog_v2        | 2     | 30     |
| signup_bonus           | promotional | issuance:signup                | 2     | 1000   |
| daily_challenge_reroll | spend       | revenue:daily_challenge_reroll | 1     | -10    |

**The three NULL-class rows are NOT `add_diamonds_to_balance`'s.** Confirmed by
description, exactly as the brief predicted:

| id                                     | description                       | reference_id                                       | created_at          |
| -------------------------------------- | --------------------------------- | -------------------------------------------------- | ------------------- |
| `41ecf404-3d60-47df-b71a-5ac2e9f1dcb1` | `Diamond Rewards v2: daily_login` | `daily_login_2d1cd6c3-...-d4863fdab20d_2026-09-07` | 2026-09-07 05:00:22 |
| `0aeff579-2ca6-4bcd-b192-0563d7c5f5d3` | `Diamond Rewards v2: daily_login` | `daily_login_47965354-...-ddaab82af765_2026-09-07` | 2026-09-07 16:27:13 |
| `8802562f-fcbe-4c5b-8f8c-198fc4478304` | `Diamond Rewards v2: daily_login` | `daily_login_9b027798-...-15554ce2959c_2026-09-07` | 2026-09-07 16:37:59 |

`add_diamonds_to_balance` writes `'Diamond Rewards v2: %s'` nowhere; `award_diamonds_v2`
writes exactly that `format()`. Each row's metadata carries `action_key`, `claim_date`,
`streak_source`, `catalog_version: 3` - the v2 catalog shape. This is **R2-02**, and the
09-03..09-06 comparison proves it is a regression rather than a pre-existing gap: the
same function wrote `promotional` / `promo_budget:catalog_v2` for thirteen rows across
those four days and stopped the day `20260907025144` landed.

Note the boundary is not a trigger. `diamond_transactions` has four triggers
(`trg_ca_append_only`, `trg_ca_diamond_earn_ledger`, `trg_ca_diamond_register_follows_journal`,
`trg_enforce_anti_farming_caps`) and none of them derives a class, so the columns were
being written by the function body that `20260907025144` replaced.

### 2.2 `deduct_diamonds(uuid,integer,text,text,text,jsonb,text,integer)`

Live: `deflen` 5454, `defmd5` `a0007bd36e461418f58b265bb4ac95f2`.

**Not lane C's body either, and the change was an improvement.** The live body carries an
idempotency BINDING lane C did not have: the counterparty and class are derived BEFORE the
replay lookup, and a replay whose amount, type, counterparty or class differs from the
stored row returns `idempotency_conflict` instead of silently re-pointing a reference at a
new recipient. The profile row is locked with `FOR UPDATE` before the lookup, which
serialises concurrent replays. Lane C's contribution (both columns always written, `spend`

- `revenue:<source>` by default, `transferred` + `player:<recipient_id>` for
  `wallet_transfer`, `wallet_diamond_transfer`, `stream_gift`, `diamond_gift_sent`,
  `live_gift_sent`) is present and now load-bearing for the conflict test.

The migration that did this is `20260906210000` and it recorded **zero statements** - see
**R2-04**. That is how the change is invisible to the query above, which returns only
`20260817190823` and lane C's `20260903002317`.

Line-by-line, two things are worth writing down:

- `SET diamonds = diamonds - p_amount, diamond_balance = diamonds - p_amount` is CORRECT.
  Both right-hand sides read the pre-UPDATE `diamonds`, so both columns land on the same
  value. It reads like a bug and is not one.
- The `LIMIT 1` with no `ORDER BY` over a shared `reference_id` namespace is **R2-14**.

Every type it wrote since 09-03: one row, `daily_challenge_reroll`, class `spend`,
counterparty `revenue:daily_challenge_reroll`. No NULL class from this function.

### 2.3 `fn_ca_journal_profile_deletion()`

Live: `deflen` 4033, `defmd5` `46590d94ae7880202cdce265e8ff9f98`.

**Which body is live, and who changed it.** Not lane C's. Three migrations have replaced
it: `20260902044519 a_deleted_account_leaves_financial_testimony`, lane C's
`20260903002317`, and `20260905065304 the_signup_grant_is_registered_once_and_deletion_retires_wha`,
which is what runs now.

**The two reason strings map cleanly onto that cutover, with no overlap:**

```sql
select case when reason like 'profile deleted with a balance%' then 'laneC'
            when reason like 'profile deleted (retirement%' then 'post-0905' end k,
       count(*), min(created_at), max(created_at), sum(amount)
from public.ca_mint_ledger where asset='diamonds' and action='burn' and reason like 'profile deleted%' group by 1;
```

| body                                          | rows | first               | last                | total burned |
| --------------------------------------------- | ---- | ------------------- | ------------------- | ------------ |
| lane C (`profile deleted with a balance ...`) | 319  | 2026-09-03 01:56:05 | 2026-09-05 06:13:51 | 956,025      |
| post-0905 (`profile deleted (retirement ...`) | 696  | 2026-09-05 06:54:59 | 2026-09-07 21:17:27 | 1,073,023    |

A clean cutover at 2026-09-05 06:xx, no interleaving. **The intent survived and was
widened.** Lane C burned `OLD.diamonds`. The live body burns
`GREATEST(COALESCE(OLD.diamonds,0), COALESCE(v_attributed,0))`, where `v_attributed` is the
register's own attribution to that holder since the diamonds baseline. Its comment states
the reason: `GREATEST` is never less than what lane C burned, so the healthy case is
byte-identical, and it additionally retires a seed the certification harness zeroed
outside the journal (18 accounts stranded 500 each). That is a strict superset of lane C's
behaviour. The archive block, the `ca_profile_deletions` block and the
`DR5:deleted_with_balance` incident are all still there.

**Is the burn amount right.** Yes, with one internal inconsistency worth noting. The row
records `balance_before = COALESCE(OLD.diamonds,0)`, `balance_after = 0` and
`amount = v_burn`. When attribution exceeds the balance, `amount > balance_before -
balance_after`. That is deliberate (the attribution genuinely left supply and the balance
column was zeroed outside the journal), but a reader reconciling `before - amount = after`
will find it does not hold on those rows. Recommend a `detail`-level note in the reason
string, which it already partly does by printing both numbers.

**Are the 717 `DR5:deleted_with_balance` incidents all certification.** Yes, all of them,
and none is a real player:

```sql
select detail->>'is_horse', split_part(coalesce(detail->>'ledger_maintenance','(none)'),':',1), count(*), sum(amount)
from public.ca_diamond_incidents where rule='DR5:deleted_with_balance' group by 1,2;
-- false, certification-cleanup : 699 rows, 1,719,548 diamonds
-- false, test-account-sweep    :  18 rows,    11,500 diamonds
```

Zero incidents with no maintenance reason. 617 of the 699 also have `cert` in the username.
The count is 717 in the brief and 718 now; one more landed at 21:29 UTC during this review.

**Does each burn match the deleted profile's balance.** For the lane C era, by construction
(`v_burn := OLD.diamonds`). For the current era, the burn is `GREATEST(balance,
attribution)` and the reason string prints all three numbers (`balance N, registered
attribution M, retired K`), so each row carries its own proof. There is no row where the
burn is LESS than the balance.

**One gap.** The `DR5:deleted_with_balance` incident fires on `IF COALESCE(OLD.diamonds,0) > 0`,
not on `IF v_burn > 0`. A profile with a zero balance but a non-zero register attribution
burns diamonds and files no incident. That is why there are 1,015 burn rows and 718
incidents. Low severity (the burn is still on the mint ledger) but the incident is the
thing an operator reads.

### 2.4 `fn_ca_journal_append_only()`

Live: `deflen` 5596, `defmd5` `917a30d0a4688bc142fddf03b89c7540`. Last replaced by lane C
(`20260903002317`) - **this one IS lane C's body**, and it is the only lane C object still
live unchanged. Five migrations touched it before lane C (`20260831143501`, `20260901004949`,
`20260901172200`, `20260901174548`, `20260901184724`); none after.

**Who deletes, and at what cadence.** The certification fleet, through PostgREST as
`postgres`, in batches of exactly 62 rows:

```sql
select reason, db_role, application, operation, count(*) n, min(at), max(at)
from public.ca_ledger_mutation_log where source_table='diamond_transactions' and at>='2026-09-03'
group by 1,2,3,4 order by n desc;
```

Every batch is `db_role=postgres`, `application='PostgREST 14.5'`, `operation=DELETE`,
`n=62`, and every batch commits inside a single transaction (min = max to the microsecond).
Reasons are `certification-cleanup:<uuid>` up to 09-06 and
`certification-cleanup:20260906022000:<uuid>` after, roughly hourly. Per-day totals:
2,959 / 3,432 / 2,735 / 2,843 / 2,205 across 09-03..09-07, i.e. ~45 batches a day.

**Is the archive copy complete. YES, exactly, with no drift over four days:**

```sql
select (select count(*) from ca_ledger_mutation_log
          where source_table='diamond_transactions' and operation='DELETE' and at>='2026-09-03') mutlog,
       (select count(*) from ca_diamond_journal_archive) archive,
       (select count(*) from ca_diamond_journal_archive where deletion_reason is not null) archive_maint,
       (select count(*) from ca_diamond_incidents where rule='DR5:journal_row_deleted_under_maintenance') dr5;
-- mutlog 14173 | archive 14173 | archive_maint 14173 | dr5 14173
```

Three independent counters agree exactly. Not one deleted journal row was lost, and the
`EXCEPTION WHEN OTHERS THEN RAISE WARNING` fallback has never fired. Archive is 8,200 kB
for 14,173 rows across 269-313 distinct users per day.

`archive_no_reason = 0` is itself evidence for **R2-03**: the profile-deletion archive path
writes `deletion_reason = v_reason`, which would be NULL for a player-initiated deletion,
and no such row exists.

**The labelling bug is R2-07** (`deleted_profile_id = user_id` on a maintenance delete).

**Is the incident volume a problem for the table.** Not for storage. `ca_diamond_incidents`
is 8,872 kB at 18,046 rows; at ~2,800/day that is roughly 1.0M rows and ~500 MB a year,
which this database will not notice. It is a problem for the SIGNAL: DR5 maintenance rows
are 78.5% of every incident ever filed, all unresolved, and they sit in the same table as
38 unresolved `DR11:trial_balance_break` warnings.

**Should cert-fleet deletes be archived silently. Recommendation: archive always, incident
once per batch, never silently.** Reasoning:

- Silent is wrong. The archive is the evidence; the incident is the notification. Removing
  the notification entirely makes an hourly deletion of financial journal rows invisible to
  anyone reading incidents, which is the failure mode `20260901172200 deleting_the_journal_must_announce_itself`
  was written to end. A rule nobody is told about is a rule nobody enforces.
- One per row is also wrong, and by a factor of 62. The batches are atomic and uniform: one
  reason string, one transaction, 62 rows every time. Sixty-two identical `info` rows carry
  exactly as much information as one row saying "62".
- The mechanism already exists in the same function. Six lines above the DR5 block,
  `fn_ca_raise_drift_incident` is called with a dedupe key
  (`'journal-bypass:'||TG_TABLE_NAME||':'||TG_OP||':'||v_kind`) and counts `occurrences`
  rather than filing a row per event. Its own comment says so: "this incident counts them
  (occurrences) rather than the chips". The DR5 block should do the same, keyed on the full
  `v_reason` (which is per batch, not per kind, so a batch is still individually visible)
  and carrying `rows_archived` plus the summed amount.
- Concretely: `WHEN v_reason ~ '^(certification-cleanup|test-account-sweep):'` file through
  the counting path; otherwise keep the per-row `info` incident, because a one-off
  maintenance delete on a real player's journal deserves its own row. That takes DR5 from
  ~2,800/day to ~45/day, a 98% reduction, and leaves every single archived row untouched.

### 2.5 `ca_diamond_journal_archive`

- **RLS**: enabled (`relrowsecurity = true`), not forced. One policy,
  `ca_diamond_journal_archive_service_role`, `cmd=ALL`, `roles={service_role}`,
  `qual=true`, `with_check=true`.
- **Grants**: `service_role` only (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER).
  No `anon`, no `authenticated`. Correct - a player must not read another player's
  archived journal.
- **Indexes**: `ca_diamond_journal_archive_pkey` UNIQUE on `(id)` (which is what makes the
  triggers' `ON CONFLICT (id) DO NOTHING` work), `idx_ca_diamond_journal_archive_user` on
  `(user_id, created_at DESC)`, `idx_ca_diamond_journal_archive_archived_at` on
  `(archived_at DESC)`. Adequate for both access patterns.
- **Growth**: 14,173 rows / 8,200 kB in five days. 2,959 / 3,432 / 2,735 / 2,843 / 2,205
  per day, distinct users 269 / 296 / 241 / 313 / 227. Extrapolated ~1.0M rows and ~600 MB
  a year at the current certification cadence. No retention policy exists on this table.
  Given the hand-history precedent (section 10.5, Dan's storage ruling), a retention
  decision for horse-and-certification archive rows is Dan's, not an agent's; flagging it
  rather than proposing a prune.
- **Columns**: 18, and every one the two writers need is present, including `counterparty`
  and `issuance_class`, so an archived row still names its class.

### 2.6 `settle_diamond_card_purchase_atomic(uuid,text,text)`

Live: `deflen` 9360, `defmd5` `0d58623b1231f683a3461a61498b68d2`. **Last replaced by lane D
(`20260903003327`) - this is still lane D's body**, unchanged in four days.

Line by line, what is correct:

- The `FOR UPDATE` on the purchase row, before anything is read.
- Three terminal states handled before the credit: already `completed` (returns
  `duplicate`, but only if the session id matches, else `settlement_conflict`); `refunded`
  with `refund_before_settlement` (binds the Stripe identities, never calls the wallet);
  anything not `pending` (refused).
- `left(p_session_id, 8) = 'cs_test_'` is correct - `cs_test_` is exactly 8 characters -
  so the DR7 test-mode warning fires on the right prefix.
- Both log-only blocks (DR7, DR8) have `EXCEPTION WHEN OTHERS THEN NULL` with the comment
  "never fail a paid settle over a comparison". That bias is right: refusing to settle a
  charge Stripe has already taken strands a player's money.
- The credit's return is checked for BOTH `success` and `duplicate`, which is the correct
  handling of `add_diamonds_to_balance`'s asymmetric replay contract (**R2-16**).
- The lot insert is `ON CONFLICT (purchase_id) DO NOTHING` against a real UNIQUE constraint
  (`diamond_purchase_lots_purchase_id_key`), so a replay is a no-op.

Bugs: **R2-15** (the dead `UPDATE ... WHERE counterparty IS NULL` sharing a `BEGIN` block
with the lot insert, so if it ever throws it takes the lot with it and files a false
`DR9:purchase_lot_write_failed`) and, indirectly, **R2-06** (this function is where lots
come from, so purchases settled before lane D have none).

One design note, not a defect: the append-only trigger permits that UPDATE. For a table
that is not `chip_transactions` or `chip_ledger`, `fn_ca_journal_append_only` allows an
update whose `amount` and `created_at` are unchanged, which is exactly this one. Verified
against the live trigger body, so removing it is safe and keeping it is safe; it is simply
dead.

**Live use since 09-03: none.** `select count(*) from diamond_purchases where created_at >= '2026-09-03'` = 0.

### 2.7 `reconcile_diamond_purchase_refund(uuid,integer,integer)`

Live: `deflen` 8892, `defmd5` `7b4dab8275c36fa2606e264b48abe567`. **Last replaced by lane D
(`20260903003327`) - still lane D's body.** Previously `20260829150000` and `20260830130000`.

**Does it still book `diamond_debts` and never write negative. YES, and it is well built:**

```sql
v_available := GREATEST(COALESCE(v_available, 0), 0);
v_applied   := LEAST(v_delta, v_available);
v_shortfall := v_delta - v_applied;
...
IF v_shortfall > 0 THEN
  INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason)
  VALUES (v_purchase.user_id, v_purchase.id, v_shortfall, 'chargeback_exceeds_balance');
```

The clawback is clamped at the balance, the remainder becomes a receivable, and the debt
insert is deliberately NOT wrapped in an exception handler - the comment says so: "if the
receivable cannot be written the whole refund rolls back and Stripe redelivers. Losing the
debt silently is worse than processing the refund a minute later." That is the right call
and matches section 10.9 rule 3 (nothing is taken back from a player for our defect, and a
shortfall is recorded rather than forced). A `DR1:chargeback_exceeds_balance` critical
incident is filed alongside.

**Is `profiles_diamonds_nonnegative` present and validated. YES to both:**

```sql
select conname, pg_get_constraintdef(oid), convalidated from pg_constraint
where conrelid='public.profiles'::regclass and conname='profiles_diamonds_nonnegative';
-- profiles_diamonds_nonnegative | CHECK ((diamonds >= 0)) | convalidated = true
```

So the clamp is belt AND braces: if the arithmetic were ever wrong, the constraint aborts
the transaction rather than storing a negative balance.

Other line-by-line notes:

- `v_cumulative := GREATEST(refunded_amount_cents, LEAST(charge, refunded))` and
  `v_target := GREATEST(refunded_diamonds, LEAST(total, round(total * cumulative / charge)))`
  make both counters monotonic, so out-of-order Stripe redelivery cannot walk a refund
  backwards. Correct.
- The `reference_id` `'diamond-refund:<purchase>:<target>'` changes with `v_target`, so
  each partial refund step is its own journal row and a true replay computes `v_delta = 0`
  and writes nothing. Correct.
- When `v_applied = 0` and `v_shortfall > 0` it still inserts a `diamond_transactions` row
  with `amount = 0`. Harmless (`trg_ca_diamond_earn_ledger` only fires on `amount > 0`) and
  arguably right, since the row carries `debt_booked` in its metadata.
- The journal row it writes names `counterparty='purchase_clearing'`,
  `issuance_class='refund'`. Lane C compliant.
- **R2-13**: the DR9 lot update swallows every error.

**Live use since 09-03: none.** No purchase has been refunded; all three rows have
`refunded_diamonds = 0`.

### 2.8 `fn_diamond_purchase_dispute(uuid,text,text,integer)`

Live: `deflen` 5720, `defmd5` `2bb7275a81d5552cbb4f815e158507f0`. Created by lane D
(`20260903003327`) and **never replaced** - only one migration in the whole history
mentions it.

**The event shape matches the caller exactly.** The RPC's allowlist is

```
'charge.dispute.created', 'charge.dispute.funds_withdrawn',
'charge.dispute.closed:won', 'charge.dispute.closed:lost'
```

and the handler produces precisely those four:

```js
const eventName =
  eventType === 'charge.dispute.closed'
    ? `charge.dispute.closed:${dispute?.status === 'won' ? 'won' : 'lost'}`
    : eventType;
```

`charge.dispute.created` and `charge.dispute.funds_withdrawn` pass through unchanged and
are both on the allowlist. Anything not literally `'won'` becomes `lost`, which leaves a
reversal standing - the safe direction, and the handler's comment says so. **No mismatch.**

Idempotency: the `(dispute_id, event)` pair is claimed under the real primary key
(`diamond_purchase_disputes_pkey PRIMARY KEY (dispute_id, event)`) with
`ON CONFLICT DO NOTHING` + `GET DIAGNOSTICS`, BEFORE any side effect, and a zero row count
returns `duplicate: true`. That is the correct shape, and splitting `closed` into `:won`
and `:lost` keeps the two outcomes as separate keys rather than collapsing them.

Ordering safety: `created` freezes lots, `funds_withdrawn` runs the same pro-rata reversal
a refund runs, `closed:won` unfreezes, `closed:lost` files a note. If `funds_withdrawn`
arrives before `created` (Stripe does not guarantee order), the reversal still runs and the
later `created` still freezes - both are independently keyed, so no path is skipped.

Bugs: **R2-09** (the evidence deadline is a literal `'UNKNOWN'` when Stripe sends
`evidence_details.due_by`) and **R2-10** (a won dispute after a reversal is only `info`).
One further note: the `funds_withdrawn` branch returns `success:false, error:'charge_amount_unknown'`
when `price_usd` is missing, which makes the handler throw and Stripe retry forever on a
purchase row that will never gain a price. It files a critical incident first, so it is
visible, but the retry is unbounded. Not raised as a numbered defect because all three
production purchase rows carry `price_usd = 1.00`; recorded here so it is not a surprise.

**Rows: zero.** `select count(*) from diamond_purchase_disputes` = 0. No dispute has ever
been processed.

### 2.9 `diamond_packages` and the World Hub checkout

8 rows, all `active = true`. **The World Hub checkout does read it**, server-side:

```
pages/api/store/create-checkout-session.js
  -> loadDiamondPackages({ requireCurrent })
  -> loadActiveDiamondPackageCatalog(getSupabase(), { allowFallback, cacheMs })
  -> src/lib/store/diamondPackageCatalog.mjs:88
       .from('diamond_packages')
       .select('package_key, display_name, diamonds, bonus_diamonds, price_usd, active')
       .eq('active', true)
```

The `.eq('active', true)` is applied in the loader, so the checkout path is correct
regardless of the policy. `requireCurrent` forces `cacheMs: 0` and `allowFallback: false`
for Club Shop card redemption, and a catalog read failure becomes a 503
`DIAMOND_PACKAGE_CATALOG_UNAVAILABLE` rather than a silent fallback price. That is the
right bias for a payment path.

RLS: enabled, one policy `diamond_packages_read_active` granting `authenticated` SELECT
with `qual = true`. **R2-11**: the policy does not do what its name says.

Also read by `pages/api/club-arena/manage-shop.js`, `marketplace-items.js`,
`shop-items.js`, and `src/lib/store/diamondStorefrontCatalog.mjs`.

### 2.10 `diamond_purchase_lots`, `diamond_debts`, `diamond_purchase_disputes`

| table                       | rows  | RLS | policies | grants beyond service_role | constraints                                                                                                              |
| --------------------------- | ----- | --- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `diamond_purchase_lots`     | **0** | on  | 0        | none                       | `UNIQUE (purchase_id)`, `issued >= 0`, `consumed >= 0`, `refunded >= 0`, `consumed + refunded <= issued` - all VALIDATED |
| `diamond_debts`             | 0     | on  | 0        | none                       | `amount > 0` - VALIDATED                                                                                                 |
| `diamond_purchase_disputes` | 0     | on  | 0        | none                       | `PRIMARY KEY (dispute_id, event)`                                                                                        |

RLS on with zero policies and no player grants is the correct posture for three
service-role-only sub-ledgers: nothing a player holds can read them.

Indexes: `idx_diamond_debts_open (user_id, created_at) WHERE settled_at IS NULL` (the
"what does this player still owe" query), `idx_diamond_debts_purchase (purchase_id) WHERE
purchase_id IS NOT NULL`, `idx_diamond_purchase_disputes_purchase (purchase_id, occurred_at DESC)`.
Well chosen for the paths that exist.

The empty `diamond_purchase_lots` against two completed purchases is **R2-06**.

### 2.11 The unique indexes on `diamond_purchases`

There are **three**, not two:

```sql
ux_diamond_purchases_stripe_session
  UNIQUE (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL
ux_diamond_purchases_stripe_payment_intent
  UNIQUE (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL
ux_diamond_checkout_request
  UNIQUE (user_id, (metadata->>'checkout_request_id'))
  WHERE NULLIF(metadata->>'checkout_request_id','') IS NOT NULL
```

All three are partial, so the NULL session ids and NULL payment intents on the existing
three rows do not collide. Together they make it impossible for one Stripe session, one
payment intent, or one client checkout request to settle twice, which is the guard that
makes `settle_diamond_card_purchase_atomic`'s final unconditional
`SET stripe_checkout_session_id = p_session_id` safe. Present and correct.

Two CHECK constraints on this table are `NOT VALID` - **R2-12**.

### 2.12 `stripe_webhook_events` and `diamond_purchases`

```sql
select count(*) from public.stripe_webhook_events;                          -- 0
select count(*) from public.diamond_purchases where created_at >= '2026-09-03'; -- 0
```

**`stripe_webhook_events` is completely empty - not zero since 09-03, zero ever.** No
Stripe webhook has been claimed through `complete_stripe_webhook_event` on this database.
`diamond_purchases` holds only the three February 2026 rows.

Consequence for the review: the entire lane D purchase and dispute path is **live but
unexercised**. Every finding in 2.6 through 2.8 is from reading the code and the schema,
not from watching it run. That is a gap in confidence, not a defect in itself.

It also means the brief's UNVERIFIED item stays UNVERIFIED: **whether
`scripts/setup-stripe-webhook.js` was ever run against the Stripe dashboard cannot be
determined from this database**, because there is no `stripe_webhook_events` row of any
type, let alone a dispute one. The repo side is in order - the script's `WEBHOOK_EVENTS`
array on `origin/main` contains `charge.dispute.created`,
`charge.dispute.funds_withdrawn` and `charge.dispute.closed` at lines 21-23 and passes
them as `enabled_events` at line 53 - but whether that array was pushed to Stripe is
**UNVERIFIED**. If it was not, the three dispute cases in `stripe.js` are unreachable and
D10 is still open in production despite the code being live.

---

## 3. WORLD HUB PUBLISH VERDICT

**PASS. PR #1257 is merged, on `origin/main`, and served by production.**

```
$ git -C ~/Documents/Smarter-Poker-World-Hub fetch -q origin
$ git log --oneline origin/main -1
e180dfc806 docs(audit): the duplicate re-formed, and two reds that are not code (#1556)

$ git log --oneline origin/main -- pages/api/store/webhooks/stripe.js | head -3
85f3dc0bbc fix(marketplace): close phase 7 final audit gaps (#1532)
6da9a94357 feat(marketplace): certify phase 7 production truth (#1515)
717dc31136 fix(marketplace): close phase 6 recovery races (#1449)

$ git merge-base --is-ancestor 92ea26c820 origin/main && echo YES
YES

$ curl -s https://smarter.poker/api/health
{"status":"ok","version":"e180dfc8067c03630350cc182eb0d2698b1740f7",...}

$ git merge-base --is-ancestor 92ea26c820 e180dfc8067c03630350cc182eb0d2698b1740f7 && echo YES
YES

$ git rev-list --count e180dfc8067c...::origin/main
0
```

The live sha equals `origin/main` exactly (0 commits between them), and PR #1257's commit
`92ea26c820` ("fix(diamond): handle Stripe disputes and read diamond package prices from
the database") is an ancestor of the sha production is serving. Its three files
(`pages/api/store/webhooks/stripe.js` +103, `pages/api/store/create-checkout-session.js`
+67, `scripts/setup-stripe-webhook.js` +8) are all present on `main`, and the dispute code
survived the two later rewrites of `stripe.js` (#1515, #1532) intact.

**Code-safety checks on the three files as they stand on `origin/main`:**

| check                              | stripe.js | create-checkout-session.js | setup-stripe-webhook.js |
| ---------------------------------- | --------- | -------------------------- | ----------------------- |
| raw `@supabase/supabase-js` import | 0         | 0                          | 0                       |
| `.single(` occurrences             | 0         | 0                          | 0                       |
| emoji                              | 0         | 0                          | 0                       |
| em dashes                          | 10        | 9                          | 0                       |

`.maybeSingle()` is used in all three database reads in the dispute path
(`diamond_purchases` by payment intent, `diamond_purchases` by recovered id, and the
`handleRefund` lookup). No `.single()` anywhere. All em dashes are inside `//` comments
(lines 166, 218, 219, 350, 603, 606, 1617, 1733, 1734, 1741 of `stripe.js`), not in any
string a player reads, so the apex-site copy gate is satisfied.

**Line-by-line review of the dispute code:** correlation, error handling and the
`charge.dispute.closed:<status>` shape are covered in 2.8; two real bugs came out of it,
**R2-08** (the `.find()` predicate) and **R2-09** (the discarded evidence deadline), plus
**R2-10** on the RPC side. The non-correlation early return is CORRECT and deliberately so:
throwing would make Stripe retry a merchandise dispute forever, and the handler logs the
dispute id before returning.

**`pages/api/auth/delete-account.js`: NOT changed since 2026-09-03.** Its last commit is
`8e43d88cbc` (2026-08-31, #1139). It sets no maintenance reason, calls no retire RPC, and
still deletes `diamond_transactions` and `profiles` with two raw `.delete()` calls. **No
`retire_profile`-style function exists in `pg_proc`.** This is **R2-03**, and it is the
highest-severity finding in the World Hub half of this review.

### The Club Arena publish verdict is a FAIL

Stated here because it is the answer to "make sure all of your work was pushed and
published correctly", and it is the opposite of the World Hub answer.

Lane C shipped: PR #2744 merged 2026-09-03T00:42:38Z, and
`supabase/migrations/20260903031500_diamond_c_...sql`,
`docs/changelog/2026-09-03-diamond-c-journal.md` and
`docs/DIAMOND-ACCOUNTING-STANDARD.md` are all present on `origin/main`.

Lanes A, B, D, E and G did not. Their migrations are APPLIED IN PRODUCTION, their PRs are
CLOSED UNMERGED, their files are absent from `origin/main`, and the consolidated branch
tip that holds them (`fix/diamond-p2-lanes-reland`, 15 commits) is on no remote at all.
`docs/changelog/2026-09-03-diamond-d-purchase.md` does not exist on `main`. That is
**R2-01**, and it should be fixed before any of the code defects, because until it is,
every fix written against those objects is a fix to a file nobody else can see.

---

## 4. SUMMARY OF LIVE-BODY PROVENANCE

| object                                | live body is       | replaced since 09-03 by                     | intent survived   |
| ------------------------------------- | ------------------ | ------------------------------------------- | ----------------- |
| `add_diamonds_to_balance`             | NOT lane C's       | `20260907070111`                            | YES, complete     |
| `deduct_diamonds`                     | NOT lane C's       | `20260906210000` (zero statements recorded) | YES, strengthened |
| `fn_ca_journal_profile_deletion`      | NOT lane C's       | `20260905065304`                            | YES, widened      |
| `fn_ca_journal_append_only`           | **lane C's**       | none                                        | n/a               |
| `settle_diamond_card_purchase_atomic` | **lane D's**       | none                                        | n/a               |
| `reconcile_diamond_purchase_refund`   | **lane D's**       | none                                        | n/a               |
| `fn_diamond_purchase_dispute`         | **lane D's**       | none                                        | n/a               |
| `award_diamonds_v2`                   | pre-lane-E lineage | `20260907025144`                            | **NO - R2-02**    |

Four of the eight objects were replaced by other agents' work in the four days since the
lanes landed. In three cases the replacement kept or improved the lane's contribution. In
one, `award_diamonds_v2`, it silently dropped it.
