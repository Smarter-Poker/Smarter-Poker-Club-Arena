-- 20261007020953_horse_hand_review_atomic_publication.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- HORSE HAND REVIEW: ONE ATOMIC PUBLICATION (Horse Brain Phase 14.1, P14-C)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT (read from the writer, server/src/services/HorseHandReview.ts)
--
--   recordHorseHandReviews made TWO independent writes per flagged hand:
--     1. an upsert into public.horse_hand_reviews (ON CONFLICT DO NOTHING),
--     2. one additive public.fn_hhr_rollup_add call per newly inserted horse.
--   They were separate PostgREST requests, so separate transactions. When the
--   second failed or its answer was lost, the immutable review row stayed and
--   its rollup contribution never happened; the loop's `break` then dropped
--   every remaining horse's rollup too. A resend could not reconcile it: the
--   review insert deduplicated to nothing, so the writer believed nothing was
--   new and added nothing. horse_review_rollup is permanent and the raw rows
--   are pruned at 30 days, so the loss was permanent as well.
--
-- THE ROOT FIX
--
--   public.fn_hhr_record_atomic(p_rows jsonb) does the whole publication for
--   one hand in ONE transaction: validate every row, insert each review row
--   once, apply the rollup arithmetic once, and keep a permanent replay
--   receipt. Either all of it commits or none of it does. A resend of the same
--   hand answers 'replayed' from the receipt and adds nothing, also after the
--   30-day prune has removed the review row. A resend whose immutable content
--   differs from what was published is refused (hhr_identity_conflict) rather
--   than silently accepted.
--
--   This is the live path made atomic (CLAUDE.md 10.12), not a repair job: no
--   sweep, no backfill, no compensating write.
--
-- WHAT IS DELIBERATELY NOT DONE
--
--   * Historical review rows written by the old split writer have no receipt,
--     and whether their rollup was applied is UNKNOWN. A resend that meets one
--     answers 'historical_unknown' and writes nothing: no blind additive retry,
--     no blanket "applied" marker, no aggregate reset or backfill.
--   * public.fn_hhr_rollup_add stays installed and unchanged. The engine build
--     that still calls it keeps working until the new engine is verified
--     serving; a later cutover migration retires it.
--   * The 20BB absolute-net review threshold is the writer's and is unchanged.
--     It is a different population from the gross >10BB rule; this function
--     does not re-filter and does not merge the two meanings. It only refuses
--     a zero net_bb, which no flagged row can carry.
--
-- THE RECEIPT HAS NO FOREIGN KEY, ON PURPOSE
--
--   Review rows are pruned at 30 days by sp_prune_horse_hand_reviews(); the
--   receipt must outlive that (it is what makes a late resend 'replayed'
--   instead of a double count), and a foreign key would also put a lock on a
--   hot table (CLAUDE.md section 2, rule 7). Receipts are never pruned.
--
-- SECURITY
--
--   SECURITY DEFINER with search_path = pg_catalog, pg_temp: every relation
--   and function below is schema-qualified, and pg_temp is LAST, so a caller's
--   temporary table named horse_hand_reviews, horse_review_rollup or
--   horse_hand_review_receipts can never receive the writes. EXECUTE is
--   service_role only. The receipts table is readable and writable by nobody
--   but this function's owner.
--
-- LOCK ORDER
--
--   Rows are processed in ascending horse_user_id::uuid order, whatever the
--   input order or letter case, so two hands that share horses always take the
--   rollup row locks in the same order and cannot deadlock each other.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5): nothing here filters on is_horse; the
-- review population is decided by the writer exactly as before.
--
-- Qualified by scripts/ci/test-horse-hand-review-atomic.py on a private
-- PostgreSQL 17 cluster (CI: accounting_postgres, shard 4).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Preimage: refuse to install over a schema this migration was not written
-- against, and refuse to install twice.
-- ─────────────────────────────────────────────────────────────────────────
DO $preimage$
BEGIN
  IF pg_catalog.to_regclass('public.horse_hand_reviews') IS NULL THEN
    RAISE EXCEPTION 'hhr_atomic preimage: public.horse_hand_reviews is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.horse_hand_reviews'::regclass
       AND c.relname = 'uq_hhr_hand_horse'
       AND i.indisunique
  ) THEN
    RAISE EXCEPTION 'hhr_atomic preimage: unique index public.uq_hhr_hand_horse on horse_hand_reviews is missing';
  END IF;
  IF pg_catalog.to_regclass('public.horse_review_rollup') IS NULL THEN
    RAISE EXCEPTION 'hhr_atomic preimage: public.horse_review_rollup is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.horse_review_rollup'::regclass
       AND attname = 'leak_net_bb'
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'hhr_atomic preimage: public.horse_review_rollup.leak_net_bb is missing';
  END IF;
  IF pg_catalog.to_regprocedure('public.fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[])') IS NULL THEN
    RAISE EXCEPTION 'hhr_atomic preimage: public.fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[]) is missing';
  END IF;
  IF pg_catalog.to_regclass('public.horse_hand_review_receipts') IS NOT NULL THEN
    RAISE EXCEPTION 'hhr_atomic preimage: public.horse_hand_review_receipts already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
     WHERE proname = 'fn_hhr_record_atomic'
       AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'hhr_atomic preimage: public.fn_hhr_record_atomic already exists';
  END IF;
END
$preimage$;

-- ─────────────────────────────────────────────────────────────────────────
-- The permanent replay receipt: one row per (hand, horse) published through
-- the atomic path.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.horse_hand_review_receipts (
  hand_id          uuid        NOT NULL,
  horse_user_id    uuid        NOT NULL,
  identity_digest  text        NOT NULL
                   CONSTRAINT horse_hand_review_receipts_digest_hex
                   CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  review_id        bigint      NOT NULL,
  rollup_day       date        NOT NULL,
  game_variant     text        NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT horse_hand_review_receipts_pkey PRIMARY KEY (hand_id, horse_user_id)
);

COMMENT ON TABLE public.horse_hand_review_receipts IS
  'Permanent replay receipt for public.fn_hhr_record_atomic: one row per (hand, horse) whose review row and horse_review_rollup contribution were committed together. Never pruned and no foreign key (review rows are pruned at 30 days); a resend after the prune still answers replayed. identity_digest is the sha256 of the typed immutable review values. Written only by fn_hhr_record_atomic.';

ALTER TABLE public.horse_hand_review_receipts ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies and NO grants: only the definer function writes it.
REVOKE ALL ON TABLE public.horse_hand_review_receipts FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- The single publication door.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.fn_hhr_record_atomic(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  -- Exactly the keys of HorseReviewRow (server/src/services/HorseHandReview.ts).
  c_keys constant text[] := ARRAY[
    'hand_id','table_id','tournament_id','club_id','played_at','game_variant',
    'format','big_blind','horse_user_id','seat','net_amount','net_bb',
    'pot_size','hole_cards','board','actions','leak_tags'];
  v_n            int;
  v_i            int;
  v_e            jsonb;
  v_missing      text[];
  v_extra        text[];
  v_first_hand   uuid;
  v_horses       uuid[] := ARRAY[]::uuid[];
  v_hand         uuid;
  v_horse        uuid;
  v_table        uuid;
  v_tournament   uuid;
  v_club         uuid;
  v_played       timestamptz;
  v_variant      text;
  v_format       text;
  v_bb           numeric;
  v_seat         int;
  v_net_amount   numeric;
  v_net_bb       numeric;
  v_pot          numeric;
  v_tags         text[];
  v_day          date;
  v_is_win       boolean;
  v_digest       text;
  v_existing     text;
  v_review_id    bigint;
  v_status       text;
  v_t            text;
  v_counts       jsonb;
  v_nets         jsonb;
  v_out          jsonb := '[]'::jsonb;
BEGIN
  -- ── shape of the payload ───────────────────────────────────────────────
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'hhr_payload_not_array: p_rows must be a JSON array of review rows';
  END IF;
  v_n := pg_catalog.jsonb_array_length(p_rows);
  IF v_n < 1 OR v_n > 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = pg_catalog.format('hhr_payload_size: expected 1..10 rows, got %s', v_n);
  END IF;

  -- ── validate EVERY row before anything is written ──────────────────────
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_e := p_rows -> v_i;
    IF pg_catalog.jsonb_typeof(v_e) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_row_not_object: row %s', v_i);
    END IF;
    v_missing := ARRAY(SELECT k FROM pg_catalog.unnest(c_keys) AS u(k) WHERE NOT (v_e ? u.k));
    v_extra   := ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(v_e) AS o(k) WHERE o.k <> ALL (c_keys));
    IF pg_catalog.cardinality(v_missing) > 0 OR pg_catalog.cardinality(v_extra) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_row_keys: row %s missing %s unknown %s', v_i, v_missing, v_extra);
    END IF;

    -- JSON types. A non-finite JS number serialises as null, so a NaN or
    -- Infinity net_bb arrives as null and is refused here.
    IF pg_catalog.jsonb_typeof(v_e -> 'hand_id') <> 'string'
       OR pg_catalog.jsonb_typeof(v_e -> 'horse_user_id') <> 'string'
       OR pg_catalog.jsonb_typeof(v_e -> 'played_at') <> 'string'
       OR pg_catalog.jsonb_typeof(v_e -> 'game_variant') <> 'string'
       OR pg_catalog.jsonb_typeof(v_e -> 'format') <> 'string'
       OR pg_catalog.jsonb_typeof(v_e -> 'table_id') NOT IN ('string', 'null')
       OR pg_catalog.jsonb_typeof(v_e -> 'tournament_id') NOT IN ('string', 'null')
       OR pg_catalog.jsonb_typeof(v_e -> 'club_id') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_type: row %s: id, time and label fields must be JSON strings', v_i);
    END IF;
    IF pg_catalog.jsonb_typeof(v_e -> 'big_blind') <> 'number'
       OR pg_catalog.jsonb_typeof(v_e -> 'net_amount') <> 'number'
       OR pg_catalog.jsonb_typeof(v_e -> 'net_bb') <> 'number'
       OR pg_catalog.jsonb_typeof(v_e -> 'seat') NOT IN ('number', 'null')
       OR pg_catalog.jsonb_typeof(v_e -> 'pot_size') NOT IN ('number', 'null') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_number: row %s: big_blind, net_amount and net_bb must be finite JSON numbers', v_i);
    END IF;
    IF pg_catalog.jsonb_typeof(v_e -> 'leak_tags') <> 'array'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_e -> 'leak_tags') AS t(x)
                   WHERE pg_catalog.jsonb_typeof(t.x) <> 'string') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_leak_tags: row %s: leak_tags must be a JSON array of strings', v_i);
    END IF;
    -- played_at must carry its own offset, so its instant never depends on
    -- the calling session's TimeZone.
    IF (v_e ->> 'played_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_played_at: row %s: played_at must be an ISO timestamp with an explicit offset', v_i);
    END IF;

    -- Casts: a data error becomes a named refusal (nothing has been written).
    BEGIN
      v_hand       := (v_e ->> 'hand_id')::uuid;
      v_horse      := (v_e ->> 'horse_user_id')::uuid;
      v_table      := (v_e ->> 'table_id')::uuid;
      v_tournament := (v_e ->> 'tournament_id')::uuid;
      v_club       := (v_e ->> 'club_id')::uuid;
      v_played     := (v_e ->> 'played_at')::timestamptz;
      v_bb         := (v_e ->> 'big_blind')::numeric;
      v_net_amount := (v_e ->> 'net_amount')::numeric;
      v_net_bb     := (v_e ->> 'net_bb')::numeric;
      v_pot        := (v_e ->> 'pot_size')::numeric;
      v_seat       := (v_e ->> 'seat')::int;
    EXCEPTION WHEN data_exception THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_value: row %s: %s', v_i, SQLERRM);
    END;

    IF NOT pg_catalog.isfinite(v_played) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_played_at: row %s: played_at must be finite', v_i);
    END IF;
    IF v_bb <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_big_blind: row %s: big_blind must be > 0', v_i);
    END IF;
    IF v_net_bb = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_net_bb: row %s: |net_bb| must be > 0', v_i);
    END IF;
    IF pg_catalog.btrim(v_e ->> 'game_variant') = '' OR pg_catalog.btrim(v_e ->> 'format') = '' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_invalid_label: row %s: game_variant and format must be non-empty', v_i);
    END IF;

    IF v_i = 0 THEN
      v_first_hand := v_hand;
    ELSIF v_hand IS DISTINCT FROM v_first_hand THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_mixed_hand: row %s carries hand %s, row 0 carries %s', v_i, v_hand, v_first_hand);
    END IF;
    -- uuid equality, so the same horse in two letter cases is one horse.
    IF v_horse = ANY (v_horses) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = pg_catalog.format('hhr_duplicate_horse: horse %s appears more than once', v_horse);
    END IF;
    v_horses := v_horses || v_horse;
  END LOOP;

  v_hand := v_first_hand;

  -- ── publish, in canonical horse order (deterministic lock order) ──────
  FOR v_e IN
    SELECT x.e
      FROM pg_catalog.jsonb_array_elements(p_rows) AS x(e)
     ORDER BY (x.e ->> 'horse_user_id')::uuid
  LOOP
    v_horse      := (v_e ->> 'horse_user_id')::uuid;
    v_table      := (v_e ->> 'table_id')::uuid;
    v_tournament := (v_e ->> 'tournament_id')::uuid;
    v_club       := (v_e ->> 'club_id')::uuid;
    v_played     := (v_e ->> 'played_at')::timestamptz;
    v_variant    := v_e ->> 'game_variant';
    v_format     := v_e ->> 'format';
    v_bb         := (v_e ->> 'big_blind')::numeric;
    v_seat       := (v_e ->> 'seat')::int;
    v_net_amount := (v_e ->> 'net_amount')::numeric;
    v_net_bb     := (v_e ->> 'net_bb')::numeric;
    v_pot        := (v_e ->> 'pot_size')::numeric;
    v_tags       := ARRAY(
                      SELECT t.tag
                        FROM pg_catalog.jsonb_array_elements_text(v_e -> 'leak_tags') WITH ORDINALITY AS t(tag, ord)
                       ORDER BY t.ord);
    v_day        := (v_played AT TIME ZONE 'UTC')::date;
    v_is_win     := v_net_bb > 0;

    -- a. identity of the immutable review values, from the TYPED values.
    --    Evidence payloads (hole_cards, board, actions) are not part of it.
    v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'hand_id',       v_hand::text,
        'table_id',      v_table::text,
        'tournament_id', v_tournament::text,
        'club_id',       v_club::text,
        'played_at',     pg_catalog.to_char(v_played AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'game_variant',  v_variant,
        'format',        v_format,
        'big_blind',     pg_catalog.trim_scale(v_bb),
        'horse_user_id', v_horse::text,
        'seat',          v_seat,
        'net_amount',    pg_catalog.trim_scale(v_net_amount),
        'net_bb',        pg_catalog.trim_scale(v_net_bb),
        'pot_size',      pg_catalog.trim_scale(v_pot),
        'leak_tags',     pg_catalog.to_jsonb(v_tags)
      )::text, 'UTF8')), 'hex');

    -- b. an existing receipt decides it
    v_existing := NULL;
    SELECT r.identity_digest INTO v_existing
      FROM public.horse_hand_review_receipts r
     WHERE r.hand_id = v_hand AND r.horse_user_id = v_horse
     FOR UPDATE;

    IF v_existing IS NOT NULL THEN
      IF v_existing <> v_digest THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = pg_catalog.format('hhr_identity_conflict: hand %s horse %s was published with different immutable content', v_hand, v_horse);
      END IF;
      v_status := 'replayed';
    ELSE
      -- c. insert the review once
      v_review_id := NULL;
      INSERT INTO public.horse_hand_reviews (
        hand_id, table_id, tournament_id, club_id, played_at, game_variant,
        format, big_blind, horse_user_id, seat, net_amount, net_bb, pot_size,
        hole_cards, board, actions, leak_tags)
      VALUES (
        v_hand, v_table, v_tournament, v_club, v_played, v_variant,
        v_format, v_bb, v_horse, v_seat, v_net_amount, v_net_bb, v_pot,
        NULLIF(v_e -> 'hole_cards', 'null'::jsonb),
        NULLIF(v_e -> 'board', 'null'::jsonb),
        NULLIF(v_e -> 'actions', 'null'::jsonb),
        v_tags)
      ON CONFLICT (hand_id, horse_user_id) DO NOTHING
      RETURNING id INTO v_review_id;

      IF v_review_id IS NOT NULL THEN
        INSERT INTO public.horse_hand_review_receipts (
          hand_id, horse_user_id, identity_digest, review_id, rollup_day, game_variant)
        VALUES (v_hand, v_horse, v_digest, v_review_id, v_day, v_variant);

        -- The rollup arithmetic of public.fn_hhr_rollup_add as installed by
        -- 20260906093726_every_tag_carries_its_own_ev, statement for
        -- statement, schema-qualified. A repeated tag is counted once per
        -- occurrence, exactly as the FOREACH there does.
        INSERT INTO public.horse_review_rollup AS r (
          horse_user_id, day, game_variant, big_wins, big_losses, sum_net_bb, leak_counts, leak_net_bb)
        VALUES (v_horse, v_day, v_variant,
                CASE WHEN v_is_win THEN 1 ELSE 0 END,
                CASE WHEN v_is_win THEN 0 ELSE 1 END,
                COALESCE(v_net_bb, 0), '{}'::jsonb, '{}'::jsonb)
        ON CONFLICT (horse_user_id, day, game_variant) DO UPDATE SET
          big_wins   = r.big_wins   + excluded.big_wins,
          big_losses = r.big_losses + excluded.big_losses,
          sum_net_bb = r.sum_net_bb + excluded.sum_net_bb,
          updated_at = pg_catalog.now();
        IF v_tags IS NOT NULL AND pg_catalog.array_length(v_tags, 1) > 0 THEN
          SELECT rr.leak_counts, rr.leak_net_bb INTO v_counts, v_nets
            FROM public.horse_review_rollup rr
           WHERE rr.horse_user_id = v_horse AND rr.day = v_day AND rr.game_variant = v_variant;
          FOREACH v_t IN ARRAY v_tags LOOP
            v_counts := pg_catalog.jsonb_set(v_counts, ARRAY[v_t],
                          pg_catalog.to_jsonb(COALESCE((v_counts ->> v_t)::int, 0) + 1));
            v_nets   := pg_catalog.jsonb_set(v_nets, ARRAY[v_t],
                          pg_catalog.to_jsonb(pg_catalog.round(
                            COALESCE((v_nets ->> v_t)::numeric, 0) + COALESCE(v_net_bb, 0), 2)));
          END LOOP;
          UPDATE public.horse_review_rollup rr
             SET leak_counts = v_counts, leak_net_bb = v_nets, updated_at = pg_catalog.now()
           WHERE rr.horse_user_id = v_horse AND rr.day = v_day AND rr.game_variant = v_variant;
        END IF;

        v_status := 'applied';
      ELSE
        -- A review row already exists. A concurrent atomic writer may have
        -- just committed it with its receipt: re-read in a new statement.
        v_existing := NULL;
        SELECT r.identity_digest INTO v_existing
          FROM public.horse_hand_review_receipts r
         WHERE r.hand_id = v_hand AND r.horse_user_id = v_horse
         FOR UPDATE;
        IF v_existing IS NOT NULL THEN
          IF v_existing <> v_digest THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001',
              MESSAGE = pg_catalog.format('hhr_identity_conflict: hand %s horse %s was published with different immutable content', v_hand, v_horse);
          END IF;
          v_status := 'replayed';
        ELSE
          -- A legacy split-writer row: whether its rollup was applied is
          -- unknown. No arithmetic, no receipt, no marker.
          v_status := 'historical_unknown';
        END IF;
      END IF;
    END IF;

    v_out := v_out || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('horse_user_id', v_horse::text, 'status', v_status));
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('version', 1, 'hand_id', v_hand::text, 'rows', v_out);
END
$function$;

COMMENT ON FUNCTION public.fn_hhr_record_atomic(jsonb) IS
  'Atomic horse hand-review publication for one hand (1..10 horse rows carrying exactly the HorseReviewRow keys). One transaction: review row inserted once, horse_review_rollup arithmetic applied once (identical to fn_hhr_rollup_add), permanent receipt kept. Returns {version:1, hand_id, rows:[{horse_user_id, status: applied|replayed|historical_unknown}]} in canonical horse order. Refuses with P0001 hhr_* on any invalid row or identity conflict, writing nothing. service_role only.';

REVOKE ALL ON FUNCTION public.fn_hhr_record_atomic(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_hhr_record_atomic(jsonb) TO service_role;

COMMIT;
