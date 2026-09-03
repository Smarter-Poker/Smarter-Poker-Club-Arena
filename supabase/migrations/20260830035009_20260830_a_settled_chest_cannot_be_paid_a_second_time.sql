-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830035009; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A SETTLED CHEST CANNOT BE PAID A SECOND TIME (2026-08-30)
-- Chest e794df3d (260 cents) was paid twice ten seconds apart: once as the
-- champion residual by fn_mystery_bounty_settle and once to the knocker by
-- fn_mystery_bounty_pay, under two different idempotency keys.
-- See supabase/migrations/20260830040000_a_settled_chest_cannot_be_paid_a_second_time.sql
-- for the full account.

ALTER TABLE public.tournament_bounty_awards
  DROP CONSTRAINT IF EXISTS tournament_bounty_awards_status_check;
ALTER TABLE public.tournament_bounty_awards
  ADD CONSTRAINT tournament_bounty_awards_status_check
  CHECK (status = ANY (ARRAY['reserved'::text, 'revealed'::text, 'paid'::text,
                             'completed'::text, 'void'::text]));

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record; v_r record; v_paid bigint := 0; v_credited boolean; v_refused int := 0;
  v_chest_status text;
BEGIN
  SELECT * INTO v_a FROM public.tournament_bounty_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;

  IF v_a.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'award_id', p_award_id,
                              'amount_cents', v_a.amount_cents);
  END IF;
  IF v_a.status = 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet_revealed');
  END IF;

  -- SETTLED IS SETTLED (2026-08-30). fn_mystery_bounty_settle swept this chest
  -- to the champion and voided the award in the same transaction. Paying it
  -- again mints the chest a second time under a different idempotency key.
  IF v_a.status = 'void' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_voided_by_settlement',
                              'award_id', p_award_id);
  END IF;

  SELECT status INTO v_chest_status
    FROM public.tournament_bounty_chests WHERE id = v_a.chest_id;
  IF v_chest_status = 'void' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_settled_to_champion',
                              'award_id', p_award_id);
  END IF;

  FOR v_r IN
    SELECT * FROM public.tournament_bounty_award_recipients
     WHERE award_id = p_award_id AND paid_at IS NULL AND amount_cents > 0
     ORDER BY user_id
     FOR UPDATE
  LOOP
    v_credited := public.fn_credit_and_log(
      v_r.user_id,
      (v_r.amount_cents / 100.0)::numeric,
      'mb:' || p_award_id::text || ':' || v_r.user_id::text,
      'bounty',
      'Mystery bounty revealed from eliminated player',
      v_a.tournament_id
    );

    IF COALESCE(v_credited, false) THEN
      UPDATE public.tournament_bounty_award_recipients SET paid_at = now() WHERE id = v_r.id;

      v_paid := v_paid + v_r.amount_cents;
      UPDATE public.tournament_players
         SET bounties_collected = COALESCE(bounties_collected, 0) + 1,
             bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_r.amount_cents / 100.0), 2)
       WHERE tournament_id = v_a.tournament_id AND user_id = v_r.user_id;

      INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount, is_mystery_revealed)
      VALUES (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
              (v_r.amount_cents / 100.0)::numeric, true)
      ON CONFLICT (tournament_id, eliminated_player_id, collector_player_id) DO NOTHING;
    ELSE
      v_refused := v_refused + 1;
    END IF;
  END LOOP;

  IF v_paid > 0 THEN
    UPDATE public.tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_paid / 100.0), 2)
     WHERE id = v_a.tournament_id;
  END IF;

  IF v_refused = 0 THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'completed', paid_at = now() WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests SET status = 'paid' WHERE id = v_a.chest_id;
  ELSE
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_mystery_bounty_pay',
            'Mystery bounty award left incomplete: a recipient credit was refused',
            jsonb_build_object('award_id', p_award_id,
                               'tournament_id', v_a.tournament_id,
                               'refused_recipients', v_refused,
                               'paid_cents', v_paid,
                               'award_cents', v_a.amount_cents,
                               'detail', 'the award is NOT marked completed and the chest is NOT marked paid, so it stays retryable'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', p_award_id,
    'amount_cents', v_a.amount_cents, 'paid_cents', v_paid,
    'refused_recipients', v_refused,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'amount_cents', amount_cents))
        FROM public.tournament_bounty_award_recipients WHERE award_id = p_award_id), '[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool bigint; v_paid bigint; v_unclaimed bigint; v_stage text;
  v_award record;
  v_funded numeric; v_ledger numeric;
  v_room bigint; v_residual bigint;
BEGIN
  SELECT mystery_bounty_stage, COALESCE(mystery_bounty_pool_cents, 0), COALESCE(bounty_pool, 0)
    INTO v_stage, v_pool, v_funded
    FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF v_stage = 'pending' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'never_activated', 'unclaimed_cents', 0,
                              'pool_cents', 0, 'settled_cents', 0, 'balanced', true, 'variance_cents', 0);
  END IF;

  -- AN OPENED CHEST BELONGS TO WHOEVER OPENED IT (2026-08-30). Paying the
  -- revealed awards inside the settlement transaction marks their chests
  -- 'paid' and takes them out of the unclaimed sweep below.
  FOR v_award IN
    SELECT id FROM public.tournament_bounty_awards
     WHERE tournament_id = p_tournament_id AND status = 'revealed'
     ORDER BY id
     FOR UPDATE
  LOOP
    PERFORM public.fn_mystery_bounty_pay(v_award.id);
  END LOOP;

  SELECT COALESCE(sum(r.amount_cents), 0) INTO v_paid
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id AND r.paid_at IS NOT NULL;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_unclaimed
    FROM public.tournament_bounty_chests
   WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');

  v_residual := v_unclaimed;

  -- THE RESIDUAL CANNOT EXCEED WHAT THE POOL STILL HOLDS, measured from the
  -- ledger for the same reason fn_finalize_bounty_pool measures from it.
  IF v_residual > 0 AND v_funded > 0 THEN
    SELECT round(COALESCE(SUM(
             CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount) ELSE wt.amount END
           ), 0), 2)
      INTO v_ledger
      FROM wallet_transactions wt
     WHERE wt.related_entity_id = p_tournament_id
       AND wt.category = 'bounty';

    v_room := GREATEST(0, floor((v_funded - COALESCE(v_ledger, 0)) * 100))::bigint;

    IF v_residual > v_room THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_mystery_bounty_settle',
              'Champion residual clamped: the unclaimed chests are worth more than the bounty pool still holds',
              jsonb_build_object('tournament_id', p_tournament_id,
                                 'unclaimed_cents', v_unclaimed,
                                 'room_cents', v_room,
                                 'ledger_paid', v_ledger,
                                 'bounty_pool', v_funded,
                                 'detail', 'the clamp is not the bug, it is the seatbelt -- find the payer that already spent the pool'));
      v_residual := v_room;
    END IF;
  END IF;

  IF p_winner_user_id IS NOT NULL THEN
    IF v_residual > 0 THEN
      PERFORM public.fn_credit_and_log(
        p_winner_user_id, (v_residual / 100.0)::numeric,
        'mb-residual:' || p_tournament_id::text,
        'bounty', 'Unclaimed mystery bounty chests awarded to champion',
        p_tournament_id);
      UPDATE public.tournament_players
         SET bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_residual / 100.0), 2)
       WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
      UPDATE public.tournaments
         SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_residual / 100.0), 2)
       WHERE id = p_tournament_id;
      v_paid := v_paid + v_residual;
    END IF;

    -- NOTHING MAY PAY THESE CHESTS AFTER THIS POINT.
    UPDATE public.tournament_bounty_awards a
       SET status = 'void'
     WHERE a.tournament_id = p_tournament_id
       AND a.status <> 'completed'
       AND EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.id = a.chest_id
                      AND c.status IN ('available','reserved','revealed'));

    UPDATE public.tournament_bounty_chests SET status = 'void'
     WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');
  END IF;

  UPDATE public.tournaments SET mystery_bounty_stage = 'complete' WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'pool_cents', v_pool, 'settled_cents', v_paid, 'unclaimed_cents', v_unclaimed,
    'residual_paid_cents', v_residual,
    'balanced', v_paid = v_pool,
    'variance_cents', v_paid - v_pool);
END;
$function$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tournament_bounty_awards_status_check'
       AND pg_get_constraintdef(oid) LIKE '%void%'
  ) THEN
    RAISE EXCEPTION 'tournament_bounty_awards_status_check does not admit void';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_mystery_bounty_pay')
       NOT LIKE '%award_voided_by_settlement%' THEN
    RAISE EXCEPTION 'fn_mystery_bounty_pay still pays a voided award';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_mystery_bounty_settle')
       NOT LIKE '%fn_mystery_bounty_pay%' THEN
    RAISE EXCEPTION 'fn_mystery_bounty_settle no longer pays revealed awards before sweeping';
  END IF;
END
$do$;
