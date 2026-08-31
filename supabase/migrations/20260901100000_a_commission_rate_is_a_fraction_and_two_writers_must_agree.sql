-- ═══════════════════════════════════════════════════════════════════════════
--  A COMMISSION RATE IS A FRACTION, AND THE TWO WRITERS MUST AGREE (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOTHING IS WRONG YET. That is the whole point of shipping this today.
--
-- Two functions write `agent_commissions` and they do not agree on what
-- `commission_rate` MEANS.
--
--   credit_agent_commission_from_rake   the live writer, 1,507,337 rows.
--                                       ROUND(p_rake_credit * commission_rate, 2)
--                                       -- always a FRACTION, always 2dp.
--
--   calculate_cascading_commission      reached from settle_hand_atomically.
--                                       CASE WHEN rate > 1 THEN rate / 100.0
--                                            ELSE rate END, then ROUND(..., 4)
--                                       -- a rate above 1 is silently
--                                       -- REINTERPRETED as a percent, and the
--                                       -- slice is rounded to four places on a
--                                       -- platform whose every other money
--                                       -- column is two.
--
-- MEASURED IN PRODUCTION 2026-08-31, read-only:
--
--   agents.commission_rate              113 rows, 0.2000 .. 0.7000, zero > 1
--   agent_commissions.commission_rate   1,507,337 rows (2 NULL), 0.2000 .. 0.7000
--   agents.player_rakeback_rate         113 rows, 0.1000 .. 0.5000
--   agents.rakeback_percentage          113 rows, all 0.0000
--   club_members.commission_rate        1,546 rows, all 0.00
--   club_members.rakeback_rate          1,546 rows, 0.00 .. 0.50
--   club_members.player_rakeback_pct    1,546 rows, 0.0000 .. 0.5000
--   rakeback_periods.rakeback_rate      4,434 rows, 0.0500 .. 0.2000
--   clubs.club_commission_rate          11 rows, all 0.9000
--   union_clubs.club_commission_rate    2 rows, all 0.9000
--
-- Every one of those is a fraction and every one is inside [0, 1] today. So
-- the coercion branch in `calculate_cascading_commission` has never fired.
--
-- THE DAY IT FIRES IS THE DAY IT COSTS MONEY. An admin who types 25 meaning
-- "25%" writes 25 into agents.commission_rate. The cascading writer would
-- quietly read that as 0.25 and look correct. The LIVE writer would read it as
-- 25 and pay TWENTY-FIVE TIMES the rake as commission -- 2,500% -- with no
-- constraint, no alarm and no ceiling anywhere between the admin and the
-- wallet. The coercion is not a safety net; it is the thing that would make
-- the bad value look survivable while the other writer detonates on it.
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--   1. Bounds every FRACTION-scaled rate column to [0, 1] with a CHECK, so a
--      25 is REFUSED at the door instead of reinterpreted behind it.
--   2. Deletes the >1-means-percent coercion. There is now no such thing as a
--      rate above 1 to coerce.
--   3. Makes both writers round to 2dp, the scale of every money column here.
--
-- ── WHICH COLUMNS, AND WHICH ARE DELIBERATELY LEFT ALONE ───────────────────
--
-- "Every column whose name ends in _rate or _pct" is the WRONG list and would
-- have been an outage. This platform genuinely holds both scales, and the
-- name does not tell you which:
--
--   rakeback_period_payouts.rakeback_pct   1,014 rows, 5.00 .. 20.00.
--       Every single row is above 1. It is a PERCENT and it is correct.
--       Bounding it to 1 would have refused every rakeback payout row.
--       NOT CONSTRAINED. Deliberately.
--
--   clubs.rake_percent, tables.rake_percent, bbj_stakes_tiers.*_pct,
--   tournaments.mystery_bounty_*_percent, commander_*, arcade_*
--       0..100 scales, several of which carry the documented -1 RAKE_INHERIT
--       sentinel. NOT CONSTRAINED. Nowhere near this money path.
--
--   sub_agents.commission_pct, commission_history.commission_rate,
--   commission_records.commission_rate, rakeback_distributions.rakeback_percentage
--       ALL FOUR TABLES ARE EMPTY (0 rows). With no data and no live writer,
--       nothing proves which scale they were built for, and a constraint whose
--       scale is a guess is worse than none. NOT CONSTRAINED. Written down
--       here so the next person does not have to re-derive that they are empty.
--
-- ── SAFETY ─────────────────────────────────────────────────────────────────
-- Each constraint is added NOT VALID (a brief AccessExclusiveLock, no table
-- scan) and then VALIDATEd in a separate statement, which takes only a
-- ShareUpdateExclusiveLock and does not block reads or writes. That matters on
-- agent_commissions, which is 1.5M rows. lock_timeout is short and the DO
-- blocks are idempotent, so a run that loses a lock race can simply be re-run.
--
-- ROLLBACK:
--   ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_commission_rate_is_a_fraction;
--   ... (one line per constraint below) ...
--   and re-run this migration with the two expressions in section 3 swapped.

SET lock_timeout = '4s';

-- ── 1. THE FRACTION LAW ────────────────────────────────────────────────────

DO $rates$
DECLARE
  r          record;
  v_bad      bigint;
  v_conname  text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('agents',           'commission_rate'),
      ('agents',           'player_rakeback_rate'),
      ('agents',           'rakeback_percentage'),
      ('agent_commissions','commission_rate'),
      ('club_members',     'commission_rate'),
      ('club_members',     'rakeback_rate'),
      ('club_members',     'player_rakeback_pct'),
      ('rakeback_periods', 'rakeback_rate'),
      ('clubs',            'club_commission_rate'),
      ('union_clubs',      'club_commission_rate')
    ) AS t(tbl, col)
  LOOP
    v_conname := r.tbl || '_' || r.col || '_is_a_fraction';

    -- The table or column may not exist in a branch database; skip rather
    -- than fail, so this migration is safe to replay anywhere.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col
    ) THEN
      RAISE NOTICE 'skipping %.% - not present', r.tbl, r.col;
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = ('public.' || r.tbl)::regclass AND conname = v_conname) THEN
      RAISE NOTICE 'skipping % - already present', v_conname;
      CONTINUE;
    END IF;

    -- LAW 3 / LAW 6: never add a validated constraint without first proving
    -- that not one live row would have been refused by it.
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE %I IS NOT NULL AND (%I < 0 OR %I > 1)',
      r.tbl, r.col, r.col, r.col) INTO v_bad;
    IF v_bad > 0 THEN
      RAISE EXCEPTION
        '%.% has % row(s) outside [0,1] - it is not a fraction column, or it has drifted. Refusing to constrain it.',
        r.tbl, r.col, v_bad;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR (%I >= 0 AND %I <= 1)) NOT VALID',
      r.tbl, v_conname, r.col, r.col, r.col);
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', r.tbl, v_conname);

    RAISE NOTICE 'added and validated %', v_conname;
  END LOOP;
END
$rates$;

COMMENT ON COLUMN public.agents.commission_rate IS
  'A FRACTION in [0,1]. 0.25 means 25%. Enforced by agents_commission_rate_is_a_fraction. Do not store 25 here; credit_agent_commission_from_rake would pay 2500% of the rake.';
COMMENT ON COLUMN public.agent_commissions.commission_rate IS
  'The fraction in [0,1] that produced `amount`. Copied from agents.commission_rate by the writer. Enforced by agent_commissions_commission_rate_is_a_fraction.';

-- ── 2. THE COERCION GOES, AND THE ROUNDING AGREES AT 2dp ───────────────────
--
-- Rewritten as a verified single-substring replacement rather than a hand
-- re-emission of the whole function. `calculate_cascading_commission` is a
-- money path with a residual leg; re-typing it to change two lines risks a
-- transcription error that review would not catch. This REFUSES to proceed
-- unless it finds the exact text it was written against, exactly once.
--
-- Chip conservation is unaffected by the rounding change. The loop subtracts
-- each slice from v_remaining and the club owner receives whatever survives,
-- so 2dp versus 4dp re-divides the same rake between agent and owner rather
-- than creating or destroying any.

DO $mig$
DECLARE
  v_src text;
  v_old text :=
'    v_rate := CASE WHEN COALESCE(v_cur_rate,0) > 1 THEN v_cur_rate / 100.0
                   ELSE COALESCE(v_cur_rate,0) END;
    v_slice := ROUND(v_remaining * v_rate, 4);';
  v_new text :=
'    -- A rate is a fraction. There is no >1-means-percent reading any more:
    -- the CHECK constraints in this migration refuse such a value outright,
    -- so coercing one here would only hide it from the OTHER writer, which
    -- has no coercion and would pay 100x.
    v_rate := COALESCE(v_cur_rate, 0);
    -- 2dp, the scale credit_agent_commission_from_rake uses and the scale of
    -- every money column this touches.
    v_slice := ROUND(v_remaining * v_rate, 2);';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'calculate_cascading_commission';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'calculate_cascading_commission not found - nothing to rewrite';
  END IF;

  IF position(v_new in v_src) > 0 THEN
    RAISE NOTICE 'calculate_cascading_commission already carries the fraction rule';
    RETURN;
  END IF;

  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION
      'calculate_cascading_commission no longer contains the percent-coercion block exactly once; it has changed since this migration was written. Re-read it before rewriting.';
  END IF;

  EXECUTE replace(v_src, v_old, v_new);
END
$mig$;

-- ── 3. POST-APPLY ASSERTIONS ───────────────────────────────────────────────

DO $verify$
DECLARE
  v_src     text;
  v_missing text;
BEGIN
  SELECT string_agg(x.want, ', ') INTO v_missing
    FROM (VALUES
      ('agents',           'agents_commission_rate_is_a_fraction'),
      ('agents',           'agents_player_rakeback_rate_is_a_fraction'),
      ('agents',           'agents_rakeback_percentage_is_a_fraction'),
      ('agent_commissions','agent_commissions_commission_rate_is_a_fraction'),
      ('club_members',     'club_members_commission_rate_is_a_fraction'),
      ('club_members',     'club_members_rakeback_rate_is_a_fraction'),
      ('club_members',     'club_members_player_rakeback_pct_is_a_fraction'),
      ('rakeback_periods', 'rakeback_periods_rakeback_rate_is_a_fraction'),
      ('clubs',            'clubs_club_commission_rate_is_a_fraction'),
      ('union_clubs',      'union_clubs_club_commission_rate_is_a_fraction')
    ) AS x(tbl, want)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = ('public.' || x.tbl)::regclass
        AND c.conname = x.want AND c.convalidated);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'these fraction constraints are missing or unvalidated: %', v_missing;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'calculate_cascading_commission';

  IF v_src LIKE '%v_cur_rate / 100.0%' THEN
    RAISE EXCEPTION 'the percent coercion survived the rewrite';
  END IF;
  IF v_src NOT LIKE '%ROUND(v_remaining * v_rate, 2)%' THEN
    RAISE EXCEPTION 'the 2dp rounding is not in place after the rewrite';
  END IF;
  IF v_src LIKE '%ROUND(v_remaining * v_rate, 4)%' THEN
    RAISE EXCEPTION 'the 4dp rounding survived the rewrite';
  END IF;

  -- The live writer must still be the 2dp fraction writer it always was.
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'credit_agent_commission_from_rake';
  IF v_src NOT LIKE '%ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2)%' THEN
    RAISE EXCEPTION 'credit_agent_commission_from_rake is not rounding the direct slice to 2dp any more';
  END IF;
END
$verify$;
