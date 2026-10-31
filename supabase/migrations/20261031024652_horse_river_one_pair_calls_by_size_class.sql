-- 20261031024652_horse_river_one_pair_calls_by_size_class.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-10-31)
-- ───────────────────────────────────────
-- The Hold'em live measure (server/src/benchmark/HoldemLiveMeasure.ts, #8810)
-- answers "how often does a horse that called a river bet holding exactly one
-- pair win, by the V62 size class of the bet it faced". Its first version
-- pulled a day of horse_hand_reviews rows (12,207 NLH rows, actions JSON and
-- all, ~60 MB) through PostgREST to compute three numbers. This function does
-- the same arithmetic WHERE THE ROWS ARE and returns the three numbers, so the
-- measurement costs one bounded indexed scan and one RPC, and anyone with the
-- service role can take it without exporting hand data.
--
-- The arithmetic is the TypeScript module's, line for line, and
-- scripts/dev/test-horse-river-one-pair-calls.sh proves both agree on the
-- same fixture hands (small / medium / large, blind defence, dead ante, live
-- ante, hero bet then raised, two pair excluded, board flush and board
-- straight excluded). Read it before changing either side.
--
--   * one pair: hero holds a pocket pair that did not hit, or one hole card
--     pairs an unpaired five-card board once; no flush or straight among the
--     seven cards (a board flush or straight plays for everyone).
--   * the bet faced: hero's first river call after at least one aggression.
--     Pot before that bet = every player's preflop/flop/turn contribution
--     (HandController convention: a call is the increment; bet / raise /
--     all_in / forced posts are the street total; a dead post pools; a live
--     ante adds) plus river money before the bet. Fraction = (aggressor's
--     river total minus what they had already put in on the river) / that pot.
--   * size class (HorseEval.v62SizeClass): large when raised or >= 0.7 pot,
--     medium >= 0.4, else small.
--   * won = net_bb > 0.
--
-- Bounded: p_since no older than 14 days, p_limit 1..20000 newest rows first,
-- game_variant = 'nlh' only, rows whose cards or actions cannot be parsed are
-- counted as unreadable; a hand that ended before the river is readable and
-- simply not a river call. STABLE, SECURITY DEFINER with a pinned search_path,
-- EXECUTE for service_role only (horse_hand_reviews is service-only). Reads
-- no horse flag (CLAUDE.md 10.5); never writes.
--
-- The result carries the caveat the report prints: horse_hand_reviews holds
-- only hands with |net| >= 20bb, so this is the big-pot subset.
--
-- One function, one transaction, no hot-table lock: horse_hand_reviews is
-- read under its played_at index at call time, not at install time.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_horse_river_one_pair_calls(
  p_since timestamptz DEFAULT now() - interval '24 hours',
  p_limit integer DEFAULT 20000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  r record; a jsonb; hero text; ranks int[]; suits text[]; rv int; i int; j int;
  hr1 int; hr2 int; hits int; pocket boolean; boardpaired boolean; ok boolean;
  rank_order constant text := '23456789TJQKA';
  paid jsonb; street text; uid text; amt numeric; act text; dead boolean;
  pot numeric; river_paid jsonb; aggr int; last_bet numeric; last_pot numeric;
  frac numeric; isc boolean; isa boolean; prev numeric; faced boolean;
  n_small bigint := 0; w_small bigint := 0; n_med bigint := 0; w_med bigint := 0;
  n_large bigint := 0; w_large bigint := 0; n_cons bigint := 0; n_unr bigint := 0;
  cnt int; s text; distinct_ranks int[]; lo int; run boolean;
BEGIN
  IF p_since IS NULL OR p_since < now() - interval '14 days' THEN
    RAISE EXCEPTION 'fn_horse_river_one_pair_calls: p_since must be within the last 14 days';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20000 THEN
    RAISE EXCEPTION 'fn_horse_river_one_pair_calls: p_limit must be 1..20000';
  END IF;

  FOR r IN SELECT hr.horse_user_id::text AS h, hr.net_bb, hr.hole_cards AS hc, hr.board AS bd, hr.actions AS ac
           FROM public.horse_hand_reviews hr
           WHERE hr.game_variant = 'nlh' AND hr.played_at >= p_since
           ORDER BY hr.played_at DESC
           LIMIT p_limit
  LOOP
    -- Unreadable = cannot be parsed. A hand that ended before the river has a
    -- short board: readable, considered, and simply not a river call (the
    -- TypeScript reader counts it the same way; the parity test pins it).
    IF r.hc IS NULL OR r.bd IS NULL OR r.ac IS NULL
       OR jsonb_typeof(r.hc) <> 'array' OR jsonb_typeof(r.bd) <> 'array' OR jsonb_typeof(r.ac) <> 'array' THEN
      n_unr := n_unr + 1; CONTINUE;
    END IF;

    -- Cards: {rank, suit} objects or "Kh" strings.
    ranks := '{}'; suits := '{}'; ok := true;
    FOR a IN SELECT value FROM jsonb_array_elements(r.hc || r.bd) LOOP
      IF jsonb_typeof(a) = 'object' THEN
        rv := position(upper(left(a->>'rank', 1)) in rank_order);
        s := lower(left(a->>'suit', 1));
      ELSIF jsonb_typeof(a) = 'string' AND length(a #>> '{}') = 2 THEN
        rv := position(upper(left(a #>> '{}', 1)) in rank_order);
        s := lower(right(a #>> '{}', 1));
      ELSE
        rv := 0; s := '';
      END IF;
      IF rv = 0 OR s NOT IN ('s','h','d','c') THEN ok := false; END IF;
      ranks := ranks || rv; suits := suits || s;
    END LOOP;
    IF NOT ok THEN n_unr := n_unr + 1; CONTINUE; END IF;
    n_cons := n_cons + 1;
    IF jsonb_array_length(r.hc) <> 2 OR jsonb_array_length(r.bd) <> 5 THEN CONTINUE; END IF;

    hr1 := ranks[1]; hr2 := ranks[2];
    boardpaired := false;
    FOR i IN 3..7 LOOP FOR j IN (i + 1)..7 LOOP IF ranks[i] = ranks[j] THEN boardpaired := true; END IF; END LOOP; END LOOP;
    IF boardpaired THEN CONTINUE; END IF;
    pocket := hr1 = hr2;
    hits := 0;
    FOR i IN 3..7 LOOP
      IF ranks[i] = hr1 THEN hits := hits + 1; END IF;
      IF NOT pocket AND ranks[i] = hr2 THEN hits := hits + 1; END IF;
    END LOOP;
    IF pocket AND hits > 0 THEN CONTINUE; END IF;        -- a set or better
    IF NOT pocket AND hits <> 1 THEN CONTINUE; END IF;   -- no pair, or two pair

    -- Flush among the seven.
    ok := true;
    FOREACH s IN ARRAY ARRAY['s','h','d','c'] LOOP
      cnt := 0;
      FOR i IN 1..7 LOOP IF suits[i] = s THEN cnt := cnt + 1; END IF; END LOOP;
      IF cnt >= 5 THEN ok := false; END IF;
    END LOOP;
    IF NOT ok THEN CONTINUE; END IF;

    -- Straight among the seven (the ace, rank 13, also counts as 0 for the wheel).
    distinct_ranks := ARRAY(SELECT DISTINCT x FROM unnest(ranks) AS x);
    IF 13 = ANY(distinct_ranks) THEN distinct_ranks := distinct_ranks || 0; END IF;
    ok := true;
    FOR lo IN 0..9 LOOP
      run := true;
      FOR i IN 0..4 LOOP IF NOT ((lo + i) = ANY(distinct_ranks)) THEN run := false; END IF; END LOOP;
      IF run THEN ok := false; END IF;
    END LOOP;
    IF NOT ok THEN CONTINUE; END IF;

    -- Contributions before the river, per street and player.
    hero := r.h; paid := '{}'::jsonb; pot := 0;
    FOR a IN SELECT value FROM jsonb_array_elements(r.ac) LOOP
      street := a->>'stage'; uid := a->>'userId'; act := a->>'action';
      dead := coalesce((a->>'dead')::boolean, false);
      amt := CASE WHEN jsonb_typeof(a->'amount') = 'number' THEN (a->>'amount')::numeric ELSE 0 END;
      IF street IS NULL OR uid IS NULL OR amt <= 0 OR street NOT IN ('preflop','flop','turn') THEN CONTINUE; END IF;
      IF dead THEN pot := pot + amt; CONTINUE; END IF;
      prev := coalesce((paid->street->>uid)::numeric, 0);
      IF act IN ('call','ante') THEN prev := prev + amt; ELSE prev := greatest(prev, amt); END IF;
      paid := jsonb_set(paid, ARRAY[street], coalesce(paid->street, '{}'::jsonb) || jsonb_build_object(uid, prev));
    END LOOP;
    FOREACH street IN ARRAY ARRAY['preflop','flop','turn'] LOOP
      pot := pot + coalesce((SELECT sum(value::numeric) FROM jsonb_each_text(coalesce(paid->street, '{}'::jsonb))), 0);
    END LOOP;

    -- The river: hero's first call after an aggression.
    river_paid := '{}'::jsonb; aggr := 0; last_bet := 0; last_pot := pot; faced := false; frac := 0;
    FOR a IN SELECT value FROM jsonb_array_elements(r.ac) WHERE value->>'stage' = 'river' LOOP
      uid := a->>'userId'; act := a->>'action';
      amt := CASE WHEN jsonb_typeof(a->'amount') = 'number' THEN (a->>'amount')::numeric ELSE 0 END;
      IF uid IS NULL THEN CONTINUE; END IF;
      isc := act = 'call' OR (act = 'all_in' AND NOT (a ? 'isFullRaise'));
      isa := act IN ('bet','raise') OR (act = 'all_in' AND (a ? 'isFullRaise'));
      IF uid = hero AND isc AND aggr > 0 THEN
        frac := CASE WHEN last_pot > 0 THEN last_bet / last_pot ELSE 1 END;
        faced := true;
        EXIT;
      END IF;
      IF isa THEN
        last_bet := greatest(0, amt - coalesce((river_paid->>uid)::numeric, 0));
        last_pot := pot + coalesce((SELECT sum(value::numeric) FROM jsonb_each_text(river_paid)), 0);
        aggr := aggr + 1;
      END IF;
      IF amt > 0 THEN
        prev := coalesce((river_paid->>uid)::numeric, 0);
        IF act = 'call' THEN prev := prev + amt; ELSE prev := greatest(prev, amt); END IF;
        river_paid := river_paid || jsonb_build_object(uid, prev);
      END IF;
    END LOOP;
    IF NOT faced THEN CONTINUE; END IF;

    IF aggr >= 2 OR frac >= 0.7 THEN
      n_large := n_large + 1; IF r.net_bb > 0 THEN w_large := w_large + 1; END IF;
    ELSIF frac >= 0.4 THEN
      n_med := n_med + 1; IF r.net_bb > 0 THEN w_med := w_med + 1; END IF;
    ELSE
      n_small := n_small + 1; IF r.net_bb > 0 THEN w_small := w_small + 1; END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'schema', 'horse-river-one-pair-calls/v1',
    'since', p_since,
    'limit', p_limit,
    'consideredRows', n_cons,
    'unreadableRows', n_unr,
    'cells', jsonb_build_array(
      jsonb_build_object('sizeClass', 'small',  'calls', n_small, 'won', w_small),
      jsonb_build_object('sizeClass', 'medium', 'calls', n_med,   'won', w_med),
      jsonb_build_object('sizeClass', 'large',  'calls', n_large, 'won', w_large)
    ),
    'caveat', 'horse_hand_reviews holds only hands with |net| >= 20bb, so these are big-pot river calls; compare before/after on the same subset'
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_horse_river_one_pair_calls(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_river_one_pair_calls(timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.fn_horse_river_one_pair_calls(timestamptz, integer) IS
  'Hold''em live measure (2026-10-31): river one-pair calls by V62 size class faced (small < 0.4 pot, medium < 0.7, large or raised) and how many won, over the newest p_limit NLH horse_hand_reviews rows since p_since (<= 14 days). The same arithmetic as server/src/benchmark/HoldemLiveMeasure.ts, run where the rows are; service_role only; big-pot subset (|net| >= 20bb).';

COMMIT;
