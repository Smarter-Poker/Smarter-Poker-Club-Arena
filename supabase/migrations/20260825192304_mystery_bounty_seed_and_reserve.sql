-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825192304; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_seed(
  p_tournament_id uuid,
  p_players_remaining int,
  p_chests jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_pool_cents bigint;
  v_bounty_cents bigint;
  v_m numeric; v_r numeric;
  v_sum bigint; v_count int;
BEGIN
  SELECT id, is_mystery_bounty, prize_pool_finalized, bounty_pool,
         bounty_pool_paid, mystery_bounty_stage,
         mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
         mystery_bounty_pool_cents
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT COALESCE(v_t.is_mystery_bounty, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_mystery_bounty');
  END IF;

  -- IDEMPOTENT. The engine's activation check runs on a five-second sweep and
  -- a restart re-runs it; seeding twice would double the inventory and the
  -- event could never reconcile.
  IF v_t.mystery_bounty_stage <> 'pending' THEN
    SELECT count(*), COALESCE(sum(amount_cents), 0) INTO v_count, v_sum
      FROM public.tournament_bounty_chests WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_seeded', true,
      'stage', v_t.mystery_bounty_stage, 'chests', v_count,
      'pool_cents', COALESCE(v_t.mystery_bounty_pool_cents, v_sum));
  END IF;

  -- ENTRY MUST BE CLOSED. bounty_pool still grows with every late entry,
  -- rebuy and add-on; an inventory built before the close is built from a pool
  -- smaller than the one the event ends up holding.
  IF NOT COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_still_open');
  END IF;

  IF p_chests IS NULL OR jsonb_typeof(p_chests) <> 'array' OR jsonb_array_length(p_chests) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chests_required');
  END IF;
  IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_count_mismatch',
      'chests', jsonb_array_length(p_chests), 'players_remaining', p_players_remaining);
  END IF;

  v_bounty_cents := round(COALESCE(v_t.bounty_pool, 0) * 100)::bigint;
  v_m := GREATEST(0, COALESCE(v_t.mystery_bounty_pool_percent, 50));
  v_r := GREATEST(0, COALESCE(v_t.mystery_bounty_regular_pool_percent, 50));
  IF v_m + v_r <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_split_misconfigured');
  END IF;
  v_pool_cents := floor(v_bounty_cents * v_m / (v_m + v_r))::bigint;

  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint THEN
    v_pool_cents := GREATEST(0, v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint);
  END IF;

  IF v_pool_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_pool');
  END IF;

  SELECT COALESCE(sum((c->>'amount_cents')::bigint), 0) INTO v_sum
    FROM jsonb_array_elements(p_chests) c;

  IF v_sum <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_mismatch',
      'inventory_cents', v_sum, 'pool_cents', v_pool_cents);
  END IF;

  INSERT INTO public.tournament_bounty_chests (tournament_id, seq, tier, amount_cents)
  SELECT p_tournament_id,
         COALESCE((c->>'seq')::int, ord::int),
         c->>'tier',
         (c->>'amount_cents')::bigint
    FROM jsonb_array_elements(p_chests) WITH ORDINALITY AS t(c, ord)
  ON CONFLICT (tournament_id, seq) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_chests) THEN
    RAISE EXCEPTION 'mystery bounty seed inserted % of % chests', v_count, jsonb_array_length(p_chests);
  END IF;

  UPDATE public.tournaments
     SET mystery_bounty_stage = 'active',
         mystery_bounty_activated_at = now(),
         mystery_bounty_activated_players = p_players_remaining,
         mystery_bounty_pool_cents = v_pool_cents
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'already_seeded', false,
    'pool_cents', v_pool_cents, 'chests', v_count, 'stage', 'active');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reserve(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_recipients jsonb,
  p_table_id uuid,
  p_hand_id text,
  p_op_id uuid,
  p_reveal_ms int DEFAULT 20000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stage text;
  v_existing record;
  v_chest record;
  v_award_id uuid;
  v_revealer uuid;
  v_idx int; v_total int;
  v_n int;
BEGIN
  IF p_eliminated_user_id IS NULL OR p_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_party');
  END IF;

  -- IDEMPOTENCY, TWO WAYS. op_id catches the same call retrying; the
  -- (tournament, eliminated) pair catches the elimination sweep processing the
  -- same bustout twice, which it does after any restart.
  SELECT id, status, table_id INTO v_existing
    FROM public.tournament_bounty_awards
   WHERE op_id = p_op_id
      OR (tournament_id = p_tournament_id AND eliminated_user_id = p_eliminated_user_id)
   LIMIT 1;

  IF FOUND THEN
    SELECT count(*) INTO v_total FROM public.tournament_bounty_awards a
     WHERE a.tournament_id = p_tournament_id
       AND a.table_id IS NOT DISTINCT FROM v_existing.table_id
       AND a.status IN ('reserved','revealed');
    SELECT count(*) INTO v_idx FROM public.tournament_bounty_awards a
     WHERE a.tournament_id = p_tournament_id
       AND a.table_id IS NOT DISTINCT FROM v_existing.table_id
       AND a.status IN ('reserved','revealed')
       AND a.reserved_at <= (SELECT reserved_at FROM public.tournament_bounty_awards WHERE id = v_existing.id);
    SELECT user_id INTO v_revealer FROM public.tournament_bounty_award_recipients
     WHERE award_id = v_existing.id AND is_designated_revealer LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'already', true, 'award_id', v_existing.id,
      'status', v_existing.status, 'queue_index', GREATEST(v_idx, 1), 'queue_total', GREATEST(v_total, 1),
      'designated_revealer', v_revealer,
      'recipient_user_ids', COALESCE((SELECT jsonb_agg(user_id) FROM public.tournament_bounty_award_recipients WHERE award_id = v_existing.id), '[]'::jsonb));
  END IF;

  SELECT mystery_bounty_stage INTO v_stage FROM public.tournaments WHERE id = p_tournament_id;
  IF v_stage IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'mystery_phase_not_active', 'stage', v_stage);
  END IF;

  IF p_recipients IS NULL OR jsonb_typeof(p_recipients) <> 'array'
     OR jsonb_array_length(p_recipients) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_recipients');
  END IF;

  -- THE DRAW. SKIP LOCKED means two knockouts landing in the same instant take
  -- two DIFFERENT chests; ORDER BY seq means they take them in the order the
  -- CSPRNG shuffle fixed at seed time.
  UPDATE public.tournament_bounty_chests
     SET status = 'reserved'
   WHERE id = (
     SELECT id FROM public.tournament_bounty_chests
      WHERE tournament_id = p_tournament_id AND status = 'available'
      ORDER BY seq
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING id, tier, amount_cents INTO v_chest;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_exhausted');
  END IF;

  INSERT INTO public.tournament_bounty_awards
    (tournament_id, chest_id, table_id, hand_id, eliminated_user_id,
     amount_cents, tier, status, op_id, reveal_deadline_at)
  VALUES (p_tournament_id, v_chest.id, p_table_id, p_hand_id, p_eliminated_user_id,
          v_chest.amount_cents, v_chest.tier, 'reserved', p_op_id,
          now() + make_interval(secs => GREATEST(1, COALESCE(p_reveal_ms, 20000)) / 1000.0))
  RETURNING id INTO v_award_id;

  UPDATE public.tournament_bounty_chests SET award_id = v_award_id WHERE id = v_chest.id;

  -- THE SPLIT. Largest remainder over the weights, leftover cents to the
  -- largest fractional parts first, so a three-way knockout out of an odd
  -- chest still pays out exactly the chest.
  WITH raw AS (
    SELECT (r->>'user_id')::uuid AS user_id,
           GREATEST(0, COALESCE((r->>'weight')::numeric, 0)) AS weight,
           COALESCE((r->>'is_designated_revealer')::boolean, false) AS flagged
      FROM jsonb_array_elements(p_recipients) r
     WHERE (r->>'user_id') IS NOT NULL
  ),
  dedup AS (
    SELECT user_id, sum(weight) AS weight, bool_or(flagged) AS flagged
      FROM raw GROUP BY user_id
  ),
  norm AS (
    SELECT user_id,
           CASE WHEN (SELECT sum(weight) FROM dedup) > 0 THEN weight ELSE 1 END AS weight,
           flagged
      FROM dedup
  ),
  alloc AS (
    SELECT n.user_id, n.weight,
           floor(v_chest.amount_cents * n.weight / t.w)::bigint AS fl,
           (v_chest.amount_cents * n.weight / t.w)
             - floor(v_chest.amount_cents * n.weight / t.w) AS frac
      FROM norm n CROSS JOIN (SELECT sum(weight) AS w FROM norm) t
  ),
  ranked AS (
    SELECT a.*,
           row_number() OVER (ORDER BY a.frac DESC, a.weight DESC, a.user_id) AS rn,
           (SELECT v_chest.amount_cents - COALESCE(sum(fl), 0) FROM alloc) AS leftover
      FROM alloc a
  )
  INSERT INTO public.tournament_bounty_award_recipients
    (award_id, user_id, amount_cents, is_designated_revealer)
  SELECT v_award_id, user_id, fl + CASE WHEN rn <= leftover THEN 1 ELSE 0 END, false
    FROM ranked
  ON CONFLICT (award_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_recipients');
  END IF;

  SELECT user_id INTO v_revealer FROM (
    SELECT (r->>'user_id')::uuid AS user_id,
           GREATEST(0, COALESCE((r->>'weight')::numeric, 0)) AS weight,
           COALESCE((r->>'is_designated_revealer')::boolean, false) AS flagged
      FROM jsonb_array_elements(p_recipients) r
     WHERE (r->>'user_id') IS NOT NULL
  ) q ORDER BY q.flagged DESC, q.weight DESC, q.user_id LIMIT 1;

  UPDATE public.tournament_bounty_award_recipients
     SET is_designated_revealer = (user_id = v_revealer)
   WHERE award_id = v_award_id;

  PERFORM 1 FROM public.tournament_bounty_award_recipients
    WHERE award_id = v_award_id HAVING sum(amount_cents) = v_chest.amount_cents;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mystery bounty split lost money on award %', v_award_id;
  END IF;

  SELECT count(*) INTO v_total FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.table_id IS NOT DISTINCT FROM p_table_id
     AND a.status IN ('reserved','revealed');
  v_idx := v_total;

  RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', v_award_id,
    'queue_index', GREATEST(v_idx, 1), 'queue_total', GREATEST(v_total, 1),
    'designated_revealer', v_revealer,
    'reveal_deadline_ms', GREATEST(1, COALESCE(p_reveal_ms, 20000)),
    'recipient_user_ids', COALESCE((SELECT jsonb_agg(user_id) FROM public.tournament_bounty_award_recipients WHERE award_id = v_award_id), '[]'::jsonb));
END;
$function$;
