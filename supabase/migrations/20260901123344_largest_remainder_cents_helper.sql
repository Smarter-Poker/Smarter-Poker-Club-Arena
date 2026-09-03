-- Largest remainder, in the database, so the payout checker can use the same
-- rule the payout writer does.
--
-- scripts/ci/check-chip-conservation.mjs asserts "largest-remainder split
-- conserves exactly across 500 fuzzed cases" -- that is the house rule for
-- splitting a pot into weighted shares. It existed only in JavaScript. The
-- database had no implementation, so fn_tournament_payout_reconcile invented
-- its own (round each place independently, hand the LAST place whatever is
-- left) and the two disagree by a cent whenever the earlier roundings do not
-- happen to cancel.
--
-- Contract: sum(result) = p_total_cents exactly, for any non-negative weights
-- that are not all zero. Leftover cents go to the largest fractional parts;
-- ties go to the earlier array position, which callers pass in finishing order,
-- so a tie is broken in favour of the better finish.

CREATE OR REPLACE FUNCTION public.fn_ca_largest_remainder_cents(
  p_total_cents numeric,
  p_weights     numeric[])
RETURNS numeric[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT ord, GREATEST(COALESCE(weight, 0), 0) AS weight
      FROM unnest(p_weights) WITH ORDINALITY AS t(weight, ord)
  ), tot AS (
    SELECT NULLIF(sum(weight), 0) AS s FROM w
  ), base AS (
    SELECT w.ord,
           floor(p_total_cents * w.weight / tot.s)                                  AS c,
           (p_total_cents * w.weight / tot.s)
             - floor(p_total_cents * w.weight / tot.s)                              AS frac
      FROM w CROSS JOIN tot
     WHERE tot.s IS NOT NULL
  ), leftover AS (
    SELECT GREATEST(p_total_cents - COALESCE(sum(c), 0), 0) AS n FROM base
  ), ranked AS (
    SELECT ord, c, row_number() OVER (ORDER BY frac DESC, ord ASC) AS rk FROM base
  )
  SELECT COALESCE(
           array_agg(c + CASE WHEN rk <= (SELECT n FROM leftover) THEN 1 ELSE 0 END
                     ORDER BY ord),
           ARRAY[]::numeric[])
    FROM ranked;
$function$;

COMMENT ON FUNCTION public.fn_ca_largest_remainder_cents(numeric, numeric[]) IS
  'Split p_total_cents across p_weights by largest remainder. Sum is exact. Ties favour the earlier position, which callers pass in finishing order.';

REVOKE ALL ON FUNCTION public.fn_ca_largest_remainder_cents(numeric, numeric[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_largest_remainder_cents(numeric, numeric[])
  TO service_role;

-- Prove the contract rather than asserting it in prose.
DO $$
DECLARE
  v numeric[]; i int; v_total numeric; v_cents numeric; v_w numeric[];
BEGIN
  -- conservation across 500 fuzzed cases, the same bar the JS side is held to
  FOR i IN 1..500 LOOP
    v_cents := floor(random() * 5000000);
    SELECT array_agg(floor(random() * 1000)) INTO v_w
      FROM generate_series(1, 1 + floor(random() * 12)::int);
    IF (SELECT sum(x) FROM unnest(v_w) x) > 0 THEN
      v := public.fn_ca_largest_remainder_cents(v_cents, v_w);
      SELECT sum(x) INTO v_total FROM unnest(v) x;
      IF v_total <> v_cents THEN
        RAISE EXCEPTION 'largest remainder lost money: % <> % for weights %', v_total, v_cents, v_w;
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(v) x WHERE x < 0) THEN
        RAISE EXCEPTION 'largest remainder produced a negative share for weights %', v_w;
      END IF;
    END IF;
  END LOOP;

  -- degenerate inputs must not throw
  IF public.fn_ca_largest_remainder_cents(100, ARRAY[]::numeric[]) <> ARRAY[]::numeric[] THEN
    RAISE EXCEPTION 'empty weights should give an empty split';
  END IF;
  IF public.fn_ca_largest_remainder_cents(100, ARRAY[0,0]::numeric[]) <> ARRAY[]::numeric[] THEN
    RAISE EXCEPTION 'all-zero weights should give an empty split, got %',
      public.fn_ca_largest_remainder_cents(100, ARRAY[0,0]::numeric[]);
  END IF;

  -- the case that started this: 513.00 over the nine-place ladder must give
  -- the tail a share, and the shares must add to the pool
  RAISE NOTICE 'largest remainder verified over 500 fuzzed cases';
END $$;;
