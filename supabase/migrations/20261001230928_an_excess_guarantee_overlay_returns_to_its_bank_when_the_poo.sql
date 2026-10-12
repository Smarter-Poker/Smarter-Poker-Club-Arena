-- 20261001230928_an_excess_guarantee_overlay_returns_to_its_bank_when_the_poo.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A GUARANTEE IS A FLOOR: THE FINAL POOL IS max(guarantee, collected)
-- ===========================================================================
--
-- Industry standard (PokerStars, GGPoker): a guarantee is a minimum prize
-- pool. The final pool is max(guarantee, every buy-in, rebuy and add-on net of
-- fee) and the house overlay is max(0, guarantee - collected).
--
-- Production paid more than that. fn_ca_fund_overlay_on_lock (trigger
-- zz_ca_fund_overlay_on_lock) tops the pool up to the guarantee from the union
-- bank or club treasury the moment the event starts, before late
-- registration, rebuys or the add-on break. Everything collected afterwards is
-- then ADDED on top, and at entry/add-on close fn_apply_prize_guarantee sees a
-- pool already at or above the guarantee and finalizes it as it stands.
--
--   c21cacad "$100 Freeroll 6:00 AM" (2026-10-01): guarantee 100.00, start-time
--   overlay 100.00 from the Midway union bank, 67 add-ons x 1.00 afterwards,
--   finalized at add-on close 12:12:17Z at 167.00 and paid 167.00.
--   Correct: pool 100.00, overlay 33.00. The bank overpaid 67.00.
--
-- Players never lose by this (they were paid the larger pool); the club or
-- union bank overpays every guaranteed event that collects money after it
-- starts.
--
-- THE FIX: fn_apply_prize_guarantee is the single finalization authority
-- (entry-window close, add-on close, the engine's own call and the settlement
-- fallbacks all reach it). Before it finalizes a pool it now returns the part
-- of the start-time overlay that the money collected since has made
-- unnecessary, to the exact bank and entity that funded it:
--
--   funded    = start-time overlay legs (category 'overlay', bank -> this
--               tournament's prize_liability, not the finalization leg)
--               minus anything already returned
--   collected = prize_pool - funded
--   target    = max(effective guarantee, collected)
--   excess    = least(funded, max(0, prize_pool - target))
--
-- The effective guarantee is the one the lock trigger funded: guaranteed_prize,
-- or for a satellite the guaranteed seats' value when larger. The return is the
-- mirror of the reviewed void return (20260926131948): the bank balance and one
-- 'reversal' leg out of prize_liability (metadata kind
-- 'reviewed_void_overlay_return', which the escrow shadow, the conservation
-- delta and the backed-payout sweep already net), then the maintained escrow,
-- then the unfinalized pool, all in one transaction with the finalization. If
-- the finalization refuses, the return is rolled back with it.
--
-- Nothing is ever taken from a player: only an UNFINALIZED pool is corrected,
-- before any payout ladder is priced from it; a finalized or completed event is
-- never touched (completed events stay as paid). A start-time overlay split
-- across two banks is left as it is (none exists in production). Diamond events
-- never take a chip overlay and are unaffected.
--
-- Law: tests/an-excess-guarantee-overlay-returns-to-its-bank.law.test.ts

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_apply_prize_guarantee(uuid,text)'::regprocedure
       AND md5(p.prosrc) = '4f921617438bfcfb0b9db32ff490b81d'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_apply_prize_guarantee is not the definition read 2026-10-01';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_escrow_apply(uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric)'::regprocedure
       AND md5(p.prosrc) = 'e084726dde176e51a8b1b0d64b0c2f0b') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_escrow_apply is not the definition read 2026-10-01';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_overlay numeric;
  v_ledger_count integer;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_return jsonb := NULL;
  v_refusal jsonb;
BEGIN
  /* A GUARANTEE IS A FLOOR (2026-10-01). The start-time overlay part that
     money collected since has made unnecessary goes back to its bank before
     the pool is finalized, so the final pool is max(guarantee, collected).
     One subtransaction with the finalization: a refused finalization rolls
     the return back too, and the caller sees the refusal unchanged. */
  BEGIN
    v_return := public.fn_ca_return_excess_start_overlay_locked(p_tournament_id);
    v_result:=public.fn_ca_apply_prize_guarantee_core(
      p_tournament_id,p_source);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
      v_refusal := v_result;
      RAISE EXCEPTION USING ERRCODE='P0405',
        MESSAGE='guarantee finalization refused; the excess return is rolled back with it';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0405' THEN
    RETURN v_refusal;
  END;
  v_overlay:=COALESCE((v_result->>'overlay')::numeric,0);
  IF v_overlay::text IN ('NaN','Infinity','-Infinity')
     OR v_overlay<0 OR v_overlay IS DISTINCT FROM round(v_overlay,2) THEN
    RAISE EXCEPTION 'guarantee core returned invalid overlay %',v_overlay
      USING ERRCODE='P0404';
  END IF;
  IF v_overlay>0 THEN
    SELECT count(*) INTO v_ledger_count
      FROM public.chip_ledger l
     WHERE l.idempotency_key=
             'tourney:'||p_tournament_id::text||':guarantee_overlay'
       AND l.tournament_id=p_tournament_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=p_tournament_id
       AND l.category='overlay'
       AND l.amount=v_overlay
       AND l.from_entity_id=(v_result->>'bank_entity_id')::uuid
       AND l.from_type=CASE WHEN v_result->>'bank_type'='union'
                            THEN 'union_bank' ELSE 'club_treasury' END;
    SELECT * INTO v_escrow
      FROM public.tournament_escrow e
     WHERE e.tournament_id=p_tournament_id
     FOR UPDATE;
    IF v_ledger_count<>1 OR NOT FOUND
       OR COALESCE(v_escrow.enforced,false) IS NOT TRUE
       OR v_result->>'escrow_after' IS NULL
       OR v_escrow.prize_balance IS DISTINCT FROM
            (v_result->>'escrow_after')::numeric THEN
      RAISE EXCEPTION
        'guarantee overlay is not one exact journaled escrow credit'
        USING ERRCODE='P0404';
    END IF;
  END IF;
  RETURN v_result||jsonb_build_object('overlay_journaled',true)
    ||CASE WHEN v_return IS NOT NULL
           THEN jsonb_build_object('excess_overlay_returned',v_return)
           ELSE '{}'::jsonb END;
END;
$function$;

-- Register the private balance writer before CREATE FUNCTION so the production
-- event trigger (fn_ca_money_rpc_registry_guard) admits it atomically.
INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES (
  'fn_ca_return_excess_start_overlay_locked','approved',
  'Owner-only helper called by fn_apply_prize_guarantee before it finalizes an unfinalized pool. Credits back to the exact union_wallets.chip_balance or clubs.chip_treasury that funded the start-time guarantee overlay the part that money collected since made unnecessary (least(funded, pool - max(guarantee, collected))), journaled as one keyed reversal leg out of prize_liability (tourney:<id>:guarantee_overlay_excess_return) with the escrow overlay debit, in the same subtransaction as the finalization. Never touches a finalized pool or a player wallet.'
)
ON CONFLICT (proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

CREATE FUNCTION public.fn_ca_return_excess_start_overlay_locked(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_system_actor constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_t public.tournaments%ROWTYPE;
  v_key text;
  v_sources integer;
  v_from_type text;
  v_from_entity uuid;
  v_first_leg uuid;
  v_funded numeric;
  v_returned numeric;
  v_pool numeric;
  v_guarantee numeric;
  v_seat_guarantee numeric;
  v_target_id uuid;
  v_collected numeric;
  v_target numeric;
  v_excess numeric;
  v_before numeric;
  v_after numeric;
  v_ledger_id uuid;
BEGIN
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN NULL;  -- a finalized pool is never repriced
  END IF;
  v_key := 'tourney:' || p_tournament_id::text || ':guarantee_overlay_excess_return';
  IF EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key = v_key) THEN
    RETURN NULL;
  END IF;

  -- The start-time legs fn_ca_fund_overlay_on_lock wrote (the finalization
  -- leg carries its own idempotency key and cannot exist before finalizing).
  SELECT count(DISTINCT (l.from_type, l.from_entity_id)), min(l.from_type),
         (array_agg(l.from_entity_id ORDER BY l.created_at, l.id))[1],
         (array_agg(l.id ORDER BY l.created_at, l.id))[1],
         round(COALESCE(sum(l.amount), 0), 2)
    INTO v_sources, v_from_type, v_from_entity, v_first_leg, v_funded
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.category = 'overlay'
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.from_type IN ('union_bank', 'club_treasury')
     AND l.idempotency_key IS DISTINCT FROM 'tourney:' || p_tournament_id::text || ':guarantee_overlay'
     AND COALESCE(l.description, '') NOT LIKE 'auto-ledgered%';
  IF COALESCE(v_funded, 0) <= 0 OR v_sources <> 1 THEN
    RETURN NULL;
  END IF;
  SELECT round(COALESCE(sum(r.amount), 0), 2) INTO v_returned
    FROM public.chip_ledger r
   WHERE r.tournament_id = p_tournament_id AND r.category = 'reversal'
     AND r.from_type = 'prize_liability' AND r.from_entity_id = p_tournament_id
     AND r.metadata->>'kind' = 'reviewed_void_overlay_return';
  v_funded := round(v_funded - v_returned, 2);
  IF v_funded <= 0 THEN RETURN NULL; END IF;

  v_pool := round(COALESCE(v_t.prize_pool, 0), 2);
  v_guarantee := round(COALESCE(v_t.guaranteed_prize, 0), 2);
  -- The same effective guarantee the lock trigger funded: a satellite's
  -- guaranteed seats are worth target buy-in + fee each.
  IF COALESCE(v_t.satellite_seats, 0) > 0
     AND (v_t.variant = 'satellite'
          OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
          OR v_t.satellite_target_id IS NOT NULL) THEN
    v_target_id := COALESCE(v_t.satellite_target_id, v_t.satellite_target);
    IF v_target_id IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount, 0) + COALESCE(t2.buy_in_fee, 0)) * v_t.satellite_seats, 2)
        INTO v_seat_guarantee FROM public.tournaments t2 WHERE t2.id = v_target_id;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_collected := round(v_pool - v_funded, 2);
  v_target := GREATEST(v_guarantee, v_collected);
  v_excess := round(LEAST(v_funded, GREATEST(0, v_pool - v_target)), 2);
  IF v_excess <= 0 THEN RETURN NULL; END IF;

  -- Lock order of the finalization core: tournament, escrow, then the bank.
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_from_type = 'union_bank' THEN
    SELECT round(COALESCE(chip_balance, 0), 2) INTO v_before FROM public.union_wallets
     WHERE union_id = v_from_entity FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    UPDATE public.union_wallets SET chip_balance = chip_balance + v_excess, updated_at = now()
     WHERE union_id = v_from_entity RETURNING round(chip_balance, 2) INTO v_after;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
  ELSE
    SELECT round(COALESCE(chip_treasury, 0), 2) INTO v_before FROM public.clubs
     WHERE id = v_from_entity FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + v_excess, updated_at = now()
     WHERE id = v_from_entity RETURNING round(chip_treasury, 2) INTO v_after;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;
  IF v_after IS DISTINCT FROM round(v_before + v_excess, 2) THEN
    RAISE EXCEPTION 'excess overlay return did not credit its bank exactly'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.chip_ledger (
    performed_by, from_type, from_entity_id, to_type, to_entity_id,
    amount, category, club_id, tournament_id, description, idempotency_key, metadata)
  VALUES (
    c_system_actor, 'prize_liability', p_tournament_id, v_from_type, v_from_entity,
    v_excess, 'reversal', v_t.club_id, p_tournament_id,
    format('Guarantee overlay excess returned to its source: %s (%s) collected %s against its %s guarantee, so the %s start-time overlay needed only %s',
           COALESCE(v_t.name, 'tournament'), p_tournament_id, v_collected, v_guarantee,
           v_funded, round(v_funded - v_excess, 2)),
    v_key,
    jsonb_build_object('kind', 'reviewed_void_overlay_return',
      'reason', 'guarantee_overlay_excess_at_finalization',
      'original_overlay_ledger_id', v_first_leg, 'funded_overlay', v_funded,
      'collected', v_collected, 'guarantee', v_guarantee,
      'pool_before', v_pool, 'pool_after', round(v_pool - v_excess, 2),
      'source_balance_before', v_before, 'source_balance_after', v_after))
  RETURNING id INTO v_ledger_id;
  PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'guarantee overlay excess return',
                                    p_overlay_in => -v_excess);

  UPDATE public.tournaments
     SET prize_pool = round(v_pool - v_excess, 2)
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('amount', v_excess, 'bank_type', v_from_type,
    'bank_entity_id', v_from_entity, 'funded_overlay', v_funded,
    'collected', v_collected, 'guarantee', v_guarantee,
    'pool_before', v_pool, 'pool_after', round(v_pool - v_excess, 2),
    'ledger_id', v_ledger_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_apply_prize_guarantee(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_return_excess_start_overlay_locked(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.fn_apply_prize_guarantee(uuid,text)'::regprocedure
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
     AND p.proconfig::text = '{"search_path=public, pg_temp"}'
     AND p.prosecdef AND p.provolatile = 'v';
  IF v_src IS NULL OR strpos(v_src, 'fn_ca_return_excess_start_overlay_locked(p_tournament_id)') = 0 THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_apply_prize_guarantee does not return the excess start-time overlay';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_return_excess_start_overlay_locked(uuid)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_ca_return_excess_start_overlay_locked has the wrong owner, grants or configuration';
  END IF;
END
$post$;

COMMIT;
