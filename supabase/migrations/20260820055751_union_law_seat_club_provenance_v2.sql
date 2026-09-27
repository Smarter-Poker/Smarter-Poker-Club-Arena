-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820055751 "union_law_seat_club_provenance_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 80a83de85b50979196cfd3aac107e2fd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — SEAT CLUB PROVENANCE + COMMINGLING DETECTION (2026-08-20)
--
-- Dan's ruling: "It's based on ACTUAL PLAY inside each club. If a user is
-- playing under one club, that rake is generated for that play under that club
-- only. They have to physically get chips from that club, sit in games inside
-- that club to earn rake inside that club. Each wallet for each club is 100%
-- separate and never commingled."
--
-- AUDIT FINDING: the platform does not currently honour this.
--   * Per-club wallets EXIST and are funded (club_members.chip_balance:
--     JAQK 41.9M, SHARK 42.2M) but the buy-in path ignores them —
--     atomic_table_buyin debits ONE global wallets row (wallet_type='PLAYER').
--     That is commingling by construction.
--   * table_seats had no club column, so nothing recorded which club a player
--     sat under.
--   * fn_union_rake_basis_by_club therefore fell back to "first club joined",
--     sending ~97% of weekly rakeback to SHARK purely because its membership
--     rows are older (all 578 players belong to BOTH clubs).
--
-- Foundation only — the live buy-in path is deliberately NOT altered here
-- (200+ players seated, hands every second). Attribution upgrades itself as
-- seat provenance arrives; behaviour is identical until then.
-- ============================================================================

ALTER TABLE public.table_seats
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id);

COMMENT ON COLUMN public.table_seats.club_id IS
  'UNION LAW (Dan 2026-08-20): the club whose chips this player sat down with. '
  'Rake from this seat belongs to that club only. NULL = legacy seat predating '
  'club-scoped buy-ins; attribution falls back to first-joined membership.';

CREATE INDEX IF NOT EXISTS idx_table_seats_club_active
  ON public.table_seats (club_id, table_id) WHERE left_at IS NULL;

CREATE OR REPLACE FUNCTION public.fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_table_club uuid; v_club uuid;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_table_club
    FROM tables t WHERE t.id = p_table_id;

  IF v_union IS NULL THEN
    RETURN v_table_club;   -- standalone club game
  END IF;

  -- Union game: honour the club context the client supplied (the club card the
  -- player entered through) when they really are a member of it.
  IF p_preferred_club IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                  JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club
                   AND m.status IN ('active','approved'))
  THEN
    RETURN p_preferred_club;
  END IF;

  SELECT m.club_id INTO v_club
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$;

-- Attribution: real seat provenance first, legacy rule only where absent -----
CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_by_club(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(club_id uuid, rake_share numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH legacy AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  ut AS (SELECT id FROM tables WHERE union_id = p_union_id AND tournament_id IS NULL),
  cash AS (
    SELECT
      COALESCE(
        (SELECT ts.club_id
           FROM table_seats ts
          WHERE ts.table_id = r.table_id
            AND ts.user_id = (e.key)::uuid
            AND ts.club_id IS NOT NULL
            AND ts.joined_at <= r.created_at
            AND (ts.left_at IS NULL OR ts.left_at >= r.created_at)
          ORDER BY ts.joined_at DESC
          LIMIT 1),
        l.club_id
      ) AS club_id,
      SUM(r.rake_amount * (e.value::numeric) / c.total) AS rake
      FROM rake_records r
      JOIN ut ON ut.id = r.table_id
      CROSS JOIN LATERAL (
        SELECT SUM(t.value::numeric) AS total
          FROM jsonb_each_text(r.player_contributions) AS t(key, value)
      ) c
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) AS e(key, value)
      LEFT JOIN legacy l ON l.user_id = (e.key)::uuid
     WHERE r.created_at >= p_start AND r.created_at < p_end
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
       AND c.total > 0
     GROUP BY 1
  ),
  tourney AS (
    -- tournament_players has no club column; entry fees attribute by the
    -- player's club membership until tournament entries carry provenance too.
    SELECT l.club_id, SUM(COALESCE(t.buy_in_fee, 0)) AS rake
      FROM tournament_players tp
      JOIN tournaments t ON t.id = tp.tournament_id AND t.union_id = p_union_id
      LEFT JOIN legacy l ON l.user_id = tp.user_id
     WHERE tp.registered_at >= p_start AND tp.registered_at < p_end
     GROUP BY l.club_id
  )
  SELECT club_id, round(SUM(rake), 2) AS rake_share
    FROM (SELECT club_id, rake FROM cash
          UNION ALL
          SELECT club_id, rake FROM tourney) x
   WHERE club_id IS NOT NULL
   GROUP BY club_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_commingling_report(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001')
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_buyin_uses_club_wallet boolean;
  v_seats_total bigint; v_seats_stamped bigint;
  v_multi_club bigint; v_club_chips jsonb;
BEGIN
  v_buyin_uses_club_wallet := EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='atomic_table_buyin'
       AND p.prosrc LIKE '%club_members%');

  SELECT count(*), count(*) FILTER (WHERE ts.club_id IS NOT NULL)
    INTO v_seats_total, v_seats_stamped
    FROM table_seats ts JOIN tables t ON t.id = ts.table_id
   WHERE ts.left_at IS NULL AND t.union_id = p_union_id;

  SELECT count(*) INTO v_multi_club FROM (
    SELECT cm.user_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
     GROUP BY cm.user_id HAVING count(DISTINCT cm.club_id) > 1) m;

  SELECT jsonb_object_agg(c.name, round(x.total))
    INTO v_club_chips
    FROM (SELECT cm.club_id, SUM(COALESCE(cm.chip_balance,0)) AS total
            FROM club_members cm
            JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
           GROUP BY cm.club_id) x
    JOIN clubs c ON c.id = x.club_id;

  RETURN jsonb_build_object(
    'buyin_debits_club_wallet', v_buyin_uses_club_wallet,
    'commingled', NOT v_buyin_uses_club_wallet,
    'active_union_seats', v_seats_total,
    'seats_with_club_provenance', v_seats_stamped,
    'players_in_multiple_clubs', v_multi_club,
    'club_chip_balances', v_club_chips,
    'note', CASE WHEN v_buyin_uses_club_wallet
                 THEN 'Buy-ins draw on the club wallet — provenance is real.'
                 ELSE 'Buy-ins still debit the single global player wallet, so club '
                      'wallets are commingled and rake attribution falls back to '
                      'first-joined. Club-scoped buy-in rollout required.' END
  );
END $function$;

