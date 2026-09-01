-- `x IS TRUE` does not match a partial index declared `WHERE x`.
--
-- ca-settlement-correctness-30m has been failing at its 120s statement timeout,
-- every time on the same statement:
--
--     SELECT count(*) FROM public.hand_history
--      WHERE created_at > now() - interval '24 hours' AND has_human IS TRUE
--
-- An index exists for exactly this:
--
--     idx_hand_history_human_created ON hand_history (created_at) WHERE has_human
--
-- and it is never used, because Postgres's predicate-implication prover does
-- not equate the BooleanTest node `has_human IS TRUE` with the bare boolean
-- predicate `has_human` the index was declared with. The two are semantically
-- identical in a WHERE clause -- both exclude NULL and false -- and the planner
-- still will not connect them.
--
-- Measured on production, same query, one word apart:
--
--     ... AND has_human IS TRUE   cost 231817.29   Index Scan idx_hand_history_created
--                                                  + Filter: (has_human IS TRUE)
--     ... AND has_human           cost     12.57   Index Only Scan
--                                                  idx_hand_history_human_created
--
-- Eighteen thousand times the cost. The first plan walks every hand dealt in
-- 24 hours -- around 221,000 rows -- to find the ~265 a human sat in.
--
-- This is worth being blunt about, because the index was added earlier today to
-- fix this exact job and the job kept timing out afterwards. The index was
-- correct. The query could not reach it. An index added for a query that cannot
-- use it looks like a fix, measures like a fix on any hand-run variant of the
-- query, and changes nothing in production -- which is what happened.
--
-- Changed in the two WHERE clauses of fn_ca_settlement_correctness_check only.
-- fn_hand_history_prune_skip_depth also writes `has_human IS TRUE`, inside
-- `count(*) FILTER (WHERE has_human IS TRUE OR reported IS TRUE)`. That is an
-- aggregate filter over an OR, not an index-usable predicate, so rewriting it
-- would buy nothing and is deliberately left alone.
--
-- Applied as a targeted substitution on the live definition so the rest of a
-- long function cannot drift by transcription.

DO $$
DECLARE
  v_def text;
  v_new text;
  v_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settlement_correctness_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_settlement_correctness_check not found';
  END IF;

  SELECT count(*) INTO v_before
    FROM unnest(string_to_array(v_def, E'\n')) l
   WHERE l LIKE '%has_human IS TRUE;%';

  IF v_before <> 2 THEN
    RAISE EXCEPTION
      'expected 2 index-usable "has_human IS TRUE" predicates, found % - the function changed shape', v_before;
  END IF;

  -- Anchored on the trailing semicolon so only the two WHERE-clause predicates
  -- are touched, never an aggregate FILTER that happens to share the text.
  v_new := replace(v_def, 'AND has_human IS TRUE;', 'AND has_human;');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'substitution changed nothing';
  END IF;

  EXECUTE v_new;
END $$;

DO $$
DECLARE v_def text; v_left int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settlement_correctness_check';

  SELECT count(*) INTO v_left
    FROM unnest(string_to_array(v_def, E'\n')) l
   WHERE l LIKE '%has_human IS TRUE;%';

  IF v_left <> 0 THEN
    RAISE EXCEPTION '% index-blind predicate(s) survived', v_left;
  END IF;
  IF position('AND has_human;' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the rewritten predicate is not present';
  END IF;
  RAISE NOTICE 'settlement-correctness now asks a question the partial index can answer';
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_settlement_correctness_check()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_correctness_check() TO service_role;;
