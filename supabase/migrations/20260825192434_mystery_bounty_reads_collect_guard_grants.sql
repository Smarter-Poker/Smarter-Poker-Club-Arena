-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825192434; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_inventory(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'pool_cents', COALESCE(t.mystery_bounty_pool_cents, 0),
    'stage', t.mystery_bounty_stage,
    'profile', t.mystery_bounty_profile,
    'activation', t.mystery_bounty_activation,
    'activation_value', t.mystery_bounty_activation_value,
    'activated_players', t.mystery_bounty_activated_players,
    'activated_at', t.mystery_bounty_activated_at,
    'tiers', COALESCE((
      SELECT jsonb_agg(row_to_json(x) ORDER BY x.amount_cents DESC)
        FROM (
          SELECT c.tier,
                 c.amount_cents,
                 count(*)::int AS original,
                 count(*) FILTER (WHERE c.status IN ('reserved','revealed','paid'))::int AS awarded,
                 count(*) FILTER (WHERE c.status = 'available')::int AS remaining
            FROM public.tournament_bounty_chests c
           WHERE c.tournament_id = p_tournament_id
           GROUP BY c.tier, c.amount_cents
        ) x
    ), '[]'::jsonb))
  FROM public.tournaments t WHERE t.id = p_tournament_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_awards(
  p_tournament_id uuid,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public.tournament_bounty_awards
               WHERE tournament_id = p_tournament_id AND status IN ('revealed','paid','completed')),
    'rows', COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.revealed_at DESC NULLS LAST)
        FROM (
          SELECT a.id AS award_id, a.amount_cents, a.tier,
                 a.tier = 'jackpot' AS is_jackpot,
                 a.revealed_at, a.hand_id, a.table_id,
                 jsonb_build_object('user_id', a.eliminated_user_id,
                   'username', COALESCE(tp.username, 'Player')) AS eliminated,
                 COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                            'user_id', rc.user_id,
                            'username', COALESCE(tp2.username, 'Player'),
                            'amount_cents', rc.amount_cents)
                          ORDER BY rc.amount_cents DESC)
                     FROM public.tournament_bounty_award_recipients rc
                     LEFT JOIN public.tournament_players tp2
                       ON tp2.tournament_id = a.tournament_id AND tp2.user_id = rc.user_id
                    WHERE rc.award_id = a.id), '[]'::jsonb) AS recipients
            FROM public.tournament_bounty_awards a
            LEFT JOIN public.tournament_players tp
              ON tp.tournament_id = a.tournament_id AND tp.user_id = a.eliminated_user_id
           WHERE a.tournament_id = p_tournament_id
             AND a.status IN ('revealed','paid','completed')
           ORDER BY a.revealed_at DESC NULLS LAST
           LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
          OFFSET GREATEST(0, COALESCE(p_offset, 0))
        ) r
    ), '[]'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_leaderboard(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('rows', COALESCE((
    SELECT jsonb_agg(row_to_json(x) ORDER BY x.earnings_cents DESC, x.username)
      FROM (
        SELECT rc.user_id,
               COALESCE(tp.username, 'Player') AS username,
               count(*)::int AS bounties_won,
               sum(rc.amount_cents)::bigint AS earnings_cents
          FROM public.tournament_bounty_award_recipients rc
          JOIN public.tournament_bounty_awards a ON a.id = rc.award_id
          LEFT JOIN public.tournament_players tp
            ON tp.tournament_id = a.tournament_id AND tp.user_id = rc.user_id
         WHERE a.tournament_id = p_tournament_id
           AND a.status IN ('revealed','paid','completed')
         GROUP BY rc.user_id, tp.username
      ) x
  ), '[]'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION public.fn_collect_bounty(p_tournament_id uuid, p_eliminated_user_id uuid, p_collector_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_elim record;
  v_head numeric; v_available numeric; v_payable numeric;
  v_cash numeric; v_to_head numeric;
  v_cents integer; v_cash_cents integer;
  v_mode text; v_funded boolean;
BEGIN
  IF p_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_party');
  END IF;

  SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         bounty_pool, bounty_pool_paid, mystery_bounty_stage
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_bounty_tournament');
  END IF;

  -- THE CHEST PATH OWNS THIS KNOCKOUT once the mystery phase is open. Two
  -- paths paying one knockout is how a funded pool goes negative.
  IF COALESCE(v_t.is_mystery_bounty, false) AND v_t.mystery_bounty_stage = 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'mystery_phase_active');
  END IF;

  IF EXISTS (SELECT 1 FROM tournament_bounties
              WHERE tournament_id = p_tournament_id
                AND eliminated_player_id = p_eliminated_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_collected');
  END IF;

  SELECT current_bounty INTO v_elim
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id
   FOR UPDATE;

  v_mode := CASE WHEN COALESCE(v_t.is_pko,false) THEN 'pko'
                 WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
                 ELSE 'regular' END;

  -- mystery_bounty_value is deliberately NOT in this COALESCE any more. It was
  -- a Postgres random() roll taken at REGISTRATION, and 9,000 historical rows
  -- still carry one; a re-swept old tournament must not pay from it.
  v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
  IF v_head <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_head_value');
  END IF;

  v_funded  := COALESCE(v_t.bounty_pool, 0) > 0;
  v_available := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);

  IF v_funded THEN
    IF v_available <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                                'head', v_head, 'available', v_available);
    END IF;
    v_payable := LEAST(v_head, v_available);
  ELSE
    v_payable := v_head;
  END IF;

  IF v_mode = 'pko' THEN
    v_cents      := round(v_payable * 100)::integer;
    v_cash_cents := (v_cents / 2)::integer;
    v_cash       := v_cash_cents / 100.0;
    v_to_head    := (v_cents - v_cash_cents) / 100.0;
  ELSE
    v_cash := v_payable; v_to_head := 0;
  END IF;

  IF v_cash > 0 THEN
    PERFORM public.credit_player_wallet(
      p_collector_user_id, v_cash,
      'tourney:' || p_tournament_id || ':bounty:' || p_eliminated_user_id
        || ':' || p_collector_user_id);
    PERFORM public.log_wallet_transaction(
      p_collector_user_id, 'PLAYER', v_cash, 'credit', 'bounty',
      CASE v_mode WHEN 'pko'         THEN 'PKO bounty (cash half) from eliminated player'
                  WHEN 'mystery_pre' THEN 'Bounty collected before the mystery phase opened'
                  ELSE 'Bounty collected from eliminated player' END,
      NULL, NULL, p_tournament_id);
  END IF;

  UPDATE tournament_players
     SET bounties_collected = COALESCE(bounties_collected,0) + 1,
         bounty_winnings    = round(COALESCE(bounty_winnings,0) + v_cash, 2),
         current_bounty     = round(COALESCE(current_bounty,0) + v_to_head, 2)
   WHERE tournament_id = p_tournament_id AND user_id = p_collector_user_id;

  UPDATE tournament_players SET current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

  IF v_funded THEN
    UPDATE tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_cash, 2)
     WHERE id = p_tournament_id;
  END IF;

  INSERT INTO tournament_bounties
    (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
     added_to_collector_bounty, is_mystery_revealed)
  VALUES (p_tournament_id, p_eliminated_user_id, p_collector_user_id, v_payable,
          CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END,
          false);

  RETURN jsonb_build_object('ok', true, 'mode', v_mode, 'funded', v_funded,
    'head', v_head, 'paid_cash', v_cash, 'added_to_head', v_to_head,
    'capped', v_funded AND v_payable < v_head,
    'pool_remaining', CASE WHEN v_funded THEN round(v_available - v_cash, 2) END);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_seed(uuid, int, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve(uuid, uuid, jsonb, uuid, text, uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_seed(uuid, int, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reserve(uuid, uuid, jsonb, uuid, text, uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reveal(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reveal(uuid, uuid, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_inventory(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_awards(uuid, int, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_leaderboard(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_inventory(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_awards(uuid, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_leaderboard(uuid) TO authenticated, service_role;
