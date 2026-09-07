# Review 1: Diamond Accounting Standard, Lanes A, B, G and the P3 fix

Reviewer 1. Read-only verification pass against production `kuklfnapbkmacvwxktbh`,
2026-09-07 ~21:35 UTC. Worktree read: `/Users/smarter.poker/Documents/.agent-trees/club-arena/diamond-reland`
(HEAD `b9e3294543`). Every claim below is from a query or a file read; anything I could
not prove is labelled UNVERIFIED.

---

## 0. Drift check: is the live body still the lane's body?

Method: extract each `CREATE OR REPLACE FUNCTION ... $tag$ body $tag$` from the lane
migration files, md5 the body, compare to `md5(prosrc)` live. Postgres stores `prosrc`
as exactly the text between the dollar quotes, so an identical md5 is proof the live
body is byte-identical to the migration.

| Object                                     | Lane file                   | file md5 / len     | live md5 / len       | verdict                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | --------------------------- | ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_ca_diamond_snapshot()`                 | A `20260903003036`          | `ff7b31c8` / 5472  | `ff7b31c8` / 5472    | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `fn_union_send_to_member_zd3core(...)`     | A `20260903003036`          | `9c3ad0f1` / 11194 | `9c3ad0f1` / 11194   | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `ca_promo_vault_buy(uuid,text,int)`        | A `20260903003036`          | `6050f6a6` / 3568  | `6050f6a6` / 3568    | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `fn_diamond_side_tables_follow_profiles()` | A `20260903003036`          | `328d5b59` / 2216  | `b3901478` / 2761    | **REPLACED** by `20260907035121_a_profile_is_born_with_its_diamond_mirrors` (md5 matches that file exactly). Lane A intent survives and is widened: the `diamond_wallets` upsert Lane A introduced is intact, and the trigger now also fires on INSERT. See D10.                          |
| `fn_purchase_time_banks(int)`              | A `20260903003036`          | `e7bc3b75` / 5422  | `67548f4a` / **211** | **REPLACED** by `20260903003327_diamond_d_purchase_clearing` (Lane D, same night). Live body is a 5-line wrapper delegating to `fn_purchase_time_banks_v2`. Lane A intent (auth gate, `feature_pricing` read, journal via `deduct_diamonds`) survives inside v2 and is stronger. See D15. |
| `handle_new_user()`                        | B `20260903002248`          | `6acb1c4d` / 8369  | `6acb1c4d` / 8369    | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `fn_ca_diamond_born_with_balance()`        | B `20260903002333`          | `8ee00da3` / 1344  | `8ee00da3` / 1344    | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `fn_ca_propose_manual_adjustment(...)`     | G `20260903003128`          | `aa37244b` / 2953  | `aa37244b` / 2953    | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `fn_ca_open_payout_freeze(...)`            | G `20260903003128`          | `d94fedbe` / 1995  | `d94fedbe` / 1995    | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `fn_ca_diamond_trial_balance_watch()`      | G `20260903003128`          | `48f02bbf` / 1746  | `48f02bbf` / 1746    | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `fn_ca_diamond_trial_balance(timestamptz)` | G `20260903003714`          | `ed4d0740` / 13158 | `ed4d0740` / 13158   | UNCHANGED (the `003714` version supersedes the `003128` one, as intended)                                                                                                                                                                                                                 |
| `fn_ca_audit_diamond_change()`             | G `20260903003714`          | `82071ee5` / 4176  | `82071ee5` / 4176    | UNCHANGED                                                                                                                                                                                                                                                                                 |
| `fn_ca_diamond_incident(...)`              | foundation `20260903000735` | `a6bafb6c` / 339   | `a6bafb6c` / 339     | UNCHANGED                                                                                                                                                                                                                                                                                 |

`fn_ca_mint` / `fn_ca_burn` are not defined in a lane A/B/G file; they are the chip
Mint that Lane B extended. Live signatures are the 7-arg
`(text,text,uuid,numeric,text,text,text)` the brief names, owner `postgres`,
`SECURITY DEFINER`, current bodies reviewed in section 6.

Migrations applied since `20260903010547` that touch diamond objects (22 of them):
`20260904183408 phase_3_1_one_mint_the_register_follows_the_journal`,
`20260904194036 the_mint_hardened`,
`20260905041753 one_mint_for_diamonds_the_register_follows_the_diamond_journal`,
`20260905065304 the_signup_grant_is_registered_once_and_deletion_retires_what_was_registered`,
`20260905103722/103831 referral_* pays diamonds`, `20260905114421 a_mission_pays_diamonds`,
`20260906141022 daily_mission_rerolls_cost_one_diamond`,
`20260907025144 award_diamonds_v2_serialized_family_caps`,
`20260907035121 a_profile_is_born_with_its_diamond_mirrors`,
`20260907035309 a_mirror_never_invents_a_number`,
`20260907053216 the_mint_reference_into_the_journal_gets_its_constraint_back`,
`20260907070111 daily_mission_claim_receipts_account_for_every_diamond`.
None of them replaced a lane A/B/G body except the two rows marked REPLACED above.

---

## 1. DEFECT TABLE

| id  | object                                                                                | sev                            | what is wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | proposed fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | `fn_ca_diamond_trial_balance`, `player_diamonds` row                                  | high                           | The balance side and the journal side measure **different windows**. `v_delta = v_now - s0.profile_diamonds` where `s0` is the first snapshot at or after `p_since`; the watch calls with `p_since = now()-1h` at :20, so `s0` is the **:10 snapshot of the same hour**, 10 minutes back. But `v_jrn` sums `diamond_transactions WHERE created_at >= v_since`, a full 60 minutes. Ten minutes of balance minus sixty minutes of journal.                                                                                                  | Incident 2026-09-07 18:20: `balance_delta` 0, `journal_net` 500, `difference` -500, note names `s0` at 18:10 while `window_start` is 17:20. Same shape on 8 of the last 12 breaks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `SELECT COALESCE(SUM(dt.amount),0) INTO v_jrn FROM public.diamond_transactions dt WHERE dt.created_at >= COALESCE(s0.taken_at, v_since) AND dt.created_at < now();` and set `v_delta := NULL` when `s0` is NULL (already done).                                                                                                                                                                                                                                                                                                       |
| D2  | `fn_ca_diamond_trial_balance`, `player_diamonds` row                                  | high                           | `journal_net` reads only the live `diamond_transactions`. The certification cleanup **deletes** journal rows, so rows that existed during the window are gone by the time the watch runs.                                                                                                                                                                                                                                                                                                                                                 | `diamond_transactions` holds **1,443 rows total, 18 since 2026-09-03**. `ca_diamond_journal_archive` holds **14,174 rows, 14,167 since 2026-09-03**. `DR5:journal_row_deleted_under_maintenance` fired 14,173 times. Aligned to the 21:10-21:20 window the live journal reads 0 and the archive reads -2,359.                                                                                                                                                                                                                                                                                                                                                                              | Sum both: `... FROM (SELECT amount, created_at FROM public.diamond_transactions UNION ALL SELECT amount, created_at FROM public.ca_diamond_journal_archive) dt WHERE dt.created_at >= COALESCE(s0.taken_at, v_since) AND dt.created_at < now()`.                                                                                                                                                                                                                                                                                      |
| D3  | `fn_ca_diamond_trial_balance`, `player_diamonds` row                                  | high                           | Even aligned (D1) and archived (D2) the difference does not close, because **a profile born with a balance writes no journal row at all** (only a `seed:` register row and a DR2 incident). The journal is structurally incapable of explaining the balance. The **register can**: `fn_ca_mint_supply('diamonds')` = `1023512.00` and `SUM(profiles.diamonds)` = `1023512`, gap exactly `0.00`.                                                                                                                                           | For the 21:10-21:20 window: as shipped `difference` = -8,600; aligned + archived = -5,741; `balance_delta - mint_net` = **+1,500**, and that 1,500 is boundary skew (3 profile inserts of 500 committed either side of the snapshot instant), not a leak.                                                                                                                                                                                                                                                                                                                                                                                                                                  | Make the honest number the register one and keep the journal one as information: return `difference := v_delta - v_mint` for `player_diamonds` (with `v_mint` already computed for `holder_type='player'`), add a new `journal_difference` column carrying `v_delta - v_jrn`, and file `DR11:trial_balance_break` only on the **register** difference. That hides no real break: an unjournaled _and_ unregistered write still shows, and a write that is registered but not journaled shows on the new journal column at info level. |
| D4  | `fn_ca_audit_diamond_change` gate list                                                | high                           | DR6 fires on **every single signup**. `handle_new_user` writes the journal row in the same transaction but a few statements _after_ the `profiles` INSERT, so `v_journaled` (any `diamond_transactions` row for this user in the last 2 seconds) is false at trigger time, and `handle_new_user` is absent from `v_sanctioned`. Wrong to fire.                                                                                                                                                                                            | `DR6:balance_changed_without_journal` by writer: `handle_new_user` **1,340** of 1,555 (86%), all `TG_OP = 'INSERT'`, 1,339 cert + 1 non-cert. Count matches the 1,340 `seed:` register rows exactly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Add `'handle_new_user'` and `'fn_ca_diamond_born_with_balance'` to both arms of `v_sanctioned`. Coverage is not lost: `handle_new_user` already files `DR2:signup_grant_not_journaled` (critical) from its own EXCEPTION block if the journal insert fails, and the `seed:` register row is asserted by the register/meter identity.                                                                                                                                                                                                  |
| D5  | `fn_ca_audit_diamond_change` gate list                                                | high                           | Name drift. The list names `'claim_daily_challenge'` and `'claim_daily_challenges'`; the live writer frame is `claim_daily_challenges_serialized_body`. That function **does** journal (one `INSERT INTO public.diamond_transactions`), so the rule is wrong to fire.                                                                                                                                                                                                                                                                     | 48 DR6 incidents, writer `claim_daily_challenges_serialized_body`, all `UPDATE`, all cert, +41,094, first 2026-09-06 12:56. `pg_proc` confirms 1 journal insert in its body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Add `'claim_daily_challenges_serialized_body'` to `v_sanctioned`, or match with `COALESCE(v_writer,'') LIKE 'claim_daily_challenge%'`.                                                                                                                                                                                                                                                                                                                                                                                                |
| D6  | `fn_ca_audit_diamond_change` gate list                                                | medium                         | `award_diamonds_v2` is not in the list at all and does journal. It is the **only non-cert** DR6 writer.                                                                                                                                                                                                                                                                                                                                                                                                                                   | 16 DR6 incidents, writer `award_diamonds_v2`, `is_cert = false`, +930, 2026-09-03 05:01 to 2026-09-07 16:37. `pg_proc`: 1 `INSERT INTO public.diamond_transactions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Add `'award_diamonds_v2'` to `v_sanctioned`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D7  | `fn_ca_audit_diamond_change`, `v_journaled` probe                                     | medium                         | The probe is "does ANY `diamond_transactions` row exist for this user in the last 2 seconds". It is not tied to this write, so it produces false negatives as well as false positives: a genuinely unjournaled write within 2 seconds of a legitimate one passes silently. `award_diamonds_v2` firing only 16 times in five days while journaling every award is the signature of that.                                                                                                                                                   | Live body, lines `v_journaled := EXISTS (SELECT 1 FROM public.diamond_transactions dt WHERE dt.user_id = NEW.id AND dt.created_at >= now() - interval '2 seconds')`. Note `now()` is transaction start, so inside one long transaction the window is not 2 seconds of wall clock at all.                                                                                                                                                                                                                                                                                                                                                                                                   | Two options, in order of preference. (a) Move DR6 to a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, so it runs at commit and sees the journal row the same transaction wrote; that removes the whole "writes after the update" class including D4/D5/D6. (b) Keep the trigger and match on the amount: `AND dt.amount = v_delta`.                                                                                                                                                                                          |
| D8  | cert harness, surfaced by DR6                                                         | medium                         | 151 DR6 incidents with writer `(no function frame)`, `app_name = 'PostgREST 14.5'`, `db_role postgres`, all `UPDATE`, all cert, **-67,775 diamonds**. A direct `UPDATE profiles SET diamonds` over PostgREST with no journal row. The rule is **right** to fire. This is the same mechanism the 2026-09-05 06:53 register correction named ("a certification account whose balance was zeroed outside the journal").                                                                                                                      | Query in section 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The harness should spend through `deduct_diamonds`. Until then the rule should not be silenced, but it should be scoped: file `DR6:cert_harness_unjournaled` at severity `info` when `v_cert`, and keep `warning` for non-cert, so the one non-cert writer is not buried under 1,538 cert rows.                                                                                                                                                                                                                                       |
| D9  | `fn_ca_mint` / `fn_ca_mint_supply`                                                    | medium                         | `fn_ca_mint_supply('diamonds')` sums **all** holder types (`player`, `house`, `circulation`), but the 2026-09-05 work asserts the register equals `SUM(profiles.diamonds)`. A diamonds mint or burn to `destination = 'house'` moves `ca_diamond_house.balance`, writes no `diamond_transactions` row (correct: that journal is keyed by a user), and increments the register. The identity silently breaks by that amount. It has never fired: `house_net = 0.00`, `ca_diamond_house.balance = 0`, `ca_diamond_house_ledger` has 0 rows. | `fn_ca_mint` body, the `v_dest = 'house'` branch; `fn_ca_mint_supply` has no `holder_type` filter. Live: player_net -599,905, house_net 0.00, circulation_net 1,623,417, sum 1,023,512 = `SUM(profiles.diamonds)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | State the identity with the house in it and pin it: `SUM(profiles.diamonds) + COALESCE((SELECT balance FROM ca_diamond_house WHERE id=1),0) = fn_ca_mint_supply('diamonds')`. Change the assertion (and any law test) rather than the Mint.                                                                                                                                                                                                                                                                                           |
| D10 | `fn_diamond_side_tables_follow_profiles` (09-07 replacement)                          | medium                         | The trigger now fires `AFTER INSERT OR UPDATE OF diamonds ON profiles` and the body has **no exception handler**. `user_diamonds` and `user_diamond_balance` each carry a FK to `auth.users(id)`. `handle_new_user`'s own comment documents a live path where "the horse seeder inserts the profile ALREADY holding 500 about 2 ms **before** the auth.users row exists". On that ordering the mirror insert raises 23503 and **aborts the profile INSERT**.                                                                              | `pg_constraint`: `user_diamonds_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)`, same on `user_diamond_balance`. Live body has no BEGIN/EXCEPTION. Has not fired: 194 DR2 births since the migration landed (2026-09-07 04:04 to 21:30), 0 profile-creation failures observed. Latent, not active.                                                                                                                                                                                                                                                                                                                                                                           | Wrap the three upserts in `BEGIN ... EXCEPTION WHEN OTHERS THEN PERFORM public.fn_ca_diamond_incident('DR10:mirror_write_failed','warning',NEW.id,NEW.diamonds,'fn_diamond_side_tables_follow_profiles', jsonb_build_object('sqlstate',SQLSTATE,'sqlerrm',SQLERRM)); END;` and `RETURN NEW`. A mirror is a mirror; it must never be able to refuse the thing it mirrors.                                                                                                                                                              |
| D11 | `ca_payout_freeze` scopes                                                             | medium                         | `ca_payout_freeze_scope_check` allows `diamond_issuance` and `diamond_tournament_payouts`, and `fn_ca_open_payout_freeze` accepts both, but **no function in the database reads either**. An operator can open a diamond freeze, get a financial alert, see an open row, and diamonds keep issuing. A control nothing enforces reads as coverage.                                                                                                                                                                                         | Every `pg_proc` body naming `ca_payout_freeze`: `bbj_atomic_payout_v2` (scope `bbj_payouts`), `fn_bbj_mini_payout` (`bbj_payouts`), `fn_settle_tournament_obligation` (`tournament_payouts`), plus the open/clear/kill-switch functions. Neither diamond scope appears in any body. 0 freezes currently open.                                                                                                                                                                                                                                                                                                                                                                              | Add the gate at the top of `fn_ca_mint` (diamonds branch), `add_diamonds_to_balance` and `award_diamonds_v2`: `IF EXISTS (SELECT 1 FROM public.ca_payout_freeze WHERE scope='diamond_issuance' AND cleared_at IS NULL) THEN RETURN jsonb_build_object('ok',false,'reason','diamond_issuance_frozen'); END IF;`. If that is not wanted yet, delete the two scopes from the CHECK so nobody believes in a brake that is not connected.                                                                                                  |
| D12 | `fn_ca_mint` / `fn_ca_burn` ACL                                                       | medium                         | Both are granted `EXECUTE` to `postgres` and `service_role` only, yet both bodies carry a branch for a caller that is not `service_role`: "is this actor `admin` or `god`". Through PostgREST `authenticated` cannot execute either, so that branch is unreachable and an admin cannot use the Mint from the app.                                                                                                                                                                                                                         | `proacl`: `fn_ca_mint` = `postgres=X/postgres                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | service_role=X/postgres`; same for `fn_ca_burn`. Compare `ca_promo_vault_buy`, which does carry `authenticated=X`.                                                                                                                                                                                                                                                                                                                                                                                                                    | Decide and make it one thing. Either `GRANT EXECUTE ON FUNCTION public.fn_ca_mint(text,text,uuid,numeric,text,text,text) TO authenticated;` (the in-body admin/god check then does the work), or delete the admin/god branch and return `the_mint_is_service_role_only`. |
| D13 | `fn_ca_diamond_snapshot`, `unexplained`                                               | medium                         | `unexplained` is `(total - cert) - (prev_total - prev_cert) - journal_noncert`. It has **no term for the register**, so a deliberate, correctly-registered retirement of a non-cert account reads as a leak. One such event has happened.                                                                                                                                                                                                                                                                                                 | Snapshot id 121 (2026-09-05 19:10): `delta_vs_prev` -8,500, `journaled_delta` 0, `unexplained` **-8,000**, the only non-zero `unexplained` in 118 rows since 09-03. Cause: at 18:10:28 a batch of 12 test/probe profiles was deleted (`logotest_177644`, `samson-probe`, `magic-probe-177`, `probe`, `probe-login`, `probe-recovery`, `probe-signup`, `ws-probe-178683`, `player30463`, `player96101`, `club-arena-real`, `club-arena-prod`) totalling 8,500, every one of them registered as a DR5 retirement burn in `ca_mint_ledger`. 8,000 of the 8,500 belonged to accounts that `fn_ca_is_cert_account` does not match, so they left the non-cert pool with no non-cert journal row. | Subtract the registered non-cert movement as well as the journal: add `v_mint_noncert` = `SUM(CASE WHEN action='mint' THEN amount ELSE -amount END)` over `ca_mint_ledger` where `asset='diamonds'`, `holder_type='player'`, `created_at > prev.taken_at` and `NOT fn_ca_is_cert_account(holder_id)`, and use `COALESCE(v_mint_noncert, v_journal_noncert)` in the `unexplained` expression (the register is complete where the journal is not). Same reasoning as D3.                                                                |
| D14 | `ca_diamond_snapshots` schema / `ca_mint_ledger.created_at`                           | low                            | There is no stored record of the register at snapshot time, and `fn_ca_register_diamond_journal_row` **backdates** its register row (`created_at` is set to `COALESCE(t.created_at, now())`, the journal row's timestamp, not the commit instant). So "was the register equal to the meter at every hour" cannot be proved from stored data, only reconstructed, and the reconstruction shows a residue of +/-500 to +/-2,000 at 8 of the last 64 snapshots which is in-flight-transaction skew rather than a break.                      | Reconstruction query in section 4. Gap is `0.00` at 56 of the last 64 snapshots and `0.00` right now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `ALTER TABLE public.ca_diamond_snapshots ADD COLUMN register_supply numeric;` and set it inside `fn_ca_diamond_snapshot` from `public.fn_ca_mint_supply('diamonds')` in the same transaction as the `SUM(profiles.diamonds)` read. Then the equality is a stored fact per hour and D3/D13 have a clean basis.                                                                                                                                                                                                                         |
| D15 | `fn_purchase_time_banks(int)` legacy wrapper                                          | low                            | The 1-arg form calls `fn_purchase_time_banks_v2(p_quantity, gen_random_uuid())` - it **mints a fresh idempotency key on every call**, which defeats the receipt table `digital_purchase_receipts` that v2 exists to use. A double submit through the legacy signature charges twice. Both signatures are granted to `authenticated`.                                                                                                                                                                                                      | Live `fn_purchase_time_banks` body (211 chars, quoted in section 7). Not exercised: 0 diamond journal rows since 2026-09-03 with a time-bank description, type, transaction_type or `tbank` reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Drop the 1-arg overload once no client calls it, or make it refuse: `RETURN jsonb_build_object('success', false, 'error', 'Secure Request Id Required')`. Do not leave a door that looks idempotent and is not.                                                                                                                                                                                                                                                                                                                       |
| D16 | `DR2:balance_born_outside_the_mint`                                                   | noise                          | 1,341 open warnings, **100% cert**, `is_horse` false on every one, `db_role` postgres, ~230 to 320 per day and rising with cert-fleet churn. Correct to record; permanently unresolvable as a warning.                                                                                                                                                                                                                                                                                                                                    | Grouped query in section 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Scope the severity: `'warning'` when `NOT public.fn_ca_is_cert_account(NEW.id)`, `'info'` otherwise. Same row, same detail, so nothing is hidden.                                                                                                                                                                                                                                                                                                                                                                                     |
| D17 | `DR5:journal_row_deleted_under_maintenance`                                           | noise                          | 14,173 open `info` rows since 09-03, ~2,200 to 3,400 per day, all cert cleanup. Working as designed and the rows are safe in `ca_diamond_journal_archive`. But an incident table growing 3k/day with nothing resolving them will make the table useless for reading.                                                                                                                                                                                                                                                                      | Counts in section 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Either stop filing one incident per row and file one per cleanup batch with a count, or add a retention/auto-resolve sweep for `severity='info'` older than 7 days.                                                                                                                                                                                                                                                                                                                                                                   |
| D18 | `fn_union_send_to_member_zd3core`, `ca_promo_vault_buy`                               | medium (unchanged, still open) | Both are still the log-only paths Lane A shipped. The union diamond branch **credits up to 100,000 diamonds per call with no debit anywhere** and no mint row; `ca_promo_vault_buy` debits `club_diamond_wallets` with no journal row and **no idempotency key**, so a double-submit debits twice. Both were deliberately recorded rather than refused (Dan's decision 6.6).                                                                                                                                                              | Live bodies quoted in section 8. Neither has been exercised since 09-03: 0 rows in `diamond_transactions` with `source` like `%vault%` or type/transaction_type like `%union%`, 0 `DR3:club_diamond_debit_unjournaled` incidents, 0 `DR2:union_diamond_grant_unfunded` incidents.                                                                                                                                                                                                                                                                                                                                                                                                          | Unchanged recommendation: fund the union grant from the Mint (`fn_ca_mint(..., 'player', ...)`) or remove the `diamonds` kind, and give `ca_promo_vault_buy` a `p_request_id` plus a journal row. Both are Dan's call, both are still open, and neither is currently moving money.                                                                                                                                                                                                                                                    |
| D19 | `fn_ca_diamond_trial_balance`, `mirror_mismatch` note; `ca_diamond_dead_store_writes` | low                            | The `mirror_mismatch` note still tells the reader "the mirror trigger UPDATEs `diamond_wallets` without an upsert, so a profile that never had a row can never get one (audit lane 1, defect 2a)". That was fixed by Lane A itself on 09-03 and again on 09-07. The mirrors are now clean. Stale text inside a live diagnostic is how a wrong belief survives a fix.                                                                                                                                                                      | `profiles` = 1,193 rows: 0 missing a `user_diamonds` row, 0 missing `user_diamond_balance`, 0 missing `diamond_wallets`, 0 disagreeing on balance in any of the three. `DR10:mirror_mismatch` last fired 2026-09-07 03:10 and has not fired since the 03:51 migration.                                                                                                                                                                                                                                                                                                                                                                                                                     | Replace the trailing sentence of the `mirror_mismatch` note with the current truth: the trigger upserts all three legs on INSERT and on UPDATE since 2026-09-07, so a missing row now means a writer bypassed the trigger. Same for the `ca_diamond_dead_store_writes` `writer_evidence` strings, which are a frozen 2026-09-03 VALUES list.                                                                                                                                                                                          |
| D20 | `fn_ca_diamond_snapshot`                                                              | verified good                  | Live body is Lane A byte for byte. `total` equals `profile_diamonds` on 117 of the 118 rows since 09-03; the one exception is row id 53 (2026-09-03 00:10, `total` 1,649,971 vs `profile_diamonds` 1,030,092), written **before** the lane migration landed at 00:30 and therefore the double-counting bug Lane A was written to fix. Exactly one non-zero `unexplained` in five days (D13).                                                                                                                                              | Query in section 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Severity totals: **6 high** (D1, D2, D3, D4, D5, plus D3 counted once), **8 medium**
(D6, D7, D8, D9, D10, D11, D12, D13, D18), **4 low** (D14, D15, D19, and D13 partially),
**2 noise** (D16, D17), **1 verified good** (D20). Counting each id once: high 5,
medium 9, low 3, noise 2, clean 1.

Nothing in lanes A, B or G is currently losing or creating a diamond. The register and
the meter agree exactly. Every high-severity defect above is a **measurement** defect:
the alarms are lying about a system that is, as far as I can measure, correct.

---

## 2. The signup double-recording verdict

**It happened, it was measured, it was fixed on 2026-09-05 06:53, and it is closed.**

`handle_new_user` is unchanged from Lane B and still writes both its own
`signup:<uid>` journal row and its own `ca_mint_ledger` row. The reason that is not a
double record today is a three-layer dedupe, one layer of which was added by another
agent after the fact:

1. `zz_ca_diamond_born_with_balance` fires on the `profiles` INSERT and writes
   `ca_mint_ledger` op_id `seed:<uid>` for the 500.
2. `handle_new_user`'s own `ca_mint_ledger` insert is guarded by
   `NOT EXISTS (... WHERE m.op_id IN ('signup:'||uid, 'seed:'||uid))`, so it is skipped
   because step 1 already wrote `seed:`.
3. The trap was step 3: `trg_ca_diamond_register_follows_journal` fires on the
   `diamond_transactions` INSERT and calls `fn_ca_register_diamond_journal_row`, which
   writes a **third** op_id shape, `diamond-journal:<origin>:<tx_id>`, that the guard in
   step 2 does not check. That is the duplicate. It was closed inside
   `fn_ca_diamond_journal_origin`, which now returns NULL for the signup grant:
   `IF v_kind = 'signup_bonus' OR v_src = 'handle_new_user' THEN RETURN NULL; END IF;`

Proof, from the database:

```sql
-- the most recent signup, end to end
with p as (select id, username, created_at, diamonds from profiles
            where created_at >= '2026-09-06' order by created_at desc limit 1)
select p.id, p.username, p.created_at, p.diamonds,
  (select count(*) from diamond_transactions t where t.user_id = p.id)          journal_rows,
  (select count(*) from ca_diamond_journal_archive a where a.user_id = p.id)    archive_rows,
  (select jsonb_agg(jsonb_build_object('op_id', m.op_id, 'action', m.action,
                                       'amount', m.amount, 'label', m.performed_by_label)
                    order by m.created_at)
     from ca_mint_ledger m where m.holder_id = p.id and m.asset = 'diamonds')   mint_rows
from p;
```

`PostDeploya9518` (`2ebabdf6-...`), created 2026-09-07 21:30:45, diamonds 500:
**1 journal row, 0 archive rows, exactly 1 mint row** -
`seed:2ebabdf6-...`, mint, 500, by `zz_ca_diamond_born_with_balance`. One movement,
one journal row, one register row.

Historic scope of the bug:

```sql
select max(latest) latest_dup, count(*) n,
       count(*) filter (where latest > '2026-09-05 06:53:04') after_fix
  from (select holder_id, max(created_at) latest
          from ca_mint_ledger
         where asset='diamonds' and action='mint'
           and (op_id like 'seed:%' or op_id like 'signup:%' or reason like '%Signup Grant%')
         group by holder_id having count(*) > 1) x;
-- latest_dup 2026-09-05 06:13:45, n 18, after_fix 0
```

18 users, 9,000 diamonds, all before the fix, none after. The 9,000 (plus one
unretired cert seed) was retired by the `circulation` burn of 18,000 on
2026-09-05 06:53:04 described in section 6.

**Verdict: no double recording today. The residual defect is a design one:
`handle_new_user`'s guard checks two op_id shapes while three exist. If a future
migration re-enables the journal-follow origin for `signup_bonus`, the duplicate
returns and nothing structural stops it.** Recommend adding the third shape to the
guard as a belt: `NOT EXISTS (SELECT 1 FROM ca_mint_ledger m WHERE m.holder_id = NEW.id
AND m.asset='diamonds' AND m.action='mint' AND m.amount = 500 AND m.created_at > now() - interval '1 minute')`,
or better, a partial unique index expressing "one signup mint per holder".

---

## 3. `fn_ca_diamond_snapshot` and `ca_diamond_snapshots`

Live body md5 `ff7b31c85d1b60f2a0dfca18d03d7b7e` = Lane A file. Unchanged.

```sql
select count(*) rows_since_0903,
       count(*) filter (where total is distinct from profile_diamonds)      total_ne_profile,
       count(*) filter (where unexplained is not null and unexplained <> 0) nonzero_unexplained,
       min(taken_at), max(taken_at)
  from ca_diamond_snapshots where taken_at >= '2026-09-03';
-- 118 rows, 1 total_ne_profile, 1 nonzero_unexplained,
-- 2026-09-03 00:10:00 to 2026-09-07 21:10:03
```

- `total <> profile_diamonds` on exactly one row, id 53 at 2026-09-03 00:10:00,
  `total` 1,649,971 against `profile_diamonds` 1,030,092. That row was written
  **before** `20260903003036` landed, so it is the DR10 double-count Lane A removed.
  Every row from 01:10 onward has `total = profile_diamonds`. **The identity holds.**
- Exactly one non-zero `unexplained`: id 121, 2026-09-05 19:10, `-8000`. Fully
  explained in D13: a batch of 12 named test and probe profiles deleted at 18:10:28,
  8,500 diamonds, every one registered as a DR5 retirement burn in `ca_mint_ledger`,
  of which 8,000 belonged to accounts `fn_ca_is_cert_account` does not match. Not a
  leak; a blind spot in the drift formula.
- Line-by-line: the drift math reads `prev.profile_diamonds` as the basis rather than
  `prev.total`, exactly as the migration header argues, and `prev.profile_diamonds` is
  NOT NULL on all rows. The `v_basis_changed` guard (`ca_cert_accounts.tagged_at >
prev.taken_at`) nulls `unexplained` on a re-tag. The mirror check counts
  disagreements without ever adding them to supply. The incident thresholds are
  `abs > 50` warning / `abs > 5000` critical, and the -8,000 event correctly tripped
  critical. All correct.
- One thing the body does not do: it never records the register. See D14.
- Wiring: `cron.job` 201, `ca-diamond-snapshot-hourly`, `10 * * * *`,
  `SELECT public.fn_ca_diamond_snapshot()`, active. ACL is `postgres` and
  `service_role` only, which is Lane A's "the snapshot is not a browser RPC"
  (`20260903004002`) doing its job.

---

## 4. `fn_ca_mint_supply('diamonds')` against the meter

Right now, exactly equal:

```sql
select (select coalesce(sum(diamonds),0) from profiles)      profiles_sum,   -- 1023512
       public.fn_ca_mint_supply('diamonds')                  register,       -- 1023512.00
       (select coalesce(sum(diamonds),0) from profiles)
         - public.fn_ca_mint_supply('diamonds')              gap;            -- 0.00
```

Holder breakdown of the register: `player` **-599,905.00**, `house` **0.00**,
`circulation` **+1,623,417.00**, 8,630 rows.

Reconstructed hourly (`SUM(mint/burn) WHERE created_at <= snapshot.taken_at` against
`snapshot.profile_diamonds`), 09-05 07:10 to 09-07 21:10, 64 snapshots: **gap 0.00 at
56 of them**; the 8 exceptions are -500, -1000, -1500, -2000 and one +1900, all during
cert-fleet churn. Those are almost certainly in-flight transactions (the snapshot's
`SUM(profiles.diamonds)` cannot see an uncommitted profile insert, while my
reconstruction includes its `ca_mint_ledger` row because that row's `created_at` is
stamped inside the same uncommitted transaction). I cannot prove that from stored data,
which is the point of D14: **"has it been equal at every hour" is currently
un-provable, only re-constructible.** Label: UNVERIFIED for the 8 exceptions;
VERIFIED for the 56 and for the present instant.

### The two `circulation` rows that are not ours

Both are other agents' opening corrections, both are documented in their own `reason`
text, and both are honest:

| op_id                                                                | action | amount         | who                        | why                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------ | -------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register-opening-baseline-correction:diamonds:2026-09-05T04:17:53Z` | mint   | **611,325.00** | `migration 20260905041033` | The register read 419,282 against a meter of 1,030,607. The gap is the history the register never carried before the diamond journal fed it: purchases, rewards, refunds and spends written between the 09-03 baseline and 09-05, plus the archived journal of deleted certification accounts whose deletion burns retired more than their registered seeds. Balance_before 419,282 -> after 1,030,607. **No diamond moved.** |
| `register-opening-baseline-correction:diamonds:2026-09-05T06:53:04Z` | burn   | **18,000.00**  | `migration 20260905064901` | The register read 1,048,622 against a meter of 1,030,622. Two named causes, both closed by that migration: the signup grant registered twice (18 duplicate pairs, section 2) and one certification account whose balance was zeroed outside the journal and was then deleted holding 0, so its seed was never retired. Balance_before 1,048,622 -> after 1,030,622. **No diamond moved and no player balance changed.**       |

For completeness, the other three non-player rows are ours: the Lane B
`baseline:diamonds:2026-09-03` mint of 1,030,092 to `house`, its reversal by the P3
fix, and the P3 re-post `baseline:diamonds:2026-09-03:v2` to `circulation`. The P3
migration did what its name says: the pre-standard circulation is booked to
`circulation`, not to the house. `house_net` is 0.00, which is correct - nothing has
ever been issued to or from `ca_diamond_house`.

---

## 5. Lane B: `zz_ca_diamond_born_with_balance` and the cert fleet

Live function `fn_ca_diamond_born_with_balance()` md5 `8ee00da3` = Lane B file.
Trigger: `AFTER INSERT ON public.profiles FOR EACH ROW WHEN ((new.diamonds IS NOT NULL)
AND (new.diamonds <> 0))`. Both halves of the body sit in their own
`BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING` blocks, so it can never block a
signup. Correct.

```sql
select detail->>'db_role' role, detail->>'app_name' app, detail->>'is_horse' horse,
       count(*) n, sum(amount) amt
  from ca_diamond_incidents
 where rule = 'DR2:balance_born_outside_the_mint' group by 1,2,3;
-- postgres | '' | false | 1341 | 670500
```

1,341 DR2 incidents, 1,340 matching `ca_mint_ledger` rows
(`performed_by_label = 'zz_ca_diamond_born_with_balance'`, reason `balance present at
profile INSERT`, 670,000.00, 2026-09-03 01:53 to 2026-09-07 21:17). The one extra
incident is the birth at 21:30 whose ledger row I read separately in section 2.

**Is recording cert-fleet churn as mints double counting against the deletion burns?
No.** The deletion door retires _what was registered_, not the balance:

```
"profile deleted (retirement recorded by trigger, DR5): balance 0,
  registered attribution 500.00, retired 500.00"   -- 298 rows, 149,000
"profile deleted (retirement recorded by trigger, DR5): balance 1000,
  registered attribution 1500.00, retired 1500.00" -- 85 rows, 127,500
```

Seed 500 in, retire 500 out, net 0 per cert account. That is exactly why
`fn_ca_mint_supply('diamonds')` equals `SUM(profiles.diamonds)` to the diamond today.
The 2026-09-05 06:53 correction is what closed the one case where it did not (an
account zeroed outside the journal and deleted holding 0). **Correct accounting.**

### Cert fleet: how it is created and destroyed, and how much

`fn_ca_is_cert_account(uuid)` matches on three tests: uuid prefix
`00000000-0000-0000-0000-%`, an active row in `ca_cert_accounts`, or an
`auth.users.email` like `%@horses.smarter.poker` or `%.invalid`.

Functions in `pg_proc` that name `ca_cert_accounts` or carry `cert` in the name:
`cleanup_reserved_certification_account(uuid)` (4,342 chars),
`fn_ca_retire_certification_club(uuid,text)` (4,747),
`fn_ca_epoch3_cert_fleet_reset(text,boolean)` (1,561),
`fn_ca_is_cert_account(uuid)`, `fn_ca_diamond_snapshot()`.

Churn per day, from the incident stream:

| day        | births (DR2) | deletions (DR5 deleted_with_balance) | journal rows deleted (DR5) |
| ---------- | ------------ | ------------------------------------ | -------------------------- |
| 2026-09-03 | 269          | 128                                  | 2,959                      |
| 2026-09-04 | 296          | 147                                  | 3,432                      |
| 2026-09-05 | 234          | 127                                  | 2,735                      |
| 2026-09-06 | 317          | 185                                  | 2,843                      |
| 2026-09-07 | 224          | 131                                  | 2,205                      |

Every birth is `is_horse = false`, `db_role postgres`, empty `application_name` (the
auth trigger path). 1,339 of the 1,340 DR6 signup incidents are cert.

### Recommendation: how DR2, DR5, DR6, DR10 and DR11 should treat cert accounts

The standard says horses are players. It says **nothing** about certification harness
accounts, and they are not players: they are test fixtures created and destroyed
hundreds of times a day by our own harness, they hold no real money, they are deleted
along with their journal, and the chip standard already excludes them from drift math
through `fn_ca_is_cert_account`. Treating them as players is what has made 96 percent
of the diamond incident stream unreadable.

Proposed ruling, one line per rule:

- **DR2 (born outside the mint)** - keep recording every birth, cert or not; drop the
  severity to `info` when `fn_ca_is_cert_account(NEW.id)`. Rationale: the register row
  is written either way, so nothing is lost; only the alarm colour changes.
- **DR5 (deleted with a balance / journal row deleted)** - keep the archive and keep
  the retirement burn for cert accounts; that is what keeps the register honest. File
  **one** incident per cleanup batch with a row count instead of one per journal row.
- **DR6 (balance changed without journal)** - fire at `warning` for non-cert, at
  `info` for cert, under the distinct rule name `DR6:cert_harness_unjournaled`. Do not
  suppress cert entirely: the 151 direct PostgREST balance writes are a real harness
  defect and somebody should still fix it.
- **DR10 (supply drift / mirror mismatch)** - unchanged. It already nets cert out of
  the drift math on both sides and it is the one rule where cert exclusion is already
  correct. Add the register term from D13.
- **DR11 (trial balance)** - **exclude cert from both sides** and report the cert pool
  as its own account row. The snapshot already stores `cert_diamonds`, so the non-cert
  delta is `(v_now - v_cert_now) - (s0.profile_diamonds - s0.cert_diamonds)` and the
  non-cert journal is the same window filtered by `NOT fn_ca_is_cert_account(user_id)`.
  This is the single change that turns 38 permanent breaks into a signal.

This is a harness-scoping decision, not a player-treatment one, and it is the same
distinction Dan already accepted for chips. It does not touch horses in any way: a
horse is a player, is never excluded from anything, and `is_horse` is false on all
1,341 of these rows.

---

## 6. Lane G: the controls

### `fn_ca_audit_diamond_change` (DR6)

Live md5 `82071ee5` = Lane G file `20260903003714`. Body reviewed line by line.

Correct and worth keeping: the INSERT/UPDATE branches are **nested**, not combined, with
the comment explaining why (PL/pgSQL evaluates a whole `IF` condition as one SQL
expression, so a single condition naming `OLD` would raise on every insert). The
`PG_CONTEXT` writer extraction correctly skips its own frame. The whole thing is
wrapped so it can never block a diamond write, and a failure lands in
`ca_ledger_write_failures` rather than in silence.

The gate list, verbatim from the live body:

```
('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
 'send_wallet_diamond_transfer', 'send_stream_gift',
 'claim_daily_challenge', 'claim_daily_challenges')
```

1,555 DR6 incidents, by writer, with the verdict for each:

| writer                                   | n                               | cert         | amount   | right to fire?                                                                                                                                                               |
| ---------------------------------------- | ------------------------------- | ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handle_new_user`                        | 1,340 (1,339 cert + 1 non-cert) | yes          | +670,000 | **No.** Journals in the same transaction, a few statements later. Missing from the gate list. D4.                                                                            |
| `(no function frame)`                    | 151                             | all cert     | -67,775  | **Yes.** A direct `UPDATE profiles SET diamonds` over PostgREST 14.5, `db_role postgres`, no journal row anywhere. A real unjournaled writer. D8.                            |
| `claim_daily_challenges_serialized_body` | 48                              | all cert     | +41,094  | **No.** It journals (1 `INSERT INTO public.diamond_transactions`). The gate list names `claim_daily_challenges`, not the `_serialized_body` name the live frame reports. D5. |
| `award_diamonds_v2`                      | 16                              | **non-cert** | +930     | **No.** It journals. Absent from the gate list entirely. D6.                                                                                                                 |

So 1,404 of 1,555 (90 percent) are wrong to fire, 151 (10 percent) are right to fire
and are all cert-harness noise, and the number of real non-cert unjournaled diamond
writes found in five days is **zero**.

### `fn_ca_diamond_trial_balance` and `fn_ca_diamond_trial_balance_watch`

Both live md5s equal their lane files. The watch is wired at `cron.job` 247,
`ca-diamond-trial-balance-hourly`, `20 * * * *`, guarded by
`pg_try_advisory_lock(hashtext('ca-diamond-trial-balance'))`, active. It has run 118
times (one `DR11:trial_balance_summary` info row per run) and has never returned -1,
so the function has not thrown.

Structurally the function is careful in ways worth preserving: it discovers
`ca_diamond_house_ledger`'s column names rather than assuming them (that table really
is `(at, delta)` and the guess was `(created_at, amount)`), it wraps every account in
its own `EXCEPTION` block so a missing table degrades to a `'table absent'` row instead
of killing the report, it excludes `mirror_mismatch`, `dead_stores`,
`promo_budgets_spent` and `suspense` from the total and says so in the total's own
note, and the `suspense` row correctly starts at the foundation timestamp
`2026-09-03 00:07:00+00` because `counterparty` did not exist before that.

The 38 open `DR11:trial_balance_break` rows on `player_diamonds`, all negative, have
exactly three mechanisms, in descending size:

1. **Cert-fleet births and deaths, unjournalable by construction** (D3). A profile born
   holding 500 writes a `seed:` register row and no journal row at all. A profile
   deleted takes its journal rows with it. Between 2026-09-03 and now,
   `diamond_transactions` gained **18** rows while `ca_diamond_journal_archive` gained
   **14,167**. `journal_net` is reading roughly 0.1 percent of the movement.
2. **The window mismatch** (D1). Ten minutes of balance against sixty minutes of
   journal. Visible in its purest form at 2026-09-07 18:20: `balance_delta` 0,
   `journal_net` 500, `difference` -500, on a window where nothing at all happened to
   the meter.
3. **The archive is not read** (D2). Even with the windows aligned, `journal_net` for
   21:10-21:20 is 0 from the live table and -2,359 from the archive.

Worked evidence for the most recent break (window 21:10:03 to 21:20:01, snapshot
`profile_diamonds` 1,031,612, meter now 1,023,512):

| measure                                     | value                                              |
| ------------------------------------------- | -------------------------------------------------- |
| `balance_delta`                             | -8,100                                             |
| journal, as shipped (live table, 1h window) | +500 -> **difference -8,600** (the filed incident) |
| journal, aligned to `s0` (live table only)  | 0                                                  |
| journal, aligned + archive                  | -2,359 -> difference -5,741                        |
| **register** `mint_net`, aligned            | **-9,600** -> **difference +1,500**                |

The +1,500 residue is three profile inserts of 500 straddling the snapshot instant, the
same skew as D14. **The register explains the movement to within transaction-boundary
noise; the journal cannot explain it at all.** That is the whole argument for D3.

The exact fix that makes the difference honest without hiding a real break, in one
place:

```sql
-- inside fn_ca_diamond_trial_balance, player_diamonds block
SELECT COALESCE(SUM(dt.amount), 0)::numeric INTO v_jrn
  FROM (SELECT amount, created_at, user_id FROM public.diamond_transactions
        UNION ALL
        SELECT amount, created_at, user_id FROM public.ca_diamond_journal_archive) dt
 WHERE dt.created_at >= COALESCE(s0.taken_at, v_since)
   AND dt.created_at <  now()
   AND NOT public.fn_ca_is_cert_account(dt.user_id);

SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0)::numeric
  INTO v_mint FROM public.ca_mint_ledger ml
 WHERE ml.asset = 'diamonds' AND ml.holder_type = 'player'
   AND ml.created_at >= COALESCE(s0.taken_at, v_since) AND ml.created_at < now()
   AND NOT public.fn_ca_is_cert_account(ml.holder_id);

-- and the non-cert balance delta, using the cert column the snapshot already stores
v_delta := (v_now - v_cert_now) - (s0.profile_diamonds - COALESCE(s0.cert_diamonds, 0));

-- difference is measured against the COMPLETE record (the register), not the
-- one-sided journal; the journal gap is reported beside it, never as the break
RETURN QUERY SELECT 'player_diamonds'::text, v_now, v_delta, v_jrn, v_mint,
                    CASE WHEN v_delta IS NULL THEN NULL ELSE v_delta - v_mint END, v_note;
```

Nothing is hidden by this. A real unjournaled write by a real player still moves
`v_delta` without moving `v_mint` and still breaks the row. What stops breaking is the
cert harness and the arithmetic.

### `ca_manual_adjustments.asset` and `fn_ca_propose_manual_adjustment`

Live md5 `aa37244b` = Lane G file. `asset text NOT NULL DEFAULT 'chips'` with
`CHECK (asset = ANY (ARRAY['chips','diamonds']))` and, better, a cross-column check
that makes the pair impossible to get wrong:

```
ca_manual_adjustments_asset_matches_target
  CHECK ((asset = 'diamonds') = (target_kind = ANY (ARRAY['diamond_wallet','diamond_house'])))
```

The function derives the asset from `target_kind` and compares `p_asset` rather than
trusting it, refuses a fractional diamond, requires management
(`fn_ca_caller_is_management`), a 20-character reason, and raises a financial alert on
every proposal. Four-eyes is a table constraint (`approver <> actor`) so it cannot be
bypassed by a future caller. **Correct.** 6 rows in the table, 0 of them diamonds, so
the diamond path is untested in production. UNVERIFIED end to end.

### `ca_payout_freeze` scopes

`CHECK (scope = ANY (ARRAY['tournament_payouts','bbj_payouts','diamond_issuance',
'diamond_tournament_payouts','arena_withdrawals']))`, `reason >= 10 chars`,
`cleared_at >= opened_at`. `fn_ca_open_payout_freeze` is management-only, idempotent
(returns `already_open` on an existing uncleared row, taken `FOR UPDATE`), and raises a
`warning` financial alert with a stable `freeze:<id>` key. All good.

**The defect is that the two diamond scopes are inert.** See D11. 0 freezes are
currently open.

### `ca_diamond_dead_store_writes`

A view over a hardcoded `VALUES` list of six dead stores joined to
`pg_stat_user_tables`, giving live `n_tup_ins/upd/del` counters per store. That is the
right shape for a seven-day-of-zero-writes delete gate. The `writer_evidence` strings
are a frozen 2026-09-03 investigation and one of them will go stale the moment
`ca_promo_vault_buy` or `fn_union_send_to_member_zd3core` changes. D19.

Caveat worth writing down: `pg_stat_user_tables` counters **reset on
`pg_stat_reset()` and on a crash recovery**, so a zero reading is not proof of seven
quiet days on its own. The gate should also compare `last_autoanalyze` (which the view
already exposes) or record its own high-water mark.

---

## 7. Lane A: the doors

### `fn_purchase_time_banks`

Live body, in full (211 chars):

```sql
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;
  RETURN public.fn_purchase_time_banks_v2(p_quantity, gen_random_uuid());
END;
```

Replaced by Lane D `20260903003327_diamond_d_purchase_clearing` the same night.
Lane A's intent survives inside `fn_purchase_time_banks_v2(int, uuid)`, which is
stronger than what Lane A shipped: an advisory lock per
`(caller, request_id)`, a `digital_purchase_receipts` row that makes a replay return
`total_cost 0, idempotent true, granted false`, a `REQUEST_ID_REUSED` refusal when the
same key arrives with a different payload, a lifetime-VIP free path added
2026-09-07 by `marketplace_phase8_lifetime_vip_unlimited_digital_benefits`, and the
price still read from `feature_pricing WHERE feature = 'time_bank_seconds'` with
explicit `NULL` ("Time Bank Pricing Not Configured") and negative
("Time Bank Pricing Is Invalid") refusals. The charge goes through `deduct_diamonds`
with `counterparty 'revenue:feature_purchase'` and `issuance_class 'spend'` in the
metadata, so it journals. Every message is Title Case with no em dash, per section 5.7.

**Live use since 2026-09-03: none.** 0 rows in `diamond_transactions` with a
time-bank description, type, transaction*type or `tbank*` reference. The defect in the
legacy 1-arg wrapper (D15) is therefore latent.

### `fn_union_send_to_member_zd3core`

Live md5 `9c3ad0f1` = Lane A file exactly. The DR2 branch Lane A added is present and
intact:

```sql
if p_kind = 'diamonds' then
  if p_amount <> floor(p_amount) then ... 'diamonds must be a whole number' end if;
  if p_amount > 100000 then ... 'maximum 100,000 diamonds per send' end if;
  /* DR2, LOG-ONLY (2026-09-03). This credit has no debit ... */
  perform public.fn_ca_diamond_incident(
    'DR2:union_diamond_grant_unfunded', 'warning', p_target_user_id, p_amount,
    'fn_union_send_to_member_zd3core', jsonb_build_object(...));
  update profiles set diamonds = coalesce(diamonds,0) + p_amount where id = p_target_user_id
  returning diamonds into v_dia_after;
  ...
  insert into diamond_transactions (... 'union_grant', 'union', ...)
```

Wiring note: the incident is raised **before** the balance moves, so if the update
fails the incident is still filed. That is the right order for a log-only recorder
(over-report, never under-report), and `fn_ca_diamond_incident` swallows its own
failures, so it cannot break a live grant. ACL is `postgres` and `service_role` only,
so this is a server-side path.

**Live use since 2026-09-03: none.** 0 `DR2:union_diamond_grant_unfunded` incidents,
0 `diamond_transactions` rows with a union type. The unfunded-issuance hole is real and
open (D18) and nobody has walked through it.

### `ca_promo_vault_buy`

Live md5 `6050f6a6` = Lane A file exactly. The `DR3:club_diamond_debit_unjournaled`
info incident is present and correctly placed before the debit. Granted to
`authenticated`, `SECURITY DEFINER`, gated on `fn_promo_vault_can_manage(p_club_id)`.

**Live use since 2026-09-03: none.** 0 `DR3` incidents. `club_diamond_wallets` still
holds 2 rows at 0.00, unchanged since creation.

---

## 8. Lane A mirrors: current state (all clean)

```sql
select count(*) profiles,
  count(*) filter (where not exists (select 1 from user_diamonds m        where m.user_id = p.id)) miss_ud,
  count(*) filter (where not exists (select 1 from user_diamond_balance m where m.user_id = p.id)) miss_udb,
  count(*) filter (where not exists (select 1 from diamond_wallets m      where m.user_id = p.id)) miss_dw,
  count(*) filter (where exists (select 1 from user_diamonds m   where m.user_id = p.id
                     and m.balance is distinct from greatest(coalesce(p.diamonds,0),0))) ne_ud,
  count(*) filter (where exists (select 1 from diamond_wallets m where m.user_id = p.id
                     and m.balance is distinct from greatest(coalesce(p.diamonds,0),0)::int)) ne_dw
from profiles p;
-- 1193, 0, 0, 0, 0, 0
```

`DR10:mirror_mismatch` fired 94 times between 2026-09-03 06:10 and 2026-09-07 03:10 and
has not fired since `20260907035121` landed at 03:51. Lane A's diagnosis (the
`diamond_wallets` leg was a bare UPDATE, so 892 of 1,308 profiles could never gain a
row) was correct, Lane A's upsert fixed the UPDATE path, and the 09-07 migration
finished the job by making the trigger fire on INSERT as well. Also relevant:
`initialize_user_diamonds` was writing a literal `(100, 100)` into `user_diamonds` and
now reads the canonical store, fixed by `20260907035309 a_mirror_never_invents_a_number`.

The one thing that migration introduced is D10: no exception handler on a trigger that
now runs during profile creation, against two tables with FKs to `auth.users`.

---

## 9. What I did not verify

- The 8 non-zero hourly register/meter reconstructions (section 4). My explanation
  (in-flight transactions, backdated `ca_mint_ledger.created_at`) is consistent with
  every observation but is **UNVERIFIED**; D14 is the change that would settle it.
- `fn_ca_propose_manual_adjustment` on a `diamond_wallet` target and
  `fn_ca_open_payout_freeze` on `diamond_issuance`: no production rows exist, so both
  diamond paths are **UNVERIFIED** end to end. I did not probe them, because a probe
  would have written a row (section 11.5).
- `fn_ca_mint` / `fn_ca_burn` on `destination = 'house'`: never exercised
  (`house_net` 0.00, `ca_diamond_house_ledger` 0 rows). D9 is read from the body, not
  from behaviour.
- Client-side wiring (`src/` in the Club Arena repo). Out of my scope; another
  reviewer has it.
- Whether the `claim_daily_challenges_serialized_body` and `award_diamonds_v2` journal
  inserts land _after_ the profiles UPDATE. I inferred it from DR6 firing at all
  (`v_journaled` false at trigger time) plus a single `INSERT INTO
public.diamond_transactions` in each body; I did not read the full 30KB
  `award_diamonds_v2`. **UNVERIFIED in detail, VERIFIED in effect.**
