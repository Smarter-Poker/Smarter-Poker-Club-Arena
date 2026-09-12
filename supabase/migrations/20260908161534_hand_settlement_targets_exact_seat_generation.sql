-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908161534; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908161534   (the stamp IS the apply time, UTC: 2026-09-08 16:15:34)
--   name        hand_settlement_targets_exact_seat_generation
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 26027 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908161534 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- A hand settles the exact seat generation it dealt, never whoever sits there later.
--
-- ROOT CAUSE (2026-09-08)
-- -----------------------
-- The engine's accepted-hand transaction names each participant, but both stack
-- settlement and the newly atomic time-bank write resolved that participant by
-- `(table_id, user_id, left_at IS NULL)`. That is not a hand identity. A player
-- can leave after being dealt and rejoin another chair before the old hand is
-- committed. Worse, `table_seats` deliberately reuses a vacated row in place;
-- the same chair keeps its `id` while `joined_at` is replaced. `id` alone is
-- therefore not an immutable generation either.
--
-- The split contract caused two failures:
--
-- 1. The stack core correctly supports a departed cash participant by applying
--    that hand's delta to the historical seat's club wallet, but the outer
--    time-bank writer looked only for a currently active row. The whole accepted
--    hand was then rolled back as `time_bank_seat_mismatch`.
-- 2. If the same user had already rejoined, the user-only lookup could select or
--    mutate the new seat generation instead of the one that was actually dealt.
--
-- Live examples of the first refusal included table 45fa34e1..., hand 8226169,
-- plus 9cc1131e..., bfae1902..., and 88c5dcac... on 2026-09-08. Inspection also
-- found pending post-commit envelopes behind predecessor barriers, so refusing
-- an accepted hand here stalls later hands rather than merely losing a cosmetic
-- time-bank update.
--
-- ROOT FIX
-- --------
-- The exact protocol carries the composite generation
-- `(table_seats.id, table_seats.joined_at)` in BOTH p_stacks and time_banks.
-- The inner stack calculation/lock/write and the outer time-bank write match
-- all four immutable facts: table_id, user_id, id, and joined_at. joined_at is
-- parsed as timestamptz and compared semantically, so equivalent PostgREST
-- offset spellings name the same instant. The application forwards the exact
-- PostgREST string; no JavaScript Date round-trip can truncate its precision.
--
-- A departed cash generation uses that exact historical row's club_id for its
-- late wallet delta. A departed tournament generation still fails closed. A
-- different-chair rejoin cannot be touched because its id differs. A same-chair
-- row reuse cannot be touched because joined_at differs; since the old row was
-- overwritten in place and no longer exists, the whole hand fails closed.
--
-- ROLLING EXPANSION, THEN STRICT CONTRACTION
-- ------------------------------------------
-- This is the database-first expansion. An all-legacy protocol-2 envelope with
-- neither field remains valid while the previous engine is draining. An exact
-- envelope must carry BOTH fields for EVERY stack and time-bank row. Partial,
-- mixed, malformed, or cross-narrative generations are refused before money or
-- seat state moves. After the exact engine is the sole live process and every
-- legacy in-flight request has drained, a separate forward contraction migration
-- must remove the legacy branches and require the composite on every request.
-- Keeping that cutover separate is deliberate zero-downtime expand/contract.
--
-- The functions are money code with large bodies. This migration applies exact,
-- one-hit substitutions to the inspected live definitions and aborts on either
-- MD5 or anchor drift. No retry, repair job, reconciliation loop, or data rewrite
-- is introduced. CREATE OR REPLACE preserves function identity, owner, and ACL.
--
-- ROLLBACK: write a new forward migration which recreates the two immediately
-- previous definitions. There is no row backfill or schema state to undo.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '0';

-- Supabase Realtime rebuilds catalog-derived subscription state. Take its
-- global catalog boundary before replacing either public function, matching
-- the platform-wide catalog -> public-object order. NOWAIT aborts a busy
-- window whole; it never queues accepted hands behind settlement DDL.
LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $migration$
DECLARE
  v_src text;
  v_anchor text;
  v_replacement text;
  v_hits integer;
BEGIN
  /* -----------------------------------------------------------------------
     Inner absolute/delta stack settlement.
     ----------------------------------------------------------------------- */
  SELECT pg_get_functiondef(
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
  ) INTO v_src;
  IF position('v_exact_seat_generation boolean;' in v_src) > 0
     AND position('exact seat generation missing or replaced' in v_src) > 0
     AND position('v_dep_club := v_exact_seat_club' in v_src) > 0 THEN
    RAISE NOTICE 'exact stack-generation settlement is already installed';
  ELSE
    IF md5(v_src) <> '027f6ca632a9aca339efd1c896e7f6a6' THEN
      RAISE EXCEPTION
        'fn_ca_settle_hand_stacks_absolute changed since exact-seat inspection';
    END IF;

  v_anchor := $old$  v_delta_mode boolean;$old$;
  v_replacement := $new$  v_delta_mode boolean;
  -- Exact seat identity is the row id plus the join instant. A vacated row can
  -- be reused in place, so neither user_id, chair number, nor row id is enough.
  v_exact_seat_generation boolean;
  v_exact_seat_id uuid;
  v_exact_seat_joined_at timestamptz;
  v_exact_seat_left_at timestamptz;
  v_exact_seat_club uuid;
  v_exact_seat_found boolean;$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one inner variable anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$  END IF;
  IF (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid) FROM jsonb_array_elements(p_stacks) x) THEN$old$;
  v_replacement := $new$  END IF;

  -- Rolling expansion accepts either a wholly legacy roster or a wholly exact
  -- roster. One-sided and mixed generations can otherwise create a request
  -- whose hash says one thing while individual rows are selected another way.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_stacks) x
     WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
        OR CASE WHEN x ? 'seat_id'
                THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                ELSE false END
        OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                THEN (x->>'seat_id') !~*
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                ELSE false END
        OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                THEN NOT pg_input_is_valid(
                  x->>'seat_joined_at', 'timestamp with time zone'
                )
                ELSE false END
  ) THEN
    RAISE EXCEPTION 'Invalid hand settlement seat generation'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
    RAISE EXCEPTION 'Mixed legacy and exact hand settlement seat generations'
      USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
    INTO v_exact_seat_generation
    FROM jsonb_array_elements(p_stacks) x;

  IF (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid) FROM jsonb_array_elements(p_stacks) x) THEN$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one inner validation anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$  SELECT jsonb_agg(jsonb_build_object('user_id', (x->>'user_id')::uuid,
      'stack', (x->>'stack')::numeric)
      || CASE WHEN x ? 'stack_before' THEN jsonb_build_object('stack_before', (x->>'stack_before')::numeric)
              ELSE '{}'::jsonb END
      ORDER BY (x->>'user_id')::uuid) INTO v_canonical
    FROM jsonb_array_elements(p_stacks) x;$old$;
  v_replacement := $new$  SELECT jsonb_agg(jsonb_build_object('user_id', (x->>'user_id')::uuid,
      'stack', (x->>'stack')::numeric)
      || CASE WHEN x ? 'stack_before' THEN jsonb_build_object('stack_before', (x->>'stack_before')::numeric)
              ELSE '{}'::jsonb END
      || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', (x->>'seat_id')::uuid,
              'seat_joined_at', x->>'seat_joined_at')
              ELSE '{}'::jsonb END
      ORDER BY (x->>'user_id')::uuid) INTO v_canonical
    FROM jsonb_array_elements(p_stacks) x;$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one inner canonical-request anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$      SELECT ts.stack INTO v_old FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN$old$;
  v_replacement := $new$      v_exact_seat_id := NULL;
      v_exact_seat_joined_at := NULL;
      v_exact_seat_left_at := NULL;
      v_exact_seat_club := NULL;
      IF v_exact_seat_generation THEN
        v_exact_seat_id := (e->>'seat_id')::uuid;
        v_exact_seat_joined_at := (e->>'seat_joined_at')::timestamptz;
        SELECT ts.stack, ts.left_at, ts.club_id
          INTO v_old, v_exact_seat_left_at, v_exact_seat_club
          FROM public.table_seats ts
         WHERE ts.id = v_exact_seat_id
           AND ts.joined_at = v_exact_seat_joined_at
           AND ts.table_id = p_table_id
           AND ts.user_id = v_uid
         FOR UPDATE;
      ELSE
        SELECT ts.stack INTO v_old FROM public.table_seats ts
         WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
         FOR UPDATE;
      END IF;
      v_exact_seat_found := FOUND;
      IF NOT v_exact_seat_found
         OR (v_exact_seat_generation AND v_exact_seat_left_at IS NOT NULL) THEN
        -- If the exact row id was reused in place, joined_at no longer matches.
        -- There is no historical row left to settle, so fail the hand whole.
        IF v_exact_seat_generation AND NOT v_exact_seat_found THEN
          RAISE EXCEPTION
            'exact seat generation missing or replaced for % - hand write rejected whole',
            v_uid;
        END IF;$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one inner seat-selection anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$          SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
           ORDER BY ts.left_at DESC LIMIT 1;$old$;
  v_replacement := $new$          IF v_exact_seat_generation THEN
            -- Use the club captured on the exact departed generation. Looking
            -- up the latest departed row can cross a later rejoin or club move.
            v_dep_club := v_exact_seat_club;
          ELSE
            SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
             WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
             ORDER BY ts.left_at DESC LIMIT 1;
          END IF;$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one departed-seat club anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$          IF v_dep_club IS NULL THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;$old$;
  v_replacement := $new$          IF v_dep_club IS NULL AND NOT v_exact_seat_generation THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one departed-seat fallback anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$          v_departed := v_departed || jsonb_build_array(jsonb_build_object(
            'user_id', v_uid, 'delta', round(v_new - v_before, 2), 'club_id', v_dep_club));$old$;
  v_replacement := $new$          v_departed := v_departed || jsonb_build_array(
            jsonb_build_object(
              'user_id', v_uid,
              'delta', round(v_new - v_before, 2),
              'club_id', v_dep_club
            ) || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', v_exact_seat_id,
              'seat_joined_at', e->>'seat_joined_at'
            ) ELSE '{}'::jsonb END
          );$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one departed-seat receipt anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$      UPDATE public.table_seats ts SET stack = v_target
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;$old$;
  v_replacement := $new$      IF v_exact_seat_generation THEN
        UPDATE public.table_seats ts SET stack = v_target
         WHERE ts.id = (e->>'seat_id')::uuid
           AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
           AND ts.table_id = p_table_id
           AND ts.user_id = v_uid
           AND ts.left_at IS NULL;
      ELSE
        UPDATE public.table_seats ts SET stack = v_target
         WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
      END IF;$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one inner seat-write anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$        IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                        WHERE ts.table_id = p_table_id AND ts.user_id = v_uid
                          AND ts.left_at IS NULL AND ts.stack = v_target) THEN$old$;
  v_replacement := $new$        IF NOT EXISTS (
          SELECT 1
            FROM public.table_seats ts
           WHERE ts.table_id = p_table_id
             AND ts.user_id = v_uid
             AND ts.stack = v_target
             AND (
               (v_exact_seat_generation
                 AND ts.id = (e->>'seat_id')::uuid
                 AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
                 AND ts.left_at IS NULL)
               OR (NOT v_exact_seat_generation AND ts.left_at IS NULL)
             )
        ) THEN$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one inner lawful-noop anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

    EXECUTE v_src;
  END IF;

  /* -----------------------------------------------------------------------
     Obligations-aware exact outer commit.
     ----------------------------------------------------------------------- */
  SELECT pg_get_functiondef(
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
  ) INTO v_src;
  IF position('v_exact_seat_generation boolean := false;' in v_src) > 0
     AND position('time_bank_seat_generation_mismatch' in v_src) > 0
     AND position('s.id = (v_item->>''seat_id'')::uuid' in v_src) > 0 THEN
    RAISE NOTICE 'exact time-bank-generation settlement is already installed';
  ELSE
    IF md5(v_src) <> '2b5d9b337c653f0430910334d7e21521' THEN
      RAISE EXCEPTION
        'fn_ca_commit_hand_settlement(12 args) changed since exact-seat inspection';
    END IF;

  v_anchor := $old$  v_row_count integer;$old$;
  v_replacement := $new$  v_row_count integer;
  v_exact_seat_generation boolean := false;$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one outer variable anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'$old$;
  v_replacement := $new$    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  -- Database-first expansion. The previous engine may send an entirely legacy
  -- roster while it drains, but exact and legacy identities never mix.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_stack_seat_generation)';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;
    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
          OR (x ? 'seat_id') IS DISTINCT FROM v_exact_seat_generation
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;

    IF v_exact_seat_generation AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_stacks) s
          WHERE s->>'user_id' = x->>'user_id'
            AND s->>'seat_id' = x->>'seat_id'
            AND (s->>'seat_joined_at')::timestamptz =
                (x->>'seat_joined_at')::timestamptz
       )
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_generation_mismatch)';
    END IF;
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one outer generation-validation anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

  v_anchor := $old$      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.left_at IS NULL;
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_updated := v_updated + v_row_count;$old$;
  v_replacement := $new$      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND s.left_at IS NULL)
         );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* Preserve the stack writer's lawful-noop rule. If a redundant-update
         suppressor is installed, ROW_COUNT may be zero even though the exact
         row already stores the requested state. Prove that exact state before
         counting it; a missing or replaced generation still refuses whole. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
           AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
           AND (
             (v_exact_seat_generation
               AND s.id = (v_item->>'seat_id')::uuid
               AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
             OR (NOT v_exact_seat_generation AND s.left_at IS NULL)
           )
      ) THEN
        v_row_count := 1;
      END IF;
      v_updated := v_updated + v_row_count;$new$;
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected one exact time-bank write anchor, found %', v_hits;
  END IF;
  v_src := replace(v_src, v_anchor, v_replacement);

    EXECUTE v_src;
  END IF;
END;
$migration$;

/* Static postconditions only. The settlement functions move money and seat
   state, so this migration never invokes them against production data. */
DO $postconditions$
DECLARE
  v_inner text;
  v_outer text;
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
  ) INTO v_inner;
  SELECT pg_get_functiondef(
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
  ) INTO v_outer;

  IF position('ts.id = v_exact_seat_id' in v_inner) = 0
     OR position('ts.joined_at = v_exact_seat_joined_at' in v_inner) = 0
     OR position('exact seat generation missing or replaced' in v_inner) = 0
     OR position('v_dep_club := v_exact_seat_club' in v_inner) = 0
     OR position('v_dep_club IS NULL AND NOT v_exact_seat_generation' in v_inner) = 0 THEN
    RAISE EXCEPTION 'exact stack-generation postconditions failed';
  END IF;
  IF position('s.id = (v_item->>''seat_id'')::uuid' in v_outer) = 0
     OR position('s.joined_at = (v_item->>''seat_joined_at'')::timestamptz' in v_outer) = 0
     OR position('time_bank_seat_generation_mismatch' in v_outer) = 0 THEN
    RAISE EXCEPTION 'exact time-bank-generation postconditions failed';
  END IF;

  -- Rolling doors survive expansion byte-for-byte. The strict contraction is
  -- a later forward migration after the old process and envelopes have drained.
  IF md5(pg_get_functiondef(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure
     )) <> '42cd051b5f7014da40a80590deebd4fa' THEN
    RAISE EXCEPTION 'a rolling legacy commit door changed unexpectedly';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     ) OR has_function_privilege(
       'anon',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'settlement function ACL changed unexpectedly';
  END IF;
END;
$postconditions$;

COMMIT;
