-- R42: launch recovery and entry closure preserve committed payout terms.
-- No historical event, receipt, rank, obligation, payout or wallet is changed.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $preflight$
DECLARE item jsonb; p record; identity oid;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements($manifest$[{"signature":"public.fn_ca_fund_overlay_on_lock()","before":"0b9e38ced818aa52f0f25ec75d74d7bc","after":"9a1e253ed64da3e005c2c55135d988be","acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v"},{"signature":"public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)","before":"3700da2562a5cabcb67e3c7a4ae3821d","after":"2db457f2fb721cff74b54d69e8f553d5","acl":"{postgres=X/postgres}","volatility":"v"},{"signature":"public.fn_tournament_payout_terms_committed_v1(uuid)","before":null,"after":"5c31fe20d25154e0c70a976b38bb88c3","acl":"{postgres=X/postgres}","volatility":"s"}]$manifest$::jsonb) LOOP
  identity:=to_regprocedure(item->>'signature');
  IF identity IS NULL THEN
   IF item->>'before' IS NOT NULL THEN RAISE EXCEPTION 'Payout terms source missing: %',item->>'signature'; END IF; CONTINUE;
  END IF;
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner WHERE f.oid=identity;
  IF md5(p.prosrc) NOT IN (COALESCE(item->>'before',item->>'after'),item->>'after')
     OR p.owner<>'postgres' OR p.proacl::text IS DISTINCT FROM item->>'acl'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile::text IS DISTINCT FROM item->>'volatility'
     OR p.proparallel::text IS DISTINCT FROM 'u' THEN
   RAISE EXCEPTION 'Payout terms unreviewed source or metadata: %',item->>'signature';
  END IF;
 END LOOP;
END $preflight$;
DO $dependencies$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_tournament_payout_key_is_place_evidence(uuid,text)')) IS DISTINCT FROM '0ac277c3ebf89bede86d63f6f38bcc66' THEN RAISE EXCEPTION 'Payout terms dependency changed: fn_tournament_payout_key_is_place_evidence(uuid,text)'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_safe_jsonb_array(text)')) IS DISTINCT FROM 'f7d50c875a67fb5a84ae4f1c32bdf941' THEN RAISE EXCEPTION 'Payout terms dependency changed: fn_safe_jsonb_array(text)'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_payout_structure(integer,integer)')) IS DISTINCT FROM '869a4e87108481934c4cdb985d489051' THEN RAISE EXCEPTION 'Payout terms dependency changed: fn_ca_payout_structure(integer,integer)'; END IF;
END $dependencies$;

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_terms_committed_v1(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id=p_tournament_id AND t.prize_pool_finalized IS TRUE)
     OR EXISTS (SELECT 1 FROM public.tournament_entry_close_receipts r
                 WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_final_table_deal_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements h
                 WHERE h.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts c
                 WHERE c.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id
                   AND o.kind IN ('place','bubble_protection','final_table_deal','late_reg_adjustment'))
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id=p_tournament_id
                   AND (p.source IN ('structure','reconcile','hu_shortfall','late_reg_adjustment',
                         'clawback','spin_backpay','overlay_backpay','final_table_deal','bubble_protection')
                        OR public.fn_tournament_payout_key_is_place_evidence(
                             p.tournament_id,p.idempotency_key)));
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_store text;
  v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
  v_attempt int; v_fallback numeric;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  /* ── 1. payout table, from the field that actually entered ─────────────
     Only when nobody has registered yet. With registrations present,
     fn_guard_managed_game_lifecycle protects payout_structure and this
     trigger currently runs BEFORE it, so writing here refuses the whole
     start. Re-enabled once the trigger is renamed to sort after the guard.

     NOT FOR A SPIN (2026-09-02). A Spin's ladder comes from the tier the
     wheel drew - 10x is 80/20 - and this rule is "pay the top N% of the
     field", which on three seats rounds to one place and silently replaced
     every high multiplier with winner-take-all. 32 games, 1,592 chips. */
  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id;

  -- A recovered RUNNING transition is not a new payout contract. The row
  -- is locked by its owning UPDATE; prepared/paid terms cannot be refitted
  -- to today's field. Keep the existing overlay transaction below intact.
  IF public.fn_tournament_payout_terms_committed_v1(OLD.id) THEN
    IF OLD.prize_pool_finalized IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Committed tournament payout terms have no finalized pool'
        USING ERRCODE='55000';
    END IF;
  ELSIF lower(COALESCE(NEW.variant,''))<>'spin'
        AND upper(COALESCE(NEW.tournament_type,''))<>'SPIN' THEN
    IF v_entrants > 0 AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = 'public.tournaments'::regclass
            AND tg.tgname = 'zz_ca_fund_overlay_on_lock')
    THEN
      NULL;  -- stand down: the guard would refuse the start
    ELSIF v_entrants > 0 THEN
      v_places := GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int));
      BEGIN
        v_existing := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
      EXCEPTION WHEN OTHERS THEN v_existing := NULL; END;

      IF v_existing IS NULL
         OR jsonb_typeof(v_existing) <> 'array'
         OR jsonb_array_length(v_existing) = 0
         OR v_existing = '[{"place":1,"percentage":100}]'::jsonb
         OR jsonb_array_length(v_existing) <> v_places
      THEN
        NEW.payout_structure := public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text;
      END IF;
    END IF;
  END IF;

  /* ── 2. the guarantee overlay, from the main bank ─────────────────────── */
  v_pool_before := round(COALESCE(NEW.prize_pool,0),2);
  v_guarantee   := round(COALESCE(NEW.guaranteed_prize,0),2);

  /* A GUARANTEED SEAT IS A GUARANTEE (2026-09-02). A satellite's advertised
     seats are worth target buy-in + fee each; the engine awards every one of
     them, so the bank funds the shortfall here, like any other guarantee. */
  IF COALESCE(NEW.satellite_seats, 0) > 0
     AND (NEW.variant = 'satellite'
          OR UPPER(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
          OR NEW.satellite_target_id IS NOT NULL) THEN
    v_target := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
    IF v_target IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount,0) + COALESCE(t2.buy_in_fee,0)) * NEW.satellite_seats, 2)
        INTO v_seat_guarantee
        FROM public.tournaments t2 WHERE t2.id = v_target;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_short := GREATEST(0, v_guarantee - v_pool_before);
  IF v_short <= 0 THEN RETURN NEW; END IF;

  PERFORM set_config('app.ledger_category', 'overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  v_union := CASE WHEN COALESCE(NEW.is_private,false) THEN NULL ELSE NEW.union_id END;

  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR UPDATE;
    v_from := 'union_bank';
    v_store := 'union_wallets.chip_balance';
    IF COALESCE(v_bank,0) < v_short THEN
      /* THE MAIN BANK IS SHORT - FALL BACK TO THE CLUB TREASURY.
         Dan 2026-09-04. Refusing here meant advertising a guarantee and then
         not paying it. */
      SELECT chip_treasury INTO v_fallback
        FROM public.clubs WHERE id = NEW.club_id FOR UPDATE;

      IF COALESCE(v_fallback,0) >= v_short THEN
        v_from  := 'club_treasury';
        v_store := 'clubs.chip_treasury';
        PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
        UPDATE public.clubs
           SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
         WHERE id = NEW.club_id;
        PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
        PERFORM public.fn_raise_server_financial_alert(
          'warning', 'fn_ca_fund_overlay_on_lock',
          format('%s took its %s chip overlay from the club treasury: the union bank held only %s. The guarantee WAS met. Refill the union bank.',
                 COALESCE(NEW.name, NEW.id::text), v_short, COALESCE(v_bank,0)),
          jsonb_build_object('kind','overlay_funded_from_fallback','tournament_id',NEW.id,
            'shortfall',v_short,'union_bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        v_union := NULL;  -- the ledger row names the account that actually moved
      ELSE
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_ca_fund_overlay_on_lock',
          format('%s needs %s chips of overlay to meet its %s guarantee. The union bank holds %s and the club treasury holds %s. BOTH are short and the pool was NOT topped up.',
                 COALESCE(NEW.name, NEW.id::text), v_short, v_guarantee,
                 COALESCE(v_bank,0), COALESCE(v_fallback,0)),
          jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
            'shortfall',v_short,'bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        RETURN NEW;
      END IF;
    ELSE
      PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets
         SET chip_balance = chip_balance - v_short, updated_at = now()
       WHERE union_id = v_union;
      PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
    END IF;
  ELSE
    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR UPDATE;
    v_from := 'club_treasury';
    v_store := 'clubs.chip_treasury';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the club treasury holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
     WHERE id = NEW.club_id;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;

  NEW.prize_pool := round(v_pool_before + v_short, 2);

  -- Funding and its escrow/journal leg are one transaction. A failed
  -- journal insert must undo the bank debit and the advertised pool change.
  -- Retry only transient deadlocks; every final error propagates to the
  -- original status update, whose existing lifecycle can retry safely.
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        v_from, COALESCE(v_union, NEW.club_id), 'prize_liability', NEW.id,
        v_short, 'overlay', NEW.club_id, NEW.id,
        format('Guarantee overlay from the main bank: %s (%s) was %s short of its %s guarantee - field made %s, bank paid %s',
               COALESCE(NEW.name, 'tournament'), NEW.id::text,
               v_short, v_guarantee,
               v_pool_before, v_short));
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      IF v_attempt = 3 THEN RAISE; END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_finalize_tournament_entry_pool_locked(p_tournament_id uuid, p_source text, p_close_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_receipt public.tournament_entry_close_receipts%ROWTYPE;
  v_result jsonb;
  v_field integer;
  v_structure jsonb;
  v_wake_id bigint;
  v_pool numeric;
  v_is_satellite boolean;
BEGIN
  IF p_close_mode NOT IN ('levels','minutes','immediate','addon') THEN
    RAISE EXCEPTION 'Invalid tournament entry close mode' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_found');
  END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_running','status',v_t.status);
  END IF;

  SELECT * INTO v_receipt
    FROM public.tournament_entry_close_receipts r
   WHERE r.tournament_id=p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    -- A DB-first/old-engine window may have consumed the first wake without
    -- understanding this receipt. Re-emit only when no unconsumed row remains;
    -- never increment the generation a current sweep is already processing.
    IF v_receipt.reprice_completed_at IS NULL
       AND (v_receipt.manager_wake_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.tournament_manager_wakes w
          WHERE w.id=v_receipt.manager_wake_id AND w.consumed_at IS NULL
       )) THEN
      v_wake_id := public.fn_emit_tournament_manager_wake(
        p_tournament_id,'late_registration');
      UPDATE public.tournament_entry_close_receipts
         SET manager_wake_id=v_wake_id,updated_at=clock_timestamp()
       WHERE tournament_id=p_tournament_id
       RETURNING * INTO v_receipt;
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'entry_closed',true,'finalized',true,
      'already_finalized',true,'close_mode',v_receipt.close_mode,
      'prize_pool',v_receipt.final_prize_pool,
      'payout_structure',v_receipt.payout_structure_snapshot,
      'reprice_pending',v_receipt.reprice_completed_at IS NULL,
      'retry_after_ms',NULL
    );
  END IF;

  SELECT count(*)::integer INTO v_field
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  IF v_field<1 THEN
    RAISE EXCEPTION 'Entry cannot close without a readable final field'
      USING ERRCODE='55000';
  END IF;

  v_is_satellite := lower(COALESCE(v_t.variant,''))='satellite'
                 OR upper(COALESCE(v_t.tournament_type,''))='SATELLITE'
                 OR v_t.satellite_target_id IS NOT NULL;

  -- Finalization or settlement evidence has already committed these terms.
  -- Legacy events can lack this newer receipt: adding it must not regenerate
  -- their payout ladder or revise prizes already prepared/paid against it.
  IF public.fn_tournament_payout_terms_committed_v1(p_tournament_id) THEN
    IF v_t.prize_pool_finalized IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Committed tournament payout terms have no finalized pool'
        USING ERRCODE='55000';
    END IF;
    v_structure := public.fn_safe_jsonb_array(v_t.payout_structure::text);
    IF jsonb_array_length(v_structure)=0 THEN
      RAISE EXCEPTION 'Committed payout structure is unreadable' USING ERRCODE='55000';
    END IF;
  -- Fresh events still use the final-field generator. Spins keep wheel terms.
  ELSIF lower(COALESCE(v_t.variant,''))<>'spin'
     AND upper(COALESCE(v_t.tournament_type,''))<>'SPIN' THEN
    v_structure := public.fn_ca_payout_structure(
      v_field,COALESCE(v_t.payout_percent,10));
    IF jsonb_array_length(v_structure)=0 THEN
      RAISE EXCEPTION 'Final payout structure is unreadable' USING ERRCODE='55000';
    END IF;
    UPDATE public.tournaments
       SET payout_structure=v_structure::text
     WHERE id=p_tournament_id;
  ELSE
    v_structure := public.fn_safe_jsonb_array(v_t.payout_structure::text);
    IF jsonb_array_length(v_structure)=0 THEN
      RAISE EXCEPTION 'Spin payout structure is unreadable' USING ERRCODE='55000';
    END IF;
  END IF;

  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    v_result := jsonb_build_object(
      'ok',true,'already_finalized',true,'prize_pool',COALESCE(v_t.prize_pool,0));
  ELSE
    v_result := public.fn_apply_prize_guarantee(
      p_tournament_id,COALESCE(NULLIF(btrim(p_source),''),'engine.entry_window_close'));
  END IF;
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR v_result->>'prize_pool' IS NULL THEN
    RAISE EXCEPTION 'Entry close could not fund/finalize its prize pool: %',
      COALESCE(v_result->>'reason','unreadable result') USING ERRCODE='55000';
  END IF;
  v_pool := (v_result->>'prize_pool')::numeric;

  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id;
  IF COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR round(COALESCE(v_t.prize_pool,0),2)<>round(v_pool,2) THEN
    RAISE EXCEPTION 'Entry close returned without an exact funded pool marker'
      USING ERRCODE='55000';
  END IF;

  -- Satellites keep the canonical field ladder for readers, but never cash-
  -- reprice eliminated finishers from it. Their immutable seat-or-cash plus
  -- remainder entitlements are materialized by the atomic satellite contract
  -- from this final funded pool; marking generic reprice complete prevents a
  -- manager from paying the display ladder as cash first.
  INSERT INTO public.tournament_entry_close_receipts(
    tournament_id,close_mode,entry_closed_at,final_prize_pool,
    payout_structure_snapshot,reprice_completed_at
  ) VALUES (
    p_tournament_id,p_close_mode,clock_timestamp(),v_pool,
    v_structure,CASE WHEN v_is_satellite THEN clock_timestamp() ELSE NULL END
  )
  RETURNING * INTO v_receipt;
  v_wake_id := public.fn_emit_tournament_manager_wake(
    p_tournament_id,'late_registration');
  UPDATE public.tournament_entry_close_receipts
     SET manager_wake_id=v_wake_id,updated_at=clock_timestamp()
   WHERE tournament_id=p_tournament_id;

  RETURN v_result || jsonb_build_object(
    'ok',true,'entry_closed',true,'finalized',true,
    'close_mode',p_close_mode,'payout_structure',v_structure,
    'reprice_pending',NOT v_is_satellite,'retry_after_ms',NULL
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_tournament_payout_terms_committed_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_terms_committed_v1(uuid) TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_fund_overlay_on_lock() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_overlay_on_lock() TO service_role;
REVOKE ALL ON FUNCTION public.fn_finalize_tournament_entry_pool_locked(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_finalize_tournament_entry_pool_locked(uuid,text,text) TO postgres;
DO $postflight$
DECLARE item jsonb; p record; identity oid;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements($manifest$[{"signature":"public.fn_ca_fund_overlay_on_lock()","before":"0b9e38ced818aa52f0f25ec75d74d7bc","after":"9a1e253ed64da3e005c2c55135d988be","acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v"},{"signature":"public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)","before":"3700da2562a5cabcb67e3c7a4ae3821d","after":"2db457f2fb721cff74b54d69e8f553d5","acl":"{postgres=X/postgres}","volatility":"v"},{"signature":"public.fn_tournament_payout_terms_committed_v1(uuid)","before":null,"after":"5c31fe20d25154e0c70a976b38bb88c3","acl":"{postgres=X/postgres}","volatility":"s"}]$manifest$::jsonb) LOOP
  identity:=to_regprocedure(item->>'signature');
  IF identity IS NULL THEN
   RAISE EXCEPTION 'Payout terms source missing: %',item->>'signature';
  END IF;
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner WHERE f.oid=identity;
  IF md5(p.prosrc) IS DISTINCT FROM item->>'after'
     OR p.owner<>'postgres' OR p.proacl::text IS DISTINCT FROM item->>'acl'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile::text IS DISTINCT FROM item->>'volatility'
     OR p.proparallel::text IS DISTINCT FROM 'u' THEN
   RAISE EXCEPTION 'Payout terms unreviewed source or metadata: %',item->>'signature';
  END IF;
 END LOOP;
END $postflight$;
COMMIT;
