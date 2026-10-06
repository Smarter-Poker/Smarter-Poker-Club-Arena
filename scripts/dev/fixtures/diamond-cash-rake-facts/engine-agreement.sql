\set ON_ERROR_STOP on
\set VERBOSITY verbose

-- ═══════════════════════════════════════════════════════════════════════════
--  THE ENGINE'S NUMBER AND THE SETTLER'S NUMBER, FOR THE SAME HAND
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This is the comparison the lane exists to produce. Every rake in
-- public.ca_probe_engine_rake was computed by the SERVER'S OWN pricer
-- (server/src/domain/diamondCashRakeSchedule.ts, run over the very rows this
-- database holds), and every hand below is submitted to the settler with that
-- number and nothing else. The settler recomputes from the same rows and
-- refuses a disagreement by name, so:
--
--   every hand that settles is one Diamond-for-Diamond agreement between the
--   engine and the database, on a real payload, for a real pot.
--
-- Three readings have to coincide, not two: the engine's, the settler's, and
-- public.probe_scheduled_rake - a separate reading of the published rows
-- written in SQL. An expectation stated once and asserted twice proves
-- nothing; three independent paths to the same integer does.

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM public.ca_probe_engine_rake) <> (SELECT count(*) FROM public.ca_probe_scenario) THEN
    RAISE EXCEPTION 'FAIL: the engine priced % of % scenarios',
      (SELECT count(*) FROM public.ca_probe_engine_rake),
      (SELECT count(*) FROM public.ca_probe_scenario);
  END IF;
  IF (SELECT count(*) FROM public.ca_probe_engine_reading) = 0 THEN
    RAISE EXCEPTION 'FAIL: the engine reported no reading of the published rows';
  END IF;
END $preflight$;

-- ─────────────────────────────────────────────────────────────────────────
-- THE ENGINE READ THE ROWS THE DATABASE READER READS.
-- A pricer that agrees on the arithmetic while resolving a different row is
-- still wrong, and it would only show up the day the owner changed something.
-- ─────────────────────────────────────────────────────────────────────────
DO $readings$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM public.ca_probe_engine_reading ORDER BY name, scope LOOP
    PERFORM public.probe_assert(
      r.value = public.fn_ca_diamond_economic(r.name, r.scope),
      format('the engine reads %s/%s as %s, and so does fn_ca_diamond_economic',
             r.name, r.scope, r.value));
  END LOOP;
END $readings$;

-- ─────────────────────────────────────────────────────────────────────────
-- EVERY SCENARIO, PRICED BY THE ENGINE AND SETTLED BY THE DATABASE.
-- ─────────────────────────────────────────────────────────────────────────
DO $agreement$
DECLARE
  s public.ca_probe_scenario%ROWTYPE;
  v_engine bigint;
  v_sql bigint;
  v_pot bigint;
  v_dealt integer;
  v_receipt jsonb;
  v_capped integer := 0;
  v_raked integer := 0;
  v_zero integer := 0;
BEGIN
  FOR s IN SELECT * FROM public.ca_probe_scenario ORDER BY hand_number LOOP
    SELECT rake INTO v_engine FROM public.ca_probe_engine_rake WHERE label = s.label;
    v_pot := (SELECT COALESCE(sum(c),0) FROM unnest(s.contributed) c);
    v_dealt := (SELECT count(*) FROM unnest(s.dealt_in) d WHERE d)::integer;
    v_sql := public.probe_scheduled_rake(s.bb, v_pot, v_dealt, s.saw_flop);

    -- (1) the engine and a separate SQL reading of the same rows agree
    PERFORM public.probe_assert(v_engine = v_sql, format(
      '%s: the engine charges %s and the published schedule says %s (pot %s, %s dealt, flop %s)',
      s.label, v_engine, v_sql, v_pot, v_dealt, s.saw_flop));

    -- (2) and the SETTLER accepts exactly that number, which is the proof:
    --     it recomputes from the rows and refuses anything else.
    v_receipt := public.probe_drive(s.label, v_engine);
    PERFORM public.probe_assert((v_receipt->>'success')::boolean,
      format('%s: the hand settles at the engine''s number', s.label));
    PERFORM public.probe_assert((v_receipt->>'rake')::bigint = v_engine,
      format('%s: the receipt states the rake the engine declared', s.label));
    PERFORM public.probe_assert((v_receipt->>'net_deltas')::bigint = -v_engine,
      format('%s: the stacks are short by exactly the rake', s.label));
    PERFORM public.probe_assert((v_receipt->'request'->'rake_facts'->>'pot')::bigint = v_pot,
      format('%s: the settler added the pot up to %s', s.label, v_pot));
    PERFORM public.probe_assert((v_receipt->'request'->'rake_facts'->>'dealt')::integer = v_dealt,
      format('%s: the settler counted %s dealt in', s.label, v_dealt));
    PERFORM public.probe_assert(
      (v_receipt->'request'->'rake_facts'->>'saw_flop')::boolean = s.saw_flop,
      format('%s: the settler read the hand''s flop fact', s.label));
    -- (3) every Diamond taken is attributed to a contributor, none is lost
    PERFORM public.probe_assert(
      COALESCE((SELECT sum(amount) FROM public.ca_diamond_rake_accrual
                 WHERE hand_number = s.hand_number AND kind = 'rake'),0) = v_engine,
      format('%s: the accrual sums to the rake exactly', s.label));

    -- (4) AND THE AGREEMENT IS NOT VACUOUS. One Diamond either side of the
    --     engine's number is refused by the recompute, so "it settled" means
    --     the number was checked rather than taken on trust. Only where a
    --     neighbouring number is a legal rake at all: below zero is refused
    --     by a different door, and above the pot by another.
    IF v_engine > 0 THEN
      PERFORM public.probe_refuses(s.label, v_engine - 1, 900, 'diamond_cash_rake_disagrees');
    END IF;
    IF v_engine + 1 <= v_pot THEN
      PERFORM public.probe_refuses(s.label, v_engine + 1, 901, 'diamond_cash_rake_disagrees');
    END IF;

    -- Coverage, counted rather than assumed.
    IF v_engine = 0 THEN v_zero := v_zero + 1; ELSE v_raked := v_raked + 1; END IF;
    IF v_engine = public.fn_ca_diamond_economic(
         'cash_rake_cap'||CASE WHEN v_dealt <= 2 THEN '_heads_up'
                               WHEN v_dealt = 3 THEN '_three_handed' ELSE '' END,
         'bb:'||s.bb::text)
    THEN v_capped := v_capped + 1; END IF;
  END LOOP;

  -- THE SCENARIOS REACH THE BRANCHES THEY CLAIM TO. A suite that happens to
  -- price every hand at zero would pass every assertion above and prove
  -- nothing about the schedule.
  PERFORM public.probe_assert(v_raked >= 10,
    format('at least ten hands were actually raked (got %s)', v_raked));
  PERFORM public.probe_assert(v_zero >= 4,
    format('at least four hands were raked nothing (got %s)', v_zero));
  PERFORM public.probe_assert(v_capped >= 7,
    format('at least seven hands were held to a published cap (got %s)', v_capped));
END $agreement$;

-- ─────────────────────────────────────────────────────────────────────────
-- AND THE CHIP SIDE IS UNTOUCHED: no Diamond rake reached a chip rake table.
-- ─────────────────────────────────────────────────────────────────────────
DO $chips$
BEGIN
  PERFORM public.probe_assert(
    (SELECT count(*) FROM public.ca_diamond_rake_accrual) > 0,
    'the Diamond rake was accrued in the Diamond arena''s own ledger');
  PERFORM public.probe_assert(
    NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name IN ('rake_records','rake_attributions')),
    'the probe never created a chip rake table, so nothing could have been written to one');
END $chips$;

\echo 'PASS: the engine prices every Diamond cash hand at the owner''s published number, and the settler recomputes the same number for every one of them'
