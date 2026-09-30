-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819002723 "20260819_cashout_expiry_and_reject_must_refund_escrow"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 decc57bf988e7f915235b9c72f6ed419 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Cashout escrow: expiry and rejection were DESTROYING player chips.
--
-- THE ESCROW MODEL (fn_request_cashout): a request DEBITS the player's
-- club_members.chip_balance immediately and books a 'cashout_request_escrow'
-- row in chip_transactions. fn_approve_cashout_atomic then credits the agent
-- and never debits the player, because the debit already happened at request
-- time. Correct and conserving - but every terminal state other than approval
-- MUST refund the escrow.
--
-- Two paths did not:
--
-- 1. fn_expire_stale_cashouts - LIVE, called from CashoutService.ts:459.
--    Flipped status to 'expired' and returned a count. No refund, so any
--    request left pending past the TTL silently destroyed the player's chips.
--
-- 2. fn_reject_cashout - no live caller yet, but a landmine. It refunded the
--    WRONG LEDGER: escrow debits club_members.chip_balance, but the reject
--    credited `wallets.balance WHERE wallet_type='PLAYER'`. Doubly wrong - club
--    chips stay destroyed AND unrelated wallet chips are minted from nowhere.
--    It also logged to wallet_transactions instead of chip_transactions, so the
--    club chip audit trail never saw it.
--
-- Blast radius today is ZERO: cashout_requests holds 0 rows - never run in
-- production. Fixed before first use.
--
-- Both now refund club_members.chip_balance (the exact ledger the escrow
-- debited) and log to chip_transactions with related_cashout_id so a request
-- and its refund reconcile as a pair.
--
-- Defaults preserved exactly (p_ttl_hours DEFAULT 72, p_reason DEFAULT NULL);
-- postgres requires DROP first to change them.
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.fn_expire_stale_cashouts(integer)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: fn_expire_stale_cashouts(integer) missing.';
  END IF;
  IF to_regprocedure('public.fn_reject_cashout(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: fn_reject_cashout(uuid,uuid,text) missing.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.fn_expire_stale_cashouts(integer);
DROP FUNCTION IF EXISTS public.fn_reject_cashout(uuid,uuid,text);

CREATE FUNCTION public.fn_expire_stale_cashouts(p_ttl_hours integer DEFAULT 72)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_expired integer := 0;
  r         record;
BEGIN
  FOR r IN
    SELECT id, club_id, player_id, amount
      FROM public.cashout_requests
     WHERE status = 'pending'
       AND created_at < NOW() - make_interval(hours => p_ttl_hours)
     FOR UPDATE
  LOOP
    UPDATE public.club_members
       SET chip_balance = COALESCE(chip_balance, 0) + r.amount::integer,
           updated_at   = NOW()
     WHERE club_id = r.club_id AND user_id = r.player_id;

    UPDATE public.cashout_requests
       SET status     = 'expired',
           updated_at = NOW(),
           agent_note = COALESCE(agent_note, '')
                        || ' [auto-expired after ' || p_ttl_hours::text || 'h; escrow refunded]'
     WHERE id = r.id;

    INSERT INTO public.chip_transactions (
      id, club_id, from_user_id, to_user_id, amount,
      transaction_type, notes, related_cashout_id, balance_after, created_at
    ) VALUES (
      gen_random_uuid(), r.club_id, NULL, r.player_id, r.amount,
      'cashout_expired_refund',
      'Cashout expired after ' || p_ttl_hours::text || 'h - escrowed chips returned to player',
      r.id,
      (SELECT COALESCE(chip_balance, 0) FROM public.club_members
        WHERE club_id = r.club_id AND user_id = r.player_id),
      NOW()
    );

    v_expired := v_expired + 1;
  END LOOP;

  RETURN v_expired;
END;
$fn$;

CREATE FUNCTION public.fn_reject_cashout(
  p_cashout_id uuid, p_agent_id uuid, p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_cashout      record;
  v_player_after numeric;
BEGIN
  SELECT * INTO v_cashout FROM public.cashout_requests
   WHERE id = p_cashout_id FOR UPDATE;

  IF v_cashout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not found');
  END IF;
  IF v_cashout.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not in pending status',
                              'current_status', v_cashout.status);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.club_members
     WHERE club_id = v_cashout.club_id
       AND user_id = p_agent_id
       AND role IN ('agent','super_agent','owner','co_owner','admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to reject for this club');
  END IF;

  UPDATE public.club_members
     SET chip_balance = COALESCE(chip_balance, 0) + v_cashout.amount::integer,
         updated_at   = NOW()
   WHERE club_id = v_cashout.club_id AND user_id = v_cashout.player_id
  RETURNING chip_balance INTO v_player_after;

  IF v_player_after IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'player has no member row in this club');
  END IF;

  UPDATE public.cashout_requests
     SET status = 'rejected', agent_note = COALESCE(p_reason, agent_note), updated_at = NOW()
   WHERE id = p_cashout_id;

  INSERT INTO public.chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_cashout.club_id, NULL, v_cashout.player_id, v_cashout.amount,
    'cashout_rejected_refund',
    COALESCE(p_reason, 'Cashout rejected - escrowed chips returned to player'),
    p_cashout_id, v_player_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'refunded', v_cashout.amount,
                            'player_id', v_cashout.player_id,
                            'player_balance_after', v_player_after);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_expire_stale_cashouts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_expire_stale_cashouts(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_expire_stale_cashouts(integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.fn_reject_cashout(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_reject_cashout(uuid,uuid,text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_reject_cashout(uuid,uuid,text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_expire_stale_cashouts(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_reject_cashout(uuid,uuid,text) TO service_role;

DO $$
DECLARE v_exp text; v_rej text; v_exp_def int; v_rej_def int;
BEGIN
  SELECT prosrc, pronargdefaults INTO v_exp, v_exp_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_expire_stale_cashouts';
  SELECT prosrc, pronargdefaults INTO v_rej, v_rej_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_reject_cashout';

  IF v_exp !~* 'club_members'  THEN RAISE EXCEPTION 'Post-apply: expiry does not refund club_members.'; END IF;
  IF v_rej ~*  'wallet_type'   THEN RAISE EXCEPTION 'Post-apply: reject still refunds the wallets ledger.'; END IF;
  IF v_rej !~* 'club_members'  THEN RAISE EXCEPTION 'Post-apply: reject does not refund club_members.'; END IF;
  -- pronargdefaults, not to_regprocedure('f()') - a DEFAULT does not create a
  -- separate zero-arg entry, which is what my first attempt wrongly asserted.
  IF v_exp_def < 1 THEN RAISE EXCEPTION 'Post-apply: p_ttl_hours DEFAULT 72 lost.'; END IF;
  IF v_rej_def < 1 THEN RAISE EXCEPTION 'Post-apply: p_reason DEFAULT NULL lost.'; END IF;
  IF has_function_privilege('authenticated','public.fn_reject_cashout(uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-apply: fn_reject_cashout must stay server-only.';
  END IF;
  IF NOT has_function_privilege('service_role','public.fn_expire_stale_cashouts(integer)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-apply: service_role lost EXECUTE on the expiry job.';
  END IF;
  RAISE NOTICE 'Post-apply OK: both refund club_members escrow; defaults intact (% / %).', v_exp_def, v_rej_def;
END $$;
