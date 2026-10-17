-- 20261017161610_a_deleted_wallet_return_takes_the_lock_the_stage_holds
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 16:16:10 UTC.
--
-- A DELETED-WALLET RETURN TAKES THE LOCK THE STAGE ALREADY HOLDS (2026-10-17)
--
-- The 2026-10-05 Midway union close has paid rounds 1 and 2. Both attempts
-- that reached round 3 were rolled back by the same deadlock (12:15 and 15:10
-- UTC, both read from union_accounting_scheduler alerts and the run's result):
--
--   fn_settle_accounting_rakeback_stage locks every paying club FOR NO KEY
--   UPDATE, then every routed wallet FOR NO KEY UPDATE, pays, and then, for a
--   deleted account among those wallets, calls fn_ca_deleted_wallet_bank_return,
--   which asks for the same rows again FOR UPDATE. FOR UPDATE is stronger: it
--   conflicts with FOR KEY SHARE, which every insert into a table with a
--   foreign key to clubs takes (agent_commissions, rake_records,
--   accounting_cash_rake_sources, chip_transactions ... on every hand). So
--   the stage, holding the wallets, waits on a hand that holds a KEY SHARE on
--   the club and is waiting on one of those wallets: "deadlock detected ...
--   while locking tuple in relation clubs", 40P01, the whole attempt rolled back.
--
-- THE FIX: the function changes only balance columns (chip_balance,
-- agent_wallet_balance, chip_treasury), never a key, so it takes FOR NO KEY
-- UPDATE on agents, club_members and clubs, the lock its own UPDATEs take and
-- the lock the stage already holds. Inside the stage nothing is waited on;
-- alone, it no longer blocks foreign-key inserts against the club. The order
-- of the locks is unchanged, and so is every amount, check, refusal, receipt,
-- ledger declaration and return value.
--
-- Not a sealed source: the original inventory matcher's 40 functions are
-- unchanged and it must still match after this. smarter_private.
-- original_erased_cash_base_discharge pins an older body of this function
-- (bccd3022...); the live body has differed from that pin since
-- 20261017065530, and the discharger has no caller (its 7 discharges ended
-- 2026-10-13), so nothing it does changes here.
--
-- GUARDS: refuses in the break window and while frozen; the live body must be
-- the exact preimage (975a6eb2..., the postimage of 20261017065530) or already
-- the postimage (43efd888..., derived read-only on production with replace());
-- each anchor occurs exactly once and the result has no FOR UPDATE left; owner,
-- SECURITY DEFINER, configuration and ACL are proven unchanged; the readback
-- must be the exact postimage.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)'::regprocedure)) = '43efd888e3b5364693bbc8fc03855c93'

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'DELETED_WALLET_LOCK_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'DELETED_WALLET_LOCK_REFUSED: the platform is frozen' USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $install$
DECLARE
  c_sig constant text := 'public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)';
  c_old1 constant text := $o1$  FROM public.agents WHERE club_id=p_club AND user_id=p_user FOR UPDATE;$o1$;
  c_new1 constant text := $n1$  FROM public.agents WHERE club_id=p_club AND user_id=p_user FOR NO KEY UPDATE;$n1$;
  c_old2 constant text := $o2$  INTO v_player FROM public.club_members WHERE club_id=p_club AND user_id=p_user FOR UPDATE;$o2$;
  c_new2 constant text := $n2$  INTO v_player FROM public.club_members WHERE club_id=p_club AND user_id=p_user FOR NO KEY UPDATE;$n2$;
  c_old3 constant text := $o3$ WHERE id=p_club AND asset='chips' AND lifecycle_status='active' FOR UPDATE;$o3$;
  c_new3 constant text := $n3$ WHERE id=p_club AND asset='chips' AND lifecycle_status='active' FOR NO KEY UPDATE;$n3$;
  v_oid oid := to_regprocedure(c_sig);
  v_def text; v_new text;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'deleted wallet lock: owner/target mismatch';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = '43efd888e3b5364693bbc8fc03855c93' THEN
    RETURN;
  END IF;
  IF md5(v_def) <> '975a6eb235c2d0a6e0f7e84043bb3d28' THEN
    RAISE EXCEPTION 'deleted wallet lock: unexpected live body %', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_old1, ''))) / length(c_old1) <> 1
     OR (length(v_def) - length(replace(v_def, c_old2, ''))) / length(c_old2) <> 1
     OR (length(v_def) - length(replace(v_def, c_old3, ''))) / length(c_old3) <> 1 THEN
    RAISE EXCEPTION 'deleted wallet lock: an anchor is not exactly once';
  END IF;
  v_new := replace(replace(replace(v_def, c_old1, c_new1), c_old2, c_new2), c_old3, c_new3);
  IF position('FOR UPDATE' in v_new) > 0 THEN
    RAISE EXCEPTION 'deleted wallet lock: a FOR UPDATE remains';
  END IF;
  IF md5(v_new) <> '43efd888e3b5364693bbc8fc03855c93' THEN
    RAISE EXCEPTION 'deleted wallet lock: computed postimage is %', md5(v_new);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_new;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'deleted wallet lock: exact readback failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'deleted wallet lock: authority drift';
  END IF;
  IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'deleted wallet lock: the original inventory sources no longer match';
  END IF;
END
$install$;

COMMIT;
