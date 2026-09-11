-- The satellite authority and its broad DDL are installed during the quiet
-- maintenance freeze. The two audited historical events are adopted only
-- after that freeze opens, without carrying any of the schema migration's
-- relation locks. This closeout consumes both owner-only exact-event helpers
-- and removes them in the same transaction.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';
SET LOCAL transaction_timeout = '180s';

-- The atomic satellite payer was installed after the R3 money-path gate and
-- was not registered with it. Pin the exact live trigger/function first, then
-- give the service-only atomic authority its own function-scoped declaration.
-- The one-time b066 helper receives the same narrow declaration only until it
-- is dropped later in this transaction.
DO $authenticate_money_path_authority$
BEGIN
  IF md5(pg_get_functiondef(
       'public.fn_ca_money_path_log()'::regprocedure))
       IS DISTINCT FROM 'c587d45213d5eeb0cfcfb53a65ddb23a'
     OR (
       SELECT count(*) FROM pg_trigger tr
        WHERE tr.tgrelid = 'public.wallet_transactions'::regclass
          AND tr.tgname = 'trg_ca_money_path_log'
          AND tr.tgfoid = 'public.fn_ca_money_path_log()'::regprocedure
          AND NOT tr.tgisinternal
          AND tr.tgenabled = 'O'
          AND tr.tgtype = 5
          AND md5(pg_get_triggerdef(tr.oid)) =
              'ddbf38a0ff0398f03b31ca7d04b27295') <> 1 THEN
    RAISE EXCEPTION 'atomic satellite money-path authority is not canonical'
      USING ERRCODE = '55000';
  END IF;
END;
$authenticate_money_path_authority$;

CREATE OR REPLACE FUNCTION public.fn_ca_money_path_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_cat  text;
  v_mode text;
BEGIN
  v_path := COALESCE(current_setting('app.money_path', true), '');
  IF v_path IN (
       'fn_settle_tournament_obligation',
       'fn_settle_satellite_tournament',
       'fn_ca_adopt_b066_satellite_remainder') THEN
    RETURN NEW;
  END IF;

  v_cat := lower(COALESCE(NEW.category, ''));

  -- The mode is data, so the way back is an UPDATE and not a deploy. A missing
  -- row means log: this guard never becomes stricter by accident.
  SELECT e.mode INTO v_mode FROM public.ca_money_path_enforcement e WHERE e.only_row;
  v_mode := COALESCE(v_mode, 'log');

  IF v_mode = 'refuse' THEN
    -- Nothing survives this raise, so the message carries the evidence: who
    -- wrote, from where, for how much, against which entity.
    RAISE EXCEPTION
      'R3: a % credit of % was written outside fn_settle_tournament_obligation (money_path=%, app=%, role=%, wallet_transactions.related_entity_id=%). Route it through fn_settle_tournament_obligation. To reopen the door: UPDATE public.ca_money_path_enforcement SET mode = ''log'';',
      COALESCE(NULLIF(v_cat, ''), '<none>'), NEW.amount, COALESCE(NULLIF(v_path, ''), '<none>'),
      COALESCE(NULLIF(current_setting('application_name', true), ''), '<none>'),
      session_user::text, NEW.related_entity_id
      USING ERRCODE = 'raise_exception';
  END IF;

  BEGIN
    INSERT INTO public.ca_money_path_violations
      (table_name, user_id, amount, category, description, related_entity_id,
       money_path, app_name, db_role)
    VALUES
      (TG_TABLE_NAME, NEW.user_id, NEW.amount, NEW.category, NEW.description,
       NEW.related_entity_id, NULLIF(v_path, ''),
       NULLIF(current_setting('application_name', true), ''),
       session_user::text);
  EXCEPTION WHEN OTHERS THEN
    -- The logger must never be the reason a credit fails.
    NULL;
  END;

  BEGIN
    -- Global scope (no entity dimension) so it files for every union; the
    -- tournament id travels in metadata only. INFO never pages.
    PERFORM public.fn_ca_raise_drift_incident(
      p_source         => 'r3_money_path_log',
      p_classification => 'unauthorized_adjustment',
      p_severity       => 'info',
      p_dedupe_key     => 'r3:' || v_cat || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24'),
      p_discrepancy    => NEW.amount,
      p_layer          => 'settlement',
      p_entity_type    => 'wallet_transactions',
      p_entity_id      => NEW.id,
      p_suspected_cause => 'a tournament-category credit was written outside fn_settle_tournament_obligation (R3, log-only)',
      p_metadata       => jsonb_build_object('category', NEW.category, 'money_path', NULLIF(v_path, ''),
                            'related_entity_id', NEW.related_entity_id,
                            'app_name', NULLIF(current_setting('application_name', true), ''),
                            'session_user', session_user::text));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_money_path_log()
  FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  RENAME TO fn_settle_satellite_tournament_pre_money_path_gate;
REVOKE ALL ON FUNCTION
  public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(
  p_tournament_id uuid,
  p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $satellite_money_path_gate$
DECLARE
  v_prior_path text := COALESCE(
    current_setting('app.money_path',true),'');
  v_result jsonb;
BEGIN
  PERFORM set_config(
    'app.money_path','fn_settle_satellite_tournament',true);
  BEGIN
    v_result :=
      public.fn_settle_satellite_tournament_pre_money_path_gate(
        p_tournament_id,p_observed_winner_id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.money_path',v_prior_path,true);
    RAISE;
  END;
  PERFORM set_config('app.money_path',v_prior_path,true);
  RETURN v_result;
END;
$satellite_money_path_gate$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  TO service_role;

-- PostgreSQL exposes jsonb_array_length but this production version has no
-- jsonb_object_length. Correct the one-time exact-evidence helper itself; do
-- not install a compatibility shim or weaken any of its three row proofs.
CREATE OR REPLACE FUNCTION public.fn_ca_adopt_682_satellite_completion()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $adopt_exact_682_completion$
DECLARE
  v_tournament_id constant uuid := '682045c5-cb07-47ed-ad0e-adbff9cb41af';
  v_target_id constant uuid := '13dd6b98-b882-4690-a479-3a6f77783ad6';
  v_winner_id constant uuid := '22af2652-f8ae-4b84-8f3d-d2894f435d79';
  v_bubble_id constant uuid := '146cf7a5-7f99-4dd3-858d-26dae69d9c80';
  v_registration_id constant uuid := '324aedef-7f12-4935-8530-dde405ea6351';
  v_seat_payout_id constant uuid := '57b96759-2acd-4142-bc4e-37b273cd3542';
  v_remainder_payout_id constant uuid := '0de0bc80-dd26-4631-b7f5-3baf0fb4a9da';
  v_obligation_id constant uuid := 'a15db36e-6684-4edd-be48-277bfb3113ba';
  v_table_id constant uuid := 'ae520859-1727-4576-9b4a-98f0e0392ace';
  v_seat_one_id constant uuid := '24a9b8a9-6bd6-47da-9c8d-ce11634955c1';
  v_seat_two_id constant uuid := '2ddc7740-eb2d-4928-af42-ac05d8c852c9';
  v_seat_key constant text :=
    'tourney:682045c5-cb07-47ed-ad0e-adbff9cb41af:seat:22af2652-f8ae-4b84-8f3d-d2894f435d79';
  v_remainder_key constant text :=
    'tourney:682045c5-cb07-47ed-ad0e-adbff9cb41af:obl:a15db36e-6684-4edd-be48-277bfb3113ba:0';
  v_source record;
  v_target record;
  v_winner public.tournament_players%ROWTYPE;
  v_bubble public.tournament_players%ROWTYPE;
  v_registration public.tournament_players%ROWTYPE;
  v_seat_payout public.tournament_payouts%ROWTYPE;
  v_remainder_payout public.tournament_payouts%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_transfer public.chip_ledger%ROWTYPE;
  v_rake_settlement public.tournament_rake_settlements%ROWTYPE;
  v_rows integer;
  v_amount numeric;
  v_receipt jsonb;
  v_closeout_at timestamptz := transaction_timestamp();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id = v_tournament_id) THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (v_tournament_id, v_target_id)
   ORDER BY CASE WHEN t.id = v_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.union_id,
         t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.total_rake, t.prize_pool_finalized, t.ended_at,
         t.buy_in_amount, t.buy_in_fee, t.created_at, t.start_time,
         t.started_at, t.level_started_at, t.table_size,
         t.current_players, t.max_players, t.on_break,
         t.break_started_at, t.break_ends_at,
         t.is_bounty, t.is_pko, t.is_mystery_bounty,
         t.is_premium_spin, t.spin_multiplier
    INTO v_source FROM public.tournaments t WHERE t.id = v_tournament_id;
  SELECT t.id, t.status, t.club_id, t.union_id, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee,
         t.prize_pool_finalized, t.current_players, t.max_players,
         t.prize_pool, t.total_rake, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin, t.spin_multiplier
    INTO v_target FROM public.tournaments t WHERE t.id = v_target_id;
  IF v_source.id IS NULL OR v_target.id IS NULL
     OR v_source.name IS DISTINCT FROM
          'Sunday $200 Deep Stack Satellite Heads-Up'
     OR upper(COALESCE(v_source.status::text,'')) <> 'COMPLETED'
     OR lower(COALESCE(v_source.variant::text,'')) <> 'sng'
     OR upper(COALESCE(v_source.tournament_type::text,'')) <> 'SATELLITE'
     OR v_source.satellite_target_id IS DISTINCT FROM v_target_id
     OR v_source.satellite_target IS NOT NULL
     OR v_source.satellite_seats IS DISTINCT FROM 1
     OR v_source.prize_pool IS DISTINCT FROM 85.00::numeric
     OR v_source.total_rake IS DISTINCT FROM 15.00::numeric
     OR v_source.buy_in_amount IS DISTINCT FROM 142.50::numeric
     OR v_source.buy_in_fee IS DISTINCT FROM 7.50::numeric
     OR v_source.created_at IS DISTINCT FROM
          '2026-09-08 11:17:39.702118+00'::timestamptz
     OR v_source.start_time IS DISTINCT FROM
          '2026-09-08 11:21:08.923+00'::timestamptz
     OR v_source.started_at IS DISTINCT FROM
          '2026-09-08 11:21:40.535+00'::timestamptz
     OR COALESCE(v_source.prize_pool_finalized,false) IS NOT TRUE
     OR v_source.ended_at IS DISTINCT FROM
          '2026-09-08 11:23:11.485+00'::timestamptz
     OR v_source.level_started_at IS DISTINCT FROM
          '2026-09-08 11:21:41.794+00'::timestamptz
     OR v_source.table_size IS DISTINCT FROM 2
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.max_players IS DISTINCT FROM 2
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL
     OR v_source.club_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_source.union_id IS DISTINCT FROM v_source.club_id
     OR v_source.is_bounty IS DISTINCT FROM false
     OR v_source.is_pko IS DISTINCT FROM false
     OR v_source.is_mystery_bounty IS DISTINCT FROM false
     OR v_source.is_premium_spin IS DISTINCT FROM false
     OR v_source.spin_multiplier IS DISTINCT FROM 0
     OR upper(COALESCE(v_target.status::text,'')) <> 'REGISTERING'
     OR v_target.club_id IS DISTINCT FROM v_source.club_id
     OR v_target.union_id IS DISTINCT FROM v_source.union_id
     OR lower(COALESCE(v_target.variant::text,'')) <> 'freezeout'
     OR upper(COALESCE(v_target.tournament_type::text,'')) <> 'MTT'
     OR v_target.buy_in_amount IS DISTINCT FROM 180.00::numeric
     OR v_target.buy_in_fee IS DISTINCT FROM 20.00::numeric
     OR v_target.max_players IS DISTINCT FROM 1000
     OR v_target.prize_pool_finalized IS DISTINCT FROM false
     OR v_target.is_bounty IS DISTINCT FROM false
     OR v_target.is_pko IS DISTINCT FROM false
     OR v_target.is_mystery_bounty IS DISTINCT FROM false
     OR v_target.is_premium_spin IS DISTINCT FROM false
     OR v_target.spin_multiplier IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '682 adoption: source or target differs from the audited 285/200 completion'
      USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s
              WHERE s.tournament_id = v_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_awards a
                 WHERE a.tournament_id = v_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = v_tournament_id) THEN
    RAISE EXCEPTION '682 adoption: immutable settlement evidence already exists'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (v_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;
  SELECT count(*) INTO v_rows FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tournament_id;
  SELECT * INTO v_winner FROM public.tournament_players tp
   WHERE tp.id = 'af7c21a6-b0a1-432b-9e40-04084320ba08'::uuid;
  SELECT * INTO v_bubble FROM public.tournament_players tp
   WHERE tp.id = 'b4e9c058-03ed-4bb0-956c-49e1e64ac901'::uuid;
  SELECT * INTO v_registration FROM public.tournament_players tp
   WHERE tp.id = v_registration_id;
  IF v_rows <> 2
     OR v_winner.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_winner.user_id IS DISTINCT FROM v_winner_id
     OR lower(COALESCE(v_winner.username,'')) <> 'sadwizard'
     OR v_winner.status::text IS DISTINCT FROM 'winner'
     OR v_winner.position IS DISTINCT FROM 1
     OR v_winner.chips IS DISTINCT FROM 600.00::numeric
     OR v_winner.chip_count IS DISTINCT FROM 0::numeric
     OR v_winner.prize IS DISTINCT FROM 200.00::numeric
     OR v_winner.table_id IS DISTINCT FROM v_table_id
     OR v_winner.seat_number IS DISTINCT FROM 1
     OR v_winner.club_id IS DISTINCT FROM
          'a0000000-0000-0000-0000-000000000001'::uuid
     OR v_winner.registered_at IS DISTINCT FROM
          '2026-09-08 11:17:46.273993+00'::timestamptz
     OR v_winner.eliminated_at IS NOT NULL
     OR v_winner.source_satellite_id IS NOT NULL
     OR v_winner.is_satellite_qualifier IS DISTINCT FROM false
     OR v_bubble.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_bubble.user_id IS DISTINCT FROM v_bubble_id
     OR lower(COALESCE(v_bubble.username,'')) <> 'connorford'
     OR v_bubble.status::text IS DISTINCT FROM 'eliminated'
     OR v_bubble.position IS DISTINCT FROM 2
     OR v_bubble.chips IS DISTINCT FROM 0::numeric
     OR v_bubble.chip_count IS DISTINCT FROM 0::numeric
     OR v_bubble.prize IS DISTINCT FROM 0::numeric
     OR v_bubble.table_id IS DISTINCT FROM v_table_id
     OR v_bubble.seat_number IS DISTINCT FROM 2
     OR v_bubble.club_id IS DISTINCT FROM
          'a0000000-0000-0000-0000-000000000001'::uuid
     OR v_bubble.registered_at IS DISTINCT FROM
          '2026-09-08 11:21:31.396373+00'::timestamptz
     OR v_bubble.eliminated_at IS DISTINCT FROM
          '2026-09-08 11:22:56.43+00'::timestamptz
     OR v_bubble.source_satellite_id IS NOT NULL
     OR v_bubble.is_satellite_qualifier IS DISTINCT FROM false
     OR v_registration.tournament_id IS DISTINCT FROM v_target_id
     OR v_registration.user_id IS DISTINCT FROM v_winner_id
     OR lower(COALESCE(v_registration.username,'')) <> 'sadwizard'
     OR v_registration.status::text IS DISTINCT FROM 'registered'
     OR v_registration.chips IS DISTINCT FROM 0
     OR v_registration.chip_count IS DISTINCT FROM 0
     OR v_registration.position IS NOT NULL
     OR v_registration.prize IS DISTINCT FROM 0::numeric
     OR v_registration.table_id IS NOT NULL
     OR v_registration.seat_number IS NOT NULL
     OR v_registration.club_id IS DISTINCT FROM
          'a0000000-0000-0000-0000-000000000001'::uuid
     OR v_registration.eliminated_at IS NOT NULL
     OR v_registration.registered_at IS DISTINCT FROM
          '2026-09-08 11:23:07.343372+00'::timestamptz
     OR COALESCE(v_registration.is_satellite_qualifier,false) IS NOT TRUE
     OR v_registration.source_satellite_id IS DISTINCT FROM v_tournament_id THEN
    RAISE EXCEPTION '682 adoption: exact source standings or target registration changed'
      USING ERRCODE = 'P0404';
  END IF;
  IF v_target.current_players IS DISTINCT FROM
       (SELECT count(*)::integer FROM public.tournament_players tp
         WHERE tp.tournament_id = v_target_id)
     OR v_target.prize_pool IS DISTINCT FROM
          round(v_target.current_players * 180.00::numeric, 2)
     OR v_target.total_rake IS DISTINCT FROM
          round(v_target.current_players * 20.00::numeric, 2) THEN
    RAISE EXCEPTION '682 adoption: target roster, pool, or rake aggregate is inconsistent'
      USING ERRCODE = 'P0404';
  END IF;
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.source_satellite_id = v_tournament_id) <> 1 THEN
    RAISE EXCEPTION '682 adoption: target contains extra or missing source registrations'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id ORDER BY p.id FOR UPDATE;
  SELECT count(*), round(COALESCE(sum(p.amount),0),2)
    INTO v_rows, v_amount FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id;
  SELECT * INTO v_seat_payout FROM public.tournament_payouts p
   WHERE p.id = v_seat_payout_id;
  SELECT * INTO v_remainder_payout FROM public.tournament_payouts p
   WHERE p.id = v_remainder_payout_id;
  IF v_rows <> 2 OR v_amount IS DISTINCT FROM 285.00::numeric
     OR v_seat_payout.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_seat_payout.user_id IS DISTINCT FROM v_winner_id
     OR v_seat_payout."position" IS DISTINCT FROM 1
     OR v_seat_payout.amount IS DISTINCT FROM 200.00::numeric
     OR v_seat_payout.source IS DISTINCT FROM 'satellite_seat'
     OR v_seat_payout.idempotency_key IS DISTINCT FROM v_seat_key
     OR v_seat_payout.recorded_by IS DISTINCT FROM 'award_satellite_seat'
     OR v_seat_payout.paid_at IS DISTINCT FROM
          '2026-09-08 11:23:07.343372+00'::timestamptz
     OR v_seat_payout.created_at IS DISTINCT FROM
          '2026-09-08 11:23:07.343372+00'::timestamptz
     OR v_seat_payout.tournament_type IS DISTINCT FROM 'SATELLITE'
     OR v_seat_payout.field_size IS DISTINCT FROM 2
     OR v_seat_payout.prize_pool IS DISTINCT FROM 285.00::numeric
     OR v_seat_payout.payout_structure IS NOT NULL
     OR v_seat_payout.metadata IS DISTINCT FROM
          '{"unbacked":0.00,"target_fee":20.00,"target_name":"Sunday $200 Deep Stack","pool_transfer":200.00,"target_buy_in":180.00,"registration_id":"324aedef-7f12-4935-8530-dde405ea6351","satellite_target_id":"13dd6b98-b882-4690-a479-3a6f77783ad6"}'::jsonb
     OR v_seat_payout.metadata->>'satellite_target_id' IS DISTINCT FROM v_target_id::text
     OR v_seat_payout.metadata->>'registration_id' IS DISTINCT FROM v_registration_id::text
     OR (v_seat_payout.metadata->>'target_buy_in')::numeric IS DISTINCT FROM 180.00
     OR (v_seat_payout.metadata->>'target_fee')::numeric IS DISTINCT FROM 20.00
     OR (v_seat_payout.metadata->>'pool_transfer')::numeric IS DISTINCT FROM 200.00
     OR (v_seat_payout.metadata->>'unbacked')::numeric IS DISTINCT FROM 0
     OR v_remainder_payout.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_remainder_payout.user_id IS DISTINCT FROM v_bubble_id
     OR v_remainder_payout."position" IS NOT NULL
     OR v_remainder_payout.amount IS DISTINCT FROM 85.00::numeric
     OR v_remainder_payout.source IS DISTINCT FROM 'satellite_remainder'
     OR v_remainder_payout.idempotency_key IS DISTINCT FROM v_remainder_key
     OR v_remainder_payout.recorded_by IS DISTINCT FROM 'credit_and_log'
     OR v_remainder_payout.paid_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz
     OR v_remainder_payout.created_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz
     OR v_remainder_payout.tournament_type IS DISTINCT FROM 'SATELLITE'
     OR v_remainder_payout.field_size IS DISTINCT FROM 2
     OR v_remainder_payout.prize_pool IS DISTINCT FROM 85.00::numeric
     OR v_remainder_payout.metadata IS NOT NULL
     OR v_remainder_payout.payout_structure IS DISTINCT FROM
          '{"payout_structure":"[{\"place\": 1, \"percentage\": 100.0000000000000000}]"}'::jsonb THEN
    RAISE EXCEPTION '682 adoption: exact append-only payout evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id ORDER BY o.id FOR UPDATE;
  SELECT * INTO v_obligation FROM public.tournament_obligations o
   WHERE o.id = v_obligation_id;
  IF (SELECT count(*) FROM public.tournament_obligations o
       WHERE o.tournament_id = v_tournament_id) <> 1
     OR v_obligation.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_obligation.kind IS DISTINCT FROM 'satellite_remainder'
     OR v_obligation.place IS NOT NULL
     OR v_obligation.user_id IS DISTINCT FROM v_bubble_id
     OR v_obligation.amount_owed IS DISTINCT FROM 85.00::numeric
     OR v_obligation.amount_paid IS DISTINCT FROM 85.00::numeric
     OR v_obligation.source IS DISTINCT FROM 'engine.processSatelliteAwards'
     OR v_obligation.created_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz
     OR v_obligation.updated_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz
     OR v_obligation.adjustment_id IS NOT NULL
     OR v_obligation.settled_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz THEN
    RAISE EXCEPTION '682 adoption: exact residual obligation changed'
      USING ERRCODE = 'P0404';
  END IF;
  PERFORM 1 FROM public.wallet_credit_idempotency k
   WHERE k.key = v_remainder_key FOR UPDATE;
  IF (SELECT count(*) FROM public.wallet_credit_idempotency k
       WHERE k.key LIKE 'tourney:' || v_tournament_id::text || ':%') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_credit_idempotency k
        WHERE k.key = v_remainder_key
          AND k.user_id = v_bubble_id AND k.amount = 85.00
          AND k.created_at =
            '2026-09-08 11:23:08.82402+00'::timestamptz) THEN
    RAISE EXCEPTION '682 adoption: exact wallet credit claim changed'
      USING ERRCODE = 'P0404';
  END IF;
  PERFORM 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id = v_tournament_id ORDER BY w.id FOR UPDATE;
  IF (SELECT count(*) FROM public.wallet_transactions w
       WHERE w.related_entity_id = v_tournament_id) <> 3
     OR (SELECT round(COALESCE(sum(w.amount),0),2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tournament_id AND w.type = 'debit')
          IS DISTINCT FROM 300.00::numeric
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = '82bf3222-25f5-460a-aa99-e4ac265da926'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_winner_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'debit' AND w.category = 'tournament_buyin'
          AND w.amount = 150.00 AND w.balance_after = 73257.10
          AND w.created_at = '2026-09-08 11:17:46.273993+00'::timestamptz
          AND w.description =
            'Tournament buy-in: Sunday $200 Deep Stack Satellite Heads-Up')
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = 'fe1fa3f9-65ae-4bf4-948d-64be24c07021'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_bubble_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'debit' AND w.category = 'tournament_buyin'
          AND w.amount = 150.00 AND w.balance_after = 17355.64
          AND w.created_at = '2026-09-08 11:21:31.396373+00'::timestamptz
          AND w.description =
            'Tournament buy-in: Sunday $200 Deep Stack Satellite Heads-Up')
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = '3ac0222c-0fb9-4be8-bd15-4f9a6bfc4143'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_bubble_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'credit'
          AND w.category = 'prize' AND w.amount = 85.00
          AND w.balance_after = 17355.64
          AND w.created_at = '2026-09-08 11:23:08.82402+00'::timestamptz
          AND w.description =
            'Satellite remainder payout: Sunday $200 Deep Stack Satellite Heads-Up') THEN
    RAISE EXCEPTION '682 adoption: exact wallet movement evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.chip_ledger l
   WHERE l.from_entity_id = v_tournament_id
      OR l.to_entity_id = v_tournament_id
   ORDER BY l.id FOR UPDATE;
  SELECT * INTO v_transfer FROM public.chip_ledger l
   WHERE l.id = '74457684-606b-4e21-bf5d-2080b3d59529'::uuid;
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.from_entity_id = v_tournament_id
          OR l.to_entity_id = v_tournament_id) <> 5
     OR (SELECT count(*) FROM public.chip_ledger l
       WHERE l.from_entity_id = v_tournament_id
         AND l.idempotency_key LIKE 'tourney:' || v_tournament_id::text
                                      || ':seat:%:pool_transfer') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '41587c9a-d438-4d68-9b27-457eaff480e7'::uuid
          AND l.chain_seq = 2655342
          AND l.row_hash = '95a1bcaa9b5b19b8ec749d6bd5b282b3c21d7b4de3a36599885fbc9c9c351ce9'
          AND l.idempotency_key IS NULL AND l.status = 'posted'
          AND l.amount = 150.00 AND l.category = 'tournament_buyin'
          AND l.from_type = 'player_wallet' AND l.from_entity_id = v_winner_id
          AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tournament_id
          AND l.tournament_id = v_tournament_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '1541288b-b050-44db-ad91-c1d85ede307d'::uuid
          AND l.chain_seq = 2656271
          AND l.row_hash = 'a29f2b5301e7752414b263577320b9b1743c3d2ac7bc0889e7153bcdc8aac43d'
          AND l.idempotency_key IS NULL AND l.status = 'posted'
          AND l.amount = 150.00 AND l.category = 'tournament_buyin'
          AND l.from_type = 'player_wallet' AND l.from_entity_id = v_bubble_id
          AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tournament_id
          AND l.tournament_id = v_tournament_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '7083eb3b-0d1a-4649-9c17-9020e2ba3926'::uuid
          AND l.chain_seq = 2656635
          AND l.row_hash = 'a39fe03421b4c453c8a2e4ec98b56b73fd67766a577e0175e3a77368a8413f34'
          AND l.idempotency_key IS NULL AND l.status = 'posted'
          AND l.amount = 85.00 AND l.category = 'tournament_prize'
          AND l.from_type = 'prize_liability' AND l.from_entity_id = v_tournament_id
          AND l.to_type = 'player_wallet' AND l.to_entity_id = v_bubble_id
          AND l.tournament_id = v_tournament_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '321d8e0d-fa53-4e25-a4fa-3cf15e55f027'::uuid
          AND l.chain_seq = 2656641
          AND l.row_hash = '49c8c65956a1d75d3cfa400ce23508c49e9aee16987f3a51e64e34979e48c8dc'
          AND l.idempotency_key IS NULL AND l.status = 'posted'
          AND l.amount = 15.00 AND l.category = 'rake'
          AND l.from_type = 'prize_liability' AND l.from_entity_id = v_tournament_id
          AND l.to_type = 'union_wallet'
          AND l.to_entity_id = '059bb325-6eeb-4bbd-957d-3a82e755bb0c'::uuid
          AND l.tournament_id = v_tournament_id)
     OR v_transfer.amount IS DISTINCT FROM 200.00::numeric
     OR v_transfer.chain_seq IS DISTINCT FROM 2656629
     OR v_transfer.row_hash IS DISTINCT FROM
          'fce3bf285df3a16e2624fa8c35e231af12e9378dc890b7cf7e9892b3db360f70'
     OR v_transfer.status IS DISTINCT FROM 'posted'
     OR v_transfer.from_type IS DISTINCT FROM 'prize_liability'
     OR v_transfer.from_entity_id IS DISTINCT FROM v_tournament_id
     OR v_transfer.from_label IS DISTINCT FROM 'tournaments.prize_pool'
     OR v_transfer.to_type IS DISTINCT FROM 'prize_liability'
     OR v_transfer.to_entity_id IS DISTINCT FROM v_target_id
     OR v_transfer.to_label IS DISTINCT FROM 'tournaments.prize_pool+total_rake'
     OR v_transfer.category IS DISTINCT FROM 'tournament_buyin'
     OR v_transfer.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_transfer.idempotency_key IS DISTINCT FROM v_seat_key || ':pool_transfer'
     OR v_transfer.pre_from_balance IS DISTINCT FROM 285.00::numeric
     OR v_transfer.post_from_balance IS DISTINCT FROM 85.00::numeric
     OR v_transfer.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_pool_transfer'
     OR (v_transfer.metadata->>'moved')::numeric IS DISTINCT FROM 200.00
     OR v_transfer.metadata->>'user_id' IS DISTINCT FROM v_winner_id::text
     OR (v_transfer.metadata->>'unbacked')::numeric IS DISTINCT FROM 0
     OR (v_transfer.metadata->>'seat_value')::numeric IS DISTINCT FROM 200.00
     OR v_transfer.metadata->>'satellite_id' IS DISTINCT FROM v_tournament_id::text
     OR v_transfer.metadata->>'satellite_target_id' IS DISTINCT FROM v_target_id::text
     OR v_transfer.metadata->>'registration_id' IS DISTINCT FROM v_registration_id::text THEN
    RAISE EXCEPTION '682 adoption: exact pool-transfer evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.rake_records r
   WHERE r.tournament_id IN (v_tournament_id, v_target_id)
   ORDER BY r.id FOR UPDATE;
  IF (SELECT count(*) FROM public.rake_records r
       WHERE r.tournament_id = v_tournament_id AND r.is_tournament) <> 2
     OR (SELECT round(COALESCE(sum(r.rake_amount),0),2)
           FROM public.rake_records r
          WHERE r.tournament_id = v_tournament_id AND r.is_tournament)
          IS DISTINCT FROM 15.00::numeric
     OR NOT EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.id = '848ac57b-75b9-49d8-befb-bc0ef5c6c02a'::uuid
          AND r.tournament_id = v_tournament_id AND r.is_tournament
          AND r.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
          AND r.hand_id IS NULL AND r.table_id IS NULL
          AND r.source = 'fn_register_horse_for_tournament'
          AND r.rake_amount = 7.50 AND r.pot_size = 150.00
          AND r.num_players = 1 AND r.global_hand_id = 23165563
          AND r.bbj_contribution = 0 AND r.returned_uncalled IS NULL
          AND r.rake_method = 'DEALT_EQUAL'
          AND r.created_at = '2026-09-08 11:17:46.273993+00'::timestamptz
          AND r.metadata->>'kind' = 'tournament_entry_fee'
          AND r.metadata->>'user_id' = v_winner_id::text
          AND r.metadata->>'registration_id' = v_winner.id::text
          AND (SELECT count(*) FROM jsonb_object_keys(r.player_contributions)) = 1
          AND (r.player_contributions->>v_winner_id::text)::numeric = 7.50)
     OR NOT EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.id = '426a7616-f00f-4858-95dc-032b1e3e8d09'::uuid
          AND r.tournament_id = v_tournament_id AND r.is_tournament
          AND r.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
          AND r.hand_id IS NULL AND r.table_id IS NULL
          AND r.source = 'fn_register_horse_for_tournament'
          AND r.rake_amount = 7.50 AND r.pot_size = 150.00
          AND r.num_players = 1 AND r.global_hand_id = 23163763
          AND r.bbj_contribution = 0 AND r.returned_uncalled IS NULL
          AND r.rake_method = 'DEALT_EQUAL'
          AND r.created_at = '2026-09-08 11:21:31.396373+00'::timestamptz
          AND r.metadata->>'kind' = 'tournament_entry_fee'
          AND r.metadata->>'user_id' = v_bubble_id::text
          AND r.metadata->>'registration_id' = v_bubble.id::text
          AND (SELECT count(*) FROM jsonb_object_keys(r.player_contributions)) = 1
          AND (r.player_contributions->>v_bubble_id::text)::numeric = 7.50)
     OR (SELECT count(*) FROM public.rake_records r
          WHERE r.tournament_id = v_target_id
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = v_tournament_id::text
            AND r.id = '0599e505-09a0-4949-9fff-e1a3b342fa31'::uuid
            AND r.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
            AND r.hand_id IS NULL AND r.table_id IS NULL
            AND r.rake_amount = 20.00 AND r.pot_size = 200.00
            AND r.num_players = 1 AND r.global_hand_id = 23166965
            AND r.bbj_contribution = 0 AND r.returned_uncalled IS NULL
            AND r.rake_method = 'DEALT_EQUAL'
            AND r.created_at = '2026-09-08 11:23:07.343372+00'::timestamptz
            AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
            AND r.metadata->>'user_id' = v_winner_id::text
            AND r.metadata->>'registration_id' = v_registration_id::text
            AND (SELECT count(*) FROM jsonb_object_keys(r.player_contributions)) = 1
            AND (r.player_contributions->>v_winner_id::text)::numeric = 20.00) <> 1 THEN
    RAISE EXCEPTION '682 adoption: exact source or target rake evidence changed'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_rake_settlement FROM public.tournament_rake_settlements r
   WHERE r.tournament_id = v_tournament_id FOR UPDATE;
  IF v_rake_settlement.amount IS DISTINCT FROM 15.00::numeric
     OR v_rake_settlement.source IS DISTINCT FROM 'engine_finish'
     OR v_rake_settlement.club_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_rake_settlement.union_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_rake_settlement.destination IS DISTINCT FROM
          'union:fade0000-0000-0000-0000-000000000001'
     OR v_rake_settlement.created_at IS DISTINCT FROM
          '2026-09-08 11:23:11.343473+00'::timestamptz
     OR v_rake_settlement.settled_at IS DISTINCT FROM
          '2026-09-08 11:23:11.343473+00'::timestamptz
     OR v_rake_settlement.attributed_at IS DISTINCT FROM
          '2026-09-08 11:23:11.343473+00'::timestamptz
     OR v_rake_settlement.attributed_users IS DISTINCT FROM 2
     OR v_rake_settlement.attribution_error IS NOT NULL THEN
    RAISE EXCEPTION '682 adoption: exact terminal rake settlement changed'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = v_tournament_id FOR UPDATE;
  SELECT * INTO v_target_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = v_target_id FOR UPDATE;
  IF v_escrow.tournament_id IS NULL OR COALESCE(v_escrow.enforced,false) IS NOT TRUE
     OR v_escrow.gross_in IS DISTINCT FROM 300.00::numeric
     OR v_escrow.fee_entries_in IS DISTINCT FROM 15.00::numeric
     OR v_escrow.satellite_fee_in IS DISTINCT FROM 0::numeric
     OR v_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_escrow.overlay_in IS DISTINCT FROM 0::numeric
     OR v_escrow.satellite_in IS DISTINCT FROM 0::numeric
     OR v_escrow.prize_out IS DISTINCT FROM 285.00::numeric
     OR v_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_escrow.fee_out IS DISTINCT FROM 15.00::numeric
     OR v_escrow.refund_prize IS DISTINCT FROM 0::numeric
     OR v_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_escrow.refund_fee IS DISTINCT FROM 0::numeric
     OR v_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_escrow.opened_at IS DISTINCT FROM
          '2026-09-08 11:17:46.273993+00'::timestamptz
     OR v_escrow.updated_at IS DISTINCT FROM
          '2026-09-08 11:23:11.343473+00'::timestamptz
     OR v_escrow.closed_at IS DISTINCT FROM
          '2026-09-08 11:23:12.112839+00'::timestamptz
     OR v_escrow.opened_from IS DISTINCT FROM
          'shadow at first sight (tournament_buyin)'
     OR v_escrow.close_note IS DISTINCT FROM 'closed at zero'
     OR v_target_escrow.tournament_id IS DISTINCT FROM v_target_id
     OR v_target_escrow.enforced IS DISTINCT FROM true
     OR v_target_escrow.gross_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.fee_entries_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.overlay_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.prize_out IS DISTINCT FROM 0::numeric
     OR v_target_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_target_escrow.fee_out IS DISTINCT FROM 0::numeric
     OR v_target_escrow.refund_prize IS DISTINCT FROM 0::numeric
     OR v_target_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_target_escrow.refund_fee IS DISTINCT FROM 0::numeric
     OR v_target_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_target_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.prize_balance IS DISTINCT FROM v_target.prize_pool
     OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_target_escrow.fee_balance IS DISTINCT FROM v_target.total_rake
     OR v_target_escrow.satellite_in IS DISTINCT FROM
          (SELECT round(COALESCE(sum(l.amount),0)
                        - COALESCE((SELECT sum(r.rake_amount)
                           FROM public.rake_records r
                          WHERE r.tournament_id = v_target_id
                            AND r.is_tournament
                            AND r.source = 'fn_award_satellite_seat'),0),2)
             FROM public.chip_ledger l
            WHERE l.to_entity_id = v_target_id
              AND l.to_type = 'prize_liability'
              AND l.idempotency_key LIKE 'tourney:%:seat:%:pool_transfer')
     OR v_target_escrow.satellite_fee_in IS DISTINCT FROM
          (SELECT round(COALESCE(sum(r.rake_amount),0),2)
             FROM public.rake_records r
            WHERE r.tournament_id = v_target_id
              AND r.is_tournament
              AND r.source = 'fn_award_satellite_seat')
     OR v_target_escrow.opened_at IS DISTINCT FROM
          '2026-09-06 18:35:47.808074+00'::timestamptz
     OR v_target_escrow.opened_from IS DISTINCT FROM
          'shadow at first sight (satellite seat fee)'
     OR v_target_escrow.closed_at IS NOT NULL
     OR v_target_escrow.close_note IS NOT NULL THEN
    RAISE EXCEPTION '682 adoption: exact closed escrow changed'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = v_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.table_id = v_table_id ORDER BY ts.id FOR UPDATE;
  IF (SELECT count(*) FROM public.tables tb
       WHERE tb.tournament_id = v_tournament_id) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tables tb WHERE tb.id = v_table_id
         AND tb.tournament_id = v_tournament_id
         AND tb.name = 'Sunday $200 Deep Stack Satellite Heads-Up'
         AND tb.club_id =
           'fade0000-0000-0000-0000-000000000001'::uuid
         AND tb.union_id =
           'fade0000-0000-0000-0000-000000000001'::uuid
         AND tb.created_at =
           '2026-09-08 11:17:40.324914+00'::timestamptz
         AND lower(COALESCE(tb.status::text,'')) = 'closed'
         AND tb.lifecycle IS NULL AND tb.current_players = 0)
     OR (SELECT count(*) FROM public.table_seats ts
          WHERE ts.table_id = v_table_id) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats ts WHERE ts.id = v_seat_one_id
         AND ts.table_id = v_table_id AND ts.user_id = v_winner_id
         AND ts.horse_id = v_winner_id
         AND ts.club_id =
           'a0000000-0000-0000-0000-000000000001'::uuid
         AND ts.seat_number = 1 AND ts.status = 'active'
         AND ts.stack = 600.00::numeric
         AND ts.joined_at =
           '2026-09-08 11:17:46.273993+00'::timestamptz
         AND ts.leave_pending IS FALSE AND ts.is_sitting_out IS FALSE
         AND ts.is_away IS FALSE
         AND ts.sit_out_at IS NULL AND ts.scheduled_leave_hands IS NULL
         AND ts.left_at = '2026-09-08 11:23:09.284818+00'::timestamptz)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats ts WHERE ts.id = v_seat_two_id
         AND ts.table_id = v_table_id AND ts.user_id = v_bubble_id
         AND ts.horse_id = v_bubble_id
         AND ts.club_id =
           'a0000000-0000-0000-0000-000000000001'::uuid
         AND ts.seat_number = 2 AND ts.status = 'active'
         AND ts.stack = 0::numeric
         AND ts.joined_at =
           '2026-09-08 11:21:31.396373+00'::timestamptz
         AND ts.leave_pending IS FALSE AND ts.is_sitting_out IS FALSE
         AND ts.is_away IS FALSE
         AND ts.sit_out_at IS NULL AND ts.scheduled_leave_hands IS NULL
         AND ts.left_at = '2026-09-08 11:22:47.875+00'::timestamptz) THEN
    RAISE EXCEPTION '682 adoption: exact source felt closeout changed'
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournaments
     SET prize_pool = 285.00, updated_at = now()
   WHERE id = v_tournament_id AND prize_pool = 85.00
     AND status = 'COMPLETED' AND prize_pool_finalized;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '682 adoption: source pool cache did not normalize exactly'
      USING ERRCODE = 'P0404';
  END IF;
  UPDATE public.tournament_players SET prize = 85.00
   WHERE id = v_bubble.id AND tournament_id = v_tournament_id
     AND position = 2 AND prize = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '682 adoption: Bubble prize cache did not normalize exactly'
      USING ERRCODE = 'P0404';
  END IF;
  UPDATE public.tables
     SET lifecycle = 'closed', terminal_closed_at = v_source.ended_at,
         updated_at = now()
   WHERE id = v_table_id AND tournament_id = v_tournament_id
     AND status = 'closed' AND lifecycle IS NULL AND current_players = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '682 adoption: table lifecycle did not normalize exactly'
      USING ERRCODE = 'P0404';
  END IF;
  UPDATE public.table_seats
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE id IN (v_seat_one_id, v_seat_two_id)
     AND table_id = v_table_id AND status = 'active'
     AND leave_pending IS FALSE AND is_sitting_out IS FALSE AND is_away IS FALSE
     AND sit_out_at IS NULL AND scheduled_leave_hands IS NULL
     AND ((id = v_seat_one_id AND stack = 600.00::numeric
           AND left_at = '2026-09-08 11:23:09.284818+00'::timestamptz)
       OR (id = v_seat_two_id AND stack = 0::numeric
           AND left_at = '2026-09-08 11:22:47.875+00'::timestamptz));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION '682 adoption: departed seat caches did not normalize exactly'
      USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (v_tournament_id, v_target_id, false, NULL,
     v_winner_id, 2, 1, 285.00,
     180.00, 20.00, 200.00, 1,
     1, 0, 0, 85.00, v_bubble_id, 2,
     1, ARRAY[v_table_id], 2, ARRAY[v_seat_one_id,v_seat_two_id],
     0, ARRAY[]::uuid[], v_source.ended_at, v_escrow.closed_at,
     v_escrow.close_note, v_closeout_at);
  INSERT INTO public.tournament_satellite_awards
    (tournament_id, place, user_id, delivery_kind, amount,
     payout_id, payout_source, idempotency_key, registration_id)
  VALUES
    (v_tournament_id, 1, v_winner_id, 'seat', 200.00,
     v_seat_payout_id, 'satellite_seat', v_seat_key, v_registration_id);
  INSERT INTO public.tournament_satellite_remainders
    (tournament_id, user_id, place, amount,
     payout_id, payout_source, payout_position, idempotency_key,
     obligation_id, obligation_kind, obligation_place, evidence_kind)
  VALUES
    (v_tournament_id, v_bubble_id, 2, 85.00,
     v_remainder_payout_id, 'satellite_remainder', NULL, v_remainder_key,
     v_obligation_id, 'satellite_remainder', NULL, 'legacy_20260908_682');

  v_receipt := public.fn_ca_satellite_settlement_receipt(
    v_tournament_id, v_winner_id);
  IF COALESCE((v_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
     OR (v_receipt->'remainder'->>'user_id')::uuid IS DISTINCT FROM v_bubble_id
     OR (v_receipt->'remainder'->>'position')::integer IS DISTINCT FROM 2
     OR (v_receipt->'remainder'->>'amount')::numeric IS DISTINCT FROM 85.00::numeric THEN
    RAISE EXCEPTION '682 adoption: immutable whole-pool receipt did not verify'
      USING ERRCODE = 'P0404';
  END IF;
END;
$adopt_exact_682_completion$;

-- This exact-row adoption helper exists only inside this migration transaction.
-- Close the default PUBLIC grant immediately anyway: no browser session may race
-- or invoke a SECURITY DEFINER settlement writer, even before the DROP below.
REVOKE ALL ON FUNCTION public.fn_ca_adopt_682_satellite_completion()
  FROM PUBLIC, anon, authenticated;


DO $complete_known_satellites_after_freeze$
DECLARE
  v_receipt jsonb;
  v_prior_money_path text := COALESCE(
    current_setting('app.money_path',true),'');
BEGIN
  IF to_regclass('public.tournament_satellite_settlement_cutover') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM public.tournament_satellite_settlement_cutover c
        WHERE c.authority = 'fn_settle_satellite_tournament:v2'
          AND c.migration_version = '20260909014421'
     ) THEN
    RAISE EXCEPTION
      'b066 closeout requires the committed satellite authority cutover first';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_adopt_b066_satellite_remainder()') IS NULL
     OR to_regprocedure(
       'public.fn_ca_adopt_682_satellite_completion()') IS NULL THEN
    RAISE EXCEPTION
      'satellite closeout requires both owner-only exact-event helpers';
  END IF;

  -- Match the terminal writers' canonical order. The terminal boundary keeps
  -- another closeout from changing either event while this transaction makes
  -- its decision. The shared maintenance boundary makes the freeze check and
  -- every ensuing adoption one serialized unit: a maintenance owner cannot
  -- announce the next freeze until this transaction commits or rolls back.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'satellite adoption closeout must run after the maintenance freeze'
      USING ERRCODE = '55006';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlements s
        WHERE s.tournament_id =
              'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
     ) THEN
    PERFORM set_config(
      'app.money_path','fn_ca_adopt_b066_satellite_remainder',true);
    v_receipt := public.fn_ca_adopt_b066_satellite_remainder();
    PERFORM set_config('app.money_path',v_prior_money_path,true);
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlements s
        WHERE s.tournament_id =
              '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
     ) THEN
    PERFORM public.fn_ca_adopt_682_satellite_completion();
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
     ) THEN
    v_receipt := public.fn_ca_satellite_settlement_receipt(
      'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid,
      '3d15bbe7-f752-4a49-be3a-079232d23b0f'::uuid);
    IF COALESCE((v_receipt->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_receipt->>'fully_settled')::boolean, false) IS NOT TRUE
       OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
       OR (v_receipt->>'ticket_award_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->>'cash_ticket_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->>'seat_count')::integer IS DISTINCT FROM 0
       OR (v_receipt->'remainder'->>'user_id')::uuid IS DISTINCT FROM
            'ed3f0662-8da7-4c24-b8d7-a1000d60cb1f'::uuid
       OR (v_receipt->'remainder'->>'position')::integer IS DISTINCT FROM 2
       OR (v_receipt->'remainder'->>'amount')::numeric IS DISTINCT FROM
            85.00::numeric THEN
      RAISE EXCEPTION
        'b066 closeout did not produce its exact immutable 285/200/85 receipt'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
     ) THEN
    v_receipt := public.fn_ca_satellite_settlement_receipt(
      '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid,
      '22af2652-f8ae-4b84-8f3d-d2894f435d79'::uuid);
    IF COALESCE((v_receipt->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_receipt->>'fully_settled')::boolean, false) IS NOT TRUE
       OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
       OR (v_receipt->>'ticket_award_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->>'cash_ticket_count')::integer IS DISTINCT FROM 0
       OR (v_receipt->>'seat_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->'remainder'->>'user_id')::uuid IS DISTINCT FROM
            '146cf7a5-7f99-4dd3-858d-26dae69d9c80'::uuid
       OR (v_receipt->'remainder'->>'position')::integer IS DISTINCT FROM 2
       OR (v_receipt->'remainder'->>'amount')::numeric IS DISTINCT FROM
            85.00::numeric THEN
      RAISE EXCEPTION
        '682 closeout did not produce its exact immutable 285/200/85 receipt'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
END;
$complete_known_satellites_after_freeze$;

DROP FUNCTION public.fn_ca_adopt_b066_satellite_remainder();
DROP FUNCTION public.fn_ca_adopt_682_satellite_completion();

CREATE OR REPLACE FUNCTION public.fn_ca_money_path_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_cat  text;
  v_mode text;
BEGIN
  v_path := COALESCE(current_setting('app.money_path', true), '');
  IF v_path IN (
       'fn_settle_tournament_obligation',
       'fn_settle_satellite_tournament') THEN
    RETURN NEW;
  END IF;

  v_cat := lower(COALESCE(NEW.category, ''));

  -- The mode is data, so the way back is an UPDATE and not a deploy. A missing
  -- row means log: this guard never becomes stricter by accident.
  SELECT e.mode INTO v_mode FROM public.ca_money_path_enforcement e WHERE e.only_row;
  v_mode := COALESCE(v_mode, 'log');

  IF v_mode = 'refuse' THEN
    -- Nothing survives this raise, so the message carries the evidence: who
    -- wrote, from where, for how much, against which entity.
    RAISE EXCEPTION
      'R3: a % credit of % was written outside fn_settle_tournament_obligation (money_path=%, app=%, role=%, wallet_transactions.related_entity_id=%). Route it through fn_settle_tournament_obligation. To reopen the door: UPDATE public.ca_money_path_enforcement SET mode = ''log'';',
      COALESCE(NULLIF(v_cat, ''), '<none>'), NEW.amount, COALESCE(NULLIF(v_path, ''), '<none>'),
      COALESCE(NULLIF(current_setting('application_name', true), ''), '<none>'),
      session_user::text, NEW.related_entity_id
      USING ERRCODE = 'raise_exception';
  END IF;

  BEGIN
    INSERT INTO public.ca_money_path_violations
      (table_name, user_id, amount, category, description, related_entity_id,
       money_path, app_name, db_role)
    VALUES
      (TG_TABLE_NAME, NEW.user_id, NEW.amount, NEW.category, NEW.description,
       NEW.related_entity_id, NULLIF(v_path, ''),
       NULLIF(current_setting('application_name', true), ''),
       session_user::text);
  EXCEPTION WHEN OTHERS THEN
    -- The logger must never be the reason a credit fails.
    NULL;
  END;

  BEGIN
    -- Global scope (no entity dimension) so it files for every union; the
    -- tournament id travels in metadata only. INFO never pages.
    PERFORM public.fn_ca_raise_drift_incident(
      p_source         => 'r3_money_path_log',
      p_classification => 'unauthorized_adjustment',
      p_severity       => 'info',
      p_dedupe_key     => 'r3:' || v_cat || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24'),
      p_discrepancy    => NEW.amount,
      p_layer          => 'settlement',
      p_entity_type    => 'wallet_transactions',
      p_entity_id      => NEW.id,
      p_suspected_cause => 'a tournament-category credit was written outside fn_settle_tournament_obligation (R3, log-only)',
      p_metadata       => jsonb_build_object('category', NEW.category, 'money_path', NULLIF(v_path, ''),
                            'related_entity_id', NEW.related_entity_id,
                            'app_name', NULLIF(current_setting('application_name', true), ''),
                            'session_user', session_user::text));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_money_path_log()
  FROM PUBLIC, anon, authenticated;

DO $prove_atomic_satellite_money_path$
DECLARE
  v_guard text;
  v_satellite_wrapper text;
BEGIN
  SELECT p.prosrc
    INTO v_guard
    FROM pg_proc p
   WHERE p.oid = 'public.fn_ca_money_path_log()'::regprocedure;
  SELECT p.prosrc
    INTO v_satellite_wrapper
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure;

  IF v_guard NOT LIKE '%fn_settle_tournament_obligation%'
     OR v_guard NOT LIKE '%fn_settle_satellite_tournament%'
     OR v_guard LIKE '%fn_ca_adopt_b066_satellite_remainder%'
     OR v_satellite_wrapper NOT LIKE
          '%set_config(%app.money_path%fn_settle_satellite_tournament%'
     OR v_satellite_wrapper NOT LIKE
          '%fn_settle_satellite_tournament_pre_money_path_gate%'
     OR to_regprocedure(
          'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)')
          IS NULL
     OR has_function_privilege(
       'anon','public.fn_settle_satellite_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_settle_satellite_tournament(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_settle_satellite_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
       'EXECUTE')
     OR (
       SELECT count(*) FROM pg_trigger tr
        WHERE tr.tgrelid = 'public.wallet_transactions'::regclass
          AND tr.tgname = 'trg_ca_money_path_log'
          AND tr.tgfoid = 'public.fn_ca_money_path_log()'::regprocedure
          AND NOT tr.tgisinternal
          AND tr.tgenabled = 'O'
          AND tr.tgtype = 5) <> 1 THEN
    RAISE EXCEPTION 'atomic satellite money-path integration did not persist exactly'
      USING ERRCODE = 'P0404';
  END IF;
END;
$prove_atomic_satellite_money_path$;

DO $prove_satellite_adoption_helpers_retired$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_adopt_b066_satellite_remainder()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_adopt_682_satellite_completion()') IS NOT NULL THEN
    RAISE EXCEPTION 'one-time satellite adoption helper survived closeout';
  END IF;
END;
$prove_satellite_adoption_helpers_retired$;

COMMIT;
