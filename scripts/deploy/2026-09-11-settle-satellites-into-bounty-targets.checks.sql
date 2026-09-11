-- Read-only checks for 2026-09-11-settle-satellites-into-bounty-targets.sql.
-- SELECT and STABLE functions only.

-- ─── PREFLIGHT 0: not inside the :50-:03 break window.
SELECT now() AT TIME ZONE 'UTC' AS utc_now,
       extract(minute FROM now() AT TIME ZONE 'UTC') NOT BETWEEN 50 AND 59
       AND extract(minute FROM now() AT TIME ZONE 'UTC') NOT BETWEEN 0 AND 3 AS outside_break_window;

-- ─── PREFLIGHT 1: the three numbers to paste into the ruling.
WITH refused AS (
  SELECT t.id FROM public.tournaments t
   WHERE t.is_bounty IS DISTINCT FROM false OR t.is_pko IS DISTINCT FROM false
      OR t.is_mystery_bounty IS DISTINCT FROM false OR t.is_premium_spin IS DISTINCT FROM false
      OR lower(COALESCE(t.variant,'')) = 'spin' OR upper(COALESCE(t.tournament_type,'')) = 'SPIN'
), sats AS (
  SELECT s.id, s.status, s.started_at,
         (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = s.id) AS n,
         (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = s.id AND tp.status = 'playing') AS live,
         (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = s.id AND tp.status = 'eliminated') AS elim
    FROM public.tournaments s
   WHERE COALESCE(s.satellite_target_id, s.satellite_target) IN (SELECT id FROM refused)
     AND upper(COALESCE(s.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')
)
SELECT count(*) FILTER (WHERE status = 'RUNNING' AND n = 2 AND live = 1 AND elim = 1) AS c_expected_settle,
       count(*) FILTER (WHERE upper(status) IN ('REGISTERING','ANNOUNCED') AND started_at IS NULL AND n = 0) AS c_expected_cancel,
       count(*) - count(*) FILTER (WHERE status = 'RUNNING' AND n = 2 AND live = 1 AND elim = 1)
                - count(*) FILTER (WHERE upper(status) IN ('REGISTERING','ANNOUNCED') AND started_at IS NULL AND n = 0) AS c_expected_in_play,
       count(*) FILTER (WHERE upper(status) NOT IN ('RUNNING','REGISTERING','ANNOUNCED')) AS must_be_zero_unexpected_state
  FROM sats;

-- ─── PREFLIGHT 2: every decided satellite, exact shape (all rows must say true).
SELECT s.id, COALESCE(s.satellite_target_id, s.satellite_target) AS target,
       w.username AS winner, w.user_id AS winner_id, b.username AS bubble, b.user_id AS bubble_id,
       s.prize_pool = 95.00 AND s.total_rake = 5.00 AND s.prize_pool_finalized AS pool_ok,
       e.prize_balance = 95.00 AND e.fee_balance = 5.00 AND e.bounty_balance = 0 AND e.closed_at IS NULL AS escrow_ok,
       NOT EXISTS (SELECT 1 FROM public.tournament_satellite_settlements h WHERE h.tournament_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id = s.id) AS untouched,
       NOT EXISTS (SELECT 1 FROM public.tournament_players x
                    WHERE x.tournament_id = COALESCE(s.satellite_target_id, s.satellite_target)
                      AND x.user_id = w.user_id) AS winner_not_in_target,
       (SELECT p.is_horse FROM public.profiles p WHERE p.id = w.user_id) AS winner_is_horse,
       public.fn_concurrent_game_load(w.user_id, NULL, NULL, COALESCE(s.satellite_target_id, s.satellite_target)) AS winner_game_load
  FROM public.tournaments s
  JOIN public.tournament_players w ON w.tournament_id = s.id AND w.status = 'playing'
  JOIN public.tournament_players b ON b.tournament_id = s.id AND b.status = 'eliminated'
  JOIN public.tournament_escrow e ON e.tournament_id = s.id
 WHERE s.satellite_target_id IN ('e9541c66-1238-438f-bc7e-c01e45a45f81','8171f9f6-1243-4d51-ac4b-9acabce110dc')
   AND s.status = 'RUNNING'
 ORDER BY s.id;

-- ─── PREFLIGHT 3: both targets not started, contract as probed, escrow agrees.
SELECT t.id, t.status, t.start_time, t.started_at, t.current_players,
       t.buy_in_amount, t.buy_in_fee, t.bounty_amount, t.is_bounty, t.is_pko,
       t.prize_pool = e.prize_balance AND t.bounty_pool = e.bounty_balance AND t.total_rake = e.fee_balance AS escrow_agrees
  FROM public.tournaments t JOIN public.tournament_escrow e ON e.tournament_id = t.id
 WHERE t.id IN ('e9541c66-1238-438f-bc7e-c01e45a45f81','8171f9f6-1243-4d51-ac4b-9acabce110dc');

-- ─── POSTFLIGHT A: nothing into a refused target is left decided or unstarted-empty.
SELECT s.id, s.status,
       (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = s.id AND tp.status = 'playing') AS live
  FROM public.tournaments s
 WHERE s.satellite_target_id IN ('e9541c66-1238-438f-bc7e-c01e45a45f81','8171f9f6-1243-4d51-ac4b-9acabce110dc')
   AND s.status NOT IN ('COMPLETED','CANCELLED');   -- expect exactly c_expected_in_play rows

-- ─── POSTFLIGHT B: every ruling header is a closed cash receipt at zero escrow.
SELECT h.tournament_id, h.winner_id, h.seat_count, h.cash_ticket_count, h.remainder, h.pool,
       t.status, e.prize_balance, e.bounty_balance, e.fee_balance, e.close_note,
       (SELECT count(*) FROM public.tournament_payouts p WHERE p.tournament_id = h.tournament_id) AS payouts,
       rs.amount AS rake, rs.attributed_at IS NOT NULL AS rake_attributed
  FROM public.tournament_satellite_settlements h
  JOIN public.tournaments t ON t.id = h.tournament_id
  JOIN public.tournament_escrow e ON e.tournament_id = h.tournament_id
  JOIN public.tournament_rake_settlements rs ON rs.tournament_id = h.tournament_id
 WHERE h.target_id IN ('e9541c66-1238-438f-bc7e-c01e45a45f81','8171f9f6-1243-4d51-ac4b-9acabce110dc')
 ORDER BY h.settled_at, h.tournament_id;

-- ─── POSTFLIGHT C: targets gained exactly one funded entry per seated winner.
SELECT t.id, t.current_players, t.prize_pool, t.bounty_pool, t.total_rake,
       e.gross_in, e.bounty_in, e.prize_balance, e.bounty_balance, e.fee_balance,
       t.prize_pool = e.prize_balance AND t.bounty_pool = e.bounty_balance AND t.total_rake = e.fee_balance AS escrow_agrees,
       (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = t.id AND tp.current_bounty = 35.00) AS funded_heads
  FROM public.tournaments t JOIN public.tournament_escrow e ON e.tournament_id = t.id
 WHERE t.id IN ('e9541c66-1238-438f-bc7e-c01e45a45f81','8171f9f6-1243-4d51-ac4b-9acabce110dc');

-- ─── POSTFLIGHT D: the engine log goes quiet within a minute
--   ssh ... 'docker logs --since 2m club-arena-engine 2>&1 | grep -c "unsupported bounty or Spin"'  -> 0
