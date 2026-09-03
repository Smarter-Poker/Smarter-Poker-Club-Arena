-- ============================================================================
-- 20260823_02_member_fee_rollup
--
-- Dan 2026-08-23: the members roster must show each member's FEES (total rake
-- generated), and Member Management must show Hands / Total Fee / MTT Fee /
-- Total Winnings / MTT Winnings over Overall, 7 Days, or a custom date range.
-- Player Statistics needs VPIP / PFR / 3-Bet / C-Bet over the same ranges.
--
-- WHY A ROLLUP AND NOT A LIVE QUERY.
-- club_members.total_rake_paid is dead: 76 rows of 1,500 are non-zero and
-- club_members.hands_played is zero for every row in the database. The truth
-- lives in hand_history -- 1.5M rows over nine days, with the per-hand player
-- list, the action log and the rake in three jsonb columns. Aggregating that
-- per player on every page load is not something a roster can do; a single
-- unfiltered pass already exceeds the statement timeout.
--
-- So: one row per (user, day, variant, cash/MTT). ~1k users x 9 days x a
-- handful of variants is tens of thousands of rows, and every question the
-- three screens ask -- a single day, the last seven, an arbitrary range,
-- lifetime -- is a SUM over a date range against a primary key. Daily grain is
-- the smallest unit any of the screens can select, so nothing is lost.
--
-- HOW THE FEE IS SPLIT.
-- A hand's rake is apportioned by what each player actually put in the pot,
-- summed from hand_history.actions. That is the same rule the club settles on,
-- so a member's Total Fee here equals the rake their play generated. Hands
-- whose action log is missing fall back to an even split across the seats --
-- recorded rather than silently dropped, because dropping them would understate
-- the club's own rake total.
--
-- HOW IT STAYS CURRENT.
-- Strictly forward from a watermark, additively. Re-running is safe because the
-- watermark only ever moves forward, and an advisory lock means two callers
-- cannot process the same window twice. ca_club_members_overview nudges it at
-- most once every two minutes, so the numbers stay live without new cron infra.
-- ============================================================================

-- ── The rollup ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.member_fee_rollup (
  user_id         uuid    NOT NULL,
  day             date    NOT NULL,
  game_variant    text    NOT NULL DEFAULT 'unknown',
  is_mtt          boolean NOT NULL DEFAULT false,

  hands           bigint  NOT NULL DEFAULT 0,
  fees            numeric NOT NULL DEFAULT 0,   -- rake this player generated
  contributed     numeric NOT NULL DEFAULT 0,   -- chips put into pots
  won             numeric NOT NULL DEFAULT 0,   -- chips taken out of pots
  wins            bigint  NOT NULL DEFAULT 0,   -- hands won

  vpip_hands      bigint  NOT NULL DEFAULT 0,
  pfr_hands       bigint  NOT NULL DEFAULT 0,
  three_bet_hands bigint  NOT NULL DEFAULT 0,
  three_bet_opps  bigint  NOT NULL DEFAULT 0,
  cbet_hands      bigint  NOT NULL DEFAULT 0,
  cbet_opps       bigint  NOT NULL DEFAULT 0,

  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, game_variant, is_mtt)
);

CREATE INDEX IF NOT EXISTS idx_member_fee_rollup_user_day
  ON public.member_fee_rollup (user_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_member_fee_rollup_day
  ON public.member_fee_rollup (day DESC);

ALTER TABLE public.member_fee_rollup ENABLE ROW LEVEL SECURITY;

-- Read-only to signed-in users; every write goes through the SECURITY DEFINER
-- refresher below, never from a client.
DROP POLICY IF EXISTS member_fee_rollup_read ON public.member_fee_rollup;
CREATE POLICY member_fee_rollup_read ON public.member_fee_rollup
  FOR SELECT TO authenticated USING (true);

-- ── The watermark ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.member_fee_rollup_state (
  id           boolean     PRIMARY KEY DEFAULT true CHECK (id),
  watermark    timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z',
  last_run_at  timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z',
  hands_seen   bigint      NOT NULL DEFAULT 0,
  hands_no_actions bigint  NOT NULL DEFAULT 0
);
INSERT INTO public.member_fee_rollup_state (id) VALUES (true) ON CONFLICT DO NOTHING;

ALTER TABLE public.member_fee_rollup_state ENABLE ROW LEVEL SECURITY;

-- ── The refresher ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_refresh_member_fee_rollup(p_batch_hands int DEFAULT 40000)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from      timestamptz;
  v_to        timestamptz;
  v_processed bigint := 0;
  v_rows      bigint := 0;
BEGIN
  -- Two refreshers must never share a window; the second simply leaves.
  IF NOT pg_try_advisory_xact_lock(hashtext('member_fee_rollup')) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'another refresh is running');
  END IF;

  SELECT watermark INTO v_from FROM public.member_fee_rollup_state WHERE id;
  IF v_from IS NULL THEN
    INSERT INTO public.member_fee_rollup_state (id) VALUES (true) ON CONFLICT DO NOTHING;
    v_from := '2000-01-01T00:00:00Z'::timestamptz;
  END IF;

  -- Upper bound: the timestamp of the p_batch_hands-th hand after the mark.
  -- Bounding by COUNT rather than by clock keeps every batch the same size no
  -- matter how busy the tables were.
  SELECT max(created_at) INTO v_to
  FROM (
    SELECT created_at FROM public.hand_history
    WHERE created_at > v_from
    ORDER BY created_at ASC
    LIMIT p_batch_hands
  ) s;

  IF v_to IS NULL THEN
    UPDATE public.member_fee_rollup_state SET last_run_at = now() WHERE id;
    RETURN jsonb_build_object('processed', 0, 'watermark', v_from, 'caught_up', true);
  END IF;

  WITH h AS (
    SELECT hh.id,
           (hh.created_at AT TIME ZONE 'UTC')::date            AS day,
           coalesce(nullif(lower(hh.game_variant), ''), 'unknown') AS variant,
           (hh.tournament_id IS NOT NULL)                      AS is_mtt,
           coalesce(hh.rake_amount, 0)                         AS rake,
           hh.players,
           coalesce(hh.winners, '[]'::jsonb)                   AS winners,
           coalesce(hh.actions, '[]'::jsonb)                   AS actions
    FROM public.hand_history hh
    WHERE hh.created_at > v_from
      AND hh.created_at <= v_to
      AND hh.players IS NOT NULL
      AND jsonb_typeof(hh.players) = 'array'
  ),
  -- Everyone dealt into the hand. This is the row set that defines "hands".
  seat AS (
    SELECT h.id AS hand_id, h.day, h.variant, h.is_mtt, h.rake,
           (pl->>'userId')::uuid AS uid
    FROM h, LATERAL jsonb_array_elements(h.players) pl
    WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  seat_counts AS (
    SELECT hand_id, count(*) AS seats FROM seat GROUP BY 1
  ),
  act AS (
    SELECT h.id AS hand_id,
           (a->>'userId')::uuid                       AS uid,
           lower(coalesce(a->>'stage', ''))           AS stage,
           lower(coalesce(a->>'action', ''))          AS action,
           coalesce((a->>'amount')::numeric, 0)       AS amount,
           coalesce((a->>'timestamp')::bigint, 0)     AS ts
    FROM h, LATERAL jsonb_array_elements(h.actions) a
    WHERE a->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  contrib AS (
    SELECT hand_id, uid,
           sum(amount)                                                        AS amt,
           count(*) FILTER (WHERE stage = 'preflop'
                              AND action IN ('call','bet','raise'))           AS vpip_acts,
           count(*) FILTER (WHERE stage = 'preflop' AND action = 'raise')     AS pfr_acts,
           count(*) FILTER (WHERE stage = 'flop'    AND action = 'bet')       AS flop_bets
    FROM act GROUP BY 1, 2
  ),
  hand_totals AS (
    SELECT hand_id, sum(amt) AS tot FROM contrib GROUP BY 1
  ),
  -- Preflop raises in order. The first is the opener; anything after it is a
  -- 3-bet (or a 4-bet, which the industry still counts in the 3-bet column).
  preflop_raises AS (
    SELECT hand_id, uid, ts,
           row_number() OVER (PARTITION BY hand_id ORDER BY ts, uid) AS rn
    FROM act WHERE stage = 'preflop' AND action = 'raise'
  ),
  three_bets AS (
    SELECT DISTINCT hand_id, uid FROM preflop_raises WHERE rn >= 2
  ),
  -- A 3-bet opportunity is facing an open: someone raised before you acted.
  three_bet_opps AS (
    SELECT DISTINCT a.hand_id, a.uid
    FROM act a
    JOIN preflop_raises o ON o.hand_id = a.hand_id AND o.rn = 1
    WHERE a.stage = 'preflop' AND a.ts > o.ts AND a.uid <> o.uid
  ),
  opener AS (
    SELECT hand_id, uid FROM preflop_raises WHERE rn = 1
  ),
  flop_seen AS (
    SELECT DISTINCT hand_id FROM act WHERE stage = 'flop'
  ),
  cbet_opps AS (
    SELECT o.hand_id, o.uid FROM opener o JOIN flop_seen f ON f.hand_id = o.hand_id
  ),
  cbets AS (
    SELECT co.hand_id, co.uid
    FROM cbet_opps co
    JOIN contrib c ON c.hand_id = co.hand_id AND c.uid = co.uid AND c.flop_bets > 0
  ),
  won AS (
    SELECT h.id AS hand_id, (w->>'userId')::uuid AS uid,
           sum(coalesce((w->>'amount')::numeric, 0)) AS amount
    FROM h, LATERAL jsonb_array_elements(h.winners) w
    WHERE w->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    GROUP BY 1, 2
  ),
  per_hand AS (
    SELECT
      s.uid, s.day, s.variant, s.is_mtt,
      -- Rake apportioned by what this player actually put in. When the action
      -- log is absent (tot is null or zero) fall back to an even split, so the
      -- club's rake still adds up across its members.
      CASE
        WHEN ht.tot IS NULL OR ht.tot = 0 THEN s.rake / NULLIF(sc.seats, 0)
        ELSE s.rake * (coalesce(c.amt, 0) / ht.tot)
      END                                             AS fee,
      coalesce(c.amt, 0)                              AS contributed,
      coalesce(w.amount, 0)                           AS won,
      (w.amount IS NOT NULL AND w.amount > 0)         AS is_win,
      (coalesce(c.vpip_acts, 0) > 0)                  AS is_vpip,
      (coalesce(c.pfr_acts, 0) > 0)                   AS is_pfr,
      (tb.uid IS NOT NULL)                            AS is_three_bet,
      (tbo.uid IS NOT NULL)                           AS has_three_bet_opp,
      (cb.uid IS NOT NULL)                            AS is_cbet,
      (cbo.uid IS NOT NULL)                           AS has_cbet_opp
    FROM seat s
    JOIN seat_counts sc      ON sc.hand_id = s.hand_id
    LEFT JOIN contrib c      ON c.hand_id  = s.hand_id AND c.uid   = s.uid
    LEFT JOIN hand_totals ht ON ht.hand_id = s.hand_id
    LEFT JOIN won w          ON w.hand_id  = s.hand_id AND w.uid   = s.uid
    LEFT JOIN three_bets tb  ON tb.hand_id = s.hand_id AND tb.uid  = s.uid
    LEFT JOIN three_bet_opps tbo ON tbo.hand_id = s.hand_id AND tbo.uid = s.uid
    LEFT JOIN cbets cb       ON cb.hand_id = s.hand_id AND cb.uid  = s.uid
    LEFT JOIN cbet_opps cbo  ON cbo.hand_id = s.hand_id AND cbo.uid = s.uid
  ),
  agg AS (
    SELECT uid, day, variant, is_mtt,
           count(*)                                    AS hands,
           sum(coalesce(fee, 0))                       AS fees,
           sum(contributed)                            AS contributed,
           sum(won)                                    AS won,
           count(*) FILTER (WHERE is_win)              AS wins,
           count(*) FILTER (WHERE is_vpip)             AS vpip_hands,
           count(*) FILTER (WHERE is_pfr)              AS pfr_hands,
           count(*) FILTER (WHERE is_three_bet)        AS three_bet_hands,
           count(*) FILTER (WHERE has_three_bet_opp)   AS three_bet_opps,
           count(*) FILTER (WHERE is_cbet)             AS cbet_hands,
           count(*) FILTER (WHERE has_cbet_opp)        AS cbet_opps
    FROM per_hand
    GROUP BY 1, 2, 3, 4
  )
  INSERT INTO public.member_fee_rollup AS r (
    user_id, day, game_variant, is_mtt,
    hands, fees, contributed, won, wins,
    vpip_hands, pfr_hands, three_bet_hands, three_bet_opps, cbet_hands, cbet_opps,
    updated_at
  )
  SELECT uid, day, variant, is_mtt,
         hands, fees, contributed, won, wins,
         vpip_hands, pfr_hands, three_bet_hands, three_bet_opps, cbet_hands, cbet_opps,
         now()
  FROM agg
  ON CONFLICT (user_id, day, game_variant, is_mtt) DO UPDATE SET
    hands           = r.hands           + EXCLUDED.hands,
    fees            = r.fees            + EXCLUDED.fees,
    contributed     = r.contributed     + EXCLUDED.contributed,
    won             = r.won             + EXCLUDED.won,
    wins            = r.wins            + EXCLUDED.wins,
    vpip_hands      = r.vpip_hands      + EXCLUDED.vpip_hands,
    pfr_hands       = r.pfr_hands       + EXCLUDED.pfr_hands,
    three_bet_hands = r.three_bet_hands + EXCLUDED.three_bet_hands,
    three_bet_opps  = r.three_bet_opps  + EXCLUDED.three_bet_opps,
    cbet_hands      = r.cbet_hands      + EXCLUDED.cbet_hands,
    cbet_opps       = r.cbet_opps       + EXCLUDED.cbet_opps,
    updated_at      = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(*) INTO v_processed
  FROM public.hand_history
  WHERE created_at > v_from AND created_at <= v_to;

  UPDATE public.member_fee_rollup_state
  SET watermark   = v_to,
      last_run_at = now(),
      hands_seen  = hands_seen + v_processed
  WHERE id;

  RETURN jsonb_build_object(
    'processed',  v_processed,
    'rollup_rows', v_rows,
    'from',       v_from,
    'watermark',  v_to,
    'caught_up',  v_processed < p_batch_hands
  );
END;
$$;

COMMENT ON FUNCTION public.fn_refresh_member_fee_rollup(int) IS
  'Advances member_fee_rollup from its watermark by up to p_batch_hands hands. Forward-only and additive, so repeated calls cannot double-count.';

REVOKE ALL ON FUNCTION public.fn_refresh_member_fee_rollup(int) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_refresh_member_fee_rollup(int) TO authenticated, service_role;
GRANT SELECT ON public.member_fee_rollup TO authenticated, service_role;
