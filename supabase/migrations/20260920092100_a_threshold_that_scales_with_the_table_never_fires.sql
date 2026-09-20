-- ═══════════════════════════════════════════════════════════════════════════
--  A THRESHOLD THAT SCALES WITH THE TABLE NEVER FIRES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260920061200 fixed this on one table. The sweep that followed found the
-- same defect on nineteen more, in two mirror-image forms, and the arithmetic
-- is the same one every time:
--
--     trigger = threshold + scale_factor x n_live_tup
--
-- A scale factor makes the trigger RACE THE TABLE. The bigger the table gets,
-- the more work is required before the thing that maintains it will run - so
-- the tables that most need vacuuming are the ones least likely to get it.
--
-- WHY THIS MATTERS AND IT IS NOT COSMETIC. VACUUM is the only thing in
-- PostgreSQL that sets the visibility map. An index-only scan checks that map;
-- when the bit is clear it visits the heap anyway. So the plan still SAYS
-- "Index Only Scan" while paying full freight, and nothing anywhere reports
-- it. That is exactly what 20260919220701's covering index was doing:
-- 112,106 heap fetches, 101,151 buffers, 110.6 ms - until a VACUUM took it to
-- 254 heap fetches, 745 buffers and 34.2 ms.
--
-- ── FORM ONE: the dead-tuple knobs on a table with no dead tuples ──────────
--
-- Six ledgers already carry an aggressive tuning set in which EVERY knob
-- counts dead tuples (vacuum_scale_factor 0.0 / vacuum_threshold 1000-2000,
-- and the same for analyze). They have ZERO updates and ZERO deletes, so none
-- of it can ever fire. The only trigger that can is the insert one, left at
-- cluster defaults - and 0.2 x several million rows is a number they reach
-- once a month or once a quarter. Measured 2026-09-20, window 10.15 days:
--
--   table                       rows      insert trigger    ins/day   fires
--   agent_commissions        6,719,405       1,344,881    177,879    ~7.6d
--   chip_ledger              4,961,439         993,288    282,676    ~3.5d
--   vip_points_ledger        8,148,996       1,630,799    177,147    ~9.2d
--   rakeback_stats_applied   8,329,322       1,666,864    108,268   ~15.4d
--   rake_distribution_legs   5,338,622       1,068,724    110,327    ~9.7d
--   club_wallet_transactions 2,807,566         562,513     55,164   ~10.2d
--
-- ── FORM TWO: no knobs at all, and already visibly degraded ────────────────
--
-- These carry no vacuum tuning whatsoever. Percentage of pages marked
-- all-visible, measured 2026-09-20:
--
--   agent_commission_settlements    0.0%   3 pages, last_autovacuum NEVER
--   horse_daily_nets                5.3%   3,637,956 updates on 113,677 rows
--   tournament_launch_receipts     10.5%
--   user_daily_challenges          25.1%   1,450,334 updates
--   cron_execution_log             33.2%   BOTH paths stalled at once
--   tournament_knockout_candidates 61.2%
--   settlement_idempotency_keys    63.6%   12 GB - 481,449 pages, 3.7 GB
--   hand_atomic_commits            65.5%   11 GB
--   union_pnl_inventory_events     84.2%
--   daily_challenge_progress_events 84.5%  9.4 GB
--   ca_hand_transfers              85.2%
--   spin_reserve_ledger            86.3%   108M index scans in 10 days
--
-- `agent_commission_settlements` is the sharpest: three pages, none of them
-- all-visible, NEVER autovacuumed, and 893 million heap fetches served from
-- it. Its dead trigger is 50 + 0.2 x 111 = 72 and its insert trigger is
-- 1000 + 0.2 x 111 = 1,022, against 83 inserts in ten days. Neither will ever
-- fire. A three-page table cannot be expensive to vacuum; it was simply never
-- asked.
--
-- `cron_execution_log` is the only table where both paths are provably
-- stalled together: dead 21,922 of 65,962 and inserts 30,064 of 66,912, with
-- last_autovacuum nine days old.
--
-- ── SIZING ────────────────────────────────────────────────────────────────
--
-- scale_factor 0.0 so the trigger is CONSTANT and stops racing the table,
-- plus a flat threshold of roughly one quarter of the measured daily rate,
-- targeting about four vacuums a day. This follows
-- 20260823080000_insert_only_tables_need_the_insert_threshold.sql, which set
-- union_wallet_transactions to a flat 5,000, and the same convention already
-- on ca_hand_player_idx (20,000) and hand_history (10,000).
--
-- Vacuuming often is close to free here: a vacuum of a table that is already
-- mostly all-visible skips every page whose bit is set, so the steady-state
-- pass touches only what changed since the last one. The cost is paid once,
-- on the first pass after this lands.
--
-- NOT INCLUDED, deliberately, and why:
--   clubs, unions, daily_challenge_event_outbox - degraded on paper but all
--     autovacuumed within the hour; their triggers are small enough already.
--   table_seats, ca_hand_player_stat - already carry explicit tuning that
--     fires (0.02 scale factor and a flat 20,000), and both vacuumed today.
--   data_audit_log, horse_adaptive_observation_journal - 4.1 GB and 3.3 GB
--     receiving ~1 row/day and 0 rows/3 days. No insert threshold helps a
--     table nobody writes to; these want a scheduled VACUUM (FREEZE) before
--     anti-wraparound forces one unthrottled, which is an operator decision
--     and not this migration's business.
--
-- This changes no query, no policy and no money path. It changes how often
-- PostgreSQL's own maintenance runs, which is the only thing that was wrong.
--
-- This migration creates no function, table, view, index, trigger or policy,
-- so nothing can look it up. It states its own proof.
--
-- @live-proof: (SELECT count(*) = 18 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('agent_commissions','chip_ledger','vip_points_ledger','rakeback_stats_applied','rake_distribution_legs','club_wallet_transactions','daily_challenge_progress_events','ca_hand_transfers','union_pnl_inventory_events','spin_reserve_ledger','agent_commission_settlements','horse_daily_nets','tournament_launch_receipts','user_daily_challenges','cron_execution_log','tournament_knockout_candidates','settlement_idempotency_keys','hand_atomic_commits') AND (reloptions::text LIKE '%autovacuum_vacuum_insert_scale_factor=0%' OR reloptions::text LIKE '%autovacuum_vacuum_scale_factor=0%'))
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── Form one: insert-only ledgers whose dead-tuple knobs can never fire ────
ALTER TABLE public.agent_commissions
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 20000);
ALTER TABLE public.chip_ledger
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 60000);
ALTER TABLE public.vip_points_ledger
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 25000);
ALTER TABLE public.rakeback_stats_applied
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 20000);
ALTER TABLE public.rake_distribution_legs
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 20000);
ALTER TABLE public.club_wallet_transactions
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 12000);

-- ── Form two, insert path: no tuning at all, already degraded ──────────────
ALTER TABLE public.daily_challenge_progress_events
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 300000);
ALTER TABLE public.ca_hand_transfers
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 150000);
ALTER TABLE public.union_pnl_inventory_events
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 100000);
ALTER TABLE public.spin_reserve_ledger
  SET (autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 2000);

-- ── Form two, dead-tuple path: a scale factor starving an update-heavy table ─
ALTER TABLE public.settlement_idempotency_keys
  SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 100000,
       autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 100000);
ALTER TABLE public.hand_atomic_commits
  SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 250000,
       autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 100000);
ALTER TABLE public.horse_daily_nets
  SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 5000);
ALTER TABLE public.user_daily_challenges
  SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 5000);
ALTER TABLE public.tournament_launch_receipts
  SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 2000);
ALTER TABLE public.tournament_knockout_candidates
  SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 5000,
       autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 5000);

-- ── Both paths stalled simultaneously ──────────────────────────────────────
ALTER TABLE public.cron_execution_log
  SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 5000,
       autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 5000);

-- ── Three pages, never vacuumed, 893 million heap fetches ──────────────────
ALTER TABLE public.agent_commission_settlements
  SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 50,
       autovacuum_vacuum_insert_scale_factor = 0.0, autovacuum_vacuum_insert_threshold = 50);

DO $$
DECLARE
  r record;
  v_missing text[] := '{}';
BEGIN
  /* Postgres normalises the literal to `0.0`, not `0`, so an array
     containment test for `=0` alone finds nothing and this block refuses a
     migration that in fact applied cleanly. It did exactly that on the first
     attempt here - correctly, since a check that cannot see its own effect
     must refuse rather than report success. Both spellings are accepted. */
  /* Every table this migration names must come out with a scale factor of
     zero on the path it was tuned for. A setting that silently did not take
     is worse than none: the next reader sees a migration that claims it. */
  FOR r IN
    SELECT unnest(ARRAY[
      'agent_commissions','chip_ledger','vip_points_ledger','rakeback_stats_applied',
      'rake_distribution_legs','club_wallet_transactions','daily_challenge_progress_events',
      'ca_hand_transfers','union_pnl_inventory_events','spin_reserve_ledger'
    ]) AS t
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = r.t
         AND (reloptions @> ARRAY['autovacuum_vacuum_insert_scale_factor=0']
           OR reloptions @> ARRAY['autovacuum_vacuum_insert_scale_factor=0.0'])
    ) THEN
      v_missing := v_missing || r.t;
    END IF;
  END LOOP;

  FOR r IN
    SELECT unnest(ARRAY[
      'settlement_idempotency_keys','hand_atomic_commits','horse_daily_nets',
      'user_daily_challenges','tournament_launch_receipts','tournament_knockout_candidates',
      'cron_execution_log','agent_commission_settlements'
    ]) AS t
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = r.t
         AND (reloptions @> ARRAY['autovacuum_vacuum_scale_factor=0']
           OR reloptions @> ARRAY['autovacuum_vacuum_scale_factor=0.0'])
    ) THEN
      v_missing := v_missing || r.t;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'autovacuum tuning did not take on: %', array_to_string(v_missing, ', ');
  END IF;
END $$;

COMMIT;
