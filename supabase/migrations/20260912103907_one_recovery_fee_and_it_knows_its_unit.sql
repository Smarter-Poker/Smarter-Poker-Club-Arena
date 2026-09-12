-- ============================================================================
-- ONE RECOVERY FEE, AND IT KNOWS ITS UNIT
-- ============================================================================
--
-- The fee on a rebuy or a re-entry is not configured anywhere. It is DERIVED,
-- from the ratio the buy-in and its fee happen to stand in, and then truncated.
-- That derivation is written four times:
--
--   * fn_ca_tournament_charge_split                  (the refund authority)
--   * fn_ca_process_tournament_chip_purchase_money_v1 (the charge itself)
--   * fn_ca_tournament_escrow                        (inline, inside a query)
--   * tournamentPurchaseQuote in TournamentBrainContext.ts (the quote)
--
-- One rule, four spellings, and the same drift shape the prize ladder carried
-- until 20260912090000 collapsed it. This is the same repair for the same
-- reason, on the site the Phase 8 audit calls the worst of them: unlike every
-- other divider in the tournament path it runs on ORDINARY PLAY rather than at
-- settlement, and what it produces flows straight into prize_pool, which is the
-- pool everything else divides.
--
-- WHAT IS ACTUALLY WRONG WITH IT. `trunc(gross * ratio * 100 + eps) / 100`
-- truncates to a CENT, because a cent is hard-coded as the smallest amount
-- anybody can be paid. For a chip tournament that is correct. For a Diamond
-- tournament it is not: a Diamond does not divide, and a 10 Diamond rebuy at a
-- 10/110 fee ratio produces a fee of 0.90 and drops 9.10 Diamonds into the
-- prize pool. Nine and a tenth Diamonds is not an amount this estate can pay,
-- store or reserve.
--
-- THIS IS NOT A NEW RAKE RATE, and that distinction is the whole of the
-- argument for making the change at all. The rule already truncates the fee
-- DOWN to the smallest payable amount. The defect is that it believes the
-- smallest payable amount is always a cent. The fee is still the same ratio,
-- still capped at ten percent, still truncated down, still in the player's
-- favour. It is told what a unit is instead of assuming one, exactly as the
-- cash tables and then the prize ladder were.
--
-- THE CHIP PATH IS UNCHANGED BY CONSTRUCTION. Every chip tournament has a unit
-- of 1, and `trunc(trunc(x) / 1) * 1` is `trunc(x)`. Section 7 proves it over
-- every rebuy, add-on and buy-in this database has ever recorded rather than
-- asserting it.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Floor an amount of cents to a whole unit.
--    The identity at a unit of one cent, which is what keeps chips still.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_unit_floor_cents(
  p_cents bigint, p_unit_cents integer DEFAULT 1)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE
    WHEN p_cents IS NULL THEN NULL
    WHEN p_cents <= 0 THEN 0
    ELSE (trunc(p_cents::numeric
                / (CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                        THEN p_unit_cents::numeric ELSE 1 END))
          * (CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                  THEN p_unit_cents::numeric ELSE 1 END))::bigint
  END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_unit_floor_cents(bigint, integer) IS
  'An amount of cents floored to a whole unit of this table or tournament. The identity for chips, whose unit is one cent.';

-- ---------------------------------------------------------------------------
-- 2. The ratio a recovery fee is charged at.
--
--    Reproduced EXACTLY, including the part that would be tidier written
--    otherwise: the guard COALESCEs and the division does not, so a NULL
--    buy-in with a positive fee yields a NULL ratio rather than a ratio of 1.
--    No tournament in this database has a NULL buy-in or a NULL fee (161,452
--    checked), so the difference is unreachable, and reproducing it is still
--    cheaper than reasoning about whether it can be reached tomorrow.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_fee_ratio(
  p_buy_in numeric, p_buy_in_fee numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE
    WHEN COALESCE(p_buy_in,0) + COALESCE(p_buy_in_fee,0) > 0
         AND COALESCE(p_buy_in_fee,0) > 0
      THEN p_buy_in_fee / (p_buy_in + p_buy_in_fee)
    ELSE 0.1
  END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_tournament_fee_ratio(numeric, numeric) IS
  'The ratio a rebuy or re-entry fee is charged at, derived from the buy-in and its fee. The only place SQL decides it.';

-- ---------------------------------------------------------------------------
-- 3. The recovery fee itself, in cents, floored to the tournament's unit.
--
--    The epsilon is kept. It is not decoration: `gross * ratio` lands a hair
--    under a whole cent for ratios that are exact in decimal but not in the
--    scale numeric division returns, and without it the fee truncates a cent
--    low. Removing it would be a silent rake change on the chip estate.
--
--    Cents in, cents out, so nothing is re-rounded on the way, and the cap at
--    ten percent is floored to the unit too - a cap that is not on the grid is
--    not a cap the ladder can honour.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_recovery_fee_cents(
  p_gross_cents bigint, p_ratio numeric, p_unit_cents integer DEFAULT 1)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE
    WHEN p_gross_cents IS NULL OR p_gross_cents <= 0 THEN 0
    WHEN p_ratio IS NULL THEN NULL
    WHEN p_ratio <= 0 THEN 0
    ELSE LEAST(
      public.fn_ca_unit_floor_cents(
        trunc(p_gross_cents::numeric * p_ratio + 0.000001)::bigint, p_unit_cents),
      public.fn_ca_unit_floor_cents(
        trunc(p_gross_cents::numeric * 0.1 + 0.000001)::bigint, p_unit_cents))
  END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_recovery_fee_cents(bigint, numeric, integer) IS
  'The one recovery fee rule: the ratio, capped at ten percent, truncated down to the tournament unit. Mirrors tournamentPurchaseQuote in server/src/services/TournamentBrainContext.ts.';

-- THE DOOR, NAMED AT BIRTH. A function created in public here is granted
-- EXECUTE to anon, authenticated and service_role by this project's default
-- privileges, and on 2026-09-12 that turned a recreated SECURITY DEFINER
-- function into one a caller with no account could reach. These are closed in
-- the migration that declares them, naming PUBLIC as well as the roles,
-- because anon inherits whatever PUBLIC holds and revoking anon alone reads as
-- a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_ca_unit_floor_cents(bigint, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_fee_ratio(numeric, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_recovery_fee_cents(bigint, numeric, integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3b. WHAT THE TWO READ-ONLY AUTHORITIES SAY TODAY, recorded before a byte of
--     them changes. Section 7 asks them the same questions afterwards and
--     refuses to let the migration stand if a single answer moved.
--
--     Both are write-free, which is why they can be called here at all:
--     fn_ca_tournament_charge_split and fn_ca_tournament_escrow contain no
--     INSERT, UPDATE, DELETE or TRUNCATE. The money core in section 5 is NOT
--     called, before or after - a function that charges a player is not a
--     thing to invoke thousands of times inside a migration to prove a
--     division. Its arithmetic is compared instead, in section 7c.
--
--     A charge the split REFUSES is an answer too, so the refusals are
--     recorded alongside the amounts.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  r record; v_ans jsonb; v_ok boolean;
BEGIN
  DROP TABLE IF EXISTS _split_before;
  CREATE TEMP TABLE _split_before(
    tournament_id uuid, category text, gross numeric, priced boolean, answer jsonb);

  FOR r IN
    SELECT DISTINCT l.tournament_id, lower(l.category) AS category, round(l.amount,2) AS gross
      FROM public.chip_ledger l
     WHERE l.tournament_id IS NOT NULL
       AND lower(l.category) IN ('rebuy','addon','tournament_buyin')
       AND round(l.amount,2) > 0
     ORDER BY 1,2,3
     LIMIT 2000
  LOOP
    BEGIN
      SELECT jsonb_build_array(s.refund_prize, s.refund_bounty, s.refund_fee)
        INTO v_ans
        FROM public.fn_ca_tournament_charge_split(r.tournament_id, r.category, r.gross) s;
      v_ok := true;
    EXCEPTION WHEN OTHERS THEN
      v_ok := false; v_ans := NULL;
    END;
    INSERT INTO _split_before VALUES (r.tournament_id, r.category, r.gross, v_ok, v_ans);
  END LOOP;

  IF (SELECT count(*) FROM _split_before WHERE priced) = 0 THEN
    RAISE EXCEPTION 'no real charge could be split; the before-sample is empty';
  END IF;

  DROP TABLE IF EXISTS _escrow_before;
  CREATE TEMP TABLE _escrow_before(tournament_id uuid, answer jsonb);
  INSERT INTO _escrow_before
  SELECT t.id, to_jsonb(e.*)
    FROM (SELECT DISTINCT l.tournament_id AS id
            FROM public.chip_ledger l
           WHERE l.tournament_id IS NOT NULL
             AND lower(l.category) IN ('rebuy','addon')
           ORDER BY 1 LIMIT 150) t
    CROSS JOIN LATERAL public.fn_ca_tournament_escrow(t.id) e;

  IF (SELECT count(*) FROM _escrow_before) = 0 THEN
    RAISE EXCEPTION 'no escrow rows recorded; the before-sample is empty';
  END IF;

  RAISE NOTICE 'recorded % split answers and % escrow rows before the rewrite',
    (SELECT count(*) FROM _split_before), (SELECT count(*) FROM _escrow_before);
END;
$do$;

-- ---------------------------------------------------------------------------
-- 4. THE REFUND AUTHORITY: public.fn_ca_tournament_charge_split
--
--    Two replacements, each sliced out of the live definition between anchors
--    rather than retyped, so no whitespace can drift between what this
--    migration believes the function says and what it says.
--
--    The unit is read inline rather than held in a new local, so the DECLARE
--    block is untouched. fn_ca_tournament_unit_cents is STABLE and this is a
--    per-charge call, not a per-row one.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_a text;
  v_from integer; v_to integer; v_hits integer;
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_tournament_charge_split(uuid,text,numeric)'::regprocedure)
    INTO v_old;
  IF position('fn_ca_recovery_fee_cents' in v_old) > 0 THEN
    RAISE NOTICE 'charge_split already delegates; skipping';
    RETURN;
  END IF;

  -- 4a. the ratio and the fee
  v_from := position('    v_ratio := CASE' in v_old);
  IF v_from = 0 THEN RAISE EXCEPTION 'charge_split: ratio anchor not found'; END IF;
  v_to := v_from - 1 + position('trunc(v_gross*0.1*100+0.000001)/100);' in substr(v_old, v_from));
  IF v_to < v_from THEN RAISE EXCEPTION 'charge_split: fee anchor not found'; END IF;
  v_a := substr(v_old, v_from,
                v_to + length('trunc(v_gross*0.1*100+0.000001)/100);') - v_from + 1);
  v_hits := (length(v_old) - length(replace(v_old, v_a, ''))) / length(v_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'charge_split: ratio/fee block matched % times, expected 1', v_hits;
  END IF;
  v_new := replace(v_old, v_a, $r$    v_ratio := public.fn_ca_tournament_fee_ratio(
      v_t.buy_in_amount, v_t.buy_in_fee);
    v_fee := public.fn_ca_recovery_fee_cents(
      round(v_gross*100)::bigint, v_ratio,
      public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric / 100;$r$);

  -- 4b. the bounty head, floored to the same unit, so the prize remainder is
  --     whole by construction rather than by luck
  v_a := $a$    v_bounty := CASE WHEN v_is_bounty THEN LEAST(
      GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),v_gross-v_fee)
      ELSE 0 END;$a$;
  v_hits := (length(v_new) - length(replace(v_new, v_a, ''))) / length(v_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'charge_split: bounty block matched % times, expected 1', v_hits;
  END IF;
  v_new := replace(v_new, v_a, $r$    v_bounty := CASE WHEN v_is_bounty THEN
      public.fn_ca_unit_floor_cents(
        round(LEAST(GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),
                    v_gross-v_fee)*100)::bigint,
        public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric / 100
      ELSE 0 END;$r$);

  IF position('fn_ca_recovery_fee_cents' in v_new) = 0
     OR position('fn_ca_tournament_fee_ratio' in v_new) = 0
     OR position('fn_ca_unit_floor_cents' in v_new) = 0
     OR position('0.000001' in v_new) > 0 THEN
    RAISE EXCEPTION 'charge_split: rewrite did not take';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 5. THE CHARGE ITSELF: fn_ca_process_tournament_chip_purchase_money_v1
--
--    This is the function that moves the money, so it is the one that decides
--    what a rebuy actually costs and what reaches the pool. The add-on branch
--    keeps its zero ratio and therefore its zero fee, untouched.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_a text;
  v_from integer; v_to integer; v_hits integer;
  c_tail constant text := 'trunc(v_total*0.1*100+0.000001)/100)';
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure)
    INTO v_old;
  IF position('fn_ca_recovery_fee_cents' in v_old) > 0 THEN
    RAISE NOTICE 'chip purchase money core already delegates; skipping';
    RETURN;
  END IF;

  v_from := position('  v_fee_ratio:=CASE' in v_old);
  IF v_from = 0 THEN RAISE EXCEPTION 'money core: ratio anchor not found'; END IF;
  v_to := v_from - 1 + position(c_tail in substr(v_old, v_from));
  IF v_to < v_from THEN RAISE EXCEPTION 'money core: fee anchor not found'; END IF;
  v_a := substr(v_old, v_from, v_to + length(c_tail) - v_from + 1);
  IF position('v_ratio:=CASE WHEN p_rebuy_type=' in v_a) = 0
     OR position('v_total:=round(v_base::numeric);' in v_a) = 0 THEN
    RAISE EXCEPTION 'money core: sliced block is not the fee derivation';
  END IF;
  v_hits := (length(v_old) - length(replace(v_old, v_a, ''))) / length(v_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'money core: fee block matched % times, expected 1', v_hits;
  END IF;

  v_new := replace(v_old, v_a, $r$  v_fee_ratio:=public.fn_ca_tournament_fee_ratio(
    v_t.buy_in_amount,v_t.buy_in_fee);
  v_ratio:=CASE WHEN p_rebuy_type='addon' THEN 0 ELSE v_fee_ratio END;
  v_total:=round(v_base::numeric);
  v_fee:=CASE WHEN v_ratio>0 AND v_total>0
    THEN public.fn_ca_recovery_fee_cents(
           round(v_total*100)::bigint,v_ratio,
           public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100$r$);

  v_a := $a$    v_bounty_head:=LEAST(
      GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),v_base);$a$;
  v_hits := (length(v_new) - length(replace(v_new, v_a, ''))) / length(v_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'money core: bounty block matched % times, expected 1', v_hits;
  END IF;
  v_new := replace(v_new, v_a, $r$    v_bounty_head:=public.fn_ca_unit_floor_cents(
      round(LEAST(GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),
                  v_base)*100)::bigint,
      public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100;$r$);

  IF position('fn_ca_recovery_fee_cents' in v_new) = 0
     OR position('fn_ca_tournament_fee_ratio' in v_new) = 0
     OR position('fn_ca_unit_floor_cents' in v_new) = 0
     OR position('0.000001' in v_new) > 0 THEN
    RAISE EXCEPTION 'money core: rewrite did not take';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 6. THE ESCROW VIEW: public.fn_ca_tournament_escrow
--
--    It re-derives the same fee inline, inside a query, purely to work out how
--    much of a recovery charge was bounty. It is read-only, and it is still a
--    fourth copy of a rule that had no business being copied once.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_a text;
  v_from integer; v_to integer; v_hits integer;
  c_tail constant text := 'trunc(round(l.amount,2)*0.1*100+0.000001)/100))';
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_tournament_escrow(uuid)'::regprocedure) INTO v_old;
  IF position('fn_ca_recovery_fee_cents' in v_old) > 0 THEN
    RAISE NOTICE 'escrow already delegates; skipping';
    RETURN;
  END IF;

  v_from := position('    ELSE LEAST(' in v_old);
  IF v_from = 0 THEN RAISE EXCEPTION 'escrow: head anchor not found'; END IF;
  v_to := v_from - 1 + position(c_tail in substr(v_old, v_from));
  IF v_to < v_from THEN RAISE EXCEPTION 'escrow: tail anchor not found'; END IF;
  v_a := substr(v_old, v_from, v_to + length(c_tail) - v_from + 1);
  IF position('t.buy_in_fee/(t.buy_in_amount+t.buy_in_fee)' in v_a) = 0 THEN
    RAISE EXCEPTION 'escrow: sliced block is not the inline fee';
  END IF;
  v_hits := (length(v_old) - length(replace(v_old, v_a, ''))) / length(v_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'escrow: inline fee matched % times, expected 1', v_hits;
  END IF;

  v_new := replace(v_old, v_a, $r$    ELSE public.fn_ca_unit_floor_cents(
      round(LEAST(
        GREATEST(0,round(t.bounty_amount,2)),
        round(l.amount,2)-public.fn_ca_recovery_fee_cents(
          round(round(l.amount,2)*100)::bigint,
          public.fn_ca_tournament_fee_ratio(t.buy_in_amount,t.buy_in_fee),
          public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100
      )*100)::bigint,
      public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100$r$);

  IF position('fn_ca_recovery_fee_cents' in v_new) = 0
     OR position('0.000001' in v_new) > 0 THEN
    RAISE EXCEPTION 'escrow: rewrite did not take';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 7. THE CHIP ESTATE IS UNCHANGED, PROVED RATHER THAN ASSERTED.
-- ---------------------------------------------------------------------------

-- 7a. The refund authority gives the same answers it gave a moment ago, on
--     every real charge shape this database has recorded.
DO $do$
DECLARE
  r record; v_ans jsonb; v_ok boolean;
  v_checked integer := 0; v_drift integer := 0;
BEGIN
  -- Section 3b always runs and always records, and the table is session
  -- scoped so it survives whether this file is applied as one transaction or
  -- a statement at a time. Its absence means the proof did not happen, and a
  -- proof that did not happen is not a proof that passed.
  IF to_regclass('pg_temp._split_before') IS NULL THEN
    RAISE EXCEPTION 'the split before-sample is missing; the comparison never ran';
  END IF;
  FOR r IN SELECT * FROM _split_before ORDER BY tournament_id, category, gross LOOP
    BEGIN
      SELECT jsonb_build_array(s.refund_prize, s.refund_bounty, s.refund_fee)
        INTO v_ans
        FROM public.fn_ca_tournament_charge_split(r.tournament_id, r.category, r.gross) s;
      v_ok := true;
    EXCEPTION WHEN OTHERS THEN
      v_ok := false; v_ans := NULL;
    END;
    v_checked := v_checked + 1;
    IF v_ok IS DISTINCT FROM r.priced OR v_ans IS DISTINCT FROM r.answer THEN
      v_drift := v_drift + 1;
    END IF;
  END LOOP;
  IF v_checked = 0 THEN RAISE EXCEPTION 'split comparison checked nothing'; END IF;
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'the charge split changed its answer on % of % real charges',
      v_drift, v_checked;
  END IF;
  RAISE NOTICE 'charge split: % real charges split identically before and after', v_checked;
END;
$do$;

-- 7b. The escrow view reports the same balances it reported a moment ago.
DO $do$
DECLARE v_checked integer; v_drift integer;
BEGIN
  IF to_regclass('pg_temp._escrow_before') IS NULL THEN
    RAISE EXCEPTION 'the escrow before-sample is missing; the comparison never ran';
  END IF;
  SELECT count(*) INTO v_checked FROM _escrow_before;
  SELECT count(*) INTO v_drift
    FROM _escrow_before b
    CROSS JOIN LATERAL public.fn_ca_tournament_escrow(b.tournament_id) e
   WHERE to_jsonb(e.*) IS DISTINCT FROM b.answer;
  IF v_checked = 0 THEN RAISE EXCEPTION 'escrow comparison checked nothing'; END IF;
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'escrow changed on % of % real tournaments', v_drift, v_checked;
  END IF;
  RAISE NOTICE 'escrow: % real tournaments report identically before and after', v_checked;
END;
$do$;

-- 7c. THE MONEY CORE'S ARITHMETIC, compared without invoking it.
--
--     A reference copy of the exact pre-change expression is built in pg_temp
--     and run against the new helper over EVERY recovery and buy-in amount
--     this database has ever recorded, paired with every fee ratio any
--     tournament actually configures. That is the whole reachable input space
--     of the rule, not a sample of it.
CREATE FUNCTION pg_temp.old_recovery_fee(p_gross numeric, p_ratio numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN p_ratio > 0 AND p_gross > 0
    THEN LEAST(trunc(p_gross*p_ratio*100+0.000001)/100,
               trunc(p_gross*0.1*100+0.000001)/100)
    ELSE 0 END;
$f$;

DO $do$
DECLARE v_pairs bigint; v_drift bigint; v_diamond bigint;
BEGIN
  DROP TABLE IF EXISTS _fee_grid;
  CREATE TEMP TABLE _fee_grid AS
  WITH g AS (
    SELECT DISTINCT round(l.amount,2) AS gross
      FROM public.chip_ledger l
     WHERE l.tournament_id IS NOT NULL
       AND lower(l.category) IN ('rebuy','addon','tournament_buyin')
       AND round(l.amount,2) > 0
  ), r AS (
    SELECT DISTINCT public.fn_ca_tournament_fee_ratio(t.buy_in_amount, t.buy_in_fee) AS ratio
      FROM public.tournaments t
  )
  SELECT g.gross, r.ratio FROM g, r WHERE r.ratio IS NOT NULL;

  SELECT count(*) INTO v_pairs FROM _fee_grid;
  IF v_pairs = 0 THEN
    RAISE EXCEPTION 'recovery fee grid is empty; refusing to claim it passed';
  END IF;

  SELECT count(*) INTO v_drift FROM _fee_grid f
   WHERE public.fn_ca_recovery_fee_cents(
           round(f.gross*100)::bigint, f.ratio, 1)::numeric / 100
         IS DISTINCT FROM pg_temp.old_recovery_fee(f.gross, f.ratio);
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'the recovery fee changed on % of % real gross/ratio pairs',
      v_drift, v_pairs;
  END IF;

  -- And the Diamond half: at a unit of one Diamond the fee is always a whole
  -- Diamond, never above the ten percent cap, and never more than the charge.
  SELECT count(*) INTO v_diamond FROM _fee_grid f
   WHERE round(f.gross*100) % 100 = 0
     AND (public.fn_ca_recovery_fee_cents(round(f.gross*100)::bigint, f.ratio, 100) % 100 <> 0
       OR public.fn_ca_recovery_fee_cents(round(f.gross*100)::bigint, f.ratio, 100)
            > trunc(round(f.gross*100) * 0.1)
       OR public.fn_ca_recovery_fee_cents(round(f.gross*100)::bigint, f.ratio, 100)
            > round(f.gross*100));
  IF v_diamond <> 0 THEN
    RAISE EXCEPTION 'the Diamond recovery fee is not whole, or breaks its cap, on % pairs',
      v_diamond;
  END IF;

  RAISE NOTICE 'recovery fee: % real gross/ratio pairs identical for chips and whole for Diamonds',
    v_pairs;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 8. ALL FOUR SQL SITES READ THE ONE RULE, AND THE NEW DOORS ARE SHUT.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_missing text := '';
  v_open text := '';
  v_fn text;
  v_owner oid;
  c_sites constant text[] := ARRAY[
    'public.fn_ca_tournament_charge_split(uuid,text,numeric)',
    'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)',
    'public.fn_ca_tournament_escrow(uuid)'
  ];
  c_new constant text[] := ARRAY[
    'public.fn_ca_unit_floor_cents(bigint,integer)',
    'public.fn_ca_tournament_fee_ratio(numeric,numeric)',
    'public.fn_ca_recovery_fee_cents(bigint,numeric,integer)'
  ];
BEGIN
  FOREACH v_fn IN ARRAY c_sites LOOP
    IF position('fn_ca_recovery_fee_cents' in pg_get_functiondef(v_fn::regprocedure)) = 0 THEN
      v_missing := v_missing || ' ' || v_fn;
    END IF;
    IF position('0.000001' in pg_get_functiondef(v_fn::regprocedure)) > 0 THEN
      v_missing := v_missing || ' ' || v_fn || '(still truncates its own)';
    END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'these sites do not read the one recovery fee rule:%', v_missing;
  END IF;

  -- A NULL proacl is the built-in default, and the built-in default for a
  -- function is EXECUTE to PUBLIC. aclexplode(NULL) returns no rows, so an
  -- EXISTS over it reports "no grants" for the most open state there is.
  FOREACH v_fn IN ARRAY c_new LOOP
    SELECT proowner INTO v_owner FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF (SELECT proacl IS NULL FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      v_open := v_open || ' ' || v_fn || '(default-open)';
    ELSIF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                   WHERE p.oid = v_fn::regprocedure AND a.grantee IS DISTINCT FROM v_owner) THEN
      v_open := v_open || ' ' || v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      v_open := v_open || ' ' || v_fn || '(reachable)';
    END IF;
  END LOOP;
  IF v_open <> '' THEN
    RAISE EXCEPTION 'these new functions are reachable by someone other than their owner:%', v_open;
  END IF;

  RAISE NOTICE 'recovery fee: three sites delegate, three new functions are owner-only';
END;
$do$;

-- ---------------------------------------------------------------------------
-- 9. The scratch the proofs were written on. Session scoped rather than
--    ON COMMIT DROP, so that a missing sample in section 7 means the
--    comparison never ran rather than that the harness tidied up early.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS _split_before;
DROP TABLE IF EXISTS _escrow_before;
DROP TABLE IF EXISTS _fee_grid;
