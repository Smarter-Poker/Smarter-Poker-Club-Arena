-- 20261022162545_the_hourly_sweep_reads_each_ledger_leg_once.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE HOURLY CONSERVATION SWEEP READS EACH LEDGER LEG ONCE (2026-10-22)
--
-- Full account: docs/changelog/2026-10-22-the-hourly-sweep-reads-each-ledger-leg-once.md
--
-- pg_cron job 233 ca-conservation-sweep-hourly (:52) still ran 72-121 s after
-- 20261022062934. Each check timed on production, read-only, 2026-10-22 (one
-- DO block per probe, ended by RAISE, so nothing was kept):
--
--   fn_chip_integrity_report             ~20 s
--     fn_ledger_liveness                  4.7 s  counts every hand of 24 h
--                                                (1.48M hand_history rows)
--     fn_chip_drift_since_baseline        4.4 s  re-sums every player wallet
--                                                leg since 2026-08-26 (3.65M)
--     fn_unaccounted_seat_exits          10.0 s  32k exits, one credit probe
--                                                each, cold heap reads
--   fn_bbj_conservation_check             9.7 s  re-sums every BBJ leg since
--                                                the epoch (7.1M), and reads
--                                                1,943 later pools' legs from
--                                                the heap (81,658 blocks)
--   fn_ca_payout_rows_without_money(3)   16.5 s  cold; 79k idempotency probes
--   fn_tournament_prize_disbursement_audit 2-8 s 26k escrow probes, cold
--
-- WHAT CHANGES. Every check keeps its coverage, its rows and its verdict:
--
--  1. The journal is append-only (trg_ca_append_only) and a leg's created_at
--     is its transaction's start (fn_ca_chip_ledger_enrich: COALESCE(NEW.
--     created_at, now()); no writer sets it). So a sum over legs older than
--     every transaction still running cannot change. The sweep now keeps
--     those sums (fn_ca_ledger_audit_checkpoint_advance, first thing in
--     fn_ca_conservation_sweep, in its own exception block) up to a horizon
--     six hours back and before the oldest open transaction, and:
--       * fn_chip_drift_since_baseline reads each member's checkpointed net
--         plus the legs after it, instead of every leg since the baseline;
--       * fn_bbj_conservation_check reads the epoch's checkpointed totals and
--         each later pool's checkpointed seeds and burns plus the legs after
--         them; the legs a later pool's opening absorbed are read by their
--         own (epoch, opening] range, as before.
--     A checkpoint whose starting point (the chip baseline, the BBJ epoch) no
--     longer matches is ignored by the readers and rebuilt by the next
--     advance, so the answer is the full re-sum in that case. No row of any
--     money table is written; the new tables hold sums, nothing else.
--  2. fn_chip_integrity_report asks whether any hand was dealt in 24 hours
--     (EXISTS) instead of counting 1.48M of them; the exact count is read only
--     on the branch whose sentence prints it. Same severity, same sentence.
--  3. fn_ca_payout_rows_without_money first sets aside every payout whose key
--     was claimed in the window (a hash of the recent claims), then probes the
--     whole claim table only for what is left. Same rows, same order.
--  4. fn_tournament_prize_disbursement_audit reads a Spin's funded overlay
--     through a partial index of the escrows that have one, and each
--     tournament's prize credits by its own key. Same rows.
--  5. Three indexes, built concurrently before the transaction:
--       idx_wallet_tx_credit_user_created_amount: the seat-exit check's credit
--         probe reads the index alone (no heap visit per exit);
--       idx_tournament_escrow_overlay_in: the escrows with a funded overlay;
--       idx_ca_bbj_pool_snapshots_baseline: the BBJ opening balances, which
--         the jackpot check read by sequential scans of every hourly snapshot.
--
-- No check is removed, no job is added or rescheduled, nothing repairs
-- anything (CLAUDE.md 10.11, 10.12). Horses are counted exactly as before
-- (10.5): no filter in this file reads is_horse.
--
-- Pinned preimages (each md5 is the live pg_get_functiondef, captured
-- 2026-10-22 into scripts/ci/fixtures/hourly-sweep-incremental/). Qualified
-- natively by scripts/ci/test-the-hourly-sweep-reads-each-leg-once.py.
--
-- @live-proof: to_regclass('public.ca_ledger_audit_marks') IS NOT NULL
-- @live-proof: position('fn_ca_ledger_audit_checkpoint_advance' IN pg_get_functiondef('public.fn_ca_conservation_sweep()'::regprocedure))>0
-- @live-proof: position('ca_ledger_audit_member_net' IN pg_get_functiondef('public.fn_chip_drift_since_baseline()'::regprocedure))>0

-- The seat-exit check's credit probe (32k exits a week, one probe each), the
-- escrows that carry a funded overlay, and the BBJ opening balances (1,944
-- baseline rows among 480,000 hourly snapshots, which the jackpot check read
-- by four sequential scans). Built one at a time, outside the transaction,
-- before it is sent.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_credit_user_created_amount ON public.wallet_transactions (user_id, created_at) INCLUDE (amount) WHERE type = 'credit';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_escrow_overlay_in ON public.tournament_escrow (tournament_id) INCLUDE (overlay_in) WHERE overlay_in > 0 AND overlay_in < 'Infinity'::numeric;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ca_bbj_pool_snapshots_baseline ON public.ca_bbj_pool_snapshots (pool_id, taken_at) INCLUDE (main, backup, promo) WHERE is_baseline;

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE r record; v_actual text;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'the hourly sweep migration requires the maintained installer';
  END IF;
  IF to_regclass('public.ca_ledger_audit_marks') IS NOT NULL THEN
    RAISE EXCEPTION 'the hourly sweep checkpoint is already installed';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_chip_drift_since_baseline()', '6e7f006fb462ab5e008f94a6d6df63e8'),
    ('public.fn_bbj_conservation_check()', 'ffbdd5f2fab8e7a8f8dbd32a667a0b5a'),
    ('public.fn_chip_integrity_report()', 'f87b9efb48d0bb8930358fabb7ebd870'),
    ('public.fn_ca_payout_rows_without_money(integer)', '7d1f46dce13044b7cb90823ed08e1be4'),
    ('public.fn_tournament_prize_disbursement_audit(integer)', 'd62ceae6005e91ab678155a826bc50e5'),
    ('public.fn_ca_conservation_sweep()', '81995d0a3590cab15132df5b1ef609e8'),
    -- Read, not replaced: what the new definitions keep calling or restating.
    ('public.fn_ledger_liveness()', '222ef060dbfe6e7c4a4c2a37cb0cfda5'),
    ('public.fn_unaccounted_seat_exits(interval,interval)', '9b4bd9fcada25292668ed80c5ccf7a0c')
  ) v(sig, pin) LOOP
    v_actual := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_actual IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION 'hourly sweep preimage changed: % (md5 %)', r.sig, v_actual;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.idx_wallet_tx_credit_user_created_amount')
                    AND i.indrelid = 'public.wallet_transactions'::regclass AND i.indisvalid AND i.indisready
                    AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX idx_wallet_tx_credit_user_created_amount ON public.wallet_transactions USING btree (user_id, created_at) INCLUDE (amount) WHERE (type = ''credit''::text)') THEN
    RAISE EXCEPTION 'idx_wallet_tx_credit_user_created_amount is missing, invalid or changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.idx_tournament_escrow_overlay_in')
                    AND i.indrelid = 'public.tournament_escrow'::regclass AND i.indisvalid AND i.indisready
                    AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX idx_tournament_escrow_overlay_in ON public.tournament_escrow USING btree (tournament_id) INCLUDE (overlay_in) WHERE ((overlay_in > (0)::numeric) AND (overlay_in < ''Infinity''::numeric))') THEN
    RAISE EXCEPTION 'idx_tournament_escrow_overlay_in is missing, invalid or changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.idx_ca_bbj_pool_snapshots_baseline')
                    AND i.indrelid = 'public.ca_bbj_pool_snapshots'::regclass AND i.indisvalid AND i.indisready
                    AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX idx_ca_bbj_pool_snapshots_baseline ON public.ca_bbj_pool_snapshots USING btree (pool_id, taken_at) INCLUDE (main, backup, promo) WHERE is_baseline') THEN
    RAISE EXCEPTION 'idx_ca_bbj_pool_snapshots_baseline is missing, invalid or changed';
  END IF;
END $guard$;

-- ---------------------------------------------------------------------------
-- 1. The sums the sweep keeps. No foreign key to a hot table (CLAUDE.md
--    section 2 rule 7): an orphan sum is harmless, a lock is not.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_ledger_audit_marks (
  metric      text        PRIMARY KEY CHECK (metric IN ('chip_drift', 'bbj_epoch')),
  from_at     timestamptz NOT NULL,
  through_at  timestamptz NOT NULL,
  to_total    numeric     NOT NULL DEFAULT 0,
  from_total  numeric     NOT NULL DEFAULT 0,
  legs        bigint      NOT NULL DEFAULT 0,
  advanced_at timestamptz NOT NULL DEFAULT now(),
  CHECK (through_at >= from_at)
);
COMMENT ON TABLE public.ca_ledger_audit_marks IS
  'How far the hourly conservation sweep has summed chip_ledger. chip_drift: player wallet legs with from_at <= created_at < through_at, per member in ca_ledger_audit_member_net (from_at = min(ca_chip_baseline.taken_at)). bbj_epoch: BBJ pool legs with from_at < created_at < through_at, to_total/from_total over every pool and per later pool in ca_ledger_audit_bbj_pool (from_at = the BBJ epoch). Written only by fn_ca_ledger_audit_checkpoint_advance. Migration 20261022162545.';

CREATE TABLE public.ca_ledger_audit_member_net (
  club_id uuid    NOT NULL,
  user_id uuid    NOT NULL,
  net     numeric NOT NULL,
  PRIMARY KEY (club_id, user_id)
);
COMMENT ON TABLE public.ca_ledger_audit_member_net IS
  'Each member''s net player_wallet movement over the chip_drift range of ca_ledger_audit_marks (both sides of every leg, as fn_chip_drift_since_baseline counts them). Migration 20261022162545.';

CREATE TABLE public.ca_ledger_audit_bbj_pool (
  pool_id uuid    PRIMARY KEY,
  seeded  numeric NOT NULL DEFAULT 0,
  burned  numeric NOT NULL DEFAULT 0,
  absorbed    numeric,
  absorbed_to timestamptz
);
COMMENT ON TABLE public.ca_ledger_audit_bbj_pool IS
  'Per BBJ pool opened after the epoch: journalled seeds (into the pool, not a contribution) and burns (out of the pool, not a payout or promo) over the bbj_epoch range of ca_ledger_audit_marks, and the legs its opening absorbed (epoch, absorbed_to], once absorbed_to (the opening) is older than the range, as fn_bbj_conservation_check counts them. Migration 20261022162545.';

ALTER TABLE public.ca_ledger_audit_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_ledger_audit_member_net ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_ledger_audit_bbj_pool ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_ledger_audit_marks, public.ca_ledger_audit_member_net, public.ca_ledger_audit_bbj_pool
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Advancing the sums. Called by the sweep; safe to call at any time.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_ledger_audit_checkpoint_advance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_horizon timestamptz; v_from timestamptz; v_through timestamptz;
  v_n bigint; v_to numeric; v_out numeric;
  v_report jsonb := '{}'::jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('ca_ledger_audit_checkpoint_advance', 0)) THEN
    RETURN jsonb_build_object('skipped', 'another advance holds the lock');
  END IF;

  -- THE HORIZON. A leg is written with created_at = its transaction's start
  -- and the journal is append-only, so once every transaction that began
  -- before an instant has ended, no leg older than it can still appear. Six
  -- hours back, and a minute before the oldest transaction still open.
  SELECT LEAST(now() - interval '6 hours', COALESCE(min(a.xact_start), now()) - interval '1 minute')
    INTO v_horizon
    FROM pg_stat_activity a WHERE a.xact_start IS NOT NULL;

  -- 1. Member nets since the chip baseline (fn_chip_drift_since_baseline).
  SELECT min(b.taken_at) INTO v_from FROM public.ca_chip_baseline b;
  IF v_from IS NOT NULL THEN
    SELECT m.through_at INTO v_through FROM public.ca_ledger_audit_marks m
     WHERE m.metric = 'chip_drift' AND m.from_at = v_from FOR UPDATE;
    IF NOT FOUND THEN
      DELETE FROM public.ca_ledger_audit_member_net WHERE true;  -- a reset: the baseline moved, every remembered net is void
      INSERT INTO public.ca_ledger_audit_marks AS m (metric, from_at, through_at, legs, advanced_at)
      VALUES ('chip_drift', v_from, v_from, 0, now())
      ON CONFLICT (metric) DO UPDATE
        SET from_at = EXCLUDED.from_at, through_at = EXCLUDED.through_at,
            to_total = 0, from_total = 0, legs = 0, advanced_at = now();
      v_through := v_from;
    END IF;
    IF v_horizon > v_through THEN
      WITH sides AS (
        SELECT cl.club_id AS c_id, cl.to_entity_id AS u_id, cl.amount AS amt
          FROM public.chip_ledger cl
         WHERE cl.club_id IS NOT NULL AND cl.to_type = 'player_wallet'
           AND cl.created_at >= v_through AND cl.created_at < v_horizon
        UNION ALL
        SELECT cl.club_id, cl.from_entity_id, -cl.amount
          FROM public.chip_ledger cl
         WHERE cl.club_id IS NOT NULL AND cl.from_type = 'player_wallet'
           AND cl.created_at >= v_through AND cl.created_at < v_horizon
      ), d AS (
        SELECT s.c_id, s.u_id, sum(s.amt) AS net, count(*) AS n
          FROM sides s WHERE s.u_id IS NOT NULL GROUP BY 1, 2
      ), up AS (
        INSERT INTO public.ca_ledger_audit_member_net AS t (club_id, user_id, net)
        SELECT d.c_id, d.u_id, d.net FROM d
        ON CONFLICT (club_id, user_id) DO UPDATE SET net = t.net + EXCLUDED.net
        RETURNING 1
      )
      SELECT COALESCE((SELECT sum(d.n) FROM d), 0) INTO v_n;
      UPDATE public.ca_ledger_audit_marks
         SET through_at = v_horizon, legs = legs + v_n, advanced_at = now()
       WHERE metric = 'chip_drift';
      v_report := v_report || jsonb_build_object('chip_drift', jsonb_build_object('through', v_horizon, 'legs', v_n));
    END IF;
  END IF;

  -- 2. BBJ legs since the epoch (fn_bbj_conservation_check).
  SELECT min(s.taken_at) INTO v_from FROM public.ca_bbj_pool_snapshots s WHERE s.is_baseline;
  IF v_from IS NOT NULL THEN
    SELECT m.through_at INTO v_through FROM public.ca_ledger_audit_marks m
     WHERE m.metric = 'bbj_epoch' AND m.from_at = v_from FOR UPDATE;
    IF NOT FOUND THEN
      DELETE FROM public.ca_ledger_audit_bbj_pool WHERE true;  -- a reset: the epoch moved, every remembered pool total is void
      INSERT INTO public.ca_ledger_audit_marks AS m (metric, from_at, through_at, legs, advanced_at)
      VALUES ('bbj_epoch', v_from, v_from, 0, now())
      ON CONFLICT (metric) DO UPDATE
        SET from_at = EXCLUDED.from_at, through_at = EXCLUDED.through_at,
            to_total = 0, from_total = 0, legs = 0, advanced_at = now();
      v_through := v_from;
    END IF;
    IF v_horizon > v_through THEN
      -- Every pool, both directions (the epoch identity).
      SELECT COALESCE(sum(CASE WHEN l.to_type = 'bbj_pool' THEN l.amount ELSE 0 END), 0),
             COALESCE(sum(CASE WHEN l.from_type = 'bbj_pool' THEN l.amount ELSE 0 END), 0),
             count(*)
        INTO v_to, v_out, v_n
        FROM public.chip_ledger l
       WHERE (l.to_type = 'bbj_pool' OR l.from_type = 'bbj_pool')
         AND l.created_at > v_from AND l.created_at >= v_through AND l.created_at < v_horizon;

      -- The pools opened after the epoch, which is the set the check reads
      -- seeds and burns for, and every pool already kept (so a kept row is
      -- never left behind its mark). A pool that joins the set later has no
      -- row and is read whole by the check until the next advance gives it one.
      WITH late AS (
        SELECT p.id AS pool_id, (x.pool_id IS NOT NULL) AS kept, b.opened_at,
               x.absorbed AS kept_absorbed, x.absorbed_to AS kept_absorbed_to
          FROM public.bbj_pools p
          LEFT JOIN (SELECT s.pool_id, min(s.taken_at) AS opened_at
                       FROM public.ca_bbj_pool_snapshots s
                      WHERE s.is_baseline
                      GROUP BY s.pool_id) b ON b.pool_id = p.id
          LEFT JOIN public.ca_ledger_audit_bbj_pool x ON x.pool_id = p.id
         WHERE COALESCE(b.opened_at, p.created_at) > v_from OR x.pool_id IS NOT NULL
      ), sums AS (
        SELECT o.pool_id,
               COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                          WHERE l.to_entity_id = o.pool_id AND l.to_type = 'bbj_pool'
                            AND l.category <> 'bbj_contribution'
                            AND l.created_at > v_from
                            AND l.created_at >= CASE WHEN o.kept THEN v_through ELSE '-infinity'::timestamptz END
                            AND l.created_at < v_horizon), 0) AS seeded,
               COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                          WHERE l.from_entity_id = o.pool_id AND l.from_type = 'bbj_pool'
                            AND l.category NOT IN ('bbj_payout', 'promo')
                            AND l.created_at > v_from
                            AND l.created_at >= CASE WHEN o.kept THEN v_through ELSE '-infinity'::timestamptz END
                            AND l.created_at < v_horizon), 0) AS burned,
               -- The legs an opening absorbed, (epoch, opening], kept once
               -- the opening is older than the horizon; read again only if
               -- the opening moves.
               CASE WHEN o.opened_at IS NULL OR o.opened_at >= v_horizon THEN NULL
                    WHEN o.kept_absorbed_to IS NOT DISTINCT FROM o.opened_at THEN o.kept_absorbed
                    ELSE COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                                    WHERE l.to_entity_id = o.pool_id AND l.to_type = 'bbj_pool'
                                      AND l.created_at > v_from AND l.created_at <= o.opened_at), 0)
                       - COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                                    WHERE l.from_entity_id = o.pool_id AND l.from_type = 'bbj_pool'
                                      AND l.created_at > v_from AND l.created_at <= o.opened_at), 0) END AS absorbed,
               CASE WHEN o.opened_at IS NULL OR o.opened_at >= v_horizon THEN NULL ELSE o.opened_at END AS absorbed_to
          FROM late o
      )
      INSERT INTO public.ca_ledger_audit_bbj_pool AS t (pool_id, seeded, burned, absorbed, absorbed_to)
      SELECT s.pool_id, s.seeded, s.burned, s.absorbed, s.absorbed_to FROM sums s
      ON CONFLICT (pool_id) DO UPDATE
        SET seeded = t.seeded + EXCLUDED.seeded, burned = t.burned + EXCLUDED.burned,
            absorbed = EXCLUDED.absorbed, absorbed_to = EXCLUDED.absorbed_to;

      UPDATE public.ca_ledger_audit_marks
         SET through_at = v_horizon, to_total = to_total + v_to, from_total = from_total + v_out,
             legs = legs + v_n, advanced_at = now()
       WHERE metric = 'bbj_epoch';
      v_report := v_report || jsonb_build_object('bbj_epoch', jsonb_build_object('through', v_horizon, 'legs', v_n));
    END IF;
  END IF;

  RETURN v_report;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_audit_checkpoint_advance() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The member drift: the checkpointed net plus the legs after it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_chip_drift_since_baseline()
 RETURNS TABLE(club_id uuid, user_id uuid, opening_balance numeric, movements_since numeric, expected numeric, actual numeric, drift numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH span AS (SELECT MIN(taken_at) AS t0 FROM public.ca_chip_baseline),
  /* EVERY SIDE OF A LEG IS ITS OWN MOVEMENT (2026-10-03). A leg moves chips
     out of its from side and into its to side, and each side is counted for
     the member it names. The reading this replaces grouped a leg under ONE
     player - the to side when it was a player_wallet - and summed both sides
     there, so a leg between two player wallets (rakeback and commission paid
     wallet to wallet since 2026-09-29: 1,905 legs, 1,022,959.37 chips) netted
     to zero for the receiver and never reached the payer. 670 members read
     as drifting by 645,215.28 in all and exactly 0.00 net, worst -103,747.97,
     every chip of it accounted for in the journal.

     EACH LEG IS READ ONCE (20261022162545). The legs before the sweep's
     checkpoint are its kept per-member nets (ca_ledger_audit_member_net,
     summed the same way, both sides); only the legs after it are read here.
     A checkpoint taken from a different baseline is not used. */
  mark AS MATERIALIZED (
    SELECT m.through_at FROM public.ca_ledger_audit_marks m, span
     WHERE m.metric = 'chip_drift' AND m.from_at = span.t0
  ),
  tail AS (SELECT COALESCE((SELECT mark.through_at FROM mark), span.t0) AS t FROM span),
  sides AS (
    SELECT n.club_id AS c_id, n.user_id AS u_id, n.net AS amt
      FROM public.ca_ledger_audit_member_net n
     WHERE EXISTS (SELECT 1 FROM mark)
    UNION ALL
    SELECT cl.club_id, cl.to_entity_id, cl.amount
      FROM public.chip_ledger cl, tail
     WHERE cl.club_id IS NOT NULL
       AND cl.created_at >= tail.t
       AND cl.to_type = 'player_wallet'
    UNION ALL
    SELECT cl.club_id, cl.from_entity_id, -cl.amount
      FROM public.chip_ledger cl, tail
     WHERE cl.club_id IS NOT NULL
       AND cl.created_at >= tail.t
       AND cl.from_type = 'player_wallet'
  ),
  moves AS (
    SELECT s.c_id, s.u_id, sum(s.amt) AS net
      FROM sides s
     GROUP BY 1, 2
  )
  SELECT b.club_id, b.user_id, b.opening_balance,
         COALESCE(m.net, 0)                              AS movements_since,
         b.opening_balance + COALESCE(m.net, 0)          AS expected,
         COALESCE(cm.chip_balance, 0)                    AS actual,
         COALESCE(cm.chip_balance, 0) - (b.opening_balance + COALESCE(m.net, 0)) AS drift
  FROM public.ca_chip_baseline b
  JOIN public.club_members cm
    ON cm.club_id = b.club_id AND cm.user_id = b.user_id
  LEFT JOIN moves m
    ON m.c_id = b.club_id AND m.u_id = b.user_id;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The jackpot books: the epoch's checkpointed totals and each later pool's
--    checkpointed seeds and burns, plus the legs after them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_bbj_conservation_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_in numeric; v_out numeric; v_bal numeric; v_gap numeric; v_base record;
  v_epoch_at timestamptz; v_epoch_unexp numeric; v_epoch_runs int;
  v_counters_paid numeric; v_payout_rows numeric; v_pre_table numeric;
  v_unrecorded_since numeric; v_seeds_live numeric;
  v_seeds numeric; v_drift numeric; v_unexplained numeric; v_tol numeric;
  v_absorbed numeric := 0; v_late_seeds numeric := 0; v_late_burns numeric := 0;
  v_cp_through timestamptz; v_cp_to numeric := 0; v_cp_from numeric := 0;
BEGIN
  v_in := fn_bbj_contributions_total();
  v_in := v_in + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_fund');

  v_out := (SELECT COALESCE(SUM(total_amount),0) FROM bbj_payouts)
         + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_promo_sweep')
         + (SELECT COALESCE(SUM(amount),0) FROM chip_transactions WHERE transaction_type='bbj_promo_sweep')
         + (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions
             WHERE category='promotion' AND description='BBJ promo pool payout');

  /* A POOL OPENED AFTER THE EPOCH IS MEASURED FROM ITS OWN OPENING
     (2026-10-02, incident f3e82f59). fn_bbj_open_pool_baseline opens a later
     pool at GREATEST(created_at, epoch) and its opening balance already holds
     every leg up to that instant - the welcome seed leg has the pool's own
     created_at. Summing that baseline AND the journal since the global epoch
     counted each 100.00 seed twice. The legs a later pool's baseline absorbed
     are added back below; and its journalled seeds and burns enter the
     lifetime identity, because unlike the remembered 1,000.00 they have a
     ledger sentence. An ORIGINAL pool's seed or burn stays unexplained.

     EACH LEG IS READ ONCE (20261022162545). Seeds and burns before the
     sweep's checkpoint are its kept per-pool sums (ca_ledger_audit_bbj_pool);
     a pool without one is read whole, as before. The absorbed legs are the
     pool's own (epoch, opening] range, read by key. */
  SELECT min(taken_at) INTO v_epoch_at FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT m.through_at, m.to_total, m.from_total INTO v_cp_through, v_cp_to, v_cp_from
    FROM public.ca_ledger_audit_marks m
   WHERE m.metric = 'bbj_epoch' AND m.from_at = v_epoch_at;
  IF NOT FOUND THEN v_cp_through := NULL; v_cp_to := 0; v_cp_from := 0; END IF;
  SELECT COALESCE(sum(x.absorbed), 0), COALESCE(sum(x.seeded), 0), COALESCE(sum(x.burned), 0)
    INTO v_absorbed, v_late_seeds, v_late_burns
    FROM (SELECT p.id AS pool_id, b.opened_at, k.seeded AS kept_seeded, k.burned AS kept_burned,
                 k.absorbed AS kept_absorbed, k.absorbed_to AS kept_absorbed_to,
                 CASE WHEN k.pool_id IS NOT NULL THEN v_cp_through ELSE '-infinity'::timestamptz END AS tail_from
            FROM public.bbj_pools p
            LEFT JOIN (SELECT s.pool_id, min(s.taken_at) AS opened_at
                         FROM public.ca_bbj_pool_snapshots s
                        WHERE s.is_baseline
                        GROUP BY s.pool_id) b ON b.pool_id = p.id
            LEFT JOIN public.ca_ledger_audit_bbj_pool k ON k.pool_id = p.id AND v_cp_through IS NOT NULL
           WHERE COALESCE(b.opened_at, p.created_at) > v_epoch_at) o
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN o.opened_at IS NULL THEN 0
             WHEN o.kept_absorbed_to = o.opened_at THEN o.kept_absorbed ELSE
          COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                     WHERE l.to_entity_id = o.pool_id AND l.to_type = 'bbj_pool'
                       AND l.created_at > v_epoch_at AND l.created_at <= o.opened_at), 0)
        - COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                     WHERE l.from_entity_id = o.pool_id AND l.from_type = 'bbj_pool'
                       AND l.created_at > v_epoch_at AND l.created_at <= o.opened_at), 0) END AS absorbed,
        COALESCE(o.kept_seeded, 0)
        + COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                     WHERE l.to_entity_id = o.pool_id AND l.to_type = 'bbj_pool'
                       AND l.category <> 'bbj_contribution'
                       AND l.created_at > v_epoch_at
                       AND l.created_at >= o.tail_from), 0) AS seeded,
        COALESCE(o.kept_burned, 0)
        + COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                     WHERE l.from_entity_id = o.pool_id AND l.from_type = 'bbj_pool'
                       AND l.category NOT IN ('bbj_payout', 'promo')
                       AND l.created_at > v_epoch_at
                       AND l.created_at >= o.tail_from), 0) AS burned
    ) x;
  v_in := v_in + v_late_seeds;
  v_out := v_out + v_late_burns;

  SELECT COALESCE(SUM(main_balance+backup_balance+promo_balance),0) INTO v_bal FROM bbj_pools;

  v_gap := round(v_in - v_out - v_bal, 2);
  SELECT * INTO v_base FROM bbj_conservation_baseline WHERE id = 1;
  v_tol := COALESCE(v_base.tolerance, 1.00);
  v_drift := round(v_gap - COALESCE(v_base.baseline_gap, 0), 2);

  -- THE EPOCH (Phase 4.2): since the opening balances, the journal identity per
  -- pool per bank. This is what `healthy` means; the lifetime figures stay.
  SELECT min(taken_at) INTO v_epoch_at FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT count(*) INTO v_epoch_runs FROM public.ca_bbj_pool_snapshots WHERE NOT is_baseline;
  /* END TO END, NOT INTERVAL BY INTERVAL (2026-09-09). Summing each hour's
     residue accumulated every straddled drop forever, because a leg whose
     transaction began before a snapshot and committed after it belongs to no
     window at all. One comparison across the whole epoch has only two
     boundaries instead of three hundred. The legs before the sweep's
     checkpoint are its kept totals (20261022162545). */
  SELECT round(
           (SELECT COALESCE(sum(main_balance + backup_balance + promo_balance), 0) FROM public.bbj_pools)
         - (SELECT COALESCE(sum(b.main + b.backup + b.promo), 0)
              FROM public.ca_bbj_pool_snapshots b WHERE b.is_baseline)
         - ((v_cp_to - v_cp_from)
            + (SELECT COALESCE(sum(CASE WHEN l.to_type = 'bbj_pool' THEN l.amount ELSE 0 END), 0)
                    - COALESCE(sum(CASE WHEN l.from_type = 'bbj_pool' THEN l.amount ELSE 0 END), 0)
                 FROM public.chip_ledger l
                WHERE (l.to_type = 'bbj_pool' OR l.from_type = 'bbj_pool')
                  AND l.created_at > v_epoch_at
                  AND l.created_at >= COALESCE(v_cp_through, '-infinity'::timestamptz))), 2)
    INTO v_epoch_unexp;
  v_epoch_unexp := round(v_epoch_unexp + v_absorbed, 2);

  /* THE LIFETIME DECOMPOSITION (phase 5.3). Two ledgers with different start
     dates, named rather than reported as a deficit.

     ROOT pools only: a merge folds the retired pool's counters into its
     destination, so summing every pool would count the club pool's 74,301.10
     twice. */
  SELECT COALESCE(sum(total_paid_out),0) INTO v_counters_paid
    FROM bbj_pools WHERE merged_into_pool_id IS NULL;
  SELECT COALESCE(sum(total_amount),0) INTO v_payout_rows FROM bbj_payouts;
  v_pre_table := round(v_counters_paid - v_payout_rows, 2);

  /* The historical figure is CLOSED at 71,749.31. Anything beyond it is a
     payout made since bbj_payouts existed that wrote no row - a live blind
     spot wearing a historical explanation's clothes. */
  v_unrecorded_since := round(v_pre_table - COALESCE(v_base.pre_ledger_payouts, 0), 2);

  /* Opening seeds pull the OTHER way: bank balance with no inflow row behind
     it. REMEMBERED, not read from bbj_pools.pool_amount - four functions can
     write that column, so deriving from it would let any of them move a money
     verdict, and would silently absorb a new seed the way the pre-ledger
     bucket would have absorbed a new unrecorded payout. The live column is
     reported beside it so a divergence is visible rather than load-bearing. */
  v_seeds := COALESCE(v_base.opening_seeds, 0);
  SELECT COALESCE(sum(pool_amount),0) INTO v_seeds_live FROM bbj_pools;

  v_unexplained := round(v_drift - v_pre_table + v_seeds, 2);

  RETURN jsonb_build_object(
    'inflow', round(v_in,2), 'outflow', round(v_out,2), 'balances', round(v_bal,2),
    'gap', v_gap,
    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    /* THE HEADLINE IS THE LIVE FIGURE (2026-09-09). This was v_drift, the
       lifetime gap, which is closed and does not move; the sweep reads this
       key for the incident's amount, so every incident said 70,795.11 while
       the thing that made the verdict unhealthy was a few chips. The
       lifetime figure keeps its place under 'lifetime' below. */
    'drift_from_baseline', round(COALESCE(v_epoch_unexp, 0), 2),
    'lifetime_drift_from_baseline', v_drift,
    'tolerance', v_tol,
    'lifetime', jsonb_build_object(
      'drift_from_baseline', v_drift,
      'paid_before_the_payout_table', v_pre_table,
      'pre_ledger_payouts_known', COALESCE(v_base.pre_ledger_payouts, 0),
      'paid_without_a_payout_row_since', v_unrecorded_since,
      'opening_seeds_known', v_seeds,
      'journalled_seeds_after_epoch', round(v_late_seeds, 2),
      'journalled_burns_after_epoch', round(v_late_burns, 2),
      'legacy_pool_amount_live', round(v_seeds_live,2),
      'unexplained', v_unexplained,
      'known_residue', COALESCE(v_base.lifetime_residue, 0),
      'moved_since_resolution', round(v_unexplained - COALESCE(v_base.lifetime_residue,0), 2),
      'note', 'The gap is two ledgers with different start dates, not missing chips. bbj_contributions begins 2026-03-03; bbj_payouts begins 2026-07-22. The union pool paid forty jackpots in between (71,749.31), and bbj_pools.total_paid_out is the witness that was there. Against it, 1,000.00 of opening seed sits in a bank with no contribution row. Both are CLOSED historical figures. `paid_without_a_payout_row_since` and `moved_since_resolution` are the live signals; everything else here is memory.'),
    'lifetime_healthy',
          abs(v_unexplained - COALESCE(v_base.lifetime_residue, 0)) <= v_tol
      AND abs(v_unrecorded_since) <= 0.01,
    'epoch', jsonb_build_object(
      'opened_at', v_epoch_at,
      'snapshots', v_epoch_runs,
      'unexplained_since_opening', round(v_epoch_unexp, 2),
      'absorbed_by_later_openings', round(v_absorbed, 2),
      'known_residue', COALESCE(v_base.epoch_residue, 0),
      'moved_since_recorded', round(v_epoch_unexp - COALESCE(v_base.epoch_residue, 0), 2)),
    'healthy', v_epoch_at IS NOT NULL
               AND abs(v_epoch_unexp - COALESCE(v_base.epoch_residue, 0)) <= v_tol);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The chip integrity report: "was any hand dealt" is an EXISTS. The exact
--    hand count is read only on the branch whose sentence prints it. Every
--    other line is fn_ledger_liveness's, unchanged, and the rest of the report
--    is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_chip_integrity_report()
 RETURNS TABLE(check_name text, severity text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sev text; v_finding text; v_days integer;
  v_drift_rows bigint; v_worst numeric;
  v_fail bigint; v_exits bigint;
  v_frozen numeric; v_last_write timestamptz;
  v_free bigint; v_lost numeric;
  v_flag bigint; v_flag_chips numeric;
  v_base numeric; v_left numeric;
  v_dealt boolean; v_hands bigint; v_moves bigint; v_ledger bigint; v_last timestamptz;
BEGIN
  /* THE LEDGER'S LIVENESS, AS fn_ledger_liveness() DECIDES IT (20261022162545).
     Its verdict needs only whether any hand was dealt in 24 hours; it counted
     all of them (1.48M rows, 4.7 s every hour). Same thresholds, same
     sentences, same order of branches; the count is read for the one sentence
     that prints it. */
  v_dealt := EXISTS (SELECT 1 FROM public.hand_history WHERE created_at > now() - interval '24 hours');
  SELECT count(*) INTO v_moves
    FROM public.club_members WHERE updated_at > now() - interval '24 hours';
  SELECT count(*), max(created_at) INTO v_ledger, v_last
    FROM public.chip_ledger WHERE created_at > now() - interval '24 hours';
  IF v_last IS NULL THEN
    SELECT max(created_at) INTO v_last FROM public.chip_ledger;
  END IF;
  v_days := GREATEST(0, EXTRACT(DAY FROM (now() - COALESCE(v_last, now())))::integer);
  IF (v_dealt OR v_moves > 0) AND v_ledger = 0 THEN
    SELECT count(*) INTO v_hands
      FROM public.hand_history WHERE created_at > now() - interval '24 hours';
    v_sev := 'critical';
    v_finding := format(
      'THE AUDIT TRAIL IS NOT RECORDING. %s hands and %s balance changes in 24h, '
      || '0 chip_ledger rows. Last ledger entry: %s (%s days ago). Every chip '
      || 'that moved since then moved unaudited.',
      v_hands, v_moves, COALESCE(v_last::text, 'NEVER'), v_days);
  ELSIF (v_dealt OR v_moves > 0) AND v_ledger < GREATEST(1, (v_moves / 10)) THEN
    v_sev := 'warn';
    v_finding := format(
      'The ledger is recording, but thinly: %s rows against %s balance changes in 24h. '
      || 'Some money paths are probably still bypassing chip_ledger.',
      v_ledger, v_moves);
  ELSIF NOT v_dealt AND v_moves = 0 THEN
    v_sev := 'ok';
    v_finding := 'Quiet period: nothing moved, so nothing was expected in the ledger.';
  ELSE
    v_sev := 'ok';
    v_finding := format('Ledger recording normally: %s rows in 24h.', v_ledger);
  END IF;
  check_name := 'ledger_liveness'; severity := v_sev; detail := v_finding;
  RETURN NEXT;

  SELECT count(*) FILTER (WHERE abs(d.drift) > 0.01), COALESCE(max(abs(d.drift)), 0)
    INTO v_drift_rows, v_worst FROM public.fn_chip_drift_since_baseline() d;
  check_name := 'drift_since_baseline';
  severity   := CASE WHEN v_drift_rows = 0 THEN 'ok' WHEN v_worst <= 1 THEN 'warn' ELSE 'critical' END;
  detail     := format('%s member(s) drifting, worst %s. Baseline 2026-08-26.', v_drift_rows, round(v_worst,2));
  RETURN NEXT;

  -- Excludes the idempotency refusal, matching fn_ca_quick_reconcile 3f:
  -- the opening grant's refused key in either declared shape, issuance_reserve
  -- since 2026-09-03 or system_mint before it (2026-09-23).
  SELECT count(*) INTO v_fail
    FROM public.ca_ledger_write_failures f
   WHERE f.occurred_at > now() - interval '48 hours'
     AND NOT (
     f.sqlstate = '23505'
     AND f.message LIKE '%ux_chip_ledger_idempotency_key%'
     AND EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.club_id = f.club_id
          AND l.idempotency_key = 'club-opening-grant:' || f.club_id::text
          AND l.category = 'mint' AND l.from_type IN ('system_mint', 'issuance_reserve')
          AND l.to_type = 'club_treasury' AND l.to_entity_id = f.club_id
          AND l.amount = 100000 AND l.status = 'posted'));
  check_name := 'ledger_write_failures';
  severity   := CASE WHEN v_fail = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s swallowed ledger write(s) in the last 48 hours (idempotency refusals of an already-posted grant excluded). Older ones stay in ca_ledger_write_failures; a closed episode must be able to age out or this check can never read ok again.', v_fail);
  RETURN NEXT;

  SELECT count(*) INTO v_exits FROM public.fn_unaccounted_seat_exits();
  check_name := 'unaccounted_seat_exits';
  severity   := CASE WHEN v_exits = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s seat exit(s) with a non-zero stack and no wallet credit.', v_exits);
  RETURN NEXT;

  SELECT count(*), COALESCE(sum(u.uncollected),0) INTO v_free, v_lost
    FROM public.fn_unpriced_tournaments('7 days') u;
  check_name := 'unpriced_tournaments';
  severity   := CASE WHEN v_free = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s COMPLETED tournament(s) in 7 days took a buy-in and earned no rake, ~%s uncollected.',
                       v_free, round(v_lost,2));
  RETURN NEXT;

  SELECT b.memberships, b.chips_held INTO v_flag, v_flag_chips
    FROM public.fn_bot_flag_disagreement() b;
  check_name := 'bot_flag_disagreement';
  severity   := CASE WHEN v_flag = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s membership(s) holding %s chips have club_members.is_bot disagreeing '
                       || 'with profiles.is_horse. Every is_bot-keyed report is wrong by this much.',
                       v_flag, round(v_flag_chips,2));
  RETURN NEXT;

  SELECT COALESCE(sum(balance),0), max(updated_at) FILTER (WHERE balance <> 0)
    INTO v_frozen, v_last_write FROM public.wallets;
  SELECT COALESCE(frozen_total, 732591994.33) INTO v_base
    FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  SELECT COALESCE(sum(deleted_balance),0) INTO v_left
    FROM public.ca_frozen_pool_deletions WHERE pool = 'public.wallets';
  check_name := 'legacy_wallets_frozen';
  severity   := CASE WHEN round(v_frozen + COALESCE(v_left,0), 2) <> round(COALESCE(v_base,0),2) THEN 'critical'
                     WHEN v_last_write > now() - interval '2 days' THEN 'critical'
                     ELSE 'ok' END;
  detail     := format('public.wallets holds %s chips plus %s recorded as having left, against a frozen baseline of %s. Last MONEY write %s. A zero-balance row created at signup is not a movement; a changed total is, and so is a row that cascaded away.',
                       round(v_frozen,2), round(COALESCE(v_left,0),2), round(COALESCE(v_base,0),2),
                       COALESCE(v_last_write::text,'never'));
  RETURN NEXT;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Payout rows with no money: the recent claims are set aside by a hash
--    first; the whole claim table is probed only for what is left.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_payout_rows_without_money(p_days integer DEFAULT 30)
 RETURNS TABLE(tournament_id uuid, tournament_name text, player_id uuid, finish_position integer, source text, amount numeric, paid_at timestamp with time zone, idempotency_key text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1));
BEGIN
  /* THE WINDOW IS A VALUE WHEN THE QUERY IS PLANNED (2026-10-22). As a
     LANGUAGE sql SECURITY DEFINER function the window arrived as an unknown
     parameter, so the three days the conservation sweep asks for were read as
     every payout ever paid: a sequential scan of tournament_payouts (876k
     rows) and of wallet_credit_idempotency for its earliest row, 13-55 s.
     Planned with its value, the window reads idx_tournament_payouts_paid_money
     and the earliest row reads idx_wallet_credit_idempotency_created. Same
     query, same rows, same order.

     THE RECENT CLAIMS ARE A HASH (20261022162545). The window's 79,000
     payouts were each probed into the 1.2M-row claim table (362,000 buffer
     visits, 16 s from a cold cache). A payout whose key was claimed in the
     window, or the day before it, is set aside by one hash of those claims;
     only what is left is probed against the whole table, so a key claimed
     at any time still counts exactly as before. */
  RETURN QUERY
    WITH cand AS MATERIALIZED (
      SELECT p.tournament_id, p.user_id, p.position, p.source, p.amount, p.paid_at, p.idempotency_key
        FROM public.tournament_payouts p
       WHERE p.source IN ('structure', 'reconcile', 'overlay_backpay', 'spin_backpay',
                          'hu_shortfall', 'late_reg_adjustment', 'final_table_deal', 'bubble_protection')
         AND p.user_id IS NOT NULL
         AND p.amount > 0
         AND p.paid_at > v_since
         AND p.paid_at > (SELECT min(w0.created_at) FROM public.wallet_credit_idempotency w0)
    ), recent AS MATERIALIZED (
      SELECT w.key FROM public.wallet_credit_idempotency w
       WHERE w.created_at >= v_since - interval '1 day'
    ), unclaimed AS MATERIALIZED (
      SELECT c.* FROM cand c
       WHERE c.idempotency_key IS NULL
          OR NOT EXISTS (SELECT 1 FROM recent r WHERE r.key = c.idempotency_key)
    )
    SELECT u.tournament_id, t.name, u.user_id, u.position, u.source, u.amount, u.paid_at, u.idempotency_key
      FROM unclaimed u
      JOIN public.tournaments t ON t.id = u.tournament_id
     WHERE u.idempotency_key IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency w
                        WHERE w.key = u.idempotency_key)
     ORDER BY u.paid_at DESC;
END
$function$;

-- ---------------------------------------------------------------------------
-- 7. The prize disbursement audit: a Spin's funded overlay through the
--    escrows that have one, and each tournament's credits by its own key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_prize_disbursement_audit(p_hours integer DEFAULT 24)
 RETURNS TABLE(tournament_id uuid, name text, variant text, prize_pool numeric, disbursed numeric, acknowledged numeric, excess numeric, ended_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours,24),1));
BEGIN
  /* READ BY KEY (20261022162545). Every completed tournament of the window
     (26,000 a day) was probed into tournament_escrow for an overlay only a
     Spin can carry and only a few escrows hold (7 s from a cold cache), and
     the prize credits were merged against all 858,000 of them. The overlay
     is read through idx_tournament_escrow_overlay_in, whose predicate is the
     CASE's own (overlay_in > 0 and finite): an escrow outside it added 0
     before and adds 0 now. Credits are summed per tournament by key. */
  RETURN QUERY
  WITH t AS (
    SELECT x.id, x.name, x.variant,
           -- A Spin promises buy_in x multiplier, paid from the spin reserve;
           -- its prize_pool column is the buy-ins and is not what it owes.
           CASE WHEN x.variant = 'spin' AND COALESCE(x.spin_multiplier, 0) > 0
                THEN GREATEST(x.prize_pool::numeric,
                  round(COALESCE(x.buy_in_amount,0) * x.spin_multiplier, 2)
                  + CASE
                      WHEN e.overlay_in > 0 AND e.overlay_in < 'Infinity'::numeric
                       AND e.overlay_in = COALESCE((
                         SELECT sum(l.amount) FROM public.chip_ledger l
                          WHERE l.tournament_id = x.id
                            AND l.category = 'overlay'
                            AND l.to_type = 'prize_liability'
                            AND l.to_entity_id = x.id
                            AND l.from_type IN ('union_bank','club_treasury')
                            AND l.status = 'posted'
                            AND l.amount > 0 AND l.amount < 'Infinity'::numeric
                       ), 0)
                      THEN e.overlay_in ELSE 0
                    END)
                ELSE x.prize_pool::numeric END AS pool,
           x.ended_at
      FROM public.tournaments x
      LEFT JOIN LATERAL (
        SELECT f.overlay_in FROM public.tournament_escrow f
         WHERE f.tournament_id = x.id
           AND f.overlay_in > 0 AND f.overlay_in < 'Infinity'::numeric
      ) e ON x.variant = 'spin' AND COALESCE(x.spin_multiplier, 0) > 0
     WHERE x.status = 'COMPLETED'
       AND x.ended_at > v_since
       AND COALESCE(x.prize_pool,0) > 0
  )
  SELECT t.id, t.name, t.variant, t.pool,
         COALESCE(p.amt,0),
         COALESCE(b.amount,0),
         round(COALESCE(p.amt,0) - t.pool - COALESCE(b.amount,0), 2),
         t.ended_at
    FROM t
    LEFT JOIN LATERAL (
      SELECT round(sum(w.amount),2) AS amt
        FROM public.wallet_transactions w
       WHERE w.related_entity_id = t.id
         AND w.type = 'credit' AND w.category = 'prize'
    ) p ON true
    LEFT JOIN public.tournament_conservation_baseline b ON b.tournament_id = t.id
   WHERE round(COALESCE(p.amt,0) - t.pool - COALESCE(b.amount,0), 2) > 0.005;
END
$function$;

-- ---------------------------------------------------------------------------
-- 8. The sweep advances the kept sums first, in its own exception block: a
--    failure there is recorded like any check's and every check still runs
--    (reading the whole range, exactly as before, if the sums did not move).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_conservation_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c record; v_n bigint; v_rows jsonb; v_verdict jsonb;
  v_found int := 0; v_failed int := 0; v_ran int := 0;
BEGIN
  /* EACH LEDGER LEG IS READ ONCE (20261022162545). The member drift and the
     jackpot books re-summed every leg since their baselines each hour (3.65M
     and 7.1M legs). The sums of legs older than every open transaction cannot
     change (the journal is append-only), so they are kept and advanced here;
     the checks add only the legs after them. */
  BEGIN
    PERFORM public.fn_ca_ledger_audit_checkpoint_advance();
  EXCEPTION WHEN OTHERS THEN
    v_failed := v_failed + 1;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_conservation_sweep:fn_ca_ledger_audit_checkpoint_advance', 'unknown', 'warning',
      'sweepfail:fn_ca_ledger_audit_checkpoint_advance:' || CURRENT_DATE::text,
      0, NULL, NULL, 'ledger', 'fn_ca_ledger_audit_checkpoint_advance',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'the conservation checkpoint could not advance: ' || SQLERRM
        || ' - the checks still run and read the whole range',
      false, jsonb_build_object('sqlstate', SQLSTATE));
  END;

  FOR c IN
    SELECT * FROM (VALUES
      ('fn_chip_integrity_report',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_chip_integrity_report() where severity <> ''ok'' limit 20) t',
       'warning'),
      ('fn_settlement_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_settlement_conservation_check() limit 20) t',
       'critical'),
      ('fn_union_chip_integrity_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_chip_integrity_check() limit 20) t',
       'critical'),
      ('fn_union_money_path_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_money_path_check() limit 20) t',
       'warning'),
      ('fn_club_arena_global_wallet_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_club_arena_global_wallet_check() limit 20) t',
       'warning'),
      ('fn_tournament_chip_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_chip_conservation_check(0.01) limit 20) t',
       'warning'),
      ('fn_satellite_conservation_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_satellite_conservation_audit(24) limit 20) t',
       'warning'),
      ('fn_tournament_prize_disbursement_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_prize_disbursement_audit(24) limit 20) t',
       'warning'),
      /* ONE FINDING IS FILED ONCE (2026-10-15). fn_union_governance_check
         ends with UNION ALL SELECT * FROM fn_union_credit_risk_check(), so
         running both filed every credit-risk finding twice under two
         sources. The governance check carries those rows with their own
         invariant names. Migration 20261015030651. */
      ('fn_union_governance_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_governance_check() limit 20) t',
       'warning'),
      ('fn_union_house_club_stamp_check',
       'select v.n, case when v.n > 0 then jsonb_build_object(''unstamped_union_tables'', v.n) end from (select public.fn_union_house_club_stamp_check() as n) v',
       'warning'),
      ('fn_union_law_integrity_breaches',
       'select coalesce(jsonb_array_length(v.j),0), case when coalesce(jsonb_array_length(v.j),0) > 0 then v.j end from (select public.fn_union_law_integrity_breaches() as j) v',
       'critical'),
      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning'),
      ('fn_rake_spec_self_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_rake_spec_self_check() limit 20) t',
       'warning'),
      ('fn_spin_ladder_drift_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_spin_ladder_drift_check(7) limit 20) t',
       'warning'),
      ('fn_ca_payout_rows_without_money',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_payout_rows_without_money(3) limit 20) t',
       'warning'),
      ('fn_ca_undeclared_leg_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_undeclared_leg_check(24) limit 20) t',
       'warning'),
      ('fn_ca_stranded_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_tournament_players() limit 20) t',
       'warning'),
      ('fn_ca_absent_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_absent_tournament_players(10) limit 20) t',
       'critical'),
      ('fn_ca_hand_commit_refusals',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_hand_commit_refusals(24) limit 20) t',
       'warning'),
      ('fn_ca_chip_store_coverage_gaps',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_chip_store_coverage_gaps() limit 20) t',
       'warning'),
      /* THE SILENCES (2026-09-12). Every check above this line measures an
         ERROR. The five below measure an ABSENCE, which is what five hours of
         zero hands actually looked like on the wire. */
      ('fn_ca_orphaned_running_tournaments',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_orphaned_running_tournaments(10) limit 20) t',
       'critical'),
      ('fn_ca_knockout_door_stalled',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_knockout_door_stalled(15) limit 20) t',
       'critical'),
      ('fn_ca_tables_that_cannot_deal',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_tables_that_cannot_deal(5) limit 20) t',
       'critical'),
      ('fn_ca_stranded_completing_tournaments',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_completing_tournaments(15) limit 20) t',
       'critical'),
      ('fn_ca_rake_rollup_writer_silent',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_rake_rollup_writer_silent(26) limit 20) t',
       'warning')
    ) v(check_name, q, sev)
  LOOP
    BEGIN
      v_ran := v_ran + 1;
      EXECUTE c.q INTO v_n, v_rows;
      IF COALESCE(v_n,0) > 0 THEN
        v_found := v_found + 1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:' || c.check_name, 'ledger_imbalance', c.sev,
          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          0, NULL, v_n::numeric, 'ledger', c.check_name,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          c.check_name || ' returned ' || v_n || ' finding(s) - an invariant does not hold',
          false, jsonb_build_object('rows', v_rows, 'row_count', v_n));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'check could not run: ' || SQLERRM
          || ' - a check that errors is as silent as one that never runs',
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  FOR c IN
    SELECT * FROM (VALUES
      ('fn_bbj_conservation_check',   'select public.fn_bbj_conservation_check()',   'healthy'),
      ('fn_bbj_promo_bank_check',     'select public.fn_bbj_promo_bank_check()',     'reconciles'),
      ('fn_settler_lag_check',        'select public.fn_settler_lag_check()',        'healthy'),
      ('fn_tournament_guarantee_check','select public.fn_tournament_guarantee_check(24)','__guarantee')
    ) v(check_name, q, health_key)
  LOOP
    BEGIN
      v_ran := v_ran + 1;
      EXECUTE c.q INTO v_verdict;

      IF (c.health_key = '__guarantee'
            AND (COALESCE((v_verdict->>'short_of_guarantee')::numeric,0) > 0
              OR COALESCE((v_verdict->>'paid_nothing')::numeric,0) > 0))
         OR (c.health_key <> '__guarantee'
            AND COALESCE((v_verdict->>c.health_key)::boolean, true) IS NOT TRUE)
      THEN
        v_found := v_found + 1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:' || c.check_name, 'ledger_imbalance', 'warning',
          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          COALESCE((v_verdict->>'drift_from_baseline')::numeric,
                   (v_verdict->>'over_swept')::numeric,
                   (v_verdict->>'chips_short')::numeric, 0),
          NULL, NULL, 'ledger', c.check_name,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          c.check_name || ' reports a conservation failure',
          false, v_verdict);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'check could not run: ' || SQLERRM,
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_conservation_sweep',
          jsonb_build_object('checks_run', v_ran, 'with_findings', v_found, 'errored', v_failed));

  RETURN jsonb_build_object('ok', true, 'checks_run', v_ran,
                            'with_findings', v_found, 'errored', v_failed);
END;
$function$;

-- The grants are the installed ones, restated.
REVOKE ALL ON FUNCTION public.fn_chip_drift_since_baseline() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_bbj_conservation_check() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_chip_integrity_report() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_payout_rows_without_money(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_prize_disbursement_audit(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_conservation_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_chip_drift_since_baseline() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_bbj_conservation_check() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_chip_integrity_report() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_payout_rows_without_money(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_prize_disbursement_audit(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_conservation_sweep() TO service_role;

COMMIT;
