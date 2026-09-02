-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825192344; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reveal(
  p_award_id uuid,
  p_actor_user_id uuid,
  p_auto boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record;
  v_revealer uuid;
  v_payload jsonb;
BEGIN
  SELECT * INTO v_a FROM public.tournament_bounty_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;

  SELECT user_id INTO v_revealer FROM public.tournament_bounty_award_recipients
   WHERE award_id = p_award_id AND is_designated_revealer LIMIT 1;

  -- AUTHORISATION. Anyone can call an RPC, so this is the line that stops a
  -- spectator opening someone else's chest.
  IF NOT COALESCE(p_auto, false) AND (p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_revealer) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_the_revealer');
  END IF;

  IF v_a.status = 'reserved' THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'revealed', revealed_at = now() WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests SET status = 'revealed' WHERE id = v_a.chest_id;
  END IF;
  -- Already revealed / paid / completed falls through and returns the same
  -- payload: a double tap, a reconnect replaying the tap, and the deadline
  -- firing just after a real tap must all show the player the same number.

  v_payload := jsonb_build_object(
    'ok', true,
    'award_id', v_a.id,
    'tournament_id', v_a.tournament_id,
    'table_id', v_a.table_id,
    'hand_id', v_a.hand_id,
    'amount_cents', v_a.amount_cents,
    'tier', v_a.tier,
    'is_jackpot', v_a.tier = 'jackpot',
    'eliminated_user_id', v_a.eliminated_user_id,
    'designated_revealer', v_revealer,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'amount_cents', amount_cents)
                       ORDER BY amount_cents DESC, user_id)
        FROM public.tournament_bounty_award_recipients WHERE award_id = p_award_id), '[]'::jsonb)
  );
  RETURN v_payload;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record; v_r record; v_paid bigint := 0; v_credited boolean;
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

  FOR v_r IN
    SELECT * FROM public.tournament_bounty_award_recipients
     WHERE award_id = p_award_id AND paid_at IS NULL AND amount_cents > 0
     ORDER BY user_id
     FOR UPDATE
  LOOP
    -- fn_credit_and_log is the ONLY way money reaches a wallet. The key makes
    -- the credit itself idempotent, so calling this twice cannot pay twice
    -- even if the paid_at stamp below never lands.
    v_credited := public.fn_credit_and_log(
      v_r.user_id,
      (v_r.amount_cents / 100.0)::numeric,
      'mb:' || p_award_id::text || ':' || v_r.user_id::text,
      'bounty',
      'Mystery bounty revealed from eliminated player',
      v_a.tournament_id
    );

    UPDATE public.tournament_bounty_award_recipients SET paid_at = now() WHERE id = v_r.id;

    IF COALESCE(v_credited, false) THEN
      v_paid := v_paid + v_r.amount_cents;
      UPDATE public.tournament_players
         SET bounties_collected = COALESCE(bounties_collected, 0) + 1,
             bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_r.amount_cents / 100.0), 2)
       WHERE tournament_id = v_a.tournament_id AND user_id = v_r.user_id;

      -- Keep the LEGACY bounty ledger in step: tournament_bounties is what
      -- every existing leaderboard, stat and audit query reads.
      INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount, is_mystery_revealed)
      VALUES (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
              (v_r.amount_cents / 100.0)::numeric, true)
      ON CONFLICT (tournament_id, eliminated_player_id, collector_player_id) DO NOTHING;
    END IF;
  END LOOP;

  IF v_paid > 0 THEN
    -- fn_finalize_bounty_pool settles bounty_pool - bounty_pool_paid to the
    -- champion, so a mystery payment that did not move this number would be
    -- paid twice: once to the knocker and again to the winner as "unclaimed".
    UPDATE public.tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_paid / 100.0), 2)
     WHERE id = v_a.tournament_id;
  END IF;

  UPDATE public.tournament_bounty_awards
     SET status = 'completed', paid_at = now() WHERE id = p_award_id;
  UPDATE public.tournament_bounty_chests SET status = 'paid' WHERE id = v_a.chest_id;

  RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', p_award_id,
    'amount_cents', v_a.amount_cents, 'paid_cents', v_paid,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'amount_cents', amount_cents))
        FROM public.tournament_bounty_award_recipients WHERE award_id = p_award_id), '[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(
  p_tournament_id uuid,
  p_winner_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool bigint; v_paid bigint; v_unclaimed bigint; v_stage text;
BEGIN
  SELECT mystery_bounty_stage, COALESCE(mystery_bounty_pool_cents, 0)
    INTO v_stage, v_pool
    FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF v_stage = 'pending' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'never_activated', 'unclaimed_cents', 0,
                              'pool_cents', 0, 'settled_cents', 0, 'balanced', true, 'variance_cents', 0);
  END IF;

  SELECT COALESCE(sum(r.amount_cents), 0) INTO v_paid
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id AND r.paid_at IS NOT NULL;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_unclaimed
    FROM public.tournament_bounty_chests
   WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');

  -- UNCLAIMED CHESTS GO TO THE CHAMPION. The last player standing was never
  -- knocked out, so their own chest - and any chest a broken elimination left
  -- behind - is theirs. The idempotency key is the tournament, so a re-run
  -- cannot pay it twice.
  IF v_unclaimed > 0 AND p_winner_user_id IS NOT NULL THEN
    PERFORM public.fn_credit_and_log(
      p_winner_user_id, (v_unclaimed / 100.0)::numeric,
      'mb-residual:' || p_tournament_id::text,
      'bounty', 'Unclaimed mystery bounty chests awarded to champion',
      p_tournament_id);
    UPDATE public.tournament_players
       SET bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_unclaimed / 100.0), 2)
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    UPDATE public.tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_unclaimed / 100.0), 2)
     WHERE id = p_tournament_id;
    UPDATE public.tournament_bounty_chests SET status = 'void'
     WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');
    v_paid := v_paid + v_unclaimed;
  END IF;

  UPDATE public.tournaments SET mystery_bounty_stage = 'complete' WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'pool_cents', v_pool, 'settled_cents', v_paid, 'unclaimed_cents', v_unclaimed,
    'balanced', v_paid = v_pool,
    'variance_cents', v_paid - v_pool);
END;
$function$;
