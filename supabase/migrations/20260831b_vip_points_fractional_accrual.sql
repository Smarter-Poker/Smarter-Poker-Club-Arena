-- PHASE 1 step B (applied to production 2026-08-31 via Supabase MCP
-- apply_migration; this file is the auditable record required by CLAUDE.md
-- RULE 2).
--
-- THE BUG. Both VIP award sites converted a player's rake credit with floor():
--     fn_award_vip_points_from_rake  (trigger on rake_records)
--     fn_attribute_tournament_rake   (tournament settlement)
-- so any game where a player's share of the rake was under 1 chip awarded ZERO
-- points and wrote no ledger row. The rake was still taken.
--
-- Measured on production 2026-08-31 over 48h, by buy-in:
--     1 / 2 / 5 / 10 chips   610 heads-up duels + 1,870 Spins   0 points
--     19+ chips              610 duels + 1,176 Spins            2-24 points
-- ~55% of all games on both flagship formats earned nothing, at exactly the
-- stakes a new player starts on.
--
-- THE FIX. A per-user CARRY (vip_points_carry, step A). Every credit is added
-- to the carry, the whole part is awarded, the remainder is kept. Twenty games
-- at 0.05 now award 1 point instead of twenty games awarding nothing.
--
-- IDEMPOTENCY. The ledger row is the marker: inserted FIRST with points 0,
-- ON CONFLICT DO NOTHING against the existing unique
-- (user_id, source_type, source_id). A replay finds the row and returns
-- without touching the carry, so a retried settlement cannot double-credit.
-- Zero-point rows are now written where none were before (~13.5k/day): they
-- are the audit record of a credit banked rather than paid, and no
-- player-facing surface lists ledger rows.
--
-- NOT TOUCHED: agent commissions and rakeback stats already received the exact
-- fractional amount. Only the VIP conversion floored.
--
-- VERIFIED LIVE after apply: 537 sub-1 credits banked in the first 12 minutes
-- (smallest 0.01), awards continuing normally, 305 players carrying 117.45
-- chips of credit that would previously have been destroyed, zero rows
-- breaking the carry < 1 invariant, zero probe rows left behind.

CREATE OR REPLACE FUNCTION public.fn_award_vip_credit(
  p_user_id     uuid,
  p_credit      numeric,
  p_source_type text,
  p_source_id   uuid,
  p_reason      text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_id uuid;
  v_carry     numeric(14,4);
  v_total     numeric(14,4);
  v_pts       bigint;
BEGIN
  -- SERVER ONLY (added the same day; see 20260831c). CI's
  -- definer-authorization check caught that this SECURITY DEFINER writer was
  -- reachable from an authenticated browser session, which could have minted
  -- its own points. Carried here too so a clean replay of this file is never
  -- the exposed version, even for the moments before 20260831c runs.
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_award_vip_credit is a server-side path'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR COALESCE(p_credit, 0) <= 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.vip_points_ledger (user_id, points, reason, source_type, source_id, credit)
  VALUES (p_user_id, 0, p_reason, p_source_type, p_source_id, round(p_credit, 4))
  ON CONFLICT (user_id, source_type, source_id) DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.vip_points_carry (user_id, carry)
  VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO UPDATE SET carry = public.vip_points_carry.carry
  RETURNING carry INTO v_carry;

  v_total := v_carry + round(p_credit, 4);
  v_pts   := floor(v_total)::bigint;

  UPDATE public.vip_points_carry
     SET carry = v_total - v_pts, updated_at = now()
   WHERE user_id = p_user_id;

  UPDATE public.vip_points_ledger SET points = v_pts WHERE id = v_ledger_id;

  IF v_pts > 0 THEN
    INSERT INTO public.vip_points (user_id, current_points, lifetime_points)
    VALUES (p_user_id, v_pts, v_pts)
    ON CONFLICT (user_id) DO UPDATE SET
      current_points  = public.vip_points.current_points  + v_pts,
      lifetime_points = public.vip_points.lifetime_points + v_pts,
      updated_at = now();
  END IF;

  RETURN v_pts;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE k text; v text; uid uuid; rec record;
BEGIN
  IF NEW.player_contributions IS NULL OR jsonb_typeof(NEW.player_contributions) <> 'object' THEN
    RETURN NEW;
  END IF;

  IF NEW.rake_method = 'WEIGHTED_CONTRIBUTED' THEN
    FOR rec IN
      SELECT a.user_id AS uid, a.credit AS credit
        FROM public.fn_allocate_rake_credits(NEW.rake_amount, NEW.player_contributions, 'WEIGHTED_CONTRIBUTED') a
    LOOP
      PERFORM public.fn_award_vip_credit(rec.uid, rec.credit, 'rake', NEW.id, 'Rake generated');
    END LOOP;
    RETURN NEW;
  END IF;

  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.player_contributions) LOOP
    BEGIN uid := k::uuid; EXCEPTION WHEN others THEN CONTINUE; END;
    BEGIN
      PERFORM public.fn_award_vip_credit(uid, COALESCE(v::numeric, 0), 'rake', NEW.id, 'Rake generated');
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_attribute_tournament_rake(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_att record; v_users integer := 0; v_chips numeric := 0;
BEGIN
  SELECT t.club_id INTO v_club FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_club');
  END IF;

  FOR v_att IN
    WITH per_user AS (
      SELECT (r.metadata->>'user_id')::uuid AS uid,
             sum(r.rake_amount) AS amt, min(r.id::text)::uuid AS row_id
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id AND r.is_tournament
         AND r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       GROUP BY 1
    ),
    userless AS (
      SELECT sum(r.rake_amount) AS amt, min(r.id::text)::uuid AS row_id
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id AND r.is_tournament
         AND (r.metadata->>'user_id') IS NULL
      HAVING sum(r.rake_amount) > 0
    ),
    members AS (
      SELECT tp.user_id FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
    ),
    spread AS (
      SELECT m.user_id AS uid,
             round(u.amt / NULLIF((SELECT count(*) FROM members), 0), 2) AS amt,
             u.row_id
        FROM userless u CROSS JOIN members m
    )
    SELECT x.uid, round(sum(x.amt), 2) AS amt, min(x.row_id::text)::uuid AS row_id
      FROM (SELECT * FROM per_user UNION ALL SELECT * FROM spread) x
     WHERE x.uid IS NOT NULL
     GROUP BY x.uid
    HAVING round(sum(x.amt), 2) > 0
  LOOP
    v_users := v_users + 1;
    v_chips := v_chips + v_att.amt;

    PERFORM public.fn_award_vip_credit(
      v_att.uid, v_att.amt, 'tournament_rake', p_tournament_id, 'Tournament rake generated');

    PERFORM public.credit_agent_commission_from_rake(
      v_att.uid, v_club, v_att.amt,
      'tournament_rake_settlement',
      md5('trs:' || p_tournament_id::text || ':' || v_att.uid::text)::uuid,
      'tournament rake settlement');

    PERFORM public.apply_rakeback_player_stats(
      v_att.row_id, v_att.uid, v_club, 0, v_att.amt);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'attributed_users', v_users,
                            'attributed_chips', round(v_chips, 2));
END;
$function$;

-- ROLLBACK:
--   restore fn_award_vip_points_from_rake / fn_attribute_tournament_rake to
--   their floor() bodies (quoted in this header);
--   DROP FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text);
--   DROP TABLE public.vip_points_carry;  ALTER TABLE vip_points_ledger DROP COLUMN credit;
