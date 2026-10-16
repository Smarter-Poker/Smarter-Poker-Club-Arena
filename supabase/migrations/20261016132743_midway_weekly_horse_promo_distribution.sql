-- Owner request 2026-10-16: at each weekly Midway close, split half of the
-- Union Promo Wallet equally over enabled horse wallets under 10,000 chips.
-- Eligibility is per club wallet, explicitly confirmed by the owner.
-- This is new scheduled business behavior on the existing weekly close,
-- not a second scheduler or a repair sweep. First payable week ends Oct 19.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $admission$
BEGIN
 IF current_user <> 'postgres' OR auth.role() IS NOT NULL THEN
  RAISE EXCEPTION 'midway_promo_installer_requires_postgres' USING ERRCODE='42501';
 END IF;
 IF public.fn_platform_frozen() OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
  RAISE EXCEPTION 'midway_promo_install_frozen';
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
  RAISE EXCEPTION 'midway_promo_weekly_close_owned';
 END IF;
 IF to_regclass('public.union_weekly_horse_promo_runs') IS NOT NULL THEN
  RAISE EXCEPTION 'midway_promo_install_replay';
 END IF;
END $admission$;

-- pg_cron uses the coordinator's trusted no-request convention; no invented
-- JWT or owner identity. Browser authorization stays on the existing owner
-- checks. The generic member writer cannot label a union-wallet column, so
-- this door owns its single explicitly labelled promo->player ledger leg.
-- Club destinations and all other member writers remain on their old paths.
DO $promo_preimage$
BEGIN
 IF md5(pg_get_functiondef('public.fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)'::regprocedure))
   <>'54539cb4d66ffdcdacd85521e5fbb929' THEN RAISE EXCEPTION 'midway_promo_disburse_preimage_changed'; END IF;
END $promo_preimage$;
CREATE OR REPLACE FUNCTION public.fn_promo_disburse(p_source_kind text, p_source_id uuid, p_target_kind text, p_target_id uuid, p_amount numeric, p_note text DEFAULT NULL::text, p_club_id uuid DEFAULT NULL::uuid, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_service  boolean := public.fn_caller_is_engine();
  v_amt      numeric := round(COALESCE(p_amount, 0), 2);
  v_op       uuid := COALESCE(p_op_id, gen_random_uuid());
  v_src      text := lower(COALESCE(p_source_kind, ''));
  v_tgt      text := lower(COALESCE(p_target_kind, ''));
  v_avail    numeric;
  v_after    numeric;
  v_to_after numeric;
  v_club     uuid;
  v_union    uuid;
  v_prior    record;
  v_tx       uuid;
  v_lands_as text;
  v_member_skip text := current_setting('app.ledger_autoskip_club_members', true);
BEGIN
  IF v_actor IS NULL AND NOT v_service THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not Authenticated');
  END IF;
  IF v_src NOT IN ('union', 'club') THEN
    RETURN jsonb_build_object('success', false, 'error', 'source must be union or club');
  END IF;
  IF v_tgt NOT IN ('club', 'player') THEN
    RETURN jsonb_build_object('success', false, 'error', 'target must be club or player');
  END IF;
  IF v_src = 'club' AND v_tgt = 'club' THEN
    RETURN jsonb_build_object('success', false, 'error', 'a club disburses promo to its players, not to a club');
  END IF;
  IF p_source_id IS NULL OR p_target_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'source and target are required');
  END IF;

  SELECT id, amount, metadata INTO v_prior
    FROM chip_transactions
   WHERE transaction_type = 'promo_disbursement'
     AND metadata ->> 'op_id' = v_op::text
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'replayed', true,
      'transaction_id', v_prior.id, 'amount', v_prior.amount,
      'source_after', (v_prior.metadata ->> 'source_after')::numeric,
      'recipient_after', (v_prior.metadata ->> 'recipient_after')::numeric);
  END IF;

  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  END IF;
  IF v_amt <> round(v_amt, 2) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  END IF;
  IF v_amt > 1e9 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  END IF;

  IF v_src = 'union' THEN
    v_union := p_source_id;
    IF NOT v_service AND NOT EXISTS (
         SELECT 1 FROM unions u WHERE u.id = v_union AND u.owner_id = v_actor) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Only The Union Owner May Disburse Union Promo');
    END IF;
  ELSE
    v_club := p_source_id;
    IF NOT v_service AND NOT EXISTS (
         SELECT 1 FROM clubs c WHERE c.id = v_club AND c.owner_id = v_actor)
       AND NOT EXISTS (
         SELECT 1 FROM club_members m
          WHERE m.club_id = v_club AND m.user_id = v_actor
            AND m.role IN ('owner', 'co_owner')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Only The Club Owner May Disburse Club Promo');
    END IF;
  END IF;

  IF v_tgt = 'club' THEN
    IF NOT EXISTS (SELECT 1 FROM union_clubs uc
                    WHERE uc.union_id = v_union AND uc.club_id = p_target_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'That Club Is Not In This Union');
    END IF;
    v_club := p_target_id;
  ELSE
    IF v_src = 'union' THEN
      v_club := p_club_id;
      IF v_club IS NULL THEN
        SELECT m.club_id INTO v_club
          FROM club_members m
          JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
         WHERE m.user_id = p_target_id
           AND COALESCE(m.status, 'active') IN ('active', 'approved')
         ORDER BY m.updated_at DESC NULLS LAST
         LIMIT 1;
      END IF;
      IF v_club IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'That Player Is Not In Any Club Of This Union');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM union_clubs uc
                      WHERE uc.union_id = v_union AND uc.club_id = v_club) THEN
        RETURN jsonb_build_object('success', false, 'error', 'That Club Is Not In This Union');
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM club_members m
                    WHERE m.club_id = v_club AND m.user_id = p_target_id
                      AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'That Player Is Not An Active Member Of That Club');
    END IF;
  END IF;

  IF v_src = 'union' THEN
    SELECT COALESCE(promo_wallet, 0) INTO v_avail
      FROM union_wallets WHERE union_id = v_union FOR UPDATE;
    IF v_avail IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Union Wallet Not Found');
    END IF;
    IF v_avail < v_amt THEN
      RETURN jsonb_build_object('success', false, 'error', 'Insufficient Promo Balance',
                                'available', v_avail, 'requested', v_amt);
    END IF;

    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.promo_wallet', true);
    PERFORM set_config('app.ledger_correlation', v_op::text, true);

    UPDATE union_wallets
       SET promo_wallet = promo_wallet - v_amt, updated_at = now()
     WHERE union_id = v_union
     RETURNING round(promo_wallet, 2) INTO v_after;
  ELSE
    SELECT COALESCE(promo_balance, 0) INTO v_avail
      FROM clubs WHERE id = v_club FOR UPDATE;
    IF v_avail IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
    END IF;
    IF v_avail < v_amt THEN
      RETURN jsonb_build_object('success', false, 'error', 'Insufficient Promo Balance',
                                'available', v_avail, 'requested', v_amt);
    END IF;

    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_club, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['clubs']);
    PERFORM set_config('app.ledger_counterparty_label', 'clubs.promo_balance', true);
    PERFORM set_config('app.ledger_correlation', v_op::text, true);

    UPDATE clubs
       SET promo_balance = promo_balance - v_amt, updated_at = now()
     WHERE id = v_club
     RETURNING round(promo_balance, 2) INTO v_after;
  END IF;

  IF v_tgt = 'club' THEN
    v_lands_as := 'club_promo_wallet';
    UPDATE clubs
       SET promo_balance = COALESCE(promo_balance, 0) + v_amt, updated_at = now()
     WHERE id = v_club
     RETURNING round(promo_balance, 2) INTO v_to_after;
  ELSE
    v_lands_as := 'ordinary_chips';
    -- The common member writer has no source-column label. This promo door
    -- owns its exact union-promo leg; leave every other caller's writer alone.
    IF v_src = 'union' THEN
      PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    END IF;
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + v_amt, updated_at = now()
     WHERE club_id = v_club AND user_id = p_target_id
     RETURNING round(chip_balance, 2) INTO v_to_after;
    IF v_src = 'union' THEN
      INSERT INTO public.chip_ledger
        (performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,to_label,
         amount,category,club_id,union_id,description,
         pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
      VALUES
        (COALESCE(v_actor,'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'union_wallet',v_union,'union_wallets.promo_wallet',
         'player_wallet',p_target_id,'club_members.chip_balance',
         v_amt,'promo',v_club,v_union,'Union Promo Disbursement',
         v_avail,v_after,v_to_after-v_amt,v_to_after);
      PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(v_member_skip,''),true);
    END IF;
  END IF;

  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_clubs', '', true);

  IF v_to_after IS NULL THEN
    RAISE EXCEPTION 'promo disbursement credit found no row: % %', v_tgt, p_target_id;
  END IF;

  INSERT INTO chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  VALUES
    (v_club, v_actor,
     CASE WHEN v_tgt = 'player' THEN p_target_id END,
     v_amt, 'promo_disbursement',
     COALESCE(NULLIF(btrim(p_note), ''), 'Promo Disbursement'),
     jsonb_build_object('op_id', v_op,
                        'source_kind', v_src, 'source_id', p_source_id,
                        'target_kind', v_tgt, 'target_id', p_target_id,
                        'authorised_by', v_actor,
                        'source_after', v_after,
                        'recipient_after', v_to_after,
                        'lands_as', v_lands_as),
     v_to_after)
  RETURNING id INTO v_tx;

  IF v_src = 'union' THEN
    INSERT INTO union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    VALUES
      (v_union, v_club, 'promo_wallet', 'debit', v_amt, v_after, 'promo_disbursement',
       COALESCE(NULLIF(btrim(p_note), ''), 'Promo disbursed by the union owner')
         || ' (' || v_tgt || ')',
       v_actor);
  END IF;

  RETURN jsonb_build_object('success', true, 'replayed', false,
    'transaction_id', v_tx, 'op_id', v_op, 'amount', v_amt,
    'source_kind', v_src, 'target_kind', v_tgt, 'club_id', v_club,
    'source_after', v_after, 'recipient_after', v_to_after,
    'lands_as', v_lands_as);
END
$function$;

CREATE TABLE public.union_weekly_horse_promo_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 union_id uuid NOT NULL,
 period_start timestamptz NOT NULL,
 period_end timestamptz NOT NULL,
 opening_promo numeric(20,2) NOT NULL CHECK(opening_promo>=0),
 budget numeric(20,2) NOT NULL CHECK(budget>=0),
 paid numeric(20,2) NOT NULL CHECK(paid>=0 AND paid<=budget),
 eligible_wallets integer NOT NULL CHECK(eligible_wallets>=0),
 paid_wallets integer NOT NULL CHECK(paid_wallets>=0 AND paid_wallets<=eligible_wallets),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(union_id,period_start,period_end),
 CHECK(period_end>period_start),
 CHECK(budget=trunc(opening_promo/2,2))
);
CREATE TABLE public.union_weekly_horse_promo_recipients (
 run_id uuid NOT NULL REFERENCES public.union_weekly_horse_promo_runs(id),
 club_id uuid NOT NULL,
 user_id uuid NOT NULL,
 opening_balance numeric(20,2) NOT NULL CHECK(opening_balance<10000),
 amount numeric(20,2) NOT NULL CHECK(amount>0),
 balance_after numeric(20,2) NOT NULL,
 operation_id uuid NOT NULL UNIQUE,
 transaction_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(run_id,club_id,user_id),
 CHECK(balance_after=opening_balance+amount)
);
ALTER TABLE public.union_weekly_horse_promo_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_weekly_horse_promo_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.union_weekly_horse_promo_runs,public.union_weekly_horse_promo_recipients FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.union_weekly_horse_promo_runs,public.union_weekly_horse_promo_recipients TO service_role;

CREATE FUNCTION public.fn_midway_weekly_horse_promo_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
DECLARE
 v_midway constant uuid := 'fade0000-0000-0000-0000-000000000001';
 v_open numeric; v_budget numeric; v_cents bigint; v_n integer; v_i integer:=0;
 v_each bigint; v_extra bigint; v_amount numeric; v_paid numeric:=0; v_paid_n integer:=0;
 v_run uuid; v_op uuid; v_wallets jsonb; v_wallet jsonb; v_result jsonb; v_prior jsonb;
 v_saved jsonb; v_key text; v_note text;
BEGIN
 IF NEW.union_id IS DISTINCT FROM v_midway OR NEW.standalone_club_id IS NOT NULL
    OR NEW.status IS DISTINCT FROM 'complete'
    OR NEW.period_end<'2026-10-19 07:00:00+00'::timestamptz THEN RETURN NEW; END IF;
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'midway_promo_service_required' USING ERRCODE='42501'; END IF;
 IF NEW.period_start IS NULL OR NEW.period_end IS NULL
    OR NEW.period_start IS DISTINCT FROM public.fn_union_week_start(NEW.period_start)
    OR NEW.period_end IS DISTINCT FROM public.fn_union_week_start(NEW.period_start+interval '8 days')
    OR clock_timestamp()<public.fn_union_accounting_run_at(NEW.period_end)
    OR NEW.result->>'success' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'midway_promo_invalid_completed_week' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('midway-weekly-promo:'||extract(epoch FROM NEW.period_end)::text,0));
 SELECT result INTO v_prior FROM public.union_weekly_horse_promo_runs
  WHERE union_id=v_midway AND period_start=NEW.period_start AND period_end=NEW.period_end;
 IF FOUND THEN
  NEW.result:=NEW.result||jsonb_build_object('weekly_horse_promo',v_prior);
  RETURN NEW;
 END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'midway_promo_platform_frozen'; END IF;
 SELECT promo_wallet INTO v_open FROM public.union_wallets WHERE union_id=v_midway FOR UPDATE;
 IF v_open IS NULL OR v_open<0 THEN RAISE EXCEPTION 'midway_promo_wallet_invalid'; END IF;
 v_budget:=trunc(v_open/2,2); v_cents:=(v_budget*100)::bigint;
 -- Lock and snapshot each eligible CLUB wallet before calculating shares.
 -- No union-wide balance aggregate and no duplicate membership expansion.
 SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.club_id,w.user_id),'[]'::jsonb) INTO v_wallets FROM (
  SELECT m.club_id,m.user_id,m.chip_balance AS opening_balance
   FROM public.club_members m JOIN public.profiles p ON p.id=m.user_id
   JOIN public.clubs c ON c.id=m.club_id
   JOIN public.union_clubs uc ON uc.club_id=c.id AND uc.union_id=c.union_id
   WHERE c.union_id=v_midway AND p.is_horse IS TRUE
    AND p.horse_status IS DISTINCT FROM 'disabled'
    AND m.is_active IS TRUE AND m.status IN('active','approved')
    AND m.membership_lifecycle_status='active' AND m.chip_balance<10000
   ORDER BY m.club_id,m.user_id FOR UPDATE OF m FOR SHARE OF p,c,uc
 )w;
 v_n:=jsonb_array_length(v_wallets); v_run:=gen_random_uuid();
 v_note:='Midway Weekly Promo Distribution: '||to_char(NEW.period_start AT TIME ZONE 'America/Los_Angeles','YYYY-MM-DD');
 INSERT INTO public.union_weekly_horse_promo_runs(id,union_id,period_start,period_end,opening_promo,budget,paid,eligible_wallets,paid_wallets,result)
 VALUES(v_run,v_midway,NEW.period_start,NEW.period_end,v_open,v_budget,0,v_n,0,'{}');
 -- Save/restore the caller's transaction-local ledger declaration.
 SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),'')) INTO v_saved FROM unnest(ARRAY[
  'app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity',
  'app.ledger_settlement','app.ledger_idempotency_key','app.ledger_counterparty_label',
  'app.ledger_correlation','app.ledger_autoskip_union_wallets','app.ledger_autoskip_clubs'])k;
 IF v_n>0 AND v_cents>0 THEN
  v_each:=v_cents/v_n; v_extra:=v_cents%v_n;
  FOR v_wallet IN SELECT value FROM jsonb_array_elements(v_wallets) LOOP
   v_i:=v_i+1; v_amount:=(v_each+CASE WHEN v_i<=v_extra THEN 1 ELSE 0 END)::numeric/100;
   IF v_amount=0 THEN CONTINUE; END IF;
   v_op:=md5('midway-weekly-promo:'||extract(epoch FROM NEW.period_end)::text||':'||(v_wallet->>'club_id')||':'||(v_wallet->>'user_id'))::uuid;
   v_result:=public.fn_promo_disburse('union',v_midway,'player',(v_wallet->>'user_id')::uuid,
    v_amount,v_note,(v_wallet->>'club_id')::uuid,v_op);
   IF v_result->>'success' IS DISTINCT FROM 'true' OR v_result->>'replayed'='true' THEN
    RAISE EXCEPTION 'midway_promo_disbursement_not_confirmed' USING DETAIL=v_result::text;
   END IF;
   INSERT INTO public.union_weekly_horse_promo_recipients(run_id,club_id,user_id,opening_balance,amount,balance_after,operation_id,transaction_id)
   VALUES(v_run,(v_wallet->>'club_id')::uuid,(v_wallet->>'user_id')::uuid,(v_wallet->>'opening_balance')::numeric,
    v_amount,(v_result->>'recipient_after')::numeric,v_op,(v_result->>'transaction_id')::uuid);
   v_paid:=v_paid+v_amount; v_paid_n:=v_paid_n+1;
  END LOOP;
 END IF;
 FOR v_key IN SELECT jsonb_object_keys(v_saved) LOOP PERFORM set_config(v_key,v_saved->>v_key,true); END LOOP;
 IF v_paid<>(CASE WHEN v_n>0 THEN v_budget ELSE 0 END)
    OR (SELECT promo_wallet FROM public.union_wallets WHERE union_id=v_midway)<>v_open-v_paid THEN
  RAISE EXCEPTION 'midway_promo_conservation_failed';
 END IF;
 v_result:=jsonb_build_object('success',true,'run_id',v_run,'opening_promo',v_open,'budget',v_budget,
  'paid',v_paid,'eligible_wallets',v_n,'paid_wallets',v_paid_n,'remaining_promo',v_open-v_paid,
  'eligibility','each_club_chip_balance_under_10000','reason',CASE WHEN v_n=0 THEN 'no_eligible_wallets' WHEN v_cents=0 THEN 'no_distributable_chips' ELSE 'paid' END);
 UPDATE public.union_weekly_horse_promo_runs SET paid=v_paid,paid_wallets=v_paid_n,result=v_result WHERE id=v_run;
 NEW.result:=NEW.result||jsonb_build_object('weekly_horse_promo',v_result);
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_midway_weekly_horse_promo_close() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER midway_weekly_horse_promo_close
 BEFORE INSERT OR UPDATE OF status,result ON public.union_accounting_runs
 FOR EACH ROW WHEN(NEW.status='complete') EXECUTE FUNCTION public.fn_midway_weekly_horse_promo_close();
COMMENT ON TABLE public.union_weekly_horse_promo_runs IS
 'Midway weekly 50% promo distribution. Per-club active horse chip_balance <10000; first week ends 2026-10-19. Atomic with existing weekly close. No eligible wallet leaves funds untouched; no historical payouts.';
COMMIT;
