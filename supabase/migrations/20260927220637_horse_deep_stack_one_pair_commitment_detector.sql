-- ═══ THE DEEP-STACK ONE-PAIR COMMITMENT DETECTOR (2026-09-27, audit WARN) ═══
--
-- The 2026-09-21 horse audit: "in deep-stack (400-500bb) tournaments, horses
-- are stacking off with one pair or an overpair, and most of these hands are
-- untagged. A new detector is needed."
--
-- It is untagged because NO hold'em detector in HorseHandReview.detectLeaks
-- reads DEPTH, and the pair ladder is covered only by
-- `top_pair_weak_kicker_stackoff` (top pair, kicker nine or worse) and
-- `weak_kicker_trips_stackoff`. An OVERPAIR, a top pair with a ten-or-better
-- kicker, and every middle or bottom pair carry no tag at any stack depth.
--
-- THIS IS A MEASUREMENT, NOT A STRATEGY CHANGE. It writes only its own three
-- tables. It does not touch horse_hand_reviews.leak_tags, because HorseLogic
-- reads leak tags by exact name into its stack-off loads, and moving a dial
-- needs a league matchup (docs/laws.d/, and the standing rule quoted in the
-- V38 PLO block of HorseHandReview.ts).
--
-- MONEY COMES FROM ACCEPTED FACTS ONLY. Chips are read from
-- hand_atomic_commits.post_commit_payload->'accepted_hand_facts', never
-- reconstructed from mixed raise-to/increment action amounts - the same rule
-- 20260914161209_horse_committed_pot_daily_audit.sql states. `actions` is
-- read for STREET SEQUENCE only.

-- ── THE MADE HAND AT THE COMMIT STREET ──────────────────────────────────────
-- Hold'em family only: exactly two hole cards, three to five board cards.
-- Returns {readable, reason} when it cannot read the cards - a detector that
-- cannot read its evidence says so and is counted, it never reports zero.
CREATE FUNCTION public.fn_ca_holdem_commit_pair_class(p_hole jsonb, p_board text[])
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  rank_of CONSTANT jsonb :=
    '{"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"T":10,"J":11,"Q":12,"K":13,"A":14}'::jsonb;
  hole_r int[] := ARRAY[]::int[];
  hole_s text[] := ARRAY[]::text[];
  board_r int[] := ARRAY[]::int[];
  board_s text[] := ARRAY[]::text[];
  all_r int[]; all_s text[];
  e jsonb; tok text; rtxt text; stxt text;
  distinct_r int[]; i int; run int := 1; prev int := NULL;
  max_suit int; n_pairs int; n_trips int; n_quads int;
  pair_rank int; top_board int; kicker int := NULL;
  has_flush boolean := false; has_straight boolean := false;
  cat text; cls text;
BEGIN
  IF p_hole IS NULL OR jsonb_typeof(p_hole) <> 'array' OR jsonb_array_length(p_hole) <> 2 THEN
    RETURN jsonb_build_object('readable', false, 'reason', 'hole_cards_not_two');
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_hole) LOOP
    IF jsonb_typeof(e) <> 'object' THEN
      RETURN jsonb_build_object('readable', false, 'reason', 'hole_card_not_object');
    END IF;
    rtxt := e->>'rank'; stxt := e->>'suit';
    IF rtxt IS NULL OR stxt IS NULL OR stxt = '' OR NOT (rank_of ? rtxt) THEN
      RETURN jsonb_build_object('readable', false, 'reason', 'hole_card_unparsed');
    END IF;
    hole_r := hole_r || (rank_of->>rtxt)::int;
    hole_s := hole_s || stxt;
  END LOOP;

  IF p_board IS NULL OR coalesce(array_length(p_board, 1), 0) < 3
     OR array_length(p_board, 1) > 5 THEN
    RETURN jsonb_build_object('readable', false, 'reason', 'board_not_three_to_five');
  END IF;
  FOREACH tok IN ARRAY p_board LOOP
    IF tok IS NULL OR length(tok) < 2 THEN
      RETURN jsonb_build_object('readable', false, 'reason', 'board_card_unparsed');
    END IF;
    rtxt := left(tok, 1); stxt := substr(tok, 2);
    IF NOT (rank_of ? rtxt) THEN
      RETURN jsonb_build_object('readable', false, 'reason', 'board_card_unparsed');
    END IF;
    board_r := board_r || (rank_of->>rtxt)::int;
    board_s := board_s || stxt;
  END LOOP;

  all_r := hole_r || board_r;
  all_s := hole_s || board_s;

  SELECT max(c) INTO max_suit FROM (SELECT count(*) c FROM unnest(all_s) x GROUP BY x) z;
  has_flush := coalesce(max_suit, 0) >= 5;

  -- Ace plays low for the wheel as well as high.
  SELECT array_agg(r ORDER BY r) INTO distinct_r
  FROM (SELECT DISTINCT unnest(all_r) AS r UNION SELECT 1 WHERE 14 = ANY(all_r)) z;
  FOREACH i IN ARRAY distinct_r LOOP
    IF prev IS NOT NULL AND i = prev + 1 THEN run := run + 1; ELSE run := 1; END IF;
    IF run >= 5 THEN has_straight := true; END IF;
    prev := i;
  END LOOP;

  SELECT count(*) FILTER (WHERE c = 2), count(*) FILTER (WHERE c = 3),
         count(*) FILTER (WHERE c >= 4)
    INTO n_pairs, n_trips, n_quads
  FROM (SELECT r, count(*) c FROM unnest(all_r) r GROUP BY r) z;

  IF n_quads > 0 THEN cat := 'quads';
  ELSIF n_trips > 0 AND (n_pairs > 0 OR n_trips > 1) THEN cat := 'full_house';
  ELSIF has_flush THEN cat := 'flush';
  ELSIF has_straight THEN cat := 'straight';
  ELSIF n_trips > 0 THEN cat := 'trips';
  ELSIF n_pairs >= 2 THEN cat := 'two_pair';
  ELSIF n_pairs = 1 THEN cat := 'one_pair';
  ELSE cat := 'high_card';
  END IF;

  IF cat <> 'one_pair' THEN
    RETURN jsonb_build_object('readable', true, 'category', cat, 'class', NULL,
                              'boardLen', array_length(board_r, 1));
  END IF;

  SELECT r INTO pair_rank
  FROM (SELECT r, count(*) c FROM unnest(all_r) r GROUP BY r) z
  WHERE c = 2 LIMIT 1;
  SELECT max(r) INTO top_board FROM unnest(board_r) r;

  -- A pair the BOARD makes for everybody is not the hand's own - the same
  -- rule the V24 kicker detectors use in HorseHandReview.detectLeaks.
  IF NOT (pair_rank = ANY(hole_r)) THEN
    cls := 'board_pair';
  ELSIF hole_r[1] = hole_r[2] THEN
    -- A pocket pair: an OVERPAIR when it beats every board rank, otherwise an
    -- underpair, which is still the hand's own one pair.
    cls := CASE WHEN pair_rank > top_board THEN 'overpair' ELSE 'one_pair' END;
  ELSE
    cls := 'one_pair';
    kicker := CASE WHEN hole_r[1] = pair_rank THEN hole_r[2] ELSE hole_r[1] END;
  END IF;

  RETURN jsonb_build_object('readable', true, 'category', cat, 'class', cls,
                            'pairRank', pair_rank, 'topBoardRank', top_board,
                            'kicker', kicker, 'boardLen', array_length(board_r, 1));
END;
$fn$;
COMMENT ON FUNCTION public.fn_ca_holdem_commit_pair_class(jsonb, text[]) IS
  'Hold-em made-hand class on the board hero could see: one_pair / overpair / board_pair, or {readable:false,reason} when the cards cannot be read. Mirrors the V24 own-pair rule in HorseHandReview.detectLeaks.';

-- ── THE STREET THE STACK WENT IN ON ─────────────────────────────────────────
-- The SQL mirror of `commitStreet` in server/src/services/HorseHandReview.ts
-- (2026-09-11): the stage of hero's LAST chip-committing action, skipping a
-- trailing CALL worth less than 15% of everything hero invested, which is a
-- remainder and not the decision. `actions` is read for SEQUENCE only; the
-- 15% test compares an action amount with an accepted-facts total, exactly as
-- the TypeScript does.
CREATE FUNCTION public.fn_ca_hand_commit_street(p_actions jsonb, p_user uuid, p_invested numeric)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  a jsonb; act text; stage text; amt numeric;
BEGIN
  IF p_actions IS NULL OR jsonb_typeof(p_actions) <> 'array' THEN RETURN NULL; END IF;
  FOR a IN
    SELECT value FROM jsonb_array_elements(p_actions) WITH ORDINALITY t(value, ord)
    WHERE jsonb_typeof(value) = 'object' AND value->>'userId' = p_user::text
    ORDER BY ord DESC
  LOOP
    act := a->>'action';
    IF act IS NULL OR act NOT IN ('bet', 'raise', 'call', 'all_in') THEN CONTINUE; END IF;
    amt := CASE WHEN jsonb_typeof(a->'amount') = 'number' THEN (a->>'amount')::numeric END;
    IF p_invested IS NOT NULL AND p_invested > 0
       AND (act = 'call' OR (act = 'all_in' AND NOT (a ? 'isFullRaise')))
       AND amt IS NOT NULL AND amt < p_invested * 0.15 THEN
      CONTINUE;
    END IF;
    stage := a->>'stage';
    IF stage IN ('preflop', 'flop', 'turn', 'river') THEN RETURN stage; END IF;
    RETURN NULL;
  END LOOP;
  RETURN NULL;
END;
$fn$;
COMMENT ON FUNCTION public.fn_ca_hand_commit_street(jsonb, uuid, numeric) IS
  'Stage of the horse last chip-committing action, skipping a sub-15% remainder call. SQL mirror of commitStreet in HorseHandReview.ts.';

-- ── THE EVIDENCE STORE ──────────────────────────────────────────────────────
CREATE TABLE public.horse_stackoff_audit_days (
  day date PRIMARY KEY,
  pass bigint NOT NULL DEFAULT 1,
  after_created_at timestamptz,
  after_hand_id uuid,
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_batch_at timestamptz,
  finished_at timestamptz,
  -- Named `candidate_hands`, not `scanned_hands`: the cursor walks only the
  -- hands that clear the pot pre-filter below, never the whole day.
  candidate_hands bigint NOT NULL DEFAULT 0,
  horse_seats bigint NOT NULL DEFAULT 0,
  deep_seats bigint NOT NULL DEFAULT 0,
  stackoff_seats bigint NOT NULL DEFAULT 0,
  tagged_seats bigint NOT NULL DEFAULT 0,
  unreadable_seats bigint NOT NULL DEFAULT 0,
  hand_gaps bigint NOT NULL DEFAULT 0,
  out_of_scope_hands bigint NOT NULL DEFAULT 0,
  deep_bb_floor numeric NOT NULL,
  commit_fraction_floor numeric NOT NULL,
  pot_filter_bb numeric NOT NULL,
  source_coverage text NOT NULL DEFAULT 'not_established'
    CHECK (source_coverage = 'not_established'),
  identity_basis text NOT NULL DEFAULT 'current_profile_is_horse'
    CHECK (identity_basis = 'current_profile_is_horse'),
  CHECK ((after_created_at IS NULL) = (after_hand_id IS NULL)),
  CHECK (pass > 0 AND candidate_hands >= 0 AND horse_seats >= 0 AND deep_seats >= 0
         AND stackoff_seats >= 0 AND tagged_seats >= 0 AND unreadable_seats >= 0
         AND hand_gaps >= 0 AND out_of_scope_hands >= 0)
);
COMMENT ON TABLE public.horse_stackoff_audit_days IS
  'Per-day cursor and counters for fn_horse_stackoff_audit_step. source_coverage is never established: the pot pre-filter and hand-history retention both bound what the sweep can see.';

CREATE TABLE public.horse_stackoff_reviews (
  hand_id uuid NOT NULL,
  horse_user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  tournament_id uuid,
  played_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  source_payload_hash text,
  game_variant text NOT NULL,
  format text NOT NULL,
  seats integer NOT NULL CHECK (seats BETWEEN 0 AND 10),
  big_blind numeric NOT NULL CHECK (big_blind > 0),
  start_bb numeric NOT NULL,
  effective_bb numeric NOT NULL,
  committed_bb numeric NOT NULL,
  commit_fraction numeric NOT NULL,
  all_in boolean NOT NULL,
  commit_street text CHECK (commit_street IN ('preflop','flop','turn','river')),
  hand_category text,
  pair_class text CHECK (pair_class IN ('one_pair','overpair','board_pair')),
  pair_rank integer,
  kicker integer,
  net_bb numeric,
  is_win boolean,
  -- NULL when the shape is real but carries no tag (a preflop commit, a set,
  -- a flush): the denominator lives in this table beside the tag, per
  -- docs/laws.d/server-src-services-EveryLeakTagHasADenominator.md.
  detector_tag text CHECK (detector_tag IN (
    'deep_one_pair_stackoff','deep_one_pair_stackoff_won',
    'deep_overpair_stackoff','deep_overpair_stackoff_won')),
  existing_leak_tags text[],
  review_row_present boolean NOT NULL,
  reasons text[] NOT NULL,
  PRIMARY KEY (hand_id, horse_user_id)
);
CREATE INDEX horse_stackoff_reviews_day ON public.horse_stackoff_reviews (played_at, hand_id);
CREATE INDEX horse_stackoff_reviews_tag ON public.horse_stackoff_reviews (detector_tag, played_at)
  WHERE detector_tag IS NOT NULL;
COMMENT ON TABLE public.horse_stackoff_reviews IS
  'One row per horse seat that committed a large fraction of a 400bb-or-deeper effective stack in a tournament hand. detector_tag is set only for the hand own one pair or overpair at a postflop commit; every other qualifying seat is kept as the denominator.';

CREATE TABLE public.horse_stackoff_audit_gaps (
  hand_id uuid PRIMARY KEY,
  played_at timestamptz NOT NULL,
  reasons text[] NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX horse_stackoff_audit_gaps_day ON public.horse_stackoff_audit_gaps (played_at, hand_id);

ALTER TABLE public.horse_stackoff_audit_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.horse_stackoff_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.horse_stackoff_audit_gaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_stackoff_audit_days, public.horse_stackoff_reviews,
  public.horse_stackoff_audit_gaps FROM PUBLIC, anon, authenticated, service_role;

-- ── THE SWEEP ───────────────────────────────────────────────────────────────
-- Idempotent and backfillable: one advisory-locked transaction owns the day
-- cursor and every derived row. Re-running a finished day starts a new pass
-- from the top and rewrites the same primary keys with the same answers, so
-- the numbers are reproducible rather than accumulated.
--
-- THE POT PRE-FILTER IS SAFE BY ARITHMETIC. A qualifying seat commits at
-- least DEEP_BB * COMMIT_FRACTION = 240bb, and those chips are in the pot, so
-- pot_size >= 240 * big_blind for every hand this detector can tag. The
-- cursor walks hands at pot_size >= 150 * big_blind, a strictly wider net.
-- hand_history is 14 GB and its evidence columns are TOASTed; filtering on
-- the inline columns first is what keeps a daily sweep affordable.
CREATE FUNCTION public.fn_horse_stackoff_audit_step(p_day date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '2s'
SET statement_timeout = '20s'
AS $fn$
DECLARE
  deep_bb        CONSTANT numeric := 400;   -- effective stack at hand start, in bb
  commit_floor   CONSTANT numeric := 0.60;  -- of the EFFECTIVE stack, not hero own
  pot_floor_bb   CONSTANT numeric := 150;
  batch_size     CONSTANT int     := 256;
  retain_days    CONSTANT int     := 35;
  d public.horse_stackoff_audit_days%ROWTYPE;
  h record; actor record;
  facts jsonb; contributions jsonb; refunds jsonb; starts jsonb; cls jsonb;
  source_ok boolean; roster_ok boolean; stacks_ok boolean; winners_ok boolean;
  in_scope boolean; scope_reason text;
  gaps text[]; reasons text[]; existing_tags text[];
  bb numeric; seats int; variant text; game_format text;
  net numeric; refund numeric; gross numeric; won_amt numeric;
  hero_start numeric; other_max numeric; eff numeric; frac numeric;
  net_bb_v numeric; is_win_v boolean; all_in_v boolean;
  street text; board_at text[]; tag text; pair_cls text; row_present boolean;
  candidates int := 0; horse_n int := 0; deep_n int := 0; stack_n int := 0;
  tagged_n int := 0; unread_n int := 0; gap_hands int := 0; oos_hands int := 0;
  last_created timestamptz; last_id uuid;
  today date := (transaction_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_day IS NOT NULL AND (p_day > today OR p_day < today - retain_days) THEN
    RAISE EXCEPTION 'fn_horse_stackoff_audit_step: day % outside the % day window', p_day, retain_days;
  END IF;
  -- Never block the dealing engine: this reads source rows and locks nothing
  -- but its own cursor row.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-stackoff-audit-v1', 0)) THEN
    RETURN jsonb_build_object('version', 1, 'status', 'busy',
      'sourceCoverage', 'not_established', 'activationAuthorized', false);
  END IF;

  IF p_day IS NOT NULL THEN
    INSERT INTO public.horse_stackoff_audit_days(day, deep_bb_floor, commit_fraction_floor, pot_filter_bb)
      VALUES (p_day, deep_bb, commit_floor, pot_floor_bb) ON CONFLICT DO NOTHING;
    SELECT * INTO d FROM public.horse_stackoff_audit_days WHERE day = p_day FOR UPDATE;
  ELSE
    INSERT INTO public.horse_stackoff_audit_days(day, deep_bb_floor, commit_fraction_floor, pot_filter_bb)
      SELECT today - i, deep_bb, commit_floor, pot_floor_bb FROM generate_series(1, 3) i
      ON CONFLICT DO NOTHING;
    SELECT * INTO d FROM public.horse_stackoff_audit_days
      WHERE day BETWEEN today - 3 AND today - 1
        AND (finished_at IS NULL OR finished_at < transaction_timestamp() - interval '24 hours')
      ORDER BY (finished_at IS NOT NULL), day FOR UPDATE LIMIT 1;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('version', 1, 'status', 'idle',
      'sourceCoverage', 'not_established', 'activationAuthorized', false);
  END IF;
  IF d.finished_at IS NOT NULL THEN
    UPDATE public.horse_stackoff_audit_days
      SET pass = pass + 1, after_created_at = NULL, after_hand_id = NULL,
          started_at = transaction_timestamp(), finished_at = NULL,
          candidate_hands = 0, horse_seats = 0, deep_seats = 0, stackoff_seats = 0,
          tagged_seats = 0, unreadable_seats = 0, hand_gaps = 0, out_of_scope_hands = 0,
          deep_bb_floor = deep_bb, commit_fraction_floor = commit_floor,
          pot_filter_bb = pot_floor_bb
      WHERE day = d.day RETURNING * INTO d;
  END IF;

  FOR h IN
    SELECT x.*, t.tournament_type, c.post_commit_payload_hash, c.post_commit_payload
    FROM (
      SELECT id, table_id, created_at, game_variant, big_blind, players, winners, actions,
             hole_cards, community_cards, community_cards2, bomb_pot, tournament_id
      FROM public.hand_history
      WHERE created_at >= coalesce(d.after_created_at, d.day::timestamp AT TIME ZONE 'UTC')
        AND created_at < (d.day + 1)::timestamp AT TIME ZONE 'UTC'
        AND (d.after_created_at IS NULL OR (created_at, id) > (d.after_created_at, d.after_hand_id))
        AND tournament_id IS NOT NULL
        AND (big_blind IS NULL OR big_blind <= 0 OR pot_size IS NULL
             OR pot_size >= pot_floor_bb * big_blind)
      ORDER BY created_at, id LIMIT batch_size
    ) x
    LEFT JOIN public.tournaments t ON t.id = x.tournament_id
    LEFT JOIN public.hand_atomic_commits c ON c.hand_id = x.id AND c.table_id = x.table_id
    ORDER BY x.created_at, x.id
  LOOP
    candidates := candidates + 1; last_created := h.created_at; last_id := h.id;
    gaps := ARRAY[]::text[]; facts := NULL; contributions := NULL; refunds := NULL;
    source_ok := false; roster_ok := false; starts := NULL;

    variant := coalesce(h.game_variant, 'unknown');
    in_scope := false; scope_reason := NULL;
    IF variant IN ('nlh', 'holdem', 'nlhe', 'texas_holdem') THEN in_scope := true;
    ELSIF variant IN ('plo4', 'plo5', 'plo6', 'plo8', 'plo', 'omaha') THEN
      scope_reason := 'variant_not_holdem';
    ELSIF variant IN ('shortdeck', 'short_deck') THEN
      -- Short deck reorders flushes and boats and gives the ace a second
      -- straight. The pair ladder is unaffected, but scoring it with the full
      -- deck ranking would be a guess, so it is named and left unscored.
      scope_reason := 'variant_shortdeck_not_scored';
    ELSE
      scope_reason := 'variant_unknown';
      gaps := array_append(gaps, 'variant_unknown');
    END IF;
    IF in_scope AND (h.bomb_pot IS NOT NULL OR h.community_cards2 IS NOT NULL) THEN
      in_scope := false; scope_reason := 'bomb_or_multi_board';
    END IF;

    IF h.post_commit_payload IS NULL THEN
      gaps := array_append(gaps, 'accepted_commitment_facts_missing');
    ELSIF h.post_commit_payload_hash IS DISTINCT FROM
          encode(extensions.digest(convert_to(h.post_commit_payload::text, 'UTF8'), 'sha256'), 'hex') THEN
      gaps := array_append(gaps, 'accepted_payload_digest_mismatch');
    ELSE
      facts := h.post_commit_payload->'accepted_hand_facts';
      contributions := facts->'contributions'; refunds := facts->'returned_uncalled';
      source_ok := jsonb_typeof(contributions) = 'object' AND jsonb_typeof(refunds) = 'object';
      IF NOT source_ok THEN gaps := array_append(gaps, 'accepted_commitment_facts_invalid'); END IF;
    END IF;

    seats := 0;
    IF jsonb_typeof(h.players) = 'array' AND jsonb_array_length(h.players) BETWEEN 2 AND 10 THEN
      seats := jsonb_array_length(h.players);
      SELECT count(*) = seats AND count(DISTINCT p->>'userId') = seats INTO roster_ok
        FROM jsonb_array_elements(h.players) p
        WHERE jsonb_typeof(p) = 'object'
          AND p->>'userId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
    END IF;
    IF NOT coalesce(roster_ok, false) THEN gaps := array_append(gaps, 'dealt_roster_invalid'); END IF;

    bb := h.big_blind;
    IF bb IS NULL OR bb::text IN ('NaN', 'Infinity', '-Infinity') OR bb <= 0 THEN
      bb := NULL; gaps := array_append(gaps, 'big_blind_invalid');
    END IF;

    game_format := CASE
      WHEN upper(h.tournament_type) IN ('SPIN', 'SPIN_AND_GO', 'SPIN_AND_GOLD') THEN 'spin'
      WHEN upper(h.tournament_type) IN ('HU_SNG', 'HEADS_UP_SNG') THEN 'hu_sng'
      WHEN upper(h.tournament_type) = 'SNG' THEN 'sng'
      WHEN upper(h.tournament_type) IN ('MTT', 'SATELLITE') THEN 'mtt'
      ELSE 'tournament_unknown' END;
    IF game_format = 'tournament_unknown' THEN
      gaps := array_append(gaps, 'tournament_format_unknown');
    END IF;

    IF NOT in_scope THEN
      oos_hands := oos_hands + 1;
    ELSIF coalesce(roster_ok, false) AND source_ok AND bb IS NOT NULL THEN
      SELECT bool_and(jsonb_typeof(p->'stack') = 'number') INTO stacks_ok
        FROM jsonb_array_elements(h.players) p;
      SELECT coalesce(bool_and(jsonb_typeof(w->'amount') = 'number'
               AND w->>'userId' IS NOT NULL), true) INTO winners_ok
        FROM jsonb_array_elements(coalesce(h.winners, '[]'::jsonb)) w;
      IF NOT coalesce(stacks_ok, false) THEN gaps := array_append(gaps, 'seat_stack_unreadable'); END IF;
      IF NOT winners_ok THEN gaps := array_append(gaps, 'winners_unreadable'); END IF;

      IF coalesce(stacks_ok, false) AND winners_ok THEN
        -- start = final stack + what was actually risked - what came back.
        -- Verified against the first publicNode of 3,527 live tournament
        -- seats on 2026-09-27: 3,527 agreed, 0 disagreed.
        SELECT jsonb_object_agg(p->>'userId',
                 (p->>'stack')::numeric
                 + coalesce((contributions->>(p->>'userId'))::numeric, 0)
                 - coalesce((SELECT sum((w->>'amount')::numeric)
                             FROM jsonb_array_elements(coalesce(h.winners, '[]'::jsonb)) w
                             WHERE w->>'userId' = p->>'userId'), 0))
          INTO starts FROM jsonb_array_elements(h.players) p;

        IF EXISTS (SELECT 1 FROM jsonb_array_elements(h.players) p
                   LEFT JOIN public.profiles pr ON pr.id = (p->>'userId')::uuid
                   WHERE pr.id IS NULL OR pr.is_horse IS NULL) THEN
          gaps := array_append(gaps, 'horse_identity_unknown');
        END IF;

        FOR actor IN
          SELECT pr.id FROM jsonb_array_elements(h.players) p
          JOIN public.profiles pr ON pr.id = (p->>'userId')::uuid
          WHERE pr.is_horse IS TRUE ORDER BY pr.id
        LOOP
          horse_n := horse_n + 1;
          reasons := ARRAY[]::text[]; existing_tags := NULL; row_present := false;
          net := CASE WHEN jsonb_typeof(contributions->actor.id::text) = 'number'
                      THEN (contributions->>actor.id::text)::numeric END;
          refund := CASE WHEN jsonb_typeof(refunds->actor.id::text) = 'number'
                         THEN (refunds->>actor.id::text)::numeric ELSE 0 END;
          hero_start := CASE WHEN jsonb_typeof(starts->actor.id::text) = 'number'
                             THEN (starts->>actor.id::text)::numeric END;
          IF net IS NULL OR hero_start IS NULL OR hero_start <= 0 THEN
            -- Counted, named, and never silently dropped.
            gaps := array_append(gaps, 'horse_money_unreadable');
            unread_n := unread_n + 1;
            CONTINUE;
          END IF;
          SELECT max(value::text::numeric) INTO other_max
            FROM jsonb_each(starts) e(key, value) WHERE key <> actor.id::text;
          IF other_max IS NULL OR other_max <= 0 THEN CONTINUE; END IF;
          eff := least(hero_start, other_max);
          IF eff / bb < deep_bb THEN CONTINUE; END IF;
          deep_n := deep_n + 1;
          frac := net / eff;
          IF frac < commit_floor THEN CONTINUE; END IF;
          stack_n := stack_n + 1;

          gross := net + refund;
          SELECT coalesce(sum((w->>'amount')::numeric), 0) INTO won_amt
            FROM jsonb_array_elements(coalesce(h.winners, '[]'::jsonb)) w
            WHERE w->>'userId' = actor.id::text;
          net_bb_v := (won_amt - net) / bb;
          is_win_v := net_bb_v > 0;
          all_in_v := net >= hero_start * 0.995
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(h.actions, '[]'::jsonb)) a
                       WHERE a->>'userId' = actor.id::text AND a->>'action' = 'all_in');

          street := public.fn_ca_hand_commit_street(h.actions, actor.id, gross);
          tag := NULL; pair_cls := NULL; cls := NULL; board_at := NULL;
          IF street IS NULL THEN
            reasons := array_append(reasons, 'commit_street_unreadable');
            unread_n := unread_n + 1;
          ELSIF street = 'preflop' THEN
            -- A preflop commit is preflop_stackoff's hand, not a postflop
            -- made-hand decision - the same standing-down rule the V38 PLO
            -- block uses in HorseHandReview.detectLeaks.
            reasons := array_append(reasons, 'preflop_commit_not_scored');
          ELSE
            board_at := CASE street WHEN 'flop' THEN h.community_cards[1:3]
                                    WHEN 'turn' THEN h.community_cards[1:4]
                                    ELSE h.community_cards[1:5] END;
            cls := public.fn_ca_holdem_commit_pair_class(h.hole_cards->actor.id::text, board_at);
            IF NOT coalesce((cls->>'readable')::boolean, false) THEN
              reasons := array_append(reasons, coalesce(cls->>'reason', 'hand_unreadable'));
              unread_n := unread_n + 1;
            ELSE
              pair_cls := cls->>'class';
              IF pair_cls = 'overpair' THEN
                tag := CASE WHEN is_win_v THEN 'deep_overpair_stackoff_won' ELSE 'deep_overpair_stackoff' END;
              ELSIF pair_cls = 'one_pair' THEN
                tag := CASE WHEN is_win_v THEN 'deep_one_pair_stackoff_won' ELSE 'deep_one_pair_stackoff' END;
              END IF;
            END IF;
          END IF;
          IF tag IS NOT NULL THEN tagged_n := tagged_n + 1; END IF;

          SELECT coalesce(r.leak_tags, ARRAY[]::text[]) INTO existing_tags
            FROM public.horse_hand_reviews r
            WHERE r.hand_id = h.id AND r.horse_user_id = actor.id LIMIT 1;
          row_present := FOUND;

          INSERT INTO public.horse_stackoff_reviews(
            hand_id, horse_user_id, table_id, tournament_id, played_at, source_payload_hash,
            game_variant, format, seats, big_blind, start_bb, effective_bb, committed_bb,
            commit_fraction, all_in, commit_street, hand_category, pair_class, pair_rank,
            kicker, net_bb, is_win, detector_tag, existing_leak_tags, review_row_present, reasons)
          VALUES (h.id, actor.id, h.table_id, h.tournament_id, h.created_at, h.post_commit_payload_hash,
            variant, game_format, seats, bb, round(hero_start / bb, 2), round(eff / bb, 2),
            round(net / bb, 2), round(frac, 4), all_in_v, street, cls->>'category', pair_cls,
            (cls->>'pairRank')::int, (cls->>'kicker')::int, round(net_bb_v, 2), is_win_v, tag,
            existing_tags, row_present, reasons || gaps)
          ON CONFLICT (hand_id, horse_user_id) DO UPDATE SET
            captured_at = transaction_timestamp(),
            source_payload_hash = excluded.source_payload_hash,
            big_blind = excluded.big_blind, start_bb = excluded.start_bb,
            effective_bb = excluded.effective_bb, committed_bb = excluded.committed_bb,
            commit_fraction = excluded.commit_fraction, all_in = excluded.all_in,
            commit_street = excluded.commit_street, hand_category = excluded.hand_category,
            pair_class = excluded.pair_class, pair_rank = excluded.pair_rank,
            kicker = excluded.kicker, net_bb = excluded.net_bb, is_win = excluded.is_win,
            detector_tag = excluded.detector_tag, existing_leak_tags = excluded.existing_leak_tags,
            review_row_present = excluded.review_row_present, reasons = excluded.reasons;
        END LOOP;
      END IF;
    END IF;

    IF cardinality(gaps) > 0 THEN
      gap_hands := gap_hands + 1;
      INSERT INTO public.horse_stackoff_audit_gaps(hand_id, played_at, reasons)
        VALUES (h.id, h.created_at, gaps)
        ON CONFLICT (hand_id) DO UPDATE SET
          reasons = ARRAY(SELECT DISTINCT v FROM unnest(public.horse_stackoff_audit_gaps.reasons || excluded.reasons) v),
          observed_at = transaction_timestamp();
    END IF;
  END LOOP;

  UPDATE public.horse_stackoff_audit_days
    SET after_created_at = coalesce(last_created, after_created_at),
        after_hand_id = coalesce(last_id, after_hand_id),
        last_batch_at = transaction_timestamp(),
        finished_at = CASE WHEN candidates < batch_size THEN transaction_timestamp() END,
        candidate_hands = candidate_hands + candidates, horse_seats = horse_seats + horse_n,
        deep_seats = deep_seats + deep_n, stackoff_seats = stackoff_seats + stack_n,
        tagged_seats = tagged_seats + tagged_n, unreadable_seats = unreadable_seats + unread_n,
        hand_gaps = hand_gaps + gap_hands, out_of_scope_hands = out_of_scope_hands + oos_hands
    WHERE day = d.day;

  DELETE FROM public.horse_stackoff_reviews WHERE (hand_id, horse_user_id) IN
    (SELECT hand_id, horse_user_id FROM public.horse_stackoff_reviews
     WHERE played_at < transaction_timestamp() - make_interval(days => retain_days)
     ORDER BY played_at, hand_id LIMIT 4096);
  DELETE FROM public.horse_stackoff_audit_gaps WHERE hand_id IN
    (SELECT hand_id FROM public.horse_stackoff_audit_gaps
     WHERE played_at < transaction_timestamp() - make_interval(days => retain_days)
     ORDER BY played_at, hand_id LIMIT 4096);
  DELETE FROM public.horse_stackoff_audit_days WHERE day < today - retain_days;

  RETURN jsonb_build_object('version', 1,
    'status', CASE WHEN candidates < batch_size THEN 'pass_complete' ELSE 'recorded' END,
    'day', d.day, 'candidateHands', candidates, 'horseSeats', horse_n, 'deepSeats', deep_n,
    'stackoffSeats', stack_n, 'taggedSeats', tagged_n, 'unreadableSeats', unread_n,
    'outOfScopeHands', oos_hands, 'handGaps', gap_hands,
    'deepBbFloor', deep_bb, 'commitFractionFloor', commit_floor, 'potFilterBb', pot_floor_bb,
    'sourceCoverage', 'not_established', 'activationAuthorized', false);
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_horse_stackoff_audit_step(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_stackoff_audit_step(date) TO service_role;
COMMENT ON FUNCTION public.fn_horse_stackoff_audit_step(date) IS
  'One bounded batch of the deep-stack one-pair commitment sweep. Idempotent: re-running a day rewrites the same rows. Reports what it could not read in horse_stackoff_audit_gaps and in its own unreadableSeats counter; it never reports a silent zero.';
