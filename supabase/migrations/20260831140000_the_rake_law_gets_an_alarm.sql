-- ═══════════════════════════════════════════════════════════════════════════
-- THE RAKE LAW GETS AN ALARM (Phase 2 of the live cash audit, item 2B)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT 2B WAS ASKED TO FIND. Every live cash table carries
-- `rake_percent = -1.00` and `rake_cap_bb = -1.00`, which reads like a broken
-- column. It is not: -1 is RAKE_INHERIT, the documented sentinel meaning "use
-- the published schedule", and it is honoured identically in three places —
-- src/config/RakeConfig.ts (isRakeSet), src/lib/rakeOverride.ts (pick) and
-- ServerTableEngineBase.getRakeOverride — with scripts/ci/
-- check-rake-schedule-parity.mjs already stopping the client and server copies
-- drifting. `ca_club_data_snapshot` even converts it back to NULL before the
-- Club Data page sees it, so the one surface that renders the column raw never
-- prints "-1%". There is nothing to fix in the resolution.
--
-- WHAT WAS ACTUALLY MISSING. Nothing anywhere asserted that the rake TAKEN
-- obeys the rake RESOLVED. Adherence was verified by hand for this audit and
-- it was perfect on the cap — across 24 hours and all nine live stakes, the
-- largest rake at each stake equals that stake's cap to the cent, zero hands
-- over cap, zero hands over 10% of the pot:
--
--     0.1/0.2  405 hands  max 3.00 = cap 3.00      2/5    977 hands  max  7.50 = cap  7.50
--     0.25/0.5 486        max 3.00 = cap 3.00      5/10   192        max 12.50 = cap 12.50
--     0.5/1    752        max 5.00 = cap 5.00      10/25  119        max 15.00 = cap 15.00
--     1/2    10378        max 5.00 = cap 5.00      25/50  139        max 20.00 = tier 20.00
--     2/4      749        max 7.50 = cap 7.50
--
-- (25/50 has no schedule row and resolves through the `nosebleeds` tier. That
-- is the design — the schedule names stakes, the tiers cover everything else —
-- and both are seeded here so the gap cannot be mistaken for one.)
--
-- BUT THE SAME PASS FOUND A RULE BEING BROKEN. "No flop, no drop" holds on
-- 3,234 of 3,234 flopped hands and on 7,276 of 7,278 unflopped ones — and
-- fails on the rest. Over 24 hours, 34 cash hands were raked with no board
-- recorded, 80.75 chips in total, and they split into two different defects:
--
--   * 19 hands, 9.05 chips, that ended preflop with at most three aggressive
--     actions and no showdown. Two examined in full are unambiguous: a 2/4
--     heads-up walk (SB posts 2, BB posts 4, SB folds, 2 returned) and a 1/2
--     PLO4 open-fold. Both pots were 4.00, both were raked 0.20 — exactly the
--     5% heads-up rate on a hand that never saw a flop. `calculateRake` returns
--     0 when `noFlopNoDrop && !sawFlop`, so `sawFlop` was true on a hand with
--     no flop. Rake is small; being raked on a walk is not.
--
--   * 15 hands, ~71 chips, that reached a showdown or ran 6-14 aggressive
--     actions into pots up to 704.00 with `community_cards` EMPTY. Those hands
--     did see a board. The rake is correct and the HISTORY is wrong — which
--     breaks hand replay for the player and silently corrupts any analysis
--     that asks whether a hand saw a flop, this one included.
--
-- Neither is fixed here; both are engine-side and belong with the cash rule
-- guards. What is fixed here is that they were invisible. This alarm is DB-side
-- for the same reason the bomb-pot repair is (20260831112020): it cannot drift
-- away from an engine build, and it keeps working through a deploy that,
-- per auto-deploy-hetzner.yml's drain gate, may report green and ship nothing.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ── The published schedule, mirrored from src/config/RakeConfig.ts ──
-- rake_cap is an ABSOLUTE amount, not big blinds. Kept as data rather than
-- inlined in the function so a stake can be added without a code change and so
-- the parity check has something to compare against.
CREATE TABLE IF NOT EXISTS public.ca_rake_schedule (
  sb           numeric NOT NULL,
  bb           numeric NOT NULL,
  rake_percent numeric NOT NULL,
  rake_cap     numeric NOT NULL,
  bbj_fee_bb   numeric NOT NULL,
  PRIMARY KEY (sb, bb)
);

INSERT INTO public.ca_rake_schedule (sb, bb, rake_percent, rake_cap, bbj_fee_bb) VALUES
  (0.1,  0.2, 10,  3.0,  0.6),
  (0.2,  0.4, 10,  3.0,  0.6),
  (0.25, 0.5, 10,  3.0,  0.6),
  (0.3,  0.6, 10,  5.0,  0.6),
  (0.5,  1.0, 10,  5.0,  0.25),
  (1,    2,   10,  5.0,  0.25),
  (2,    4,   10,  7.5,  0.12),
  (2,    5,   10,  7.5,  0.12),
  (5,    5,   10,  7.5,  0.12),
  (3,    6,   10,  8.0,  0.12),
  (4,    8,   10, 10.0,  0.12),
  (5,   10,   10, 12.5,  0.06),
  (10,  20,   10, 15.0,  0.06),
  (10,  25,   10, 15.0,  0.06)
ON CONFLICT (sb, bb) DO UPDATE
  SET rake_percent = EXCLUDED.rake_percent,
      rake_cap     = EXCLUDED.rake_cap,
      bbj_fee_bb   = EXCLUDED.bbj_fee_bb;

-- ── The tiers that cover every stake the schedule does not name ──
-- max_bb NULL is the open top end (STAKES_TIERS.nosebleeds carries Infinity).
CREATE TABLE IF NOT EXISTS public.ca_rake_tier (
  label        text PRIMARY KEY,
  min_bb       numeric NOT NULL,
  max_bb       numeric,
  rake_percent numeric NOT NULL,
  rake_cap     numeric NOT NULL,
  bbj_fee_bb   numeric NOT NULL
);

INSERT INTO public.ca_rake_tier (label, min_bb, max_bb, rake_percent, rake_cap, bbj_fee_bb) VALUES
  ('nano',        0.1,  0.2, 10,  3.0, 0.6),
  ('micro',       0.3,  0.8, 10,  3.0, 0.6),
  ('small',       1.0,  3.0, 10,  5.0, 0.25),
  ('mid',         3.5,  8.0, 10,  8.0, 0.12),
  ('high',        9.0, 40.0, 10, 15.0, 0.06),
  ('nosebleeds', 41.0, NULL, 10, 20.0, 0.03)
ON CONFLICT (label) DO UPDATE
  SET min_bb = EXCLUDED.min_bb, max_bb = EXCLUDED.max_bb,
      rake_percent = EXCLUDED.rake_percent, rake_cap = EXCLUDED.rake_cap,
      bbj_fee_bb = EXCLUDED.bbj_fee_bb;

COMMENT ON TABLE public.ca_rake_schedule IS
  'Mirror of RAKE_SCHEDULE in src/config/RakeConfig.ts. rake_cap is an absolute amount. Read only by the rake-law alarm; the engine uses its own copy.';
COMMENT ON TABLE public.ca_rake_tier IS
  'Mirror of STAKES_TIERS in src/config/RakeConfig.ts. Covers stakes the schedule does not name. max_bb NULL is the open top end.';

-- ── The cap a stake resolves to: exact schedule row first, then the tier ──
-- Exactly the precedence getRakeConfig applies (scheduleMatch ?? tier).
CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb),
    (SELECT t.rake_cap FROM public.ca_rake_tier t
      WHERE p_bb >= t.min_bb AND (t.max_bb IS NULL OR p_bb <= t.max_bb)
      ORDER BY t.min_bb DESC LIMIT 1)
  );
$$;

-- ── Every way the rake taken can disagree with the rake owed ──
--
-- Three kinds, deliberately kept apart because they have different fixes:
--
--   over_cap            the rake exceeds the resolved cap. Never seen live.
--   over_percent        the rake exceeds MAX_RAKE_PERCENT of the pot. Never
--                       seen live. An override may only move the rate DOWN,
--                       so 10% is a ceiling for every table at every stake.
--   no_flop_no_drop     raked with no board, and the hand plainly ended before
--                       one: no showdown and at most three aggressive actions.
--   board_not_recorded  raked with no board, but the hand reached a showdown
--                       or ran four or more aggressive actions. The rake is
--                       right; the hand history is missing its board.
--
-- The last two are split on evidence rather than lumped together, because
-- calling a recording gap a rake violation would send whoever is on shift to
-- read the rake code, which is not where that bug lives.
CREATE OR REPLACE FUNCTION public.fn_rake_law_violations(p_window interval DEFAULT '1 hour')
RETURNS TABLE (
  kind          text,
  hand_id       uuid,
  table_id      uuid,
  occurred_at   timestamptz,
  small_blind   numeric,
  big_blind     numeric,
  pot           numeric,
  rake          numeric,
  allowed       numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at, hh.rake_amount AS rake,
           hh.pot_size AS pot, t.small_blind AS sb, t.big_blind AS bb,
           COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) AS board_n,
           hh.showdown IS NOT NULL AS has_showdown,
           (SELECT count(*) FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
             WHERE a->>'action' IN ('call','raise','bet','allin','all-in')) AS agg
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.created_at > now() - p_window
       AND t.tournament_id IS NULL
       AND COALESCE(hh.rake_amount, 0) > 0
  ), r AS (
    SELECT h.*, public.fn_effective_rake_cap(h.sb, h.bb) AS cap FROM h
  )
  SELECT 'over_cap', id, table_id, created_at, sb, bb, pot, rake, cap
    FROM r WHERE cap IS NOT NULL AND rake > cap + 0.005
  UNION ALL
  SELECT 'over_percent', id, table_id, created_at, sb, bb, pot, rake,
         round(pot * 0.10, 2)
    FROM r WHERE rake > pot * 0.10 + 0.005
  UNION ALL
  SELECT 'no_flop_no_drop', id, table_id, created_at, sb, bb, pot, rake, 0
    FROM r WHERE board_n < 3 AND NOT has_showdown AND agg <= 3
  UNION ALL
  SELECT 'board_not_recorded', id, table_id, created_at, sb, bb, pot, rake, rake
    FROM r WHERE board_n < 3 AND (has_showdown OR agg > 3);
$$;

-- ── The hourly alarm ──
--
-- Writes into ledger_reconcile_log beside the money-integrity checks, so there
-- is ONE place to look. Idempotent by hand id: a hand already logged is never
-- logged twice, which matters because the window overlaps itself if a run is
-- late and because a repaired hand should stop reappearing on its own.
--
-- board_not_recorded is logged at 'warning'. It costs no player any chips; it
-- costs them their hand history, which is worth an alarm but not a page.
CREATE OR REPLACE FUNCTION public.fn_rake_law_check(p_window interval DEFAULT '2 hours')
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_rake_law_violations(p_window)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       drift, severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'rake_law', v.table_id,
           v.allowed, v.rake, round(v.rake - v.allowed, 2),
           CASE WHEN v.kind = 'board_not_recorded' THEN 'warning' ELSE 'critical' END,
           jsonb_build_object(
             'kind', v.kind,
             'hand_id', v.hand_id,
             'occurred_at', v.occurred_at,
             'stake', v.small_blind::text || '/' || v.big_blind::text,
             'pot', v.pot),
           v.kind || ': raked ' || v.rake::text || ' where ' || v.allowed::text || ' was owed'
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'rake_law'
          AND l.metadata->>'hand_id' = v.hand_id::text)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$$;

-- Neither function is a browser surface. They read hand histories across every
-- club, so nothing holding an anon or authenticated JWT has any business
-- calling them; the alarm runs as the cron owner.
REVOKE ALL ON FUNCTION public.fn_effective_rake_cap(numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_law_violations(interval)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_law_check(interval)             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_effective_rake_cap(numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_law_violations(interval)        TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_law_check(interval)             TO service_role;

-- Every 40 minutes past the hour, over a 2 hour window: the overlap means a
-- skipped or late run loses nothing, and the hand-id guard makes the overlap
-- free. Off the :00 and :20 marks so it does not queue behind
-- reconcile-ledger-integrity-6h or bomb-multi-winner-repair-hourly.
SELECT cron.schedule('rake-law-adherence-hourly', '40 * * * *',
                     $cron$SELECT public.fn_rake_law_check('2 hours'::interval);$cron$);

COMMIT;
