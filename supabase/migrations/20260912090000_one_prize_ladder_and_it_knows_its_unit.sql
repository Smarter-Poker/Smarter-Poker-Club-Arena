-- ============================================================================
-- ONE PRIZE LADDER, AND IT KNOWS ITS UNIT
-- ============================================================================
--
-- The rule for turning a prize pool into per-place amounts was written FOUR
-- times: `fn_ca_tournament_place_amounts` (the payer),
-- `fn_tournament_place_prize_exact` (the reprice path), a third copy inside
-- `fn_tournament_payout_reconcile` (which exists to CHECK the others), and
-- `computePlacePrize` in TypeScript. Two languages, four spellings, one rule.
--
-- That is the drift shape this estate was bitten by twice on 2026-09-12 alone:
-- the plain-cash rule had become five rules, and the games list five copies.
-- The TypeScript pair is at least held together by
-- tests/payout-one-rule-everywhere.law.test.ts, which compares the two files
-- byte for byte. Nothing held the three SQL copies to anything.
--
-- They are one function now: `fn_ca_prize_ladder`. The three callers keep
-- their own validation, which legitimately differs - the payer knows about
-- spins, bubble protection and trimming to the final field; the reprice path
-- is pure; the reconciler is read-only - and hand the ARITHMETIC to one place.
-- The seam is the division, which is the part that drifted.
--
-- AND IT TAKES THE UNIT. A Diamond does not divide, and the prize ladder was
-- the last place in the estate still assuming a cent. `computePlacePrize`
-- learned this on 2026-09-12; this is the SQL half of the same change, and the
-- two now implement one rule in the one place each language keeps it.
--
-- THE CHIP PATH IS UNCHANGED BY CONSTRUCTION, not by inspection. Every chip
-- tournament has a unit of 1, `round(round(x) / 1) * 1` is `round(x)`, and the
-- short-field branch is gated on the unit being larger than a cent. That
-- gating is a scope decision rather than a claim the chip rule is right: the
-- same defect is in the chip ladder at pools under one unit per place, and
-- repairing it there means moving payoutExactness.law.test.ts's BigInt
-- reference in the same commit. See server/src/tournament/payoutMath.ts.
--
-- THE FOURTH SITE IS A CALLER, NOT A COPY. fn_complete_tournament_entry_reprice
-- owns the only call to the pure reprice path in the database, and it is the
-- only place that knows which tournament is being repriced, so it is where the
-- unit is looked up and handed down. Section 7.
--
-- WHAT IS NOT IN SCOPE, said plainly rather than left to be discovered. The
-- reconciler keeps its own entry semantics: it reads the stored structure
-- verbatim, with no de-duplication and no place filter, exactly as it did
-- yesterday. Three malformed shapes exist where that would disagree with the
-- ladder's index-based residual, and all three are unreachable - across the
-- 160,955 tournaments in this database carrying an array payout structure
-- there are zero duplicate places, zero non-positive percentages and zero
-- malformed places, and the payer rejects every one of those shapes outright.
-- Section 5 says so at the site.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. What unit does this tournament pay in?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unit_cents(p_tournament_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id
       AND c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
  ) THEN 100 ELSE 1 END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_tournament_unit_cents(uuid) IS
  'The smallest amount this tournament can pay, in cents: 100 for a Diamond arena tournament, 1 for every chip one. The only place SQL answers this.';

-- ---------------------------------------------------------------------------
-- 2. A payout structure, cleaned into the one shape the ladder reads.
--
--    A FAITHFUL MIRROR OF computePlacePrize's normalisation, including the
--    part that looks like a bug and is not: a place whose percentage is zero
--    or malformed is KEPT, clamped to zero basis points, because the
--    TypeScript keeps it and so does fn_tournament_place_prize_exact. It
--    matters. The residual goes to the LAST entry, so dropping a trailing
--    zero-percentage place would move the residual to a different player.
--    Only places below 1 and duplicates are dropped, and the first entry for
--    a duplicate place wins, exactly as `find` did.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_prize_entries(p_structure jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('place', place, 'bp', bp)
                            ORDER BY place), '[]'::jsonb)
    FROM (
      SELECT DISTINCT ON (place) place, round(pct * 100)::bigint AS bp
        FROM (
          SELECT e.ordinality,
                 CASE WHEN COALESCE(e.value->>'place','') ~ '^[0-9]+$'
                      THEN (e.value->>'place')::integer END AS place,
                 CASE WHEN COALESCE(e.value->>'percentage','') ~ '^[0-9]+([.][0-9]+)?$'
                      THEN GREATEST((e.value->>'percentage')::numeric, 0) ELSE 0 END AS pct
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(p_structure) = 'array'
                        THEN p_structure ELSE '[]'::jsonb END
                 ) WITH ORDINALITY e(value, ordinality)
        ) n
       WHERE place > 0
       ORDER BY place, ordinality
    ) c;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The ladder. Cents in, cents out, so nothing is re-rounded on the way.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_prize_ladder(
  p_pool_cents bigint, p_entries jsonb, p_unit_cents integer DEFAULT 1)
RETURNS TABLE(place integer, cents bigint)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_unit bigint;
  v_total_bp bigint;
  v_count integer;
  v_places integer[];
  v_bps bigint[];
  v_remaining bigint;
  v_share bigint;
  i integer;
BEGIN
  v_unit := CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                 THEN p_unit_cents::bigint ELSE 1 END;
  IF p_pool_cents IS NULL OR p_pool_cents <= 0
     OR p_entries IS NULL OR jsonb_typeof(p_entries) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_entries) = 0 THEN
    RETURN;
  END IF;

  SELECT array_agg((e->>'place')::integer ORDER BY (e->>'place')::integer),
         array_agg((e->>'bp')::bigint ORDER BY (e->>'place')::integer),
         COALESCE(sum((e->>'bp')::bigint), 0),
         count(*)
    INTO v_places, v_bps, v_total_bp, v_count
    FROM jsonb_array_elements(p_entries) e;
  IF v_total_bp <= 0 OR v_count = 0 THEN RETURN; END IF;

  -- THE SHORT FIELD. A pool holding fewer units than there are places pays the
  -- places it CAN, one unit each from the top. Left alone, every share below
  -- rounds to zero and the last place absorbs the pool as its "residual": the
  -- whole prize to the last finisher and nothing to the first. An indivisible
  -- unit cannot be split nine ways, and every other answer pays somebody more
  -- than the player who beat them.
  IF v_unit > 1 AND (p_pool_cents / v_unit) < v_count THEN
    FOR i IN 1..v_count LOOP
      place := v_places[i];
      cents := CASE WHEN i <= (p_pool_cents / v_unit) THEN v_unit ELSE 0 END;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  -- Spend down in place order; the LAST paid place takes whatever remains, so
  -- the places sum to the pool exactly rather than by hoping the rounding
  -- cancels, and the adjustment lands on the smallest prize.
  v_remaining := p_pool_cents;
  FOR i IN 1..v_count LOOP
    IF i = v_count THEN
      v_share := v_remaining;
    ELSE
      v_share := LEAST(v_remaining,
        (round(round((p_pool_cents::numeric * v_bps[i]::numeric) / v_total_bp::numeric)
               / v_unit::numeric) * v_unit)::bigint);
    END IF;
    v_share := GREATEST(v_share, 0);
    v_remaining := v_remaining - v_share;
    place := v_places[i];
    cents := v_share;
    RETURN NEXT;
  END LOOP;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'prize ladder left % cents undistributed', v_remaining
      USING ERRCODE = '23514';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_prize_ladder(bigint, jsonb, integer) IS
  'The one prize ladder. Mirrors computePlacePrize in server/src/tournament/payoutMath.ts; the three SQL callers keep their own validation and hand the arithmetic here.';

COMMENT ON FUNCTION public.fn_ca_prize_entries(jsonb) IS
  'A payout structure normalised to [{place,bp}] exactly as computePlacePrize normalises it, zero-percentage places included so the residual still lands on the same player.';

-- ---------------------------------------------------------------------------
-- 4. THE PAYER (site 1): public.fn_ca_tournament_place_amounts
--
--    It keeps every piece of judgement it owns - the Spin ladders, the
--    stored-structure validation, the trim to the final field, the Bubble
--    reserve and its own per-place sanity check - and hands the DIVISION to
--    fn_ca_prize_ladder.
--
--    EXACT BY CONSTRUCTION, not by inspection. v_trimmed is already
--    [{place,bp}] ordered by place; it can never hold a non-positive bp
--    because the validation loop above fails the whole candidate on
--    `v_bp <= 0`; and v_count and v_total_bp are computed from v_trimmed by
--    the same aggregates the ladder recomputes from the same jsonb.
--
--    The old block is not retyped here. It is SLICED OUT OF THE LIVE
--    DEFINITION between two anchors and replaced, so no whitespace can drift
--    between what this migration thinks the function says and what it says.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_a text; v_r text;
  v_from integer; v_to integer; v_hits integer;
  v_tid uuid; v_ans jsonb;
  c_head constant text := '  v_remaining := v_pool_cents;';
  c_tail constant text := '    v_remaining := v_remaining - v_share;';
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_tournament_place_amounts(uuid)'::regprocedure)
    INTO v_old;
  IF position('fn_ca_prize_ladder' in v_old) > 0 THEN
    RAISE NOTICE 'place_amounts already delegates to fn_ca_prize_ladder; skipping';
    RETURN;
  END IF;

  v_from := position(c_head in v_old);
  IF v_from = 0 THEN RAISE EXCEPTION 'place_amounts: head anchor not found'; END IF;
  v_to := v_from - 1 + position(c_tail in substr(v_old, v_from));
  IF v_to < v_from THEN RAISE EXCEPTION 'place_amounts: tail anchor not found'; END IF;

  v_a := substr(v_old, v_from, v_to + length(c_tail) + 1 - v_from);

  IF position(E'\n' in right(v_a, 1)) = 0 THEN
    RAISE EXCEPTION 'place_amounts: sliced block does not end at a line break';
  END IF;
  IF position('jsonb_array_elements(v_trimmed)' in v_a) = 0
     OR position('v_total_bp::numeric' in v_a) = 0
     OR position('v_index = v_count' in v_a) = 0 THEN
    RAISE EXCEPTION 'place_amounts: sliced block is not the ladder';
  END IF;
  v_hits := (length(v_old) - length(replace(v_old, v_a, ''))) / length(v_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'place_amounts: ladder block matched % times, expected 1', v_hits;
  END IF;

  v_r := $r$  v_remaining := v_pool_cents;
  FOR v_entry IN
    SELECT jsonb_build_object('place', l.place, 'cents', l.cents)
      FROM public.fn_ca_prize_ladder(
             v_pool_cents,
             v_trimmed,
             public.fn_ca_tournament_unit_cents(p_tournament_id)) l
     ORDER BY l.place
  LOOP
    v_index := v_index + 1;
    v_place := (v_entry->>'place')::integer;
    v_share := (v_entry->>'cents')::bigint;
    v_remaining := v_remaining - v_share;
$r$;

  v_new := replace(v_old, v_a, v_r);
  IF v_new = v_old
     OR position('fn_ca_prize_ladder' in v_new) = 0
     OR position('fn_ca_tournament_unit_cents' in v_new) = 0
     OR position('v_total_bp::numeric' in v_new) > 0 THEN
    RAISE EXCEPTION 'place_amounts: rewrite did not take';
  END IF;

  -- WHAT THE PAYER SAYS TODAY, recorded before a byte of it changes. Section
  -- 8b asks the rewritten function the same questions and refuses to let the
  -- migration stand if a single answer moved. A tournament the payer REFUSES
  -- to price is an answer too, so the refusals are recorded alongside.
  CREATE TEMP TABLE _payer_before(tournament_id uuid, priced boolean, answer jsonb)
    ON COMMIT DROP;
  FOR v_tid IN
    SELECT id FROM public.tournaments
     WHERE status = 'COMPLETED' AND COALESCE(prize_pool, 0) > 0
     ORDER BY id LIMIT 500
  LOOP
    BEGIN
      SELECT jsonb_agg(jsonb_build_array(a.place, a.amount) ORDER BY a.place)
        INTO v_ans FROM public.fn_ca_tournament_place_amounts(v_tid) a;
      INSERT INTO _payer_before VALUES (v_tid, true, v_ans);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _payer_before VALUES (v_tid, false, NULL);
    END;
  END LOOP;
  IF (SELECT count(*) FROM _payer_before WHERE priced) = 0 THEN
    RAISE EXCEPTION 'no completed tournament could be priced; the before-sample is empty';
  END IF;

  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 5. THE CHECKER (site 3): public.fn_tournament_payout_reconcile
--
--    THIS ONE IS NOT OPTIONAL AND IT IS NOT COSMETIC. The reconciler does not
--    merely report; it TOPS UP a place it believes was underpaid. If the payer
--    snapped a Diamond prize to a whole Diamond and the checker still divided
--    to the cent, the checker would read every Diamond tournament as underpaid
--    by up to 99 cents a place and pay the difference - manufacturing the
--    overpayment it exists to detect. That is not a hypothetical: it is
--    precisely what happened on 2026-08-29 with the Union Morning Classic,
--    described at length in server/src/tournament/payoutMath.ts. The payer and
--    the checker must learn the unit in the same migration or not at all.
--
--    Its own entry semantics are UNTOUCHED. It reads v_struct verbatim - no
--    de-duplication, no place filter, no percentage filter - exactly as it did
--    before, and the ladder is handed those same entries. The three shapes
--    where the ladder's index-based residual could differ from this function's
--    max(place) residual all require a malformed structure, and across the
--    160,955 tournaments in this database that carry an array payout structure
--    there are zero duplicate places, zero non-positive percentages and zero
--    malformed places. The divergence is unreachable, and the payer rejects
--    every one of those shapes outright in any case.
--
--    The guard above this block (v_pool <= 0 OR empty structure -> skipped,
--    and v_total_bp <= 0 -> skipped) means the ladder is never called with a
--    non-positive pool, so its empty-set return is unreachable here.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_a text; v_r text;
  v_from integer; v_to integer; v_hits integer;
  c_head constant text := '  FOR r IN';
  c_tail constant text := '    v_remaining := v_remaining - v_cents;';
BEGIN
  SELECT pg_get_functiondef('public.fn_tournament_payout_reconcile(uuid,boolean)'::regprocedure)
    INTO v_old;
  IF position('fn_ca_prize_ladder' in v_old) > 0 THEN
    RAISE NOTICE 'payout_reconcile already delegates to fn_ca_prize_ladder; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_old) - length(replace(v_old, c_head, ''))) / length(c_head);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'payout_reconcile: "FOR r IN" matched % times, expected 1', v_hits;
  END IF;

  v_from := position(c_head in v_old);
  v_to := v_from - 1 + position(c_tail in substr(v_old, v_from));
  IF v_to < v_from THEN RAISE EXCEPTION 'payout_reconcile: tail anchor not found'; END IF;

  v_a := substr(v_old, v_from, v_to + length(c_tail) + 1 - v_from);

  IF position('r.place = v_last_place' in v_a) = 0
     OR position('round(v_pool_cents * r.bp / v_total_bp)' in v_a) = 0
     OR position('jsonb_array_elements(v_struct)' in v_a) = 0 THEN
    RAISE EXCEPTION 'payout_reconcile: sliced block is not the ladder';
  END IF;
  v_hits := (length(v_old) - length(replace(v_old, v_a, ''))) / length(v_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'payout_reconcile: ladder block matched % times, expected 1', v_hits;
  END IF;

  v_r := $r$  FOR r IN
    SELECT l.place AS place, l.cents AS cents
      FROM public.fn_ca_prize_ladder(
             v_pool_cents::bigint,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'place', (e->>'place')::int,
                       'bp',    round((e->>'percentage')::numeric * 100)::bigint)
                     ORDER BY (e->>'place')::int), '[]'::jsonb)
                FROM jsonb_array_elements(v_struct) e),
             public.fn_ca_tournament_unit_cents(p_tournament_id)) l
     ORDER BY l.place
  LOOP
    v_cents := r.cents;
    v_remaining := v_remaining - v_cents;
$r$;

  v_new := replace(v_old, v_a, v_r);
  IF v_new = v_old
     OR position('fn_ca_prize_ladder' in v_new) = 0
     OR position('fn_ca_tournament_unit_cents' in v_new) = 0
     OR position('r.bp' in v_new) > 0 THEN
    RAISE EXCEPTION 'payout_reconcile: rewrite did not take';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 6. THE REPRICE PATH (site 2): public.fn_tournament_place_prize_exact
--
--    This one is PURE - IMMUTABLE, and it is handed a pool and a structure
--    with no tournament id anywhere in its arguments - so it cannot look the
--    unit up. It has to be told. That is a signature change rather than a
--    body change, and a signature change means DROP and CREATE.
--
--    Safe to drop: pg_depend reports no dependent object of any kind, and the
--    only reference to it in the whole database is inside the plpgsql body of
--    fn_complete_tournament_entry_reprice, which is rewritten in section 7
--    below to pass the unit. The new parameter carries DEFAULT 1, so any
--    three-argument call that outlives this migration still resolves, and
--    still resolves to a cent.
--
--    It is SECURITY DEFINER with an ACL of {postgres=X/postgres}: PUBLIC has
--    no EXECUTE. A fresh CREATE grants EXECUTE to PUBLIC by default, so the
--    REVOKE below is not tidiness, it is restoring the door to where it was.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_tournament_place_prize_exact(numeric, text, integer);

CREATE OR REPLACE FUNCTION public.fn_tournament_place_prize_exact(
  p_pool numeric, p_structure text, p_place integer, p_unit_cents integer DEFAULT 1)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cents bigint;
BEGIN
  IF p_place IS NULL THEN RETURN 0; END IF;
  SELECT l.cents INTO v_cents
    FROM public.fn_ca_prize_ladder(
           GREATEST(round(COALESCE(p_pool, 0) * 100), 0)::bigint,
           public.fn_ca_prize_entries(public.fn_safe_jsonb_array(p_structure)),
           p_unit_cents) l
   WHERE l.place = p_place;
  RETURN (COALESCE(v_cents, 0)::numeric / 100);
END;
$function$;

REVOKE ALL ON FUNCTION
  public.fn_tournament_place_prize_exact(numeric, text, integer, integer) FROM PUBLIC;

COMMENT ON FUNCTION public.fn_tournament_place_prize_exact(numeric, text, integer, integer) IS
  'One place of the prize ladder, priced from a pool and a structure alone. Pure, so the unit arrives as an argument; the arithmetic is fn_ca_prize_ladder.';

-- ---------------------------------------------------------------------------
-- 7. THE ONE CALLER of the reprice path tells it the unit.
--    Satellite closeout is the only branch that prices places this way; the
--    cash branch already derives from fn_ca_tournament_place_amounts, which
--    learned the unit in section 4.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_hits integer;
  c_a constant text := 'tp.position) AS expected';
  c_b constant text := 'tp.position,
          public.fn_ca_tournament_unit_cents(p_tournament_id)) AS expected';
BEGIN
  SELECT pg_get_functiondef('public.fn_complete_tournament_entry_reprice(uuid)'::regprocedure)
    INTO v_old;
  IF position('fn_ca_tournament_unit_cents' in v_old) > 0 THEN
    RAISE NOTICE 'entry_reprice already passes the unit; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_old) - length(replace(v_old, c_a, ''))) / length(c_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'entry_reprice: call-site anchor matched % times, expected 1', v_hits;
  END IF;
  IF position('fn_tournament_place_prize_exact' in v_old) = 0 THEN
    RAISE EXCEPTION 'entry_reprice: no call to fn_tournament_place_prize_exact';
  END IF;

  v_new := replace(v_old, c_a, c_b);
  IF v_new = v_old OR position('fn_ca_tournament_unit_cents' in v_new) = 0 THEN
    RAISE EXCEPTION 'entry_reprice: rewrite did not take';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 8. THE CHIP LADDER IS UNCHANGED, PROVED RATHER THAN ASSERTED.
--
--    A reference copy of the PRE-CHANGE arithmetic is built in pg_temp and
--    run against the new ladder at unit = 1, over every distinct payout
--    structure this database actually stores crossed with a set of pools
--    chosen to land on the interesting rounding boundaries - including 513.00
--    and 483.00, the two pools named in payoutMath.ts as having produced real
--    one-cent errors. If the new ladder disagrees with the old rule anywhere
--    in that grid, this migration aborts and nothing is applied.
--
--    The same grid then proves the Diamond half: at unit = 100 every place is
--    a whole number of Diamonds and the places still sum to the pool exactly.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.old_ladder(p_pool_cents bigint, p_entries jsonb)
RETURNS TABLE(place integer, cents bigint)
LANGUAGE plpgsql AS $f$
DECLARE
  v_total_bp bigint; v_count integer; v_places integer[]; v_bps bigint[];
  v_remaining bigint; v_share bigint; i integer;
BEGIN
  IF p_pool_cents IS NULL OR p_pool_cents <= 0 OR p_entries IS NULL
     OR jsonb_typeof(p_entries) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_entries) = 0 THEN RETURN; END IF;
  SELECT array_agg((e->>'place')::integer ORDER BY (e->>'place')::integer),
         array_agg((e->>'bp')::bigint ORDER BY (e->>'place')::integer),
         COALESCE(sum((e->>'bp')::bigint), 0), count(*)
    INTO v_places, v_bps, v_total_bp, v_count
    FROM jsonb_array_elements(p_entries) e;
  IF v_total_bp <= 0 OR v_count = 0 THEN RETURN; END IF;
  v_remaining := p_pool_cents;
  FOR i IN 1..v_count LOOP
    IF i = v_count THEN
      v_share := v_remaining;
    ELSE
      v_share := LEAST(v_remaining,
        round((p_pool_cents::numeric * v_bps[i]::numeric) / v_total_bp::numeric)::bigint);
    END IF;
    v_share := GREATEST(v_share, 0);
    v_remaining := v_remaining - v_share;
    place := v_places[i]; cents := v_share; RETURN NEXT;
  END LOOP;
END;
$f$;

DO $do$
DECLARE
  v_structures integer;
  v_drift integer;
  v_unsnapped integer;
BEGIN
  CREATE TEMP TABLE _ladder_grid ON COMMIT DROP AS
  WITH s AS (
    SELECT DISTINCT public.fn_ca_prize_entries(
             public.fn_safe_jsonb_array(t.payout_structure::text)) AS entries
      FROM public.tournaments t
     WHERE t.payout_structure IS NOT NULL
     LIMIT 400
  ), p(pool_cents) AS (
    SELECT unnest(ARRAY[1,2,7,9,13,99,100,101,199,4830,5130,48300,51300,
                        100000,123457,999999,1000000]::bigint[])
  )
  SELECT s.entries, p.pool_cents FROM s, p
   WHERE jsonb_array_length(s.entries) > 0;

  SELECT count(*) INTO v_structures FROM _ladder_grid;
  IF v_structures = 0 THEN
    RAISE EXCEPTION 'chip-invariance grid is empty; refusing to claim it passed';
  END IF;

  SELECT count(*) INTO v_drift FROM _ladder_grid g
   WHERE (SELECT jsonb_agg(jsonb_build_array(l.place, l.cents) ORDER BY l.place)
            FROM public.fn_ca_prize_ladder(g.pool_cents, g.entries, 1) l)
         IS DISTINCT FROM
         (SELECT jsonb_agg(jsonb_build_array(o.place, o.cents) ORDER BY o.place)
            FROM pg_temp.old_ladder(g.pool_cents, g.entries) o);
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'chip ladder changed on % of % grid points; aborting',
      v_drift, v_structures;
  END IF;

  SELECT count(*) INTO v_unsnapped FROM _ladder_grid g
   WHERE EXISTS (SELECT 1 FROM public.fn_ca_prize_ladder(g.pool_cents * 100, g.entries, 100) l
                  WHERE l.cents % 100 <> 0 OR l.cents < 0)
      OR COALESCE((SELECT sum(l.cents)
                     FROM public.fn_ca_prize_ladder(g.pool_cents * 100, g.entries, 100) l), 0)
         NOT IN (0, g.pool_cents * 100);
  IF v_unsnapped <> 0 THEN
    RAISE EXCEPTION 'Diamond ladder failed to snap or to sum on % of % grid points',
      v_unsnapped, v_structures;
  END IF;

  RAISE NOTICE 'prize ladder: % grid points, chip answers identical, Diamond answers whole',
    v_structures;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 8b. THE PAYER GIVES THE SAME ANSWERS IT GAVE BEFORE, on real tournaments.
--
--     Section 4 recorded what fn_ca_tournament_place_amounts said about 500
--     real completed tournaments while it still contained its own arithmetic.
--     The rewritten function is now asked the same 500 questions. Every
--     answer must match to the cent, and a tournament it refused to price
--     must still be refused. This is the end-to-end proof: not that the new
--     ladder computes the same numbers in isolation, but that the function
--     the platform actually pays from produces the same output it did an
--     instant ago.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_tid uuid; v_ans jsonb; v_priced boolean;
  v_checked integer := 0; v_drift integer := 0;
BEGIN
  -- Section 4 skips its rewrite if the payer already delegates, and in that
  -- case it records no before-sample. There is then nothing to compare and
  -- nothing to prove, which is not the same as a proof that passed.
  IF to_regclass('pg_temp._payer_before') IS NULL THEN
    RAISE NOTICE 'no before-sample recorded (the payer already delegated); nothing to compare';
    RETURN;
  END IF;

  FOR v_tid IN SELECT tournament_id FROM _payer_before ORDER BY tournament_id LOOP
    BEGIN
      SELECT jsonb_agg(jsonb_build_array(a.place, a.amount) ORDER BY a.place)
        INTO v_ans FROM public.fn_ca_tournament_place_amounts(v_tid) a;
      v_priced := true;
    EXCEPTION WHEN OTHERS THEN
      v_priced := false; v_ans := NULL;
    END;
    v_checked := v_checked + 1;
    IF NOT EXISTS (
      SELECT 1 FROM _payer_before b
       WHERE b.tournament_id = v_tid
         AND b.priced = v_priced
         AND b.answer IS NOT DISTINCT FROM v_ans
    ) THEN
      v_drift := v_drift + 1;
    END IF;
  END LOOP;

  IF v_checked = 0 THEN
    RAISE EXCEPTION 'payer before/after comparison checked nothing';
  END IF;
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'the payer changed its answer on % of % real tournaments',
      v_drift, v_checked;
  END IF;
  RAISE NOTICE 'payer: % real tournaments priced identically before and after', v_checked;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 8c. THE CHECKER'S ARITHMETIC IS THE SAME ARITHMETIC, on real tournaments.
--
--     fn_tournament_payout_reconcile is not called here. Calling it would
--     exercise its payment machinery to prove a division, and a function that
--     tops money up is not a thing to invoke 2,000 times inside a migration to
--     satisfy curiosity. What changed inside it is one block of arithmetic, so
--     that block is what gets compared: its exact pre-change rule, rebuilt in
--     pg_temp, against the exact expression it now delegates to, over the real
--     completed tournaments it would actually reconcile.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.old_reconcile_ladder(p_pool_cents numeric, p_struct jsonb)
RETURNS TABLE(place integer, cents numeric)
LANGUAGE plpgsql AS $f$
DECLARE
  v_last_place int; v_total_bp numeric; v_remaining numeric; v_cents numeric; r record;
BEGIN
  SELECT max((e->>'place')::int) INTO v_last_place FROM jsonb_array_elements(p_struct) e;
  SELECT COALESCE(SUM(round((e->>'percentage')::numeric * 100)), 0) INTO v_total_bp
    FROM jsonb_array_elements(p_struct) e;
  IF v_total_bp <= 0 OR v_last_place IS NULL THEN RETURN; END IF;
  v_remaining := p_pool_cents;
  FOR r IN
    SELECT (e->>'place')::int                      AS place,
           round((e->>'percentage')::numeric * 100) AS bp
      FROM jsonb_array_elements(p_struct) e
     ORDER BY (e->>'place')::int
  LOOP
    IF r.place = v_last_place THEN
      v_cents := GREATEST(v_remaining, 0);
    ELSE
      v_cents := LEAST(v_remaining, round(p_pool_cents * r.bp / v_total_bp));
      v_cents := GREATEST(v_cents, 0);
    END IF;
    v_remaining := v_remaining - v_cents;
    place := r.place; cents := v_cents; RETURN NEXT;
  END LOOP;
END;
$f$;

DO $do$
DECLARE
  v_checked integer; v_drift integer; v_diamond integer;
BEGIN
  CREATE TEMP TABLE _recon_sample ON COMMIT DROP AS
  SELECT t.id,
         round(COALESCE(t.prize_pool, 0), 2) * 100          AS pool_cents,
         t.payout_structure::jsonb                          AS struct,
         public.fn_ca_tournament_unit_cents(t.id)           AS unit
    FROM public.tournaments t
   WHERE COALESCE(t.status, '') = 'COMPLETED'
     AND COALESCE(t.variant, '') <> 'satellite'
     AND upper(COALESCE(t.tournament_type, '')) <> 'SATELLITE'
     AND round(COALESCE(t.prize_pool, 0), 2) > 0
     AND t.payout_structure IS NOT NULL
     AND jsonb_array_length(
           public.fn_safe_jsonb_array(t.payout_structure::text)) > 0
   ORDER BY t.id
   LIMIT 2000;

  SELECT count(*) INTO v_checked FROM _recon_sample;
  IF v_checked = 0 THEN
    RAISE EXCEPTION 'checker comparison sample is empty; refusing to claim it passed';
  END IF;

  -- Every tournament that has ever run is a chip tournament, so old and new
  -- must agree on all of them. If a Diamond tournament ever appears in this
  -- sample the claim below stops being true and this migration must be
  -- re-reasoned rather than re-run.
  SELECT count(*) INTO v_diamond FROM _recon_sample WHERE unit <> 1;
  IF v_diamond <> 0 THEN
    RAISE EXCEPTION 'the checker sample contains % Diamond tournaments; the chip-invariance claim does not cover them', v_diamond;
  END IF;

  SELECT count(*) INTO v_drift FROM _recon_sample g
   WHERE (SELECT jsonb_agg(jsonb_build_array(l.place, l.cents) ORDER BY l.place)
            FROM public.fn_ca_prize_ladder(
                   g.pool_cents::bigint,
                   (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                             'place', (e->>'place')::int,
                             'bp',    round((e->>'percentage')::numeric * 100)::bigint)
                           ORDER BY (e->>'place')::int), '[]'::jsonb)
                      FROM jsonb_array_elements(g.struct) e),
                   g.unit) l)
         IS DISTINCT FROM
         (SELECT jsonb_agg(jsonb_build_array(o.place, o.cents::bigint) ORDER BY o.place)
            FROM pg_temp.old_reconcile_ladder(g.pool_cents, g.struct) o);
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'the checker would price % of % real tournaments differently',
      v_drift, v_checked;
  END IF;
  RAISE NOTICE 'checker: % real tournaments price identically before and after', v_checked;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 9. ALL FOUR SITES NOW READ THE ONE LADDER.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_missing text := '';
BEGIN
  IF position('fn_ca_prize_ladder' in
       pg_get_functiondef('public.fn_ca_tournament_place_amounts(uuid)'::regprocedure)) = 0
    THEN v_missing := v_missing || ' fn_ca_tournament_place_amounts'; END IF;
  IF position('fn_ca_prize_ladder' in
       pg_get_functiondef('public.fn_tournament_payout_reconcile(uuid,boolean)'::regprocedure)) = 0
    THEN v_missing := v_missing || ' fn_tournament_payout_reconcile'; END IF;
  IF position('fn_ca_prize_ladder' in
       pg_get_functiondef('public.fn_tournament_place_prize_exact(numeric,text,integer,integer)'::regprocedure)) = 0
    THEN v_missing := v_missing || ' fn_tournament_place_prize_exact'; END IF;
  IF position('fn_ca_tournament_unit_cents' in
       pg_get_functiondef('public.fn_complete_tournament_entry_reprice(uuid)'::regprocedure)) = 0
    THEN v_missing := v_missing || ' fn_complete_tournament_entry_reprice'; END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'these sites do not read the one ladder:%', v_missing;
  END IF;

  IF (SELECT provolatile FROM pg_proc WHERE oid =
        'public.fn_tournament_place_prize_exact(numeric,text,integer,integer)'::regprocedure) <> 'i'
     OR (SELECT prosecdef FROM pg_proc WHERE oid =
        'public.fn_tournament_place_prize_exact(numeric,text,integer,integer)'::regprocedure) IS NOT TRUE THEN
    RAISE EXCEPTION 'fn_tournament_place_prize_exact lost IMMUTABLE or SECURITY DEFINER';
  END IF;

  -- The door, not the spelling of the door. A fresh CREATE grants EXECUTE to
  -- PUBLIC, and the function this replaced had that revoked; asserting the
  -- literal ACL string would also assert who owns it, which is not the point.
  -- Grantee 0 is PUBLIC.
  IF (SELECT proacl IS NULL
             OR EXISTS (SELECT 1 FROM aclexplode(proacl) a
                         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        FROM pg_proc
       WHERE oid = 'public.fn_tournament_place_prize_exact(numeric,text,integer,integer)'::regprocedure)
  THEN
    RAISE EXCEPTION
      'fn_tournament_place_prize_exact is executable by PUBLIC; the REVOKE did not take';
  END IF;
END;
$do$;
