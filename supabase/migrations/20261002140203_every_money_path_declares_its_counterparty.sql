-- 20261002140203_every_money_path_declares_its_counterparty
--
-- ===========================================================================
--  EVERY MONEY PATH DECLARES ITS COUNTERPARTY
-- ===========================================================================
--
-- Dan, 2026-10-01: "fix any and all issues with the chip drift ... chip
-- drifts should not be possible." Launch plan phase 1b.
--
-- THE DEFECT. Since 20261002073930 (08:36:58 UTC today) a transaction that
-- writes a chip_ledger leg against settlement_suspense AND moves a covered
-- balance does not commit. The journal triggers (fn_ca_autoledger,
-- fn_club_members_ledger_writer) fall to settlement_suspense whenever the
-- writer named no counterparty. fn_ca_ratchet_watch raised incident 36991212
-- when fn_ca_undeclared_money_paths() rose 80 -> 86 rows: 86 (function,
-- table, column) rows over 52 functions, each one a path that would now be
-- refused the first time it ran.
--
-- WHAT THE ROWS SAID (read 2026-10-02 13:42-14:10 UTC)
--   * chip_ledger, 30 days: the last settlement_suspense leg written by any
--     live door is 2026-09-14 06:27 (the weekly close). Nothing has been
--     refused live since 07:36 (postgres_logs: only rolled-back probes).
--     The 86 are rare doors and dead doors, not today's traffic.
--   * The producer MISCOUNTED both ways. It matched a function on the word
--     "UPDATE <table>" anywhere and the column name anywhere, so a function
--     that reads chip_balance and updates club_members.role (fn_agent_attach_
--     player, fn_remove_settled_club_member, fn_club_set_member_role,
--     fn_club_owner_has_a_player_wallet, fn_resolve_bbj_pool) counted as a
--     money path. And it did not know the second declaration contract that
--     fn_ca_undeclared_leg_check itself names: a door that stands its trigger
--     down with app.ledger_autoskip_<table> and writes its own named leg
--     (fn_settle_accounting_*, fn_horse_*_before_maintenance_gate,
--     fn_ca_backpay_guarantee_shortfalls, fn_ca_return_excess_start_overlay_
--     locked, fn_spin_deactivate, promo_apply_playthrough, fn_ca_alarm_drill).
--     15 of the 52 functions are those two miscounts.
--   * The 37 that really move a covered balance undeclared, by fact:
--       25 dead doors: no caller in pg_proc (other than name lists in guards),
--          no cron.job, no reachable engine/hub/client caller (closed
--          EXECUTE, a dead export, or a hub route nothing calls), 0 calls
--          since the 2026-09-28 pg_stat_statements reset.        -> RETIRED
--        5 generic primitives whose counterparty is the CALLER's to name
--          (a wallet debit/credit, a treasury debit/credit). Every live
--          caller already declares (fn_credit_and_log, the tournament
--          registrars, fn_union_weekly_rakeback_close, fn_accounting_legacy_
--          pay_week). They now refuse BY NAME before moving anything when
--          nothing is declared, instead of being refused anonymously at
--          commit.                                               -> GUARDED
--        6 live doors with an inherent counterparty: fn_member_leave_to_
--          treasury (wallet -> club treasury), fn_seed_horses_to_floor
--          (treasury -> horse wallets), fn_spin_activate (owner wallet ->
--          spin pool), fn_spin_absorb_club_pool_into_union (spin pool ->
--          treasury), fn_close_club_wallets_on_union_join (BBJ pool and promo
--          float -> treasury), fn_spin_reserve_wallet_fund (union main bank ->
--          union spin reserve). Each now names it in the same transaction and
--          puts back whatever its caller had declared.            -> DECLARED
--        1 self-test that only writes inside a sub-block it always rolls back
--          (fn_bbj_selftest_payout_conservation).        -> registry 'system'
--   * fn_union_credit_wallet_zd3core: an unmapped tx_type declared nothing and
--     fell to suspense. Its only caller with a tx_type outside the map is the
--     World Hub settle-period union hold ('settlement_hold'), a two-RPC
--     transfer (fn_debit_treasury, then this) that cannot balance in either
--     transaction and has not run in 30 days. An unmapped tx_type is now
--     refused by name before the write. Nothing is mapped to suspense.
--
-- PROOF BEFORE THIS FILE (one rolled-back DO block each, live refuse mode,
-- 14:02-14:09 UTC): an undeclared +0.01 member credit read suspense 0.01 in
-- the transaction tally (control); each declared pattern below read
-- settlement_suspense 0 and every account balance = its legs:
--   seed horses 0.50 / member leave 5,000.00 and 72,507.20 (zero then
--   delete) / spin absorb 200.00 / spin activate 50.00 / union-join BBJ
--   100.00 + promo 3.00 / spin reserve fund promo 1.00 + main bank 2.00
--   (the first main-bank variant, a union_wallet-row counterparty, was
--   refused by the invoice issuer: accounting_invoice_recipient_missing; the
--   shape below names the union, as every declaring union payer does).
--
-- A preimage block asserts the md5 of every body this file replaces, and the
-- post block asserts fn_ca_undeclared_money_paths() is empty. Functions only,
-- one transaction: no table, trigger or policy is created, altered or dropped.
-- Nothing is dropped. No balance is moved by this file.
-- ===========================================================================
-- @live-proof: (SELECT count(*) FROM public.fn_ca_undeclared_money_paths()) = 0

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  r record;
  v_live text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('atomic_tournament_register',              '183aeb5c686c1953c16521e78b31e791'),
      ('credit_club_wallet_rake',                 '5bdfcb622f87e79fba9e11514ca1c50a'),
      ('decrement_club_treasury',                 '26483e9a2118c469b73e19eb1b439089'),
      ('deduct_chip_balance',                     '335cc4d3feec11854ab523de00dc9f67'),
      ('distribute_chips',                        '5a85876871114818dc9e3be605bd2a2f'),
      ('fn_add_chips',                            '5192634c92d6dc39c60dd12670bd0540'),
      ('fn_cashier_claim_back',                   'c4b282258dcbd62a3b78343bdcb2921a'),
      ('fn_cashier_send_chips',                   '49384b569256d67d27829787b5247114'),
      ('fn_debit_chips',                          '72cca0066130459c0eccc9432963df1a'),
      ('fn_leave_club_atomic',                    '1f90fc30a27f8159a27699d427f385ad'),
      ('fn_reject_cashout',                       'b96d1aff70d8a13b01a2015ccd9aa54f'),
      ('fn_spin_reserve_seed_from_union',         '019b56fe705a825b01cbbc3555e4e684'),
      ('fn_tournament_atomic_register',           'c92af85df41906063958185a4250a130'),
      ('fn_union_distribute_promo',               'fa2a61bcb645324b85c319b4a2ef53b2'),
      ('fn_union_fund_promo_from_bank',           '386101adb34d63834273d2ac86d42612'),
      ('fn_wallet_claim_back',                    '350f50a08e0cd51c9c0dfda19ad0eeeb'),
      ('increment_union_chip_balance',            '5b50b12a4fe7cf2efa7b27ebd233d99c'),
      ('lock_chips_for_table',                    '5e2e47b0f85e1afabb685344fef01f75'),
      ('mass_fund_horses',                        '0dc190e9a2249f5495e4f7f3b1a18f1c'),
      ('mint_club_chips',                         '143f7fa683258c3f88c1f0beef1e9087'),
      ('record_rake',                             '08b41453b5560ecf6c22c57bc5aa062d'),
      ('redeem_promo_to_chips',                   'dcc43bade05a1cc833e864784a25d4c4'),
      ('spin_pool_draw',                          '2fa4bcab52d37544dbd3d1615acef376'),
      ('transfer_promo_agent_to_player',          '273e7159bfcfd16004f585370df09c12'),
      ('unlock_chips_from_table',                 '96124b367cdb7031bac3d36425adf0b0'),
      ('atomic_deduct_wallet_and_log',            'ab3d8e4c0baac59e7194319ffceba71e'),
      ('fn_credit_chips',                         'bc7dd5e4860d89a09e53dc0de55231b6'),
      ('fn_credit_player_wallet_once',            '150e637deab4cc7b4170470d912c0b23'),
      ('fn_credit_treasury_zd4core',              'd3b40c9a7746d1976607013c4dd4ba96'),
      ('fn_debit_treasury',                       'eb5ad4cf85381ec4e7f88ffeb8436af3'),
      ('fn_member_leave_to_treasury',             'b74f9573f2c205175b4c69c8717e5d61'),
      ('fn_seed_horses_to_floor',                 '4a4246864c566b96996e1abfd44a6718'),
      ('fn_spin_activate',                        '1c2fc703ff3397be63d9158fd8619300'),
      ('fn_spin_absorb_club_pool_into_union',     '597e55406f936b64a129f327707422ea'),
      ('fn_close_club_wallets_on_union_join',     '4e685839b7d680046946813574437881'),
      ('fn_spin_reserve_wallet_fund',             '7f56b303f79743b2f11427dfde4a3c5c'),
      ('fn_union_credit_wallet_zd3core',          '70481ca76c7265f6351ed1d512bd6218'),
      ('fn_ca_undeclared_money_paths',            'f4f1d53ea0a5dd835a8fec1f477ea1d2')) AS x(f, m)
  LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.f;
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the body this file was written against (md5 %, expected %); re-read it', r.f, v_live, r.m;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('fn_ca_ledger_declaration_save', 'fn_ca_ledger_declaration_restore')) THEN
    RAISE EXCEPTION 'preimage: the declaration save/restore helpers already exist; read them before replacing';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. A door that names its own counterparty puts back what its caller named.
--    The declaration GUCs are transaction-scoped, so a door that declares and
--    then clears (as fn_union_credit_wallet_zd3core does) erases a caller's
--    declaration for every write after it. These two carry it across.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_declaration_save(p_autoskip_tables text[] DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  t text;
BEGIN
  v := jsonb_build_object(
    'app.ledger_category',            COALESCE(current_setting('app.ledger_category', true), ''),
    'app.ledger_counterparty',        COALESCE(current_setting('app.ledger_counterparty', true), ''),
    'app.ledger_counterparty_entity', COALESCE(current_setting('app.ledger_counterparty_entity', true), ''));
  IF p_autoskip_tables IS NOT NULL THEN
    FOREACH t IN ARRAY p_autoskip_tables LOOP
      IF t !~ '^[a-z_]+$' THEN
        RAISE EXCEPTION 'fn_ca_ledger_declaration_save: bad autoskip table name %', t;
      END IF;
      v := v || jsonb_build_object('app.ledger_autoskip_' || t,
                                   COALESCE(current_setting('app.ledger_autoskip_' || t, true), ''));
    END LOOP;
  END IF;
  RETURN v;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_declaration_restore(p_saved jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT key, value FROM jsonb_each_text(COALESCE(p_saved, '{}'::jsonb)) LOOP
    IF r.key !~ '^app\.ledger_(category|counterparty|counterparty_entity|autoskip_[a-z_]+)$' THEN
      RAISE EXCEPTION 'fn_ca_ledger_declaration_restore: % is not a ledger declaration setting', r.key;
    END IF;
    PERFORM set_config(r.key, COALESCE(r.value, ''), true);
  END LOOP;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_ledger_declaration_save(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_declaration_restore(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_declaration_save(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_declaration_restore(jsonb) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_ledger_declaration_save', 'system',
   '20261002140203: reads the transaction-scoped ledger declaration settings; moves no money'),
  ('fn_ca_ledger_declaration_restore', 'system',
   '20261002140203: puts back the ledger declaration settings a door found on entry; moves no money')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. RETIRED: 25 doors nothing calls. Each keeps its signature, moves
--    nothing, and answers <name>_retired - the way fn_clawback_chips_atomic
--    was retired - so a stray caller gets a name instead of a commit-time
--    refusal. Nothing is dropped: a function another tree still names must
--    not vanish under it.
--    "Nothing calls" means, measured 2026-10-02: no pg_proc caller other than
--    a name list in a guard, no cron.job, 0 calls since the 2026-09-28
--    pg_stat_statements reset, and no reachable caller in the engine, the
--    client or the World Hub (EXECUTE closed to the caller's role, a dead
--    export, or a hub route nothing calls).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.atomic_tournament_register(p_tournament_id uuid, p_user_id uuid, p_username text, p_total_cost numeric, p_current_bounty numeric, p_mystery_bounty_value numeric, p_is_bounty_tournament boolean, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A tournament entry debit that named
     no counterparty; EXECUTE was already closed to every client role and no
     function calls it. Registration is fn_register_for_tournament. Nothing
     is moved here. */
  RAISE EXCEPTION 'atomic_tournament_register_retired'
    USING ERRCODE = '0A000', HINT = 'Register through fn_register_for_tournament.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.credit_club_wallet_rake(p_club_id uuid, p_rake numeric, p_bbj numeric DEFAULT 0, p_hand_id uuid DEFAULT NULL::uuid, p_hand_number integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Credited club_wallets.chip_balance
     with net rake and named no counterparty. Its only caller is
     logRakeCollection in server/src/services/supabase/rake.ts, which nothing
     calls: hand rake is settled inside the atomic hand commit. Nothing is
     moved here. */
  RAISE EXCEPTION 'credit_club_wallet_rake_retired'
    USING ERRCODE = '0A000', HINT = 'Rake is credited by the atomic hand commit.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_club_treasury(p_club_id uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A bare treasury debit with no
     counterparty and no caller anywhere. Nothing is moved here. */
  RAISE EXCEPTION 'decrement_club_treasury_retired'
    USING ERRCODE = '0A000', HINT = 'A treasury debit belongs to the door that knows where the chips go.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.deduct_chip_balance(p_club_id uuid, p_user_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A bare wallet debit with no
     counterparty and no caller; EXECUTE was closed. Nothing is moved here. */
  RAISE EXCEPTION 'deduct_chip_balance_retired'
    USING ERRCODE = '0A000', HINT = 'A wallet debit belongs to the door that knows where the chips go.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.distribute_chips(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_distributed_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Moved clubs.chip_pool to a member
     with no counterparty; closed since 2026-09-04 (chip std 3.3), no caller.
     The Club Bank send is fn_club_bank_send. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'distribute_chips_retired',
    'message', 'Use the Club Bank send (fn_club_bank_send)');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_add_chips(p_user_id uuid, p_club_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A bare wallet credit with no
     counterparty. fn_leave_seat_and_refund no longer calls it; nothing does.
     Nothing is moved here. */
  RAISE EXCEPTION 'fn_add_chips_retired'
    USING ERRCODE = '0A000', HINT = 'A wallet credit belongs to the door that knows where the chips come from.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashier_claim_back(p_club_id uuid, p_from_user_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A peer wallet move that named no
     counterparty. It required auth.uid() but EXECUTE was granted only to
     service_role (which has none), so no caller could reach it. The claim
     back is fn_club_bank_claim_back / fn_agent_wallet_claim_back. Nothing is
     moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_cashier_claim_back_retired',
    'message', 'Use the Club Bank claim back (fn_club_bank_claim_back) or the agent wallet claim back (fn_agent_wallet_claim_back)');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashier_send_chips(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A peer wallet move that named no
     counterparty. It required auth.uid() but EXECUTE was granted only to
     service_role, so no caller could reach it. The send is fn_club_bank_send
     / fn_agent_wallet_send. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_cashier_send_chips_retired',
    'message', 'Use the Club Bank send (fn_club_bank_send) or the agent wallet send');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_debit_chips(p_club_id uuid, p_user_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A bare wallet debit with no
     counterparty. Its only caller was the World Hub leave-club route, which
     nothing calls; leaving a club is fn_member_leave_to_treasury. Nothing is
     moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_debit_chips_retired',
    'message', 'Leave a club through fn_member_leave_to_treasury');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_leave_club_atomic(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Superseded by
     fn_member_leave_to_treasury, which now names the counterparty; no caller.
     Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_leave_club_atomic_retired',
    'message', 'Leave a club through fn_member_leave_to_treasury');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_reject_cashout(p_cashout_id uuid, p_agent_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Refunded a rejected cashout into the
     player wallet with no counterparty. public.cashout_requests holds no
     row at all, and nothing calls this. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_reject_cashout_retired',
    'message', 'Cashout requests are not served by this door');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_reserve_seed_from_union(p_union_id uuid, p_club_id uuid, p_amount numeric, p_highest_stake numeric DEFAULT NULL::numeric, p_ceiling numeric DEFAULT NULL::numeric, p_wallet text DEFAULT 'spin_reserve_wallet'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Seeded a union Spin pool with no
     counterparty; no caller in the database, the engine, the client or the
     World Hub. A union seeds its Spins through fn_spin_activate. Nothing is
     moved here. */
  RETURN jsonb_build_object('ok', false, 'success', false,
    'reason', 'fn_spin_reserve_seed_from_union_retired',
    'error', 'fn_spin_reserve_seed_from_union_retired',
    'message', 'Seed Spins through fn_spin_activate');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_atomic_register(p_user_id uuid, p_club_id uuid, p_tournament_id uuid, p_buy_in numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A tournament entry debit with no
     counterparty; EXECUTE closed, no caller. Registration is
     fn_register_for_tournament. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_tournament_atomic_register_retired',
    'message', 'Register through fn_register_for_tournament');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_distribute_promo(p_union_id uuid, p_target_kind text, p_target_id uuid, p_amount numeric, p_agent_club_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Moved the union promo wallet to a
     club or agent with no counterparty. Its callers are mint_club_promo
     (closed) and the World Hub distribute-promo route, which nothing calls.
     The union promo send is fn_union_promo_send. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_union_distribute_promo_retired',
    'message', 'Use the union promo send (fn_union_promo_send)');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_fund_promo_from_bank(p_union_id uuid, p_amount numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Moved union main bank to the union
     promo wallet with no counterparty; nothing calls it (only a comment in
     fn_union_send_chips_to_club names it). Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_union_fund_promo_from_bank_retired',
    'message', 'Use the union promo send (fn_union_promo_send)');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_wallet_claim_back(p_club_id uuid, p_from_user_id uuid, p_amount numeric, p_target_wallet text, p_source_wallet text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Closed; its only caller was
     fn_cashier_claim_back, retired above. The claim back is
     fn_club_bank_claim_back / fn_agent_wallet_claim_back. Nothing is moved
     here. */
  RETURN jsonb_build_object('success', false, 'error', 'fn_wallet_claim_back_retired',
    'message', 'Use the Club Bank claim back (fn_club_bank_claim_back) or the agent wallet claim back (fn_agent_wallet_claim_back)');
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment_union_chip_balance(p_union_id uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A bare union bank credit with no
     counterparty; closed, no caller. Nothing is moved here. */
  RAISE EXCEPTION 'increment_union_chip_balance_retired'
    USING ERRCODE = '0A000', HINT = 'A union credit belongs to the door that knows where the chips come from.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.lock_chips_for_table(p_club_id uuid, p_user_id uuid, p_table_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). The legacy World Hub table-chips
     buy-in: a wallet debit that put the chips nowhere. Nothing calls the
     route; buy-ins are atomic_table_buyin. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'lock_chips_for_table_retired',
    'message', 'Buy in through atomic_table_buyin');
END;
$function$;

CREATE OR REPLACE FUNCTION public.mass_fund_horses(p_club_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Credited horse wallets from nowhere;
     closed, no caller. Horses are funded from their club treasury by
     fn_horse_fund_from_treasury, exactly as a human is funded. Nothing is
     moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'mass_fund_horses_retired',
    'message', 'Fund a horse through fn_horse_fund_from_treasury');
END;
$function$;

CREATE OR REPLACE FUNCTION public.mint_club_chips(p_club_id uuid, p_amount numeric, p_minted_by uuid DEFAULT NULL::uuid, p_diamonds_cost numeric DEFAULT 0, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). A free mint into clubs.chip_pool
     with no counterparty; closed since 2026-09-04 and EXECUTE held only by
     postgres, so the World Hub mint-chips route could not reach it. Chips
     are minted by fn_mint_chips_from_diamonds.
     Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'mint_club_chips_retired',
    'message', 'Mint through fn_mint_chips_from_diamonds');
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_rake(p_hand_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_rake_amount numeric DEFAULT 0, p_pot_size numeric DEFAULT 0, p_num_players integer DEFAULT 0, p_player_contributions jsonb DEFAULT NULL::jsonb, p_is_tournament boolean DEFAULT false, p_tournament_id uuid DEFAULT NULL::uuid, p_bbj_pct numeric DEFAULT 0.05)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). The legacy per-hand rake recorder.
     Its callers (settle_hand_atomically, increment_settlement_counters, the
     retired World Hub poker-engine) run nowhere: 0 calls. Hand rake, BBJ
     contribution and union routing are written by the atomic hand commit.
     Nothing is moved or recorded here. */
  RETURN jsonb_build_object('success', false, 'error', 'record_rake_retired',
    'message', 'Rake is recorded by the atomic hand commit');
END;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_promo_to_chips(p_club_id uuid, p_player_user_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Converted promo to cashable chips
     with no counterparty and no playthrough; no caller. Promo is released by
     promo_apply_playthrough. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'redeem_promo_to_chips_retired',
    'message', 'Promo is released by playthrough');
END;
$function$;

CREATE OR REPLACE FUNCTION public.spin_pool_draw(p_club_id uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Drew from a Spin pool with no
     counterparty (and down to -500); closed, no caller. Spin prizes are
     drawn inside the Spin settlement. Nothing is moved here. */
  RAISE EXCEPTION 'spin_pool_draw_retired'
    USING ERRCODE = '0A000', HINT = 'Spin prizes are drawn inside the Spin settlement.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_promo_agent_to_player(p_club_id uuid, p_agent_user_id uuid, p_player_user_id uuid, p_amount numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). Moved agent promo to a player with
     no counterparty. EXECUTE was held only by postgres and service_role, so
     the client panels could not reach it, and the World Hub routes that
     name it are not called. The promo send is fn_promo_wallet_send.
     Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'transfer_promo_agent_to_player_retired',
    'message', 'Use the promo wallet send (fn_promo_wallet_send)');
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlock_chips_from_table(p_club_id uuid, p_user_id uuid, p_table_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  /* RETIRED 2026-10-02 (20261002140203). The legacy World Hub table-chips
     cash-out: a wallet credit from nowhere. Nothing calls the route; cash-out
     is atomic_table_cashout. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'unlock_chips_from_table_retired',
    'message', 'Cash out through atomic_table_cashout');
END;
$function$;

UPDATE public.ca_money_rpc_registry
   SET status = 'retired',
       notes = '20261002140203: retired - moves nothing, answers ' || proname || '_retired. It moved a covered balance with no ledger counterparty and nothing called it. Previously: ' || COALESCE(notes, '')
 WHERE proname IN ('atomic_tournament_register','credit_club_wallet_rake','decrement_club_treasury',
   'deduct_chip_balance','distribute_chips','fn_add_chips','fn_cashier_claim_back','fn_cashier_send_chips',
   'fn_debit_chips','fn_leave_club_atomic','fn_reject_cashout','fn_spin_reserve_seed_from_union',
   'fn_tournament_atomic_register','fn_union_distribute_promo','fn_union_fund_promo_from_bank',
   'fn_wallet_claim_back','increment_union_chip_balance','lock_chips_for_table','mass_fund_horses',
   'mint_club_chips','record_rake','redeem_promo_to_chips','spin_pool_draw',
   'transfer_promo_agent_to_player','unlock_chips_from_table');

UPDATE public.ca_money_rpc_registry
   SET status = 'system',
       notes = '20261002140203: audited - every write is inside a sub-block that always raises SELFTEST-ROLLBACK, so no balance it touches survives the call. Previously: ' || COALESCE(notes, '')
 WHERE proname = 'fn_bbj_selftest_payout_conservation';

-- ---------------------------------------------------------------------------
-- 3. GUARDED: five primitives whose counterparty is the caller's to name.
--    A wallet debit, a wallet credit and a treasury debit/credit do not know
--    where the chips come from or go to; the door that calls them does, and
--    every live caller already says so (fn_credit_and_log, the tournament
--    registrars, fn_union_weekly_rakeback_close, fn_accounting_legacy_pay_
--    week). Before the balance moves, each now asks whether a counterparty
--    is declared (or its journal stood down for a caller-written leg) and,
--    if not, refuses by its own name. A refusal here moved nothing; the same
--    call was already refused at commit, anonymously, since 08:36:58.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'debit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric;
  v_club_id uuid;
  v_context_club uuid;
  v_context_tournament uuid;
  v_declared_club uuid;
  v_declared_text text;
  v_has_club boolean;
BEGIN
  IF p_user_id IS NULL
     OR p_amount IS NULL
     OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount <= 0
     OR p_amount <> round(p_amount,2) THEN
    RAISE EXCEPTION 'wallet debit requires a positive two-decimal amount'
      USING ERRCODE='22023';
  END IF;

  v_declared_text:=NULLIF(current_setting('app.ledger_club_id',true),'');
  IF v_declared_text IS NOT NULL THEN
    BEGIN
      v_declared_club:=v_declared_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'wallet debit declared club is not a UUID'
        USING ERRCODE='22023';
    END;
    v_club_id:=v_declared_club;
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT t.club_id, t.tournament_id INTO v_context_club, v_context_tournament
      FROM public.tables t
     WHERE t.id=p_table_id;
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'wallet debit table % has no club context',p_table_id
        USING ERRCODE='P0002';
    END IF;
    IF v_context_tournament IS NOT NULL THEN
      -- THE ENTRY IS CHARGED TO THE WALLET THE ENTRY IS STAMPED WITH
      -- (2026-09-10): a tournament table resolves the wallet the way the
      -- entry stamp does, so a rebuy at a union event comes from the same
      -- member-club wallet the buy-in came from.
      v_context_club:=public.fn_tournament_club_for_user(
        p_user_id,v_context_tournament,v_club_id);
      IF v_context_club IS NULL THEN
        RAISE EXCEPTION 'no club wallet in the union of tournament % resolves for player %',
          v_context_tournament,p_user_id USING ERRCODE='42501';
      END IF;
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own table %',p_table_id
        USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF p_related_entity_id IS NOT NULL
     AND lower(COALESCE(p_category,'')) IN
       ('tournament_buyin','tournament_rebuy','rebuy','reentry','addon') THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id=p_related_entity_id
                     AND t.club_id IS NOT NULL) THEN
      RAISE EXCEPTION 'wallet debit tournament % has no club context',
        p_related_entity_id USING ERRCODE='P0002';
    END IF;
    -- THE ENTRY IS CHARGED TO THE WALLET THE ENTRY IS STAMPED WITH
    -- (2026-09-10). trg_tournament_players_stamp_club stamps the entry with
    -- fn_tournament_club_for_user; the debit reads the same function with the
    -- same preferred club, so the wallet a prize returns to is the wallet the
    -- buy-in left. Reading tournaments.club_id here charged the union's house
    -- club for every union-hosted entry (3,232 entries / 73,659.00 in 24h).
    v_context_club:=public.fn_tournament_club_for_user(
      p_user_id,p_related_entity_id,v_club_id);
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'no club wallet in the union of tournament % resolves for player %',
        p_related_entity_id,p_user_id USING ERRCODE='42501';
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own tournament %',
        p_related_entity_id USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF v_club_id IS NULL THEN
    v_club_id:=public.fn_player_home_club(p_user_id,NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    IF public.fn_ensure_club_wallet(p_user_id,v_club_id) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'player % has no active wallet at club %',p_user_id,v_club_id
        USING ERRCODE='42501';
    END IF;
    SELECT cm.chip_balance INTO v_balance
      FROM public.club_members cm
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
     FOR UPDATE;
    IF v_balance IS NULL OR v_balance<p_amount THEN
      RETURN false;
    END IF;
    /* THE CALLER NAMES WHERE THE CHIPS GO (2026-10-02, 20261002140203). This
       primitive debits a wallet for a door it does not know. Without a
       declared counterparty the club_members journal books the leg against
       settlement_suspense and the commit check refuses the transaction; say
       so here, by name, before anything moves. */
    IF NULLIF(current_setting('app.ledger_counterparty', true), '') IS NULL
       AND COALESCE(current_setting('app.ledger_autoskip_club_members', true), '') <> '1' THEN
      RAISE EXCEPTION 'atomic_deduct_wallet_and_log_requires_a_declared_counterparty'
        USING ERRCODE = '23514',
              DETAIL  = 'a player wallet debit with no app.ledger_counterparty would be journalled against settlement_suspense',
              HINT    = 'The calling door declares where the chips go (fn_ca_declare_ledger) before it calls, or stands the club_members journal down and writes its own leg.';
    END IF;
    UPDATE public.club_members cm
       SET chip_balance=cm.chip_balance-p_amount,updated_at=now()
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
       AND cm.chip_balance>=p_amount;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    INSERT INTO public.chip_transactions(
      club_id,from_user_id,amount,transaction_type,notes
    ) VALUES (
      v_club_id,p_user_id,p_amount,p_category,
      COALESCE(NULLIF(p_description,''),'Wallet debit')
    );
    RETURN true;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.club_members cm WHERE cm.user_id=p_user_id
  ) INTO v_has_club;
  IF v_has_club THEN
    RAISE EXCEPTION 'No active club wallet resolves for Club Arena debit from player %',
      p_user_id USING ERRCODE='42501';
  END IF;

  UPDATE public.wallets w
     SET balance=w.balance-p_amount,updated_at=now()
   WHERE w.user_id=p_user_id AND w.wallet_type='PLAYER'
     AND w.balance>=p_amount;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_credit_player_wallet_once(p_user_id uuid, p_amount numeric, p_idempotency_key text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer; v_tourn uuid; v_club uuid; v_balance numeric;
  v_is_tournament boolean := false; v_has_any_club boolean;
  v_fallback uuid;
BEGIN
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        -- FALSE, not void: the caller needs to know it must NOT write a
        -- ledger row for a credit somebody else already made.
        IF v_inserted = 0 THEN RETURN false; END IF;
    END IF;

    /* THE CALLER NAMES WHERE THE CHIPS COME FROM (2026-10-02,
       20261002140203). This primitive credits a wallet for a door it does
       not know (fn_credit_and_log, which declares, is its live caller).
       Without a declared counterparty the club_members journal books the leg
       against settlement_suspense and the commit check refuses the
       transaction; say so here, by name, before anything moves. */
    IF NULLIF(current_setting('app.ledger_counterparty', true), '') IS NULL
       AND COALESCE(current_setting('app.ledger_autoskip_club_members', true), '') <> '1' THEN
      RAISE EXCEPTION 'fn_credit_player_wallet_once_requires_a_declared_counterparty'
        USING ERRCODE = '23514',
              DETAIL  = 'a player wallet credit with no app.ledger_counterparty would be journalled against settlement_suspense',
              HINT    = 'The calling door declares where the chips come from (fn_ca_declare_ledger) before it calls, or stands the club_members journal down and writes its own leg.';
    END IF;

    IF p_idempotency_key IS NOT NULL AND p_idempotency_key LIKE 'tourney:%' THEN
      v_is_tournament := true;
      BEGIN
        v_tourn := (split_part(p_idempotency_key, ':', 2))::uuid;
      EXCEPTION WHEN OTHERS THEN v_tourn := NULL;
      END;
      IF v_tourn IS NOT NULL THEN
        SELECT tp.club_id INTO v_club FROM tournament_players tp
         WHERE tp.tournament_id = v_tourn AND tp.user_id = p_user_id LIMIT 1;
        IF v_club IS NULL THEN
          SELECT t.club_id INTO v_club FROM tournaments t WHERE t.id = v_tourn;
          v_club := COALESCE(public.fn_player_home_club(p_user_id, NULL), v_club);
        END IF;
      END IF;
    END IF;

    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;

    IF v_club IS NOT NULL THEN
      PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
       WHERE user_id = p_user_id AND club_id = v_club
       RETURNING chip_balance INTO v_balance;
      IF v_balance IS NOT NULL THEN RETURN true; END IF;
    END IF;

    /* ZERO-DRIFT (2026-08-31): cross-club tournament entry - the stamped club
       holds no wallet for this player. Follow the money home instead of
       refusing a prize the pool already owes. */
    IF v_is_tournament AND v_tourn IS NOT NULL THEN
      SELECT ct.club_id INTO v_fallback
        FROM chip_transactions ct
        JOIN tournaments t ON t.id = v_tourn
       WHERE ct.from_user_id = p_user_id
         AND ct.transaction_type = 'tournament_buyin'
         AND ct.notes = 'Tournament buy-in: ' || t.name
         AND ct.created_at > COALESCE(t.started_at, t.created_at, now()) - interval '7 days'
         AND EXISTS (SELECT 1 FROM club_members m
                      WHERE m.user_id = p_user_id AND m.club_id = ct.club_id)
       ORDER BY ct.created_at DESC LIMIT 1;
      IF v_fallback IS NULL THEN
        v_fallback := public.fn_player_home_club(p_user_id, NULL);
      END IF;
      IF v_fallback IS NULL THEN
        SELECT m.club_id INTO v_fallback
          FROM club_members m
         WHERE m.user_id = p_user_id
           AND COALESCE(m.status, 'active') IN ('active','approved')
         ORDER BY COALESCE(m.chip_balance, 0) DESC, m.club_id LIMIT 1;
      END IF;
      IF v_fallback IS NOT NULL AND v_fallback IS DISTINCT FROM v_club THEN
        PERFORM public.fn_ensure_club_wallet(p_user_id, v_fallback);
        UPDATE club_members
           SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
         WHERE user_id = p_user_id AND club_id = v_fallback
         RETURNING chip_balance INTO v_balance;
        IF v_balance IS NOT NULL THEN RETURN true; END IF;
      END IF;
    END IF;

    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id)
      INTO v_has_any_club;

    IF v_is_tournament OR v_has_any_club THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical','credit_player_wallet',
              'Club Arena credit could not resolve a club wallet - payment refused rather than pooled',
              jsonb_build_object('user_id',p_user_id,'amount',p_amount,
                                 'idempotency_key',p_idempotency_key,'tournament_id',v_tourn));
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;

    UPDATE wallets SET balance = balance + p_amount, updated_at = NOW()
      WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    IF NOT FOUND THEN
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
        VALUES (p_user_id, 'PLAYER', p_amount, 0, NOW(), NOW());
    END IF;

    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_credit_chips(p_club_id uuid, p_user_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
  v_amt numeric := round(p_amount, 2);
BEGIN
  IF v_amt IS NULL OR v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  /* THE CALLER NAMES WHERE THE CHIPS COME FROM (2026-10-02,
     20261002140203). This primitive credits a wallet for a door it does not
     know. Without a declared counterparty the club_members journal books the
     leg against settlement_suspense and the commit check refuses the
     transaction; say so here, by name, before anything moves. */
  IF NULLIF(current_setting('app.ledger_counterparty', true), '') IS NULL
     AND COALESCE(current_setting('app.ledger_autoskip_club_members', true), '') <> '1' THEN
    RAISE EXCEPTION 'fn_credit_chips_requires_a_declared_counterparty'
      USING ERRCODE = '23514',
            DETAIL  = 'a player wallet credit with no app.ledger_counterparty would be journalled against settlement_suspense',
            HINT    = 'The calling door declares where the chips come from (fn_ca_declare_ledger) before it calls.';
  END IF;

  PERFORM set_config('app.ledger_category', 'player_funding', true);

  SELECT COALESCE(chip_balance, 0) INTO v_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;

  IF v_before IS NULL THEN
    INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_user_id, 'player', v_amt, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_members.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
    v_before := 0;
    v_after := v_amt;
  ELSE
    /* ZERO-DRIFT (2026-08-31): was + p_amount::integer - the balance moved by
       a truncated amount while the journal recorded the full numeric amount,
       destroying fractions on every fractional call. */
    UPDATE club_members
    SET chip_balance = COALESCE(chip_balance, 0) + v_amt,
        updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_user_id;
    v_after := v_before + v_amt;
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, NULL, p_user_id, v_amt,
    COALESCE(p_metadata->>'transaction_type', 'chip_credit'),
    COALESCE(p_reason, 'Chip credit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', v_amt,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_credit_treasury_zd4core(p_club_id uuid, p_amount numeric, p_reason text, p_metadata jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid parameters');
  END IF;

  /* THE CALLER NAMES WHERE THE CHIPS COME FROM (2026-10-02,
     20261002140203). fn_union_weekly_rakeback_close and
     fn_accounting_legacy_pay_week declare and stand the clubs journal down;
     a caller that does neither would be refused at commit. Say so here, by
     name, before anything moves. */
  IF NULLIF(current_setting('app.ledger_counterparty', true), '') IS NULL
     AND COALESCE(current_setting('app.ledger_autoskip_clubs', true), '') <> '1' THEN
    RAISE EXCEPTION 'fn_credit_treasury_requires_a_declared_counterparty'
      USING ERRCODE = '23514',
            DETAIL  = 'a club treasury credit with no app.ledger_counterparty would be journalled against settlement_suspense',
            HINT    = 'The calling door declares where the chips come from (fn_ca_declare_ledger), or stands the clubs journal down and writes its own leg.';
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_before
  FROM clubs WHERE id = p_club_id FOR NO KEY UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  UPDATE clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_after := v_before + p_amount;

  INSERT INTO chip_transactions (
    id, club_id, amount, transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_amount,
    'treasury_credit', COALESCE(p_reason, 'Treasury credit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_debit_treasury(p_club_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid parameters');
  END IF;

  /* THE CALLER NAMES WHERE THE CHIPS GO (2026-10-02, 20261002140203). A
     treasury debit for a door this primitive does not know. Without a
     declared counterparty the clubs journal books the leg against
     settlement_suspense and the commit check refuses the transaction; say so
     here, by name, before anything moves. */
  IF NULLIF(current_setting('app.ledger_counterparty', true), '') IS NULL
     AND COALESCE(current_setting('app.ledger_autoskip_clubs', true), '') <> '1' THEN
    RAISE EXCEPTION 'fn_debit_treasury_requires_a_declared_counterparty'
      USING ERRCODE = '23514',
            DETAIL  = 'a club treasury debit with no app.ledger_counterparty would be journalled against settlement_suspense',
            HINT    = 'The calling door declares where the chips go (fn_ca_declare_ledger), or stands the clubs journal down and writes its own leg.';
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  IF v_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient treasury',
      'balance', v_before,
      'requested', p_amount
    );
  END IF;

  UPDATE clubs
  SET chip_treasury = chip_treasury - p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_after := v_before - p_amount;

  INSERT INTO chip_transactions (
    id, club_id, amount, transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_amount,
    'treasury_debit', COALESCE(p_reason, 'Treasury debit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. DECLARED: six live doors whose counterparty is inherent. Each names it
--    immediately before the balance write, in the same transaction, and puts
--    back whatever declaration it found (fn_ca_ledger_declaration_restore),
--    so nothing leaks onto a caller's later writes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_member_leave_to_treasury(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_role  text;
  v_chips numeric;
  v_after numeric;
  v_caller uuid := auth.uid();
  v_saved jsonb;
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club and user required');
  END IF;

  -- AUTHZ: service role, the member themselves, or a club treasury manager.
  IF v_caller IS NOT NULL
     AND v_caller <> p_user_id
     AND NOT public.fn_actor_can_manage_club_treasury(p_club_id) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'not authorized to remove another member from this club');
  END IF;

  SELECT role, COALESCE(chip_balance, 0)
    INTO v_role, v_chips
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_user_id
  FOR UPDATE;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a member');
  END IF;

  IF v_role = 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner must transfer ownership first');
  END IF;

  IF v_chips > 0 THEN
    /* THE WALLET PAYS THE TREASURY, BY NAME (2026-10-02, 20261002140203).
       This credited the treasury with no counterparty (a settlement_suspense
       leg) and then DELETEd the member row, which the delete journal booked
       as a burn of the same chips: the chips were counted out twice and in
       from nowhere once. The wallet is now emptied INTO the treasury under a
       declared club_treasury counterparty (one leg, player wallet -> club
       treasury), the treasury credit itself writes no second leg, and the
       row is deleted holding no chips. */
    v_saved := public.fn_ca_ledger_declaration_save(ARRAY['clubs']);
    PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'club_treasury', p_club_id,
                                        NULL, NULL, ARRAY['clubs']);

    UPDATE club_members
       SET chip_balance = 0, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;

    UPDATE clubs
    SET chip_treasury = COALESCE(chip_treasury, 0) + v_chips,
        updated_at = NOW()
    WHERE id = p_club_id
    RETURNING chip_treasury INTO v_after;

    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);

    IF v_after IS NULL THEN
      RAISE EXCEPTION 'club % not found while returning % chips from member %', p_club_id, v_chips, p_user_id;
    END IF;

    INSERT INTO chip_transactions (
      id, club_id, from_user_id, amount, transaction_type, notes, balance_after, created_at
    ) VALUES (
      gen_random_uuid(), p_club_id, p_user_id, v_chips,
      'leave_club_chip_return', 'Chips returned to treasury on club departure',
      v_after, NOW()
    );
  END IF;

  DELETE FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;

  RETURN jsonb_build_object('success', true, 'chips_returned', COALESCE(v_chips, 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_seed_horses_to_floor(p_club_id uuid, p_floor numeric)
 RETURNS TABLE(horses_funded integer, chips_moved numeric, treasury_after numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_needed  numeric;
    v_count   integer;
    v_before  numeric;
    v_after   numeric;
    v_saved   jsonb;
BEGIN
    IF p_floor IS NULL OR p_floor <= 0 THEN
        RAISE EXCEPTION 'floor must be positive, got %', p_floor;
    END IF;

    SELECT coalesce(chip_treasury, 0) INTO v_before FROM public.clubs WHERE id = p_club_id;
    IF v_before IS NULL THEN
        RAISE EXCEPTION 'club % not found', p_club_id;
    END IF;

    SELECT count(*), coalesce(sum(p_floor - cm.chip_balance), 0)
      INTO v_count, v_needed
      FROM public.club_members cm
      JOIN public.profiles p ON p.id = cm.user_id
     WHERE cm.club_id = p_club_id AND p.is_horse AND cm.chip_balance < p_floor;

    IF v_count = 0 THEN
        RETURN QUERY SELECT 0, 0::numeric, v_before;
        RETURN;
    END IF;

    -- All or nothing. A half-seeded roster is harder to reason about than an
    -- unseeded one, and the caller can always mint first and retry.
    IF v_before < v_needed THEN
        RAISE EXCEPTION 'treasury % cannot cover % for % horses (floor %) - mint first',
              v_before, v_needed, v_count, p_floor;
    END IF;

    INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
    SELECT p_club_id, NULL, cm.user_id, p_floor - cm.chip_balance, 'horse_treasury_funding',
           'Topped up to the club bankroll floor so the horse can buy into any table',
           p_floor
      FROM public.club_members cm
      JOIN public.profiles p ON p.id = cm.user_id
     WHERE cm.club_id = p_club_id AND p.is_horse AND cm.chip_balance < p_floor;

    /* THE TREASURY FUNDS THE HORSE, BY NAME (2026-10-02, 20261002140203).
       Each horse's leg is club treasury -> its wallet, exactly the leg a
       human funded from the same treasury gets; the treasury debit below is
       the other side of those legs, so its own journal stands down. */
    v_saved := public.fn_ca_ledger_declaration_save(ARRAY['clubs']);
    PERFORM public.fn_ca_declare_ledger('horse_funding', 'club_treasury', p_club_id,
                                        NULL, NULL, ARRAY['clubs']);

    UPDATE public.club_members cm
       SET chip_balance = p_floor
      FROM public.profiles p
     WHERE p.id = cm.user_id
       AND cm.club_id = p_club_id AND p.is_horse AND cm.chip_balance < p_floor;

    UPDATE public.clubs SET chip_treasury = chip_treasury - v_needed WHERE id = p_club_id
    RETURNING chip_treasury INTO v_after;

    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);

    IF v_after < 0 THEN
        RAISE EXCEPTION 'post-apply failed: treasury went negative (%)', v_after;
    END IF;
    IF (v_before - v_after) <> v_needed THEN
        RAISE EXCEPTION 'post-apply failed: conservation broken - treasury moved %, credited %',
              (v_before - v_after), v_needed;
    END IF;

    RETURN QUERY SELECT v_count, v_needed, v_after;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_activate(p_club_id uuid, p_seed_amount numeric, p_offered_max_stake numeric, p_source_wallet text, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner uuid; v_kind text; v_required numeric; v_seed numeric;
  v_wallet_after numeric; v_bal numeric; v_active boolean; v_activated timestamptz;
  v_outstanding numeric; v_prev_wallet text; v_still_needed numeric;
  v_pool_id uuid; v_saved jsonb;
BEGIN
  IF COALESCE(p_offered_max_stake,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'max_stake_must_be_positive');
  END IF;

  v_owner    := public.fn_spin_reserve_pool(p_club_id);
  v_kind     := public.fn_spin_owner_kind(v_owner);
  v_required := public.fn_spin_required_seed(p_offered_max_stake);

  IF v_required <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'max_stake_too_small',
      'offered_max_stake', p_offered_max_stake);
  END IF;

  v_seed := round(COALESCE(p_seed_amount, 0), 2);

  SELECT id, is_active, activated_at, seeded_amount, seed_source_wallet
    INTO v_pool_id, v_active, v_activated, v_outstanding, v_prev_wallet
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  IF COALESCE(v_active,false) AND v_activated IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_active', 'owner_id', v_owner);
  END IF;

  IF COALESCE(v_outstanding,0) > 0
     AND v_prev_wallet IS NOT NULL
     AND v_prev_wallet <> p_source_wallet THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seed_outstanding_to_another_wallet',
      'outstanding', v_outstanding, 'owed_to', v_prev_wallet, 'owner_id', v_owner);
  END IF;

  -- An outstanding seed is already IN the pool doing the job the seed exists
  -- to do. Charging for it again is charging twice for the same protection.
  v_still_needed := GREATEST(v_required - COALESCE(v_outstanding, 0), 0);

  IF v_seed < v_still_needed THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seed_below_required',
      'required_seed', v_required, 'already_outstanding', COALESCE(v_outstanding,0),
      'still_needed', v_still_needed, 'offered', v_seed,
      'owner_id', v_owner, 'owner_kind', v_kind);
  END IF;

  /* THE SEED LEAVES THE OWNER'S WALLET FOR THE POOL, BY NAME (2026-10-02,
     20261002140203). When a caller has already declared this movement (the
     club welcome package declares its opening_setup allocation), its
     declaration stands, as fn_spin_move_owner_wallet already honours. When
     nobody has, the counterparty is this pool: one leg owner wallet -> spin
     reserve, and the pool's own journal stands down instead of booking a
     second leg out of an anonymous spin_reserve. */
  IF NULLIF(current_setting('app.ledger_counterparty', true), '') IS NULL THEN
    v_saved := public.fn_ca_ledger_declaration_save(ARRAY['spin_bonus_pools']);
    PERFORM public.fn_ca_declare_ledger('overlay', 'spin_reserve', v_pool_id,
                                        NULL, NULL, ARRAY['spin_bonus_pools']);
  END IF;

  -- Zero is a legitimate top-up when the outstanding seed already covers the
  -- bar; skip the wallet move entirely rather than book a no-op transfer.
  IF v_seed > 0 THEN
    v_wallet_after := public.fn_spin_move_owner_wallet(
                        v_owner, v_kind, p_source_wallet, -v_seed);
    IF v_wallet_after IS NULL THEN
      IF v_saved IS NOT NULL THEN PERFORM public.fn_ca_ledger_declaration_restore(v_saved); END IF;
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_funds_or_no_wallet',
        'wallet', p_source_wallet, 'owner_id', v_owner, 'owner_kind', v_kind);
    END IF;
  END IF;

  UPDATE public.spin_bonus_pools
     SET balance            = balance + v_seed,
         seeded_amount      = seeded_amount + v_seed,
         seed_source_wallet = p_source_wallet,
         offered_max_stake  = p_offered_max_stake,
         highest_stake      = GREATEST(highest_stake, p_offered_max_stake),
         -- GREATEST only while something is owed. See the reset in settle:
         -- once the seed is repaid this drops to 0 and the next activation
         -- sets it fresh, so a retired 20,000 bar cannot strand a later 200.
         required_seed_at_activation = GREATEST(required_seed_at_activation, v_required),
         ceiling_amount     = 0,
         owner_kind         = v_kind,
         is_active          = true,
         activated_at       = now(),
         activated_by       = p_actor,
         deactivated_at     = NULL,
         updated_at         = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'spin pool row vanished for owner % after debiting % from %',
      v_owner, v_seed, p_source_wallet;
  END IF;

  IF v_saved IS NOT NULL THEN
    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);
  END IF;

  IF v_seed > 0 THEN
    INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
    VALUES (v_owner, 'seed', v_seed, v_bal,
            format('activation seed from %s %s (repayable at %s%s)',
                   v_kind, p_source_wallet, v_required,
                   CASE WHEN COALESCE(v_outstanding,0) > 0
                        THEN format(', %s already outstanding', v_outstanding)
                        ELSE '' END));
  END IF;

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_owner, 'activation', 0, v_bal,
          format('Spins activated, max stake %s, required seed %s, charged %s',
                 p_offered_max_stake, v_required, v_seed));

  RETURN jsonb_build_object('ok', true, 'owner_id', v_owner, 'owner_kind', v_kind,
    'balance', v_bal, 'seeded_amount', COALESCE(v_outstanding,0) + v_seed,
    'charged', v_seed, 'required_seed', v_required,
    'source_wallet', p_source_wallet, 'source_wallet_after', v_wallet_after,
    'offered_max_stake', p_offered_max_stake);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_absorb_club_pool_into_union(p_club_id uuid, p_union_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bal numeric; v_seed numeric; v_after numeric; v_pool_id uuid; v_saved jsonb;
BEGIN
  IF p_club_id IS NULL OR p_union_id IS NULL OR p_club_id = p_union_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'nothing_to_absorb');
  END IF;

  SELECT id, balance, seeded_amount INTO v_pool_id, v_bal, v_seed
    FROM public.spin_bonus_pools WHERE club_id = p_club_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'club_had_no_pool');
  END IF;

  /* A pool below zero owes the house; paying it "into" the treasury would
     book a negative payment. No pool has ever been below zero (0 of 49 on
     2026-10-02); refuse by name rather than invent the rule here. */
  IF COALESCE(v_bal,0) < 0 THEN
    RAISE EXCEPTION 'spin_pool_below_zero_cannot_be_absorbed: club % pool %', p_club_id, v_bal
      USING ERRCODE = '23514';
  END IF;

  /* THE POOL PAYS THE TREASURY, BY NAME (2026-10-02, 20261002140203). One
     leg, spin reserve (this pool) -> club treasury; the pool's own journal
     stands down for the zeroing below instead of booking a second leg. */
  v_saved := public.fn_ca_ledger_declaration_save(ARRAY['spin_bonus_pools']);
  PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'spin_reserve', v_pool_id,
                                      NULL, NULL, ARRAY['spin_bonus_pools']);

  IF COALESCE(v_bal,0) > 0 THEN
    v_after := public.fn_spin_move_owner_wallet(p_club_id, 'club', 'chip_treasury', v_bal);
    IF v_after IS NULL THEN
      RAISE EXCEPTION 'cannot return the % Spins balance of club % to its treasury', v_bal, p_club_id;
    END IF;

    INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
    VALUES (p_club_id, 'merge', -v_bal, 0,
            format('Spins wallet closed on joining union %s - entire balance (including %s of outstanding seed) paid to the club main bank, to keep or disburse at its own discretion',
                   p_union_id, COALESCE(v_seed,0)));
  END IF;

  UPDATE public.spin_bonus_pools
     SET balance = 0, seeded_amount = 0, required_seed_at_activation = 0,
         seed_source_wallet = NULL, offered_max_stake = 0,
         is_active = false, deactivated_at = now(), updated_at = now()
   WHERE club_id = p_club_id;

  PERFORM public.fn_ca_ledger_declaration_restore(v_saved);

  RETURN jsonb_build_object('ok', true, 'club_id', p_club_id, 'union_id', p_union_id,
    'paid_to_main_bank', COALESCE(v_bal,0), 'club_treasury_after', v_after);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_close_club_wallets_on_union_join(p_club_id uuid, p_union_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_spin jsonb;
  v_bbj_main numeric := 0; v_bbj_backup numeric := 0; v_bbj_promo numeric := 0;
  v_bbj_total numeric := 0; v_club_promo numeric := 0;
  v_keep_main numeric; v_keep_backup numeric; v_pool_id uuid; v_union_pool uuid; v_after numeric; v_treasury numeric;
  v_saved jsonb;
BEGIN
  IF p_club_id IS NULL OR p_union_id IS NULL OR p_club_id = p_union_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'nothing_to_close');
  END IF;

  v_spin := public.fn_spin_absorb_club_pool_into_union(p_club_id, p_union_id);

  SELECT id, COALESCE(main_balance,0), COALESCE(backup_balance,0), COALESCE(promo_balance,0)
    INTO v_pool_id, v_bbj_main, v_bbj_backup, v_bbj_promo
    FROM public.bbj_pools
   WHERE club_id = p_club_id AND union_id IS NULL
   FOR UPDATE;

  IF v_pool_id IS NOT NULL THEN
    v_keep_main := public.fn_bbj_parked_reserve(v_pool_id,'main');
    v_keep_backup := public.fn_bbj_parked_reserve(v_pool_id,'backup');
    v_bbj_main := v_bbj_main-v_keep_main;
    v_bbj_backup := v_bbj_backup-v_keep_backup;
    IF v_bbj_main<0 OR v_bbj_backup<0 THEN
      RAISE EXCEPTION 'club jackpot bank cannot cover its parked obligations';
    END IF;
    v_bbj_total := v_bbj_main + v_bbj_backup + v_bbj_promo;
    SELECT id INTO v_union_pool FROM public.bbj_pools WHERE union_id = p_union_id LIMIT 1;

    /* THE JACKPOT BANK PAYS THE TREASURY, BY NAME (2026-10-02,
       20261002140203). One leg, BBJ pool -> club treasury; the pool's own
       journal stands down for the sweep below instead of booking a second
       leg. */
    v_saved := public.fn_ca_ledger_declaration_save(ARRAY['bbj_pools']);
    PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'bbj_pool', v_pool_id,
                                        NULL, NULL, ARRAY['bbj_pools']);

    IF v_bbj_total > 0 THEN
      v_after := public.fn_spin_move_owner_wallet(p_club_id, 'club', 'chip_treasury', v_bbj_total);
      IF v_after IS NULL THEN
        RAISE EXCEPTION 'cannot pay the % BBJ balance of club % into its treasury', v_bbj_total, p_club_id;
      END IF;

      -- bbj_promo_sweep so fn_bbj_conservation_check counts this as OUTFLOW.
      -- Without this row the gap moves by exactly v_bbj_total and a correct
      -- transfer reads as a money leak.
      INSERT INTO public.chip_transactions
        (id, club_id, amount, transaction_type, notes, balance_after, metadata)
      VALUES (gen_random_uuid(), p_club_id, v_bbj_total, 'bbj_promo_sweep',
              format('BBJ, backup and promo closed into the club main bank on joining union %s - the club keeps these funds. Play moves to the union pool; this money does not.', p_union_id),
              v_after,
              jsonb_build_object('reason','union_join','union_id',p_union_id,
                                 'bbj_main',v_bbj_main,'bbj_backup',v_bbj_backup,
                                 'bbj_promo',v_bbj_promo,'club_pool_id',v_pool_id));
    END IF;

    UPDATE public.bbj_pools
       SET main_balance = v_keep_main, backup_balance = v_keep_backup, promo_balance = 0,
           status = 'retired',
           merged_into_pool_id = COALESCE(merged_into_pool_id, v_union_pool),
           updated_at = now()
     WHERE id = v_pool_id;

    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);
  END IF;

  SELECT COALESCE(promo_balance,0) INTO v_club_promo
    FROM public.clubs WHERE id = p_club_id FOR UPDATE;

  IF v_club_promo > 0 THEN
    /* THE PROMO FLOAT PAYS THE TREASURY, BY NAME (2026-10-02,
       20261002140203). Two statements so each column is journalled once:
       the promo float is emptied under a declared club_treasury counterparty
       (one leg, promo wallet -> club treasury), then the treasury is
       credited with the clubs journal stood down. */
    v_saved := public.fn_ca_ledger_declaration_save(ARRAY['clubs']);
    PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'club_treasury', p_club_id);

    UPDATE public.clubs
       SET promo_balance = 0
     WHERE id = p_club_id;

    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);

    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) + v_club_promo
     WHERE id = p_club_id
     RETURNING chip_treasury INTO v_treasury;

    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);

    INSERT INTO public.chip_transactions
      (id, club_id, amount, transaction_type, notes, balance_after, metadata)
    VALUES (gen_random_uuid(), p_club_id, v_club_promo, 'promo_closed_on_union_join',
            format('Club promo float closed into the main bank on joining union %s - the club keeps these funds to disburse at its own discretion', p_union_id),
            v_treasury,
            jsonb_build_object('reason','union_join','union_id',p_union_id));
  END IF;

  RETURN jsonb_build_object('ok', true, 'club_id', p_club_id, 'union_id', p_union_id,
    'spins', v_spin, 'bbj_swept', v_bbj_total, 'club_promo_swept', v_club_promo,
    'club_treasury_after', COALESCE(v_treasury, v_after));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_reserve_wallet_fund(p_union_id uuid, p_amount numeric, p_from_wallet text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_from numeric; v_after numeric; v_res numeric; v_saved jsonb;
BEGIN
  IF COALESCE(p_amount,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;

  /* NOT FROM NOWHERE (2026-10-02, 20261002140203). With no source wallet
     this credited spin_reserve_wallet out of thin air ("operator deposit")
     with no counterparty. The only reachable caller,
     fn_spin_reserve_wallet_fund_op, already refuses that; the core now does
     too. Chips enter a union through its mint. */
  IF p_from_wallet IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_wallet_required',
      'allowed', jsonb_build_array('promo_wallet', 'rake_wallet', 'chip_balance'));
  END IF;
  IF p_from_wallet NOT IN ('promo_wallet','rake_wallet','chip_balance') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsupported_source_wallet');
  END IF;

  -- NOT ON CONFLICT: union_wallets carries no advertised unique constraint on
  -- union_id, and an ON CONFLICT naming a column without one is a runtime
  -- error rather than a no-op.
  INSERT INTO public.union_wallets (union_id)
  SELECT p_union_id
   WHERE NOT EXISTS (SELECT 1 FROM public.union_wallets w WHERE w.union_id = p_union_id);

  EXECUTE format('SELECT %I FROM public.union_wallets WHERE union_id = $1 FOR UPDATE', p_from_wallet)
    INTO v_from USING p_union_id;
  IF COALESCE(v_from,0) < p_amount THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_union_funds',
      'wallet', p_from_wallet, 'available', COALESCE(v_from,0), 'requested', p_amount);
  END IF;

  /* THE UNION NAMES ITS OWN MOVE (2026-10-02, 20261002140203). The promo,
     rake and Spin reserve sub-wallets are one ledger account (union_wallet);
     moving between them moves no balance the ledger counts, so the
     union_wallets journal stands down and no leg is owed. From the main bank
     it is a real transfer, union_bank -> union_wallet, written here as one
     leg naming the union on both sides - the shape every declaring union
     payer writes, and the one the accounting invoice can address (a leg
     naming the wallet row was refused: accounting_invoice_recipient_missing,
     measured 2026-10-02). */
  v_saved := public.fn_ca_ledger_declaration_save(ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);

  EXECUTE format(
    'UPDATE public.union_wallets SET %I = %I - $1, updated_at = now()
      WHERE union_id = $2 RETURNING %I', p_from_wallet, p_from_wallet, p_from_wallet)
    INTO v_after USING p_amount, p_union_id;
  INSERT INTO public.union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, notes)
  VALUES (p_union_id, p_from_wallet, 'debit', p_amount, v_after,
          'spin_reserve_wallet_fund',
          COALESCE(p_note, 'moved to the Spin reserve wallet'));

  UPDATE public.union_wallets
     SET spin_reserve_wallet = spin_reserve_wallet + p_amount, updated_at = now()
   WHERE union_id = p_union_id RETURNING spin_reserve_wallet INTO v_res;

  IF p_from_wallet = 'chip_balance' THEN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, from_label,
       to_type, to_entity_id, to_label,
       amount, category, union_id, description)
    VALUES (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
            'union_bank', p_union_id, 'union_wallets.chip_balance',
            'union_wallet', p_union_id, 'union_wallets.spin_reserve_wallet',
            round(p_amount, 2), 'treasury_transfer', p_union_id,
            'union main bank funded the Spin reserve wallet (fn_spin_reserve_wallet_fund)');
  END IF;

  PERFORM public.fn_ca_ledger_declaration_restore(v_saved);

  INSERT INTO public.union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, notes)
  VALUES (p_union_id, 'spin_reserve_wallet', 'credit', p_amount, v_res,
          'spin_reserve_wallet_fund',
          COALESCE(p_note, format('from %s', p_from_wallet)));

  RETURN jsonb_build_object('ok', true, 'spin_reserve_wallet', v_res);
END; $function$;

-- ---------------------------------------------------------------------------
-- 5. fn_union_credit_wallet_zd3core: an unmapped tx_type is refused by name.
--    "An unmapped tx_type declares nothing and stays on settlement_suspense"
--    was the old rule; since 08:36:58 that is a commit-time refusal with no
--    name on it. The map (fn_ca_union_wallet_ledger_shape) is unchanged: its
--    four tx_types are the ones whose source is knowable inside this call.
--    The one live tx_type outside it, the World Hub settle-period
--    'settlement_hold', is the second half of a two-RPC transfer whose first
--    half (fn_debit_treasury) commits separately; no mapping can balance it,
--    and it has not run in 30 days.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_union_credit_wallet_zd3core(p_union_id uuid, p_wallet text, p_amount numeric, p_tx_type text, p_club_id uuid, p_period_id uuid, p_notes text, p_created_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_column text;
  v_before numeric;
  v_after numeric;
  v_sql text;
  v_cat text;
  v_cp text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  v_wallet_column := CASE lower(p_wallet)
    WHEN 'chip' THEN 'chip_balance'
    WHEN 'chip_balance' THEN 'chip_balance'
    WHEN 'rake' THEN 'rake_wallet'
    WHEN 'rake_wallet' THEN 'rake_wallet'
    WHEN 'bbj' THEN 'bbj_wallet'
    WHEN 'bbj_wallet' THEN 'bbj_wallet'
    WHEN 'promo' THEN 'promo_wallet'
    WHEN 'promo_wallet' THEN 'promo_wallet'
    WHEN 'insurance' THEN 'insurance_wallet'
    WHEN 'insurance_wallet' THEN 'insurance_wallet'
    ELSE NULL
  END;

  IF v_wallet_column IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown wallet: ' || p_wallet);
  END IF;

  /* SAY WHERE THE CHIPS CAME FROM, OR DO NOT MOVE THEM (2026-10-02,
     20261002140203). The counterparty comes from the tx_type map. An
     unmapped tx_type used to declare nothing and fall to
     settlement_suspense, which the commit check now refuses; it is refused
     here instead, by name, before the wallet row is even touched. */
  SELECT category, counterparty INTO v_cat, v_cp
    FROM public.fn_ca_union_wallet_ledger_shape(p_tx_type);
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'fn_union_credit_wallet_unmapped_tx_type: %', COALESCE(p_tx_type, '(null)')
      USING ERRCODE = '23514',
            DETAIL  = 'a union wallet credit whose tx_type names no ledger counterparty would be journalled against settlement_suspense',
            HINT    = 'Map the tx_type in fn_ca_union_wallet_ledger_shape to the account the chips really come from, or credit the union through the door that moves the source in the same transaction.';
  END IF;

  -- Ensure wallet row exists
  INSERT INTO union_wallets (union_id, created_at, updated_at)
  VALUES (p_union_id, NOW(), NOW())
  ON CONFLICT (union_id) DO NOTHING;

  -- Read + lock before
  v_sql := format('SELECT COALESCE(%I,0) FROM union_wallets WHERE union_id = $1 FOR UPDATE', v_wallet_column);
  EXECUTE v_sql INTO v_before USING p_union_id;

  /* Declared immediately before the write and cleared immediately after, so
     it cannot leak onto an unrelated autoledger write later in the same
     transaction. */
  PERFORM public.fn_ca_declare_ledger(v_cat, v_cp);

  -- Update
  v_sql := format('UPDATE union_wallets SET %I = COALESCE(%I,0) + $1, updated_at = NOW() WHERE union_id = $2 RETURNING %I',
                  v_wallet_column, v_wallet_column, v_wallet_column);
  EXECUTE v_sql INTO v_after USING p_amount, p_union_id;

  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);

  -- Audit
  INSERT INTO union_wallet_transactions (
    id, union_id, wallet, direction, amount, balance_after,
    tx_type, club_id, period_id, notes, created_by, created_at
  ) VALUES (
    gen_random_uuid(), p_union_id, v_wallet_column, 'credit', p_amount, v_after,
    COALESCE(p_tx_type, 'credit'), p_club_id, p_period_id, p_notes, p_created_by, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'wallet', v_wallet_column,
    'balance_before', v_before, 'balance_after', v_after
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. THE WATCH COUNTS WHAT IS TRUE.
--    fn_ca_undeclared_money_paths() matched "UPDATE <table>" anywhere and the
--    column name anywhere in a body, so a function that read chip_balance and
--    updated club_members.role was a money path; and it did not know the
--    second declaration contract (stand the table's journal down with
--    app.ledger_autoskip_<table> and write the named leg yourself), which the
--    sibling detector fn_ca_undeclared_leg_check names in its own message.
--    Now a row is a function that ASSIGNS the column inside an UPDATE of the
--    table (statement-scoped) and neither declares a counterparty nor stands
--    that table's journal down while writing its own chip_ledger leg.
--    It still reads static UPDATE text only: an INSERT of an opening balance
--    or a balance written through dynamic SQL is caught at commit by the
--    ledger invariant itself, not here (stated in the changelog).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_undeclared_money_paths()
 RETURNS TABLE(proname text, tbl text, col text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH watched AS (
    SELECT c.relname::text AS tbl,
           (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS col
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc  p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND p.proname = 'fn_ca_autoledger'
  ), fns AS (
    SELECT p.proname::text AS proname, p.prosrc,
           (p.prosrc ILIKE '%fn_ca_declare_ledger%'
            OR p.prosrc ILIKE '%app.ledger_counterparty%') AS declares,
           (p.prosrc ~* 'INSERT\s+INTO\s+(public\.)?chip_ledger\y') AS writes_own_leg
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
  )
  SELECT DISTINCT f.proname, w.tbl, w.col
    FROM fns f
    JOIN watched w
      -- statement-scoped: the column is ASSIGNED by an UPDATE of the table
      ON f.prosrc ~* ('UPDATE\s+(public\.)?' || w.tbl || '\y[^;]*?\ySET\y[^;]*?\y' || w.col || '\s*=')
   WHERE NOT f.declares
     -- the second contract: the table's journal stood down, the door's own leg written
     AND NOT (f.writes_own_leg AND f.prosrc ~* ('ledger_autoskip_' || w.tbl || '\y'))
     AND f.proname NOT IN ('fn_ca_autoledger', 'fn_ca_autoledger_delete',
                           'fn_ca_declare_ledger', 'fn_ca_undeclared_money_paths')
     -- 2026-09-12: a function AUDITED AS MOVING NO MONEY is not an undeclared
     -- money path. status='system' IS that audit, written into
     -- ca_money_rpc_registry by the ab_ca_money_rpc_registered event trigger
     -- before the function is allowed to exist.
     AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g
                      WHERE g.proname = f.proname AND g.status = 'system')
   ORDER BY 1, 2, 3
$function$;

DO $post$
DECLARE
  v_left text;
  v_n int;
BEGIN
  SELECT count(*), string_agg(DISTINCT proname, ', ') INTO v_n, v_left
    FROM public.fn_ca_undeclared_money_paths();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'post: % undeclared money path row(s) remain: %', v_n, v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_money_rpc_registry
              WHERE proname IN ('atomic_tournament_register','credit_club_wallet_rake','decrement_club_treasury',
                'deduct_chip_balance','distribute_chips','fn_add_chips','fn_cashier_claim_back','fn_cashier_send_chips',
                'fn_debit_chips','fn_leave_club_atomic','fn_reject_cashout','fn_spin_reserve_seed_from_union',
                'fn_tournament_atomic_register','fn_union_distribute_promo','fn_union_fund_promo_from_bank',
                'fn_wallet_claim_back','increment_union_chip_balance','lock_chips_for_table','mass_fund_horses',
                'mint_club_chips','record_rake','redeem_promo_to_chips','spin_pool_draw',
                'transfer_promo_agent_to_player','unlock_chips_from_table')
                AND status <> 'retired') THEN
    RAISE EXCEPTION 'post: a retired door is not registered as retired';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('atomic_tournament_register','credit_club_wallet_rake','decrement_club_treasury',
                  'deduct_chip_balance','distribute_chips','fn_add_chips','fn_cashier_claim_back','fn_cashier_send_chips',
                  'fn_debit_chips','fn_leave_club_atomic','fn_reject_cashout','fn_spin_reserve_seed_from_union',
                  'fn_tournament_atomic_register','fn_union_distribute_promo','fn_union_fund_promo_from_bank',
                  'fn_wallet_claim_back','increment_union_chip_balance','lock_chips_for_table','mass_fund_horses',
                  'mint_club_chips','record_rake','redeem_promo_to_chips','spin_pool_draw',
                  'transfer_promo_agent_to_player','unlock_chips_from_table')
                AND (p.prosrc ~* '\yUPDATE\y' OR p.prosrc ~* '\yINSERT\y' OR position('_retired' in p.prosrc) = 0)) THEN
    RAISE EXCEPTION 'post: a retired door still writes or does not answer <name>_retired';
  END IF;
  RAISE NOTICE 'every money path declares its counterparty: 0 undeclared rows';
END $post$;

COMMIT;
