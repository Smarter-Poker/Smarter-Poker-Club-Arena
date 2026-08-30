-- ═══════════════════════════════════════════════════════════════════════════
--  DOES THE MONEY ADD UP? Read-only. Safe against production.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every money bug found on 2026-08-29/30 was found by ONE of these queries,
-- and none of them were found by reading code first. That is the argument for
-- this file existing: the ledger tells you what happened; the source only
-- tells you what somebody intended.
--
-- What each check has already caught, so nobody dismisses a red result:
--
--   1  a 513.00 prize pool paying 513.01, twice a day, because the engine
--      computed places in binary floats and the reconciler then "topped up"
--      the cent it disagreed about
--   2  bounty pools paying out MORE than they held -- 140.60 in one afternoon
--      -- because two payers both sized the pool from a stale counter instead
--      of the ledger
--   3  3,158 knockouts paid to the champion instead of the knocker
--   4  38 events, 11,238.80, owed to players and never paid, hidden because
--      the sweep's window filtered on a column nothing maintains
--
-- RUN ORDER DOES NOT MATTER. Every query is independent and read-only.

-- ── 1. TOURNAMENT PRIZES: the places must sum to the pool, exactly ────────
-- Expect wrong = 0. A non-zero here is either a payout bug or a pool that
-- moved after the places were priced.
WITH ev AS (
  SELECT id, prize_pool FROM tournaments
   WHERE status = 'COMPLETED' AND COALESCE(prize_pool,0) > 0
     AND COALESCE(variant,'') <> 'satellite'
     AND ended_at > now() - interval '24 hours'
), paid AS (
  SELECT wt.related_entity_id AS tid,
         round(SUM(CASE WHEN lower(wt.type)='debit' THEN -abs(wt.amount) ELSE wt.amount END), 2) AS paid
    FROM wallet_transactions wt
   WHERE wt.category = 'prize' AND wt.related_entity_id IN (SELECT id FROM ev)
   GROUP BY 1
)
SELECT count(*) AS events,
       count(*) FILTER (WHERE COALESCE(p.paid,0) = e.prize_pool) AS exact_to_the_cent,
       count(*) FILTER (WHERE COALESCE(p.paid,0) <> e.prize_pool) AS wrong,
       round(COALESCE(SUM(COALESCE(p.paid,0) - e.prize_pool),0), 2) AS net_error
  FROM ev e LEFT JOIN paid p ON p.tid = e.id;

-- ── 2. BOUNTY POOLS: never pay out more than was funded ───────────────────
-- Expect overpaid = 0. Chips created from nothing is the worst failure on the
-- platform, and it balanced its own counter for four hours before anyone
-- noticed, so this asks the LEDGER.
--
-- `underpaid` is the tolerable direction and usually is not a bug at all: the
-- champion is never knocked out, so their own head is legitimately unclaimed
-- and is swept to them. On a healthy event pool == paid exactly.
WITH b AS (
  SELECT t.id, t.name, COALESCE(t.bounty_pool,0) AS pool,
    (SELECT round(COALESCE(SUM(CASE WHEN lower(w.type)='debit' THEN -abs(w.amount) ELSE w.amount END),0), 2)
       FROM wallet_transactions w
      WHERE w.category = 'bounty' AND w.related_entity_id = t.id) AS paid
    FROM tournaments t
   WHERE t.status = 'COMPLETED' AND COALESCE(t.bounty_pool,0) > 0
     AND t.ended_at > now() - interval '24 hours'
)
SELECT count(*) AS bounty_events,
       count(*) FILTER (WHERE paid > pool + 0.005) AS overpaid,
       round(COALESCE(SUM(paid - pool) FILTER (WHERE paid > pool + 0.005),0), 2) AS chips_minted,
       count(*) FILTER (WHERE paid < pool - 0.005) AS underpaid,
       round(COALESCE(SUM(pool - paid) FILTER (WHERE paid < pool - 0.005),0), 2) AS left_in_pool
  FROM b;

-- ── 3. BOUNTIES REACH THE KNOCKER, not just the champion ─────────────────
-- Expect knocker_payments to track the knockout count. Between 18 and 27
-- August it was ZERO on 85 events: 3,158 knockouts paid nothing while the
-- whole pool was swept to the winner as "unclaimed". Every pool balanced, so
-- check 2 above stayed silent throughout -- which is exactly why this one
-- exists separately.
SELECT left(t.name, 30) AS name, t.ended_at::date AS day,
       (SELECT count(*) FROM tournament_players tp
         WHERE tp.tournament_id = t.id AND tp.position IS NOT NULL AND tp.position > 1) AS knockouts,
       (SELECT count(*) FROM wallet_transactions w
         WHERE w.category = 'bounty' AND w.related_entity_id = t.id
           AND w.description NOT LIKE '%champion%') AS knocker_payments
  FROM tournaments t
 WHERE t.status = 'COMPLETED' AND COALESCE(t.bounty_pool,0) > 0
   AND t.ended_at > now() - interval '24 hours'
 ORDER BY t.ended_at DESC
 LIMIT 20;

-- ── 4. CASH HANDS: pot = rake + winners + jackpot drop ───────────────────
-- Expect paid_more_than_pot = 0. A hand paying LESS is normally the Bad Beat
-- Jackpot drop, which is real funding rather than a leak -- check 5 proves
-- that per hand rather than assuming it.
WITH h AS (
  SELECT id, pot_size, COALESCE(rake_amount,0) AS rake, winners
    FROM hand_history
   WHERE created_at > now() - interval '45 minutes'
     AND winners IS NOT NULL AND jsonb_typeof(winners) = 'array'
     AND jsonb_array_length(winners) > 0
   LIMIT 4000
), w AS (
  SELECT h.id, h.pot_size, h.rake,
         (SELECT COALESCE(SUM((e->>'amount')::numeric),0)
            FROM jsonb_array_elements(h.winners) e) AS paid
    FROM h
)
SELECT count(*) AS hands_checked,
       count(*) FILTER (WHERE abs(paid - (pot_size - rake)) <= 0.005) AS balanced,
       count(*) FILTER (WHERE paid > pot_size - rake + 0.005) AS paid_more_than_pot,
       count(*) FILTER (WHERE paid < pot_size - rake - 0.005) AS paid_less_than_pot
  FROM w;

-- ── 5. ...and the shortfall in 4 IS the jackpot drop, per hand ───────────
-- Expect bbj_exactly_explains_it = hands_with_shortfall, and the two totals
-- equal to the cent. Measured 2026-08-30: 490 of 490, 225.19 = 225.19.
WITH h AS (
  SELECT id, pot_size, COALESCE(rake_amount,0) AS rake, winners
    FROM hand_history
   WHERE created_at > now() - interval '45 minutes'
     AND winners IS NOT NULL AND jsonb_typeof(winners) = 'array'
     AND jsonb_array_length(winners) > 0
   LIMIT 4000
), w AS (
  SELECT h.id, h.pot_size, h.rake,
         (SELECT COALESCE(SUM((e->>'amount')::numeric),0)
            FROM jsonb_array_elements(h.winners) e) AS paid
    FROM h
), gap AS (
  SELECT id, round(pot_size - rake - paid, 2) AS shortfall
    FROM w WHERE paid < pot_size - rake - 0.005
)
SELECT count(*) AS hands_with_shortfall,
       count(*) FILTER (WHERE c.bbj IS NOT NULL AND abs(c.bbj - g.shortfall) <= 0.005) AS bbj_exactly_explains_it,
       round(COALESCE(SUM(g.shortfall),0), 2) AS total_shortfall,
       round(COALESCE(SUM(c.bbj),0), 2) AS total_bbj_drop
  FROM gap g
  LEFT JOIN LATERAL (
    SELECT round(SUM(bc.amount), 2) AS bbj
      FROM bbj_contributions bc WHERE bc.hand_id = g.id
  ) c ON true;

-- ── 6. NOBODY HOLDS A NEGATIVE BALANCE ───────────────────────────────────
-- Expect zeros. A negative wallet or seat stack means something debited past
-- empty, which no guard on this platform is supposed to allow.
SELECT (SELECT count(*) FROM club_members WHERE chip_balance < 0)            AS negative_wallets,
       (SELECT count(*) FROM table_seats WHERE left_at IS NULL AND stack < 0) AS negative_stacks,
       (SELECT round(COALESCE(SUM(chip_balance),0),2) FROM club_members)      AS chips_in_wallets,
       (SELECT round(COALESCE(SUM(stack),0),2) FROM table_seats WHERE left_at IS NULL) AS chips_on_the_felt;

-- ── 7. MONEY OWED AND NEVER PAID ─────────────────────────────────────────
-- Expect 0.00. Dry run -- p_apply is false, so this moves nothing.
-- NOTE the window is `started_at`, NOT `updated_at`: tournaments.updated_at is
-- never maintained and holds row-creation time, which is what hid 38 events
-- carrying 11,238.80 until 2026-08-29.
WITH cand AS (
  SELECT id FROM tournaments
   WHERE status = 'COMPLETED' AND started_at > now() - interval '7 days'
     AND COALESCE(prize_pool,0) > 0 AND COALESCE(variant,'') <> 'satellite'
)
SELECT round(COALESCE(SUM((fn_tournament_payout_reconcile(id, false)->>'total_top_up')::numeric), 0), 2)
         AS total_owed
  FROM cand;
