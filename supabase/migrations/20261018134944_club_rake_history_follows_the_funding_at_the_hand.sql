-- Version reserved by scripts/new-migration.mjs.
-- Club Data continuation, 2026-10-18: the advanced Report's rake breakdown
-- reads ca_club_rake_daily. Six closed club/day rows still disagreed with
-- cash facts (JAQK/SHARK, Sep16, Sep17, Oct17). Recomputing Sep16-17 today
-- changed their split again: the fallback used a current seat/latest receipt.
-- The Club Data history seed already uses receipts/seats at the hand's time.
-- Keep rake_attributions first; apply that same time bound to this calculator.
-- No wallet, ledger, settlement, scheduler or live-game state is changed.
-- Only demonstrated closed-day rollup gaps are rebuilt explicitly afterward.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_compute(p_from timestamp with time zone, p_to timestamp with time zone, p_ids uuid[])
 RETURNS TABLE(club_id uuid, stat_date date, hands bigint, rake numeric, bbj numeric, pot numeric, source_rows bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT r.id, r.table_id, r.club_id, r.created_at,
           coalesce(r.rake_amount, 0) AS rake, coalesce(r.bbj_contribution, 0) AS bbj,
           coalesce(r.pot_size, 0) AS pot, r.player_contributions
      FROM rake_records r
     WHERE p_ids IS NOT NULL AND r.id = ANY (p_ids)
       AND r.club_id IS NOT NULL AND NOT coalesce(r.is_tournament, false)
       AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
    UNION ALL
    SELECT r.id, r.table_id, r.club_id, r.created_at,
           coalesce(r.rake_amount, 0), coalesce(r.bbj_contribution, 0),
           coalesce(r.pot_size, 0), r.player_contributions
      FROM rake_records r
     WHERE p_ids IS NULL AND r.created_at >= p_from AND r.created_at < p_to
       AND r.club_id IS NOT NULL AND NOT coalesce(r.is_tournament, false)
       AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
  ),
  tbl AS (
    SELECT s.id, s.club_id AS table_club, (s.created_at AT TIME ZONE 'UTC')::date AS day,
           s.rake, s.bbj, s.pot, s.player_contributions, t.union_id, s.table_id, s.created_at
      FROM src s
      LEFT JOIN tables t ON t.id = s.table_id
     WHERE t.id IS NULL OR t.tournament_id IS NULL
  ),
  -- Only a union table needs its contributions read: a standalone table's
  -- rake has exactly one place to go. A key that is not a uuid or a value
  -- that is not a number is ignored, never raised: a reporting rollup must
  -- not fail a ledger write. A contribution of zero still counts the hand
  -- for that player's club, as club_table_daily counts it.
  contrib AS (
    SELECT b.id, b.union_id,
           CASE WHEN e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN e.key::uuid END AS uid,
           CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric END AS contrib
      FROM tbl b
      CROSS JOIN LATERAL jsonb_each_text(
        CASE WHEN jsonb_typeof(b.player_contributions) = 'object'
             THEN b.player_contributions ELSE '{}'::jsonb END) e
     WHERE b.union_id IS NOT NULL
  ),
  attributed AS (
    SELECT c.id, c.contrib,
           -- The witness wins. Without it, use the funding or seat at the
           -- hand's time, never a later seat or buy-in at the same table.
           coalesce((SELECT ra.club_id FROM rake_attributions ra
                      WHERE ra.rake_record_id = c.id AND ra.player_id = c.uid AND ra.club_id IS NOT NULL
                      LIMIT 1),
                    (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
                      WHERE x.operation_kind = 'buyin' AND x.table_id = b.table_id
                        AND x.account_entity_id = c.uid AND x.seat_joined_at <= b.created_at
                      ORDER BY x.seat_joined_at DESC LIMIT 1),
                    (SELECT ts.club_id FROM public.table_seats ts
                      WHERE ts.table_id = b.table_id AND ts.user_id = c.uid
                        AND ts.club_id IS NOT NULL AND ts.joined_at <= b.created_at
                      ORDER BY ts.joined_at DESC LIMIT 1),
                    (SELECT cm.club_id
                       FROM club_members cm
                       JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = c.union_id
                      WHERE cm.user_id = c.uid
                      ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
                      LIMIT 1),
                    b.table_club) AS club_id
      FROM contrib c JOIN tbl b ON b.id = c.id
     WHERE c.uid IS NOT NULL AND c.contrib IS NOT NULL AND c.contrib >= 0
  ),
  split AS (
    SELECT a.id, a.club_id, sum(a.contrib) AS contrib, count(*) AS src_rows
      FROM attributed a GROUP BY a.id, a.club_id
  ),
  split_total AS (
    SELECT s.id, sum(s.contrib) AS tot FROM split s GROUP BY s.id
  ),
  hand_rows AS (
    SELECT b.*, EXISTS (SELECT 1 FROM split_total st WHERE st.id = b.id AND st.tot > 0) AS has_split
      FROM tbl b
  ),
  parts AS (
    -- A union hand with a usable split: rake by contribution share, and one
    -- hand for every club that contributed.
    SELECT h.day, s.club_id, 1::bigint AS hands, h.rake * s.contrib / st.tot AS rake,
           0::numeric AS bbj, 0::numeric AS pot, s.src_rows
      FROM split s
      JOIN split_total st ON st.id = s.id AND st.tot > 0
      JOIN hand_rows h ON h.id = s.id
    UNION ALL
    -- The table's club: the drop and the pot volume of every hand it hosted,
    -- plus the whole hand when nothing could be attributed.
    SELECT h.day, h.table_club,
           CASE WHEN h.has_split THEN 0 ELSE 1 END,
           CASE WHEN h.has_split THEN 0 ELSE h.rake END,
           h.bbj, h.pot,
           CASE WHEN h.has_split THEN 0 ELSE 1 END
      FROM hand_rows h
  )
  SELECT p.club_id, p.day, sum(p.hands)::bigint, sum(p.rake), sum(p.bbj), sum(p.pot),
         sum(p.src_rows)::bigint
    FROM parts p
   GROUP BY p.club_id, p.day;
$function$;

COMMIT;
