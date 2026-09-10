-- Installed read-only proof captured 2026-09-10; body MD5 b7bc1bb46141fb6bd415b3658e622a3b.
CREATE OR REPLACE FUNCTION public.fn_prove_played_spin_launch_recovery(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
 SET statement_timeout TO '10s'
AS $function$
WITH contract AS (
  SELECT t.id,
         t.status::text AS status,
         lower(COALESCE(t.variant, '')) AS variant,
         upper(COALESCE(t.tournament_type, '')) AS tournament_type,
         t.max_players,
         t.buy_in_amount AS buy_in,
         t.starting_chips,
         round(t.buy_in_amount * 3 * public.fn_spin_rake_rate(t.buy_in_amount), 2)
           AS expected_house_rake,
         round(t.buy_in_amount * 3
               * (1 - public.fn_spin_rake_rate(t.buy_in_amount)), 2)
           AS expected_reserve_in
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
), roster AS (
  SELECT count(*) AS roster_count,
         count(DISTINCT tp.user_id) AS roster_users,
         count(*) FILTER (WHERE tp.status = 'playing') AS active_players,
         count(*) FILTER (WHERE tp.status = 'playing' AND tp.chips > 0)
           AS positive_active_players,
         count(*) FILTER (WHERE tp.status = 'eliminated') AS eliminated_players,
         count(*) FILTER (WHERE tp.status NOT IN ('playing', 'eliminated')) AS other_players,
         count(*) FILTER (WHERE tp.chips IS NULL OR tp.chips < 0) AS invalid_stacks,
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.chips = 0)
           AS zero_stack_eliminations,
         COALESCE(sum(tp.chips), 0) AS roster_chips,
         COALESCE(
           array_agg(tp.user_id ORDER BY tp.user_id)
             FILTER (WHERE tp.user_id IS NOT NULL),
           ARRAY[]::uuid[]
         ) AS original_player_ids,
         COALESCE(
           array_agg(tp.user_id ORDER BY tp.user_id)
             FILTER (WHERE tp.status = 'playing'),
           ARRAY[]::uuid[]
         ) AS active_player_ids
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
), entitlements AS (
  SELECT count(e.id) AS entitlement_count,
         count(DISTINCT e.user_id) AS entitlement_users,
         count(DISTINCT e.user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = e.user_id
           )
         ) AS roster_entitlement_users,
         min(e.gross) AS min_gross,
         max(e.gross) AS max_gross,
         round(COALESCE(sum(e.gross), 0), 2) AS gross_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id = p_tournament_id
     AND e.entitlement_kind = 'wallet_charge'
     AND e.charge_category = 'tournament_buyin'
), payments AS (
  SELECT count(w.id) AS payment_count,
         count(DISTINCT w.user_id) AS paid_users,
         count(DISTINCT w.user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = w.user_id
           )
         ) AS roster_paid_users,
         min(w.amount) AS min_amount,
         max(w.amount) AS max_amount,
         round(COALESCE(sum(w.amount), 0), 2) AS payment_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit'
     AND w.category = 'tournament_buyin'
), charge_evidence AS (
  SELECT count(l.id) AS source_charge_count,
         count(l.id) FILTER (
           WHERE l.tournament_id = e.tournament_id
             AND l.club_id = e.refund_wallet_club_id
             AND l.from_type = 'player_wallet'
             AND l.from_entity_id = e.user_id
             AND l.to_type = 'prize_liability'
             AND l.to_entity_id = e.tournament_id
             AND l.category = e.charge_category
             AND l.amount = e.gross
         ) AS exact_source_charges
    FROM public.tournament_refund_entitlements e
    LEFT JOIN public.chip_ledger l ON l.id = e.source_ledger_id
   WHERE e.tournament_id = p_tournament_id
     AND e.entitlement_kind = 'wallet_charge'
     AND e.charge_category = 'tournament_buyin'
), reserve_evidence AS (
  SELECT count(sr.id) FILTER (WHERE sr.kind = 'contribution') AS contribution_count,
         count(sr.id) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_count,
         (array_agg(sr.id ORDER BY sr.created_at, sr.id)
           FILTER (WHERE sr.kind = 'contribution'))[1] AS contribution_id,
         (array_agg(sr.id ORDER BY sr.created_at, sr.id)
           FILTER (WHERE sr.kind = 'jackpot_draw'))[1] AS draw_id,
         (array_agg(sr.club_id ORDER BY sr.created_at, sr.id)
           FILTER (WHERE sr.kind = 'contribution'))[1] AS contribution_owner,
         (array_agg(sr.club_id ORDER BY sr.created_at, sr.id)
           FILTER (WHERE sr.kind = 'jackpot_draw'))[1] AS draw_owner,
         min(sr.amount) FILTER (WHERE sr.kind = 'contribution') AS contribution_amount,
         min(sr.buy_in) FILTER (WHERE sr.kind = 'contribution') AS contribution_buy_in,
         min(sr.seats) FILTER (WHERE sr.kind = 'contribution') AS contribution_seats,
         min(sr.house_rake) FILTER (WHERE sr.kind = 'contribution') AS contribution_rake,
         min(sr.balance_after) FILTER (WHERE sr.kind = 'contribution')
           AS contribution_balance,
         min(sr.amount) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_amount,
         min(sr.buy_in) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_buy_in,
         min(sr.seats) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_seats,
         min(sr.multiplier) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_multiplier,
         min(sr.balance_after) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_balance,
         min(sr.created_at) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_created_at
    FROM public.spin_reserve_ledger sr
   WHERE sr.tournament_id = p_tournament_id
     AND sr.kind IN ('contribution', 'jackpot_draw')
), reserve_pool AS (
  SELECT count(p.id) AS pool_count,
         (array_agg(p.id ORDER BY p.id))[1] AS pool_id
    FROM public.spin_bonus_pools p
    CROSS JOIN reserve_evidence r
   WHERE p.club_id = r.draw_owner
), journals AS (
  SELECT count(l.id) FILTER (WHERE l.category = 'spin_entry') AS entry_journal_count,
         count(l.id) FILTER (WHERE l.category = 'spin_prize') AS draw_journal_count,
         count(l.id) FILTER (
           WHERE l.category = 'spin_entry'
             AND l.from_type = 'prize_liability'
             AND l.from_entity_id = p_tournament_id
             AND l.to_type = 'spin_reserve'
             AND l.to_entity_id = p.pool_id
             AND l.amount = c.expected_reserve_in
             AND l.post_to_balance IS NOT DISTINCT FROM r.contribution_balance
         ) AS exact_entry_journals,
         count(l.id) FILTER (
           WHERE l.category = 'spin_prize'
             AND l.from_type = 'spin_reserve'
             AND l.from_entity_id = p.pool_id
             AND l.to_type = 'prize_liability'
             AND l.to_entity_id = p_tournament_id
             AND l.amount = round(-r.draw_amount, 2)
             AND l.post_from_balance IS NOT DISTINCT FROM r.draw_balance
         ) AS exact_draw_journals
    FROM contract c
    CROSS JOIN reserve_evidence r
    CROSS JOIN reserve_pool p
    LEFT JOIN public.chip_ledger l
      ON l.tournament_id = p_tournament_id
     AND l.category IN ('spin_entry', 'spin_prize')
   GROUP BY c.expected_reserve_in, r.contribution_balance, r.draw_amount,
            r.draw_balance, p.pool_id
), table_evidence AS (
  SELECT count(t.id) AS table_count,
         count(t.id) FILTER (WHERE t.status IN ('running', 'waiting')) AS open_tables,
         (array_agg(t.id ORDER BY t.created_at, t.id)
           FILTER (WHERE t.status IN ('running', 'waiting')))[1] AS table_id,
         min(t.current_players) FILTER (WHERE t.status IN ('running', 'waiting'))
           AS current_players,
         min(t.max_players) FILTER (WHERE t.status IN ('running', 'waiting'))
           AS table_capacity
    FROM public.tables t
   WHERE t.tournament_id = p_tournament_id
), live_seats AS (
  SELECT count(s.id) AS live_seats,
         count(DISTINCT s.user_id) AS live_users,
         count(DISTINCT (s.table_id, s.seat_number)) AS live_coordinates,
         count(DISTINCT s.table_id) AS live_tables,
         count(s.id) FILTER (
           WHERE s.stack IS NULL
              OR s.stack::text IN ('NaN', 'Infinity', '-Infinity')
              OR s.stack < 0
         ) AS invalid_live_stacks,
         count(s.id) FILTER (WHERE s.stack > 0) AS positive_live_seats,
         count(s.id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = s.user_id
                AND tp.status = 'playing'
                AND tp.table_id = s.table_id
                AND tp.seat_number = s.seat_number
                AND tp.chips IS NOT DISTINCT FROM s.stack
           )
         ) AS matching_active_seats,
         COALESCE(sum(s.stack), 0) AS seat_chips
    FROM public.table_seats s
    JOIN public.tables t ON t.id = s.table_id
   WHERE t.tournament_id = p_tournament_id
     AND s.left_at IS NULL
), vacated_seat AS (
  SELECT count(DISTINCT tp.user_id) AS vacated_eliminated_players
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'eliminated'
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables t ON t.id = s.table_id
        WHERE t.tournament_id = p_tournament_id
          AND s.user_id = tp.user_id
          AND s.left_at IS NOT NULL
     )
), hands AS (
  SELECT count(h.id) FILTER (WHERE h.created_at >= r.draw_created_at) AS hand_count
    FROM reserve_evidence r
    LEFT JOIN public.hand_history h
      ON h.tournament_id = p_tournament_id
    LEFT JOIN public.tables t
      ON t.id = h.table_id
     AND t.tournament_id = p_tournament_id
   WHERE h.id IS NULL OR t.id IS NOT NULL
), escrow AS (
  SELECT count(e.tournament_id) AS escrow_count,
         min(e.reserve_out) AS reserve_out,
         min(e.reserve_in) AS escrow_reserve_in,
         min(e.prize_balance) AS prize_balance
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
), facts AS (
  SELECT c.*,
         r.*,
         e.*,
         pay.*,
         charge.*,
         re.*,
         pool.*,
         j.*,
         te.*,
         ls.*,
         vs.*,
         h.*,
         esc.*,
         (c.starting_chips * 3)::numeric AS funding_floor
    FROM (SELECT 1) seed
    LEFT JOIN contract c ON true
    CROSS JOIN roster r
    CROSS JOIN entitlements e
    CROSS JOIN payments pay
    CROSS JOIN charge_evidence charge
    CROSS JOIN reserve_evidence re
    CROSS JOIN reserve_pool pool
    CROSS JOIN journals j
    CROSS JOIN table_evidence te
    CROSS JOIN live_seats ls
    CROSS JOIN vacated_seat vs
    CROSS JOIN hands h
    CROSS JOIN escrow esc
), verdict AS (
  SELECT f.*,
         (f.id IS NOT NULL
          AND f.status = 'REGISTERING'
          AND (f.variant = 'spin' OR f.tournament_type = 'SPIN')
          AND f.variant <> 'sng'
          AND f.tournament_type <> 'SNG'
          AND f.max_players = 3
          AND f.buy_in IS NOT NULL
          AND f.buy_in::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND f.buy_in > 0
          AND f.starting_chips IS NOT NULL
          AND f.starting_chips > 0
          AND f.roster_count = 3
          AND f.roster_users = 3
          AND f.active_players = 2
          AND f.positive_active_players = 2
          AND f.eliminated_players = 1
          AND f.other_players = 0
          AND f.invalid_stacks = 0
          AND f.zero_stack_eliminations = 1
          AND f.roster_chips = f.funding_floor
          AND f.entitlement_count = 3
          AND f.entitlement_users = 3
          AND f.roster_entitlement_users = 3
          AND f.min_gross = f.buy_in
          AND f.max_gross = f.buy_in
          AND f.gross_total = round(f.buy_in * 3, 2)
          AND f.payment_count = 3
          AND f.paid_users = 3
          AND f.roster_paid_users = 3
          AND f.min_amount = f.buy_in
          AND f.max_amount = f.buy_in
          AND f.payment_total = round(f.buy_in * 3, 2)
          AND f.source_charge_count = 3
          AND f.exact_source_charges = 3
          AND f.contribution_count = 1
          AND f.draw_count = 1
          AND f.contribution_owner IS NOT NULL
          AND f.contribution_owner = f.draw_owner
          AND f.contribution_amount = f.expected_reserve_in
          AND f.contribution_buy_in = f.buy_in
          AND f.contribution_seats = 3
          AND f.contribution_rake = f.expected_house_rake
          AND f.draw_amount IS NOT NULL
          AND round(-f.draw_amount, 2) = round(f.buy_in * f.draw_multiplier, 2)
          AND f.draw_buy_in = f.buy_in
          AND f.draw_seats = 3
          AND f.draw_multiplier > 0
          AND f.pool_count = 1
          AND f.entry_journal_count = 1
          AND f.draw_journal_count = 1
          AND f.exact_entry_journals = 1
          AND f.exact_draw_journals = 1
          AND f.escrow_count = 1
          AND f.reserve_out = f.expected_reserve_in
          AND f.escrow_reserve_in = round(-f.draw_amount, 2)
          AND f.prize_balance = round(-f.draw_amount, 2)
          AND f.table_count = 1
          AND f.open_tables = 1
          AND f.current_players = 2
          AND f.table_capacity = 3
          AND f.live_seats = 2
          AND f.live_users = 2
          AND f.live_coordinates = 2
          AND f.live_tables = 1
          AND f.invalid_live_stacks = 0
          AND f.positive_live_seats = 2
          AND f.matching_active_seats = 2
          AND f.seat_chips = f.funding_floor
          AND f.seat_chips = f.roster_chips
          AND f.vacated_eliminated_players = 1
          AND f.hand_count >= 1) AS ok
    FROM facts f
)
SELECT CASE WHEN v.ok THEN
  jsonb_build_object(
    'ok', true,
    'recovery_mode', 'played_vacated_spin',
    'tournament_id', p_tournament_id,
    'original_field', 3,
    'active_field', 2,
    'eliminated_players', v.eliminated_players,
    'paid_users', v.paid_users,
    'entitlement_users', v.entitlement_users,
    'live_seats', v.live_seats,
    'hand_count', v.hand_count,
    'funding_floor', v.funding_floor,
    'roster_chips', v.roster_chips,
    'seat_chips', v.seat_chips,
    'original_player_ids', to_jsonb(v.original_player_ids),
    'active_player_ids', to_jsonb(v.active_player_ids)
  )
ELSE
  jsonb_build_object(
    'ok', false,
    'reason', 'played_spin_launch_recovery_unproven',
    'tournament_id', p_tournament_id
  )
END
  FROM verdict v;
$function$;
