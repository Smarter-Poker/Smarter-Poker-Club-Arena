-- 20260910002540_hand_settlement_requires_exact_seat_generation
--
-- STRICT CONTRACT AFTER THE ROLLING EXPANSION
-- -------------------------------------------
-- 20260908161534 taught the accepted-hand functions to settle the immutable
-- `(table_seats.id, table_seats.joined_at)` generation while temporarily
-- retaining all-legacy payloads for a zero-downtime engine rollout. The later
-- Stage-B authority cutover 20260910002530 removes the old 9- and 11-argument
-- RPC doors, but its surviving 12-argument RPC and seven-argument stack core
-- can still receive a generation-blind JSON roster. That compatibility path
-- can target whichever active row happens to exist after a leave/rejoin.
--
-- This is the contract half of expand/contract. Apply it only after:
--
--   1. 20260908161534 is installed;
--   2. the exact engine is the sole live engine and old requests have drained;
--   3. 20260910002530 has removed both old hand-commit signatures.
--
-- A later terminal-receipt migration was applied after the expansion from an
-- older source snapshot and replaced both functions, losing the exact-seat
-- selectors while adding atomic terminal receipts and zero-stack tournament
-- close. Production then restored the rolling exact-seat expansion over those
-- receipt-aware bodies. This contraction recognizes both byte-exact preimages:
-- the repaired rolling source now live and the generation-blind receipt source
-- it replaced. The seat-exit authority prerequisite then renamed that exact
-- implementation core to
-- fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority and installed an
-- owner-only capability wrapper at the public name. This contraction edits
-- the preserved private core in place; replacing the wrapper would silently
-- remove zero-stack seat-exit authority. Both paths retain every receipt,
-- lifecycle, lock-order and
-- zero-seat behavior while removing the compatibility fallback.
--
-- Every nonempty stack and time-bank item must then name a valid seat_id plus
-- seat_joined_at. Stack selection/write and time-bank write have no user-only
-- active-row fallback. A different-chair rejoin cannot be selected. A reused
-- same-chair row has a different joined_at and is refused whole. Exact departed
-- cash settlement still uses only the historical row's club; departed
-- tournament settlement remains fail closed.
--
-- The direct seven-argument stack function is an implementation core, not a
-- runtime RPC. No production caller needs it, and exposing it to service_role
-- bypasses the exact table lease, atomic hand history, projection outbox and
-- post-commit envelope. This cutover makes it owner-only. The 12-argument RPC
-- remains the only service_role settlement door.
--
-- No cron, retry, repair sweep, reconciliation write, data rewrite or runtime
-- flag is introduced. Exact source hashes and one-hit substitutions abort on
-- drift. CREATE OR REPLACE preserves function owner/identity. Rollback is a new
-- forward migration after a deliberately redeployed legacy-compatible engine;
-- do not reopen a generation-blind door during an ordinary application rollback.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Global Supabase catalog order: realtime.subscription before public objects.
-- NOWAIT refuses a busy cutover window whole rather than blocking live tables.
LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $strict_contract$
DECLARE
  v_inner text;
  v_outer text;
  v_anchors text[];
  v_replacements text[];
  v_expected_hits integer[];
  v_hits integer;
  v_i integer;
  v_inner_strict boolean;
  v_outer_strict boolean;
BEGIN
  IF to_regprocedure(
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'
     ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'
        ) IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION 'strict exact-seat contraction requires both expanded settlement functions';
  END IF;

  -- These are the rolling public doors retired by 20260910002530. Refuse an
  -- out-of-order contraction rather than breaking a still-draining engine.
  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'strict exact-seat contraction requires Stage-B legacy hand doors retired';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
  ) INTO v_inner;
  SELECT pg_get_functiondef(
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
  ) INTO v_outer;

  v_inner_strict :=
    position('Exact seat generation is required for every hand settlement participant' in v_inner) > 0
    AND position('v_exact_seat_generation' in v_inner) = 0;
  v_outer_strict :=
    position('exact_stack_seat_generation_required' in v_outer) > 0
    AND position('exact_time_bank_seat_generation_required' in v_outer) > 0
    AND position('v_exact_seat_generation' in v_outer) = 0;

  IF v_inner_strict IS DISTINCT FROM v_outer_strict THEN
    RAISE EXCEPTION 'strict exact-seat contraction is partially installed';
  END IF;

  IF v_inner_strict THEN
    IF md5(v_inner) <> 'edfd095bae13ece6bedc989c3acd0467'
       OR md5(v_outer) <> '022f0de6ed0fb51ff3fbe5f3ff36f6d0' THEN
      RAISE EXCEPTION 'strict exact-seat settlement source changed after cutover';
    END IF;
    RAISE NOTICE 'strict exact seat-generation settlement is already installed';
  ELSE
    IF has_function_privilege(
         'anon',
         'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'authenticated',
         'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'service_role',
         'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'anon',
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'authenticated',
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
         'EXECUTE'
       )
       OR NOT has_function_privilege(
         'service_role',
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
         'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'receipt-aware settlement ACL changed before strict contraction';
    END IF;

    /* The production repair after the terminal-receipt writer restored the
       rolling exact-seat expansion over the receipt-aware bodies. Contract
       that byte-exact source directly; do not replay or discard either
       terminal-receipt or zero-stack behavior. */
    IF md5(v_inner) = 'ba1cdf1b56e5bb0c1c199b65390ee1f2'
       AND md5(v_outer) = 'f93a85ebe5a509ccb7dfedb9be1ed3fa' THEN
      v_anchors := ARRAY[
      $old$  v_exact_seat_generation boolean;
$old$,
      $old$  -- Rolling expansion accepts either a wholly legacy roster or a wholly exact
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
$old$,
      $old$      || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', (x->>'seat_id')::uuid,
              'seat_joined_at', x->>'seat_joined_at')
              ELSE '{}'::jsonb END
$old$,
      $old$      v_exact_seat_id := NULL;
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
        END IF;
$old$,
      $old$          IF v_exact_seat_generation THEN
            -- Use the club captured on the exact departed generation. Looking
            -- up the latest departed row can cross a later rejoin or club move.
            v_dep_club := v_exact_seat_club;
          ELSE
            SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
             WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
             ORDER BY ts.left_at DESC LIMIT 1;
          END IF;
$old$,
      $old$          IF v_dep_club IS NULL AND NOT v_exact_seat_generation THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;
$old$,
      $old$            ) || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', v_exact_seat_id,
              'seat_joined_at', e->>'seat_joined_at'
            ) ELSE '{}'::jsonb END
$old$,
      $old$      IF v_exact_seat_generation THEN
        UPDATE public.table_seats ts SET stack = v_target
         WHERE ts.id = (e->>'seat_id')::uuid
           AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
           AND ts.table_id = p_table_id
           AND ts.user_id = v_uid
           AND ts.left_at IS NULL;
      ELSE
        UPDATE public.table_seats ts SET stack = v_target
         WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
      END IF;
$old$,
      $old$             AND (
               (v_exact_seat_generation
                 AND ts.id = (e->>'seat_id')::uuid
                 AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
                 AND ts.left_at IS NULL)
               OR (NOT v_exact_seat_generation AND ts.left_at IS NULL)
             )
$old$
      ];
      v_replacements := ARRAY[
      ''::text,
      $new$  -- Exact seat generation is required for every hand settlement participant.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_stacks) x
     WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
        OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
        OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                THEN (x->>'seat_id') !~*
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                ELSE true END
        OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                THEN NOT pg_input_is_valid(
                  x->>'seat_joined_at', 'timestamp with time zone'
                )
                ELSE true END
  ) THEN
    RAISE EXCEPTION 'Exact hand settlement seat generation is required'
      USING ERRCODE = '22023';
  END IF;
$new$,
      $new$      || jsonb_build_object(
           'seat_id', (x->>'seat_id')::uuid,
           'seat_joined_at', x->>'seat_joined_at')
$new$,
      $new$      v_exact_seat_id := (e->>'seat_id')::uuid;
      v_exact_seat_joined_at := (e->>'seat_joined_at')::timestamptz;
      v_exact_seat_left_at := NULL;
      v_exact_seat_club := NULL;
      SELECT ts.stack, ts.left_at, ts.club_id
        INTO v_old, v_exact_seat_left_at, v_exact_seat_club
        FROM public.table_seats ts
       WHERE ts.id = v_exact_seat_id
         AND ts.joined_at = v_exact_seat_joined_at
         AND ts.table_id = p_table_id
         AND ts.user_id = v_uid
       FOR UPDATE;
      v_exact_seat_found := FOUND;
      IF NOT v_exact_seat_found THEN
        -- A row id can be reused in place. A changed joined_at is not the seat
        -- this hand dealt, and no current active seat is an acceptable fallback.
        RAISE EXCEPTION
          'exact seat generation missing or replaced for % - hand write rejected whole',
          v_uid;
      END IF;
      IF v_exact_seat_left_at IS NOT NULL THEN
$new$,
      $new$          -- Use the club captured on the exact departed generation. Looking
          -- up the latest departed row can cross a later rejoin or club move.
          v_dep_club := v_exact_seat_club;
$new$,
      ''::text,
      $new$            ) || jsonb_build_object(
              'seat_id', v_exact_seat_id,
              'seat_joined_at', e->>'seat_joined_at'
            )
$new$,
      $new$      UPDATE public.table_seats ts SET stack = v_target
       WHERE ts.id = (e->>'seat_id')::uuid
         AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
         AND ts.table_id = p_table_id
         AND ts.user_id = v_uid
         AND ts.left_at IS NULL;
$new$,
      $new$             AND ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.left_at IS NULL
$new$
      ];
      FOR v_i IN 1..array_length(v_anchors, 1) LOOP
        v_hits := (length(v_inner) - length(replace(v_inner, v_anchors[v_i], '')))
                  / length(v_anchors[v_i]);
        IF v_hits <> 1 THEN
          RAISE EXCEPTION 'restored exact inner anchor % expected once, found %',
            v_i, v_hits;
        END IF;
        v_inner := replace(v_inner, v_anchors[v_i], v_replacements[v_i]);
      END LOOP;
      IF md5(v_inner) <> 'edfd095bae13ece6bedc989c3acd0467'
         OR position('v_exact_seat_generation' in v_inner) > 0
         OR position('Exact seat generation is required for every hand settlement participant'
                     in v_inner) = 0
         OR position('tournament_zero_stack_seat_generations' in v_inner) = 0 THEN
        RAISE EXCEPTION 'restored exact inner contraction produced an unknown source';
      END IF;
      EXECUTE v_inner;

      v_anchors := ARRAY[
      $old$  v_exact_seat_generation boolean := false;
$old$,
      $old$  -- Database-first expansion. The previous engine may send an entirely legacy
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
$old$,
      $old$      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );$old$,
      $old$      GET DIAGNOSTICS v_row_count = ROW_COUNT;
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
             OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
           )
      ) THEN
        v_row_count := 1;
      END IF;
      v_updated := v_updated + v_row_count;$old$
      ];
      v_replacements := ARRAY[
      ''::text,
      $new$  -- Strict exact-engine contract. Every nonempty narrative names one
  -- immutable seat generation; no active-row lookup is a legal substitute.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
          OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
          OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE true END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE true END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (exact_stack_seat_generation_required)';
    END IF;
  END IF;

  IF jsonb_array_length(p_post_commit_obligations->'time_banks') > 0
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
        WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
           OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
           OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
           OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                   THEN (x->>'seat_id') !~*
                     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   ELSE true END
           OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                   THEN NOT pg_input_is_valid(
                     x->>'seat_joined_at', 'timestamp with time zone'
                   )
                   ELSE true END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (exact_time_bank_seat_generation_required)';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
          AND s->>'seat_id' = x->>'seat_id'
          AND (s->>'seat_joined_at')::timestamptz =
              (x->>'seat_joined_at')::timestamptz
     )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (time_bank_seat_generation_mismatch)';
  END IF;
$new$,
      $new$      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.id = (v_item->>'seat_id')::uuid
         AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz
         AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         );$new$,
      $new$      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK. Count a verified exact
         departed generation as a lawful no-op, and count an active exact row
         whose requested values already match when the redundant-update guard
         suppressed the physical UPDATE. A missing or reused generation still
         refuses the whole accepted hand. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.id = (v_item->>'seat_id')::uuid
           AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz
           AND (
             s.left_at IS NOT NULL
             OR (
               s.time_bank_uses_remaining =
                 (v_item->>'uses_remaining')::integer
               AND s.time_bank_remaining =
                 (v_item->>'seconds_remaining')::integer
             )
           )
      ) THEN
        v_row_count := 1;
      END IF;
      v_updated := v_updated + v_row_count;$new$
      ];
      v_expected_hits := ARRAY[1, 1, 1, 1];
      FOR v_i IN 1..array_length(v_anchors, 1) LOOP
        v_hits := (length(v_outer) - length(replace(v_outer, v_anchors[v_i], '')))
                  / length(v_anchors[v_i]);
        IF v_hits <> v_expected_hits[v_i] THEN
          RAISE EXCEPTION
            'restored exact outer anchor % expected % occurrence(s), found %',
            v_i, v_expected_hits[v_i], v_hits;
        END IF;
        v_outer := replace(v_outer, v_anchors[v_i], v_replacements[v_i]);
      END LOOP;
      IF md5(v_outer) <> '022f0de6ed0fb51ff3fbe5f3ff36f6d0'
         OR position('v_exact_seat_generation' in v_outer) > 0
         OR position('exact_stack_seat_generation_required' in v_outer) = 0
         OR position('exact_time_bank_seat_generation_required' in v_outer) = 0
         OR position('post_commit_request_hash' in v_outer) = 0
         OR position('tournament_zero_stack_seat_generations' in v_outer) = 0
         OR position('A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK' in v_outer) = 0 THEN
        RAISE EXCEPTION 'restored exact outer contraction produced an unknown source';
      END IF;
      EXECUTE v_outer;
    ELSE
    IF md5(v_inner) <> '2e322bc7dfee3cf5cb6548ed3a587095' THEN
      RAISE EXCEPTION
        'receipt-aware fn_ca_settle_hand_stacks_absolute changed before strict contraction';
    END IF;
    IF md5(v_outer) <> '8ddb91f5f7bb5f27b609ec83cb69fa66' THEN
      RAISE EXCEPTION
        'receipt-aware fn_ca_commit_hand_settlement changed before strict contraction';
    END IF;
    /* Receipt-aware inner core: require one immutable generation from request,
       through canonical replay identity, lock, write and tournament close. */
    v_anchors := ARRAY[
      $old$  v_delta_mode boolean;
$old$,
      $old$  END IF;
  IF (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid) FROM jsonb_array_elements(p_stacks) x) THEN
$old$,
      $old$  SELECT jsonb_agg(jsonb_build_object('user_id', (x->>'user_id')::uuid,
      'stack', (x->>'stack')::numeric)
      || CASE WHEN x ? 'stack_before' THEN jsonb_build_object('stack_before', (x->>'stack_before')::numeric)
              ELSE '{}'::jsonb END
      ORDER BY (x->>'user_id')::uuid) INTO v_canonical
    FROM jsonb_array_elements(p_stacks) x;
$old$,
      $old$    PERFORM 1
      FROM public.table_seats ts
      JOIN (
        SELECT DISTINCT (x.value->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(v_canonical) AS x(value)
      ) target ON target.user_id = ts.user_id
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
     ORDER BY ts.id
     FOR UPDATE OF ts;
$old$,
      $old$      SELECT ts.stack INTO v_old FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN
$old$,
      $old$          SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
           ORDER BY ts.left_at DESC LIMIT 1;
$old$,
      $old$          IF v_dep_club IS NULL THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;
$old$,
      $old$          v_departed := v_departed || jsonb_build_array(jsonb_build_object(
            'user_id', v_uid, 'delta', round(v_new - v_before, 2), 'club_id', v_dep_club));
$old$,
      $old$      UPDATE public.table_seats ts SET stack = v_target
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
$old$,
      $old$        IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                        WHERE ts.table_id = p_table_id AND ts.user_id = v_uid
                          AND ts.left_at IS NULL AND ts.stack = v_target) THEN
$old$,
      $old$                JOIN public.table_seats ts
                  ON ts.table_id = p_table_id
                 AND ts.user_id = tp.user_id
                 AND ts.left_at IS NULL
$old$,
      $old$        FROM public.table_seats ts
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = ts.user_id
       WHERE ts.table_id = p_table_id
         AND ts.left_at IS NULL
$old$
    ];
    v_replacements := ARRAY[
      $new$  v_delta_mode boolean;
  v_exact_seat_id uuid;
  v_exact_seat_joined_at timestamptz;
  v_exact_seat_left_at timestamptz;
  v_exact_seat_club uuid;
  v_exact_seat_found boolean;
$new$,
      $new$  END IF;

  -- Exact seat generation is required for every hand settlement participant.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_stacks) x
     WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
        OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
        OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                THEN (x->>'seat_id') !~*
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                ELSE true END
        OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                THEN NOT pg_input_is_valid(
                  x->>'seat_joined_at', 'timestamp with time zone'
                )
                ELSE true END
  ) THEN
    RAISE EXCEPTION 'Exact hand settlement seat generation is required'
      USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid) FROM jsonb_array_elements(p_stacks) x) THEN
$new$,
      $new$  SELECT jsonb_agg(jsonb_build_object('user_id', (x->>'user_id')::uuid,
      'stack', (x->>'stack')::numeric)
      || CASE WHEN x ? 'stack_before' THEN jsonb_build_object('stack_before', (x->>'stack_before')::numeric)
              ELSE '{}'::jsonb END
      || jsonb_build_object(
           'seat_id', (x->>'seat_id')::uuid,
           'seat_joined_at', x->>'seat_joined_at')
      ORDER BY (x->>'user_id')::uuid) INTO v_canonical
    FROM jsonb_array_elements(p_stacks) x;
$new$,
      $new$    PERFORM 1
      FROM public.table_seats ts
      JOIN jsonb_array_elements(v_canonical) target(value)
        ON ts.id = (target.value->>'seat_id')::uuid
       AND ts.joined_at = (target.value->>'seat_joined_at')::timestamptz
       AND ts.user_id = (target.value->>'user_id')::uuid
     WHERE ts.table_id = p_table_id
     ORDER BY ts.id
     FOR UPDATE OF ts;
$new$,
      $new$      v_exact_seat_id := (e->>'seat_id')::uuid;
      v_exact_seat_joined_at := (e->>'seat_joined_at')::timestamptz;
      v_exact_seat_left_at := NULL;
      v_exact_seat_club := NULL;
      SELECT ts.stack, ts.left_at, ts.club_id
        INTO v_old, v_exact_seat_left_at, v_exact_seat_club
        FROM public.table_seats ts
       WHERE ts.id = v_exact_seat_id
         AND ts.joined_at = v_exact_seat_joined_at
         AND ts.table_id = p_table_id
         AND ts.user_id = v_uid
       FOR UPDATE;
      v_exact_seat_found := FOUND;
      IF NOT v_exact_seat_found THEN
        -- A row id can be reused in place. A changed joined_at is not the seat
        -- this hand dealt, and no current active seat is an acceptable fallback.
        RAISE EXCEPTION
          'exact seat generation missing or replaced for % - hand write rejected whole',
          v_uid;
      END IF;
      IF v_exact_seat_left_at IS NOT NULL THEN
$new$,
      $new$          -- Use the club captured on the exact departed generation. Looking
          -- up the latest departed row can cross a later rejoin or club move.
          v_dep_club := v_exact_seat_club;
$new$,
      ''::text,
      $new$          v_departed := v_departed || jsonb_build_array(
            jsonb_build_object(
              'user_id', v_uid,
              'delta', round(v_new - v_before, 2),
              'club_id', v_dep_club
            ) || jsonb_build_object(
              'seat_id', v_exact_seat_id,
              'seat_joined_at', e->>'seat_joined_at'
            ));
$new$,
      $new$      UPDATE public.table_seats ts SET stack = v_target
       WHERE ts.id = (e->>'seat_id')::uuid
         AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
         AND ts.table_id = p_table_id
         AND ts.user_id = v_uid
         AND ts.left_at IS NULL;
$new$,
      $new$        IF NOT EXISTS (
          SELECT 1
            FROM public.table_seats ts
           WHERE ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = p_table_id
             AND ts.user_id = v_uid
             AND ts.left_at IS NULL
             AND ts.stack = v_target
        ) THEN
$new$,
      $new$                JOIN jsonb_array_elements(v_canonical) generation(value)
                  ON generation.value->>'user_id' = target.key
                JOIN public.table_seats ts
                  ON ts.id = (generation.value->>'seat_id')::uuid
                 AND ts.joined_at =
                       (generation.value->>'seat_joined_at')::timestamptz
                 AND ts.table_id = p_table_id
                 AND ts.user_id = tp.user_id
                 AND ts.left_at IS NULL
$new$,
      $new$        FROM public.table_seats ts
        JOIN jsonb_array_elements(v_canonical) generation(value)
          ON ts.id = (generation.value->>'seat_id')::uuid
         AND ts.joined_at =
               (generation.value->>'seat_joined_at')::timestamptz
         AND ts.user_id = (generation.value->>'user_id')::uuid
        JOIN jsonb_each_text(v_targets) target
          ON target.key = generation.value->>'user_id'
       WHERE ts.table_id = p_table_id
         AND ts.left_at IS NULL
$new$
    ];
    FOR v_i IN 1..array_length(v_anchors, 1) LOOP
      v_hits := (length(v_inner) - length(replace(v_inner, v_anchors[v_i], '')))
                / length(v_anchors[v_i]);
      IF v_hits <> 1 THEN
        RAISE EXCEPTION 'strict inner anchor % expected once, found %', v_i, v_hits;
      END IF;
      v_inner := replace(v_inner, v_anchors[v_i], v_replacements[v_i]);
    END LOOP;
    IF position('v_exact_seat_generation' in v_inner) > 0
       OR position('WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL'
                   in v_inner) > 0 THEN
      RAISE EXCEPTION 'a generation-blind inner seat fallback survived contraction';
    END IF;
    EXECUTE v_inner;

    /* Receipt-aware outer door: validate both narratives before the inner
       transaction and write only the exact seat generation it returned. */
    v_anchors := ARRAY[
      $old$    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
$old$,
      $old$       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
$old$,
      $old$      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_updated := v_updated + v_row_count;
$old$
    ];
    v_replacements := ARRAY[
      $new$    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  -- Strict exact-engine contract. Every nonempty narrative names one
  -- immutable seat generation; no active-row lookup is a legal substitute.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
          OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
          OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE true END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE true END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (exact_stack_seat_generation_required)';
    END IF;
  END IF;

  IF jsonb_array_length(p_post_commit_obligations->'time_banks') > 0
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
        WHERE NOT (x ? 'seat_id' AND x ? 'seat_joined_at')
           OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
           OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
           OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                   THEN (x->>'seat_id') !~*
                     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   ELSE true END
           OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                   THEN NOT pg_input_is_valid(
                     x->>'seat_joined_at', 'timestamp with time zone'
                   )
                   ELSE true END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (exact_time_bank_seat_generation_required)';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
          AND s->>'seat_id' = x->>'seat_id'
          AND (s->>'seat_joined_at')::timestamptz =
              (x->>'seat_joined_at')::timestamptz
     )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (time_bank_seat_generation_mismatch)';
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
$new$,
      $new$       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.id = (v_item->>'seat_id')::uuid
         AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz
         AND (
$new$,
      $new$      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK. Count a verified exact
         departed generation as a lawful no-op, and count an active exact row
         whose requested values already match when the redundant-update guard
         suppressed the physical UPDATE. A missing or reused generation still
         refuses the whole accepted hand. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.id = (v_item->>'seat_id')::uuid
           AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz
           AND (
             s.left_at IS NOT NULL
             OR (
               s.time_bank_uses_remaining =
                 (v_item->>'uses_remaining')::integer
               AND s.time_bank_remaining =
                 (v_item->>'seconds_remaining')::integer
             )
           )
      ) THEN
        v_row_count := 1;
      END IF;
      v_updated := v_updated + v_row_count;
$new$
    ];
    v_expected_hits := ARRAY[1, 1, 1];
    FOR v_i IN 1..array_length(v_anchors, 1) LOOP
      v_hits := (length(v_outer) - length(replace(v_outer, v_anchors[v_i], '')))
                / length(v_anchors[v_i]);
      IF v_hits <> v_expected_hits[v_i] THEN
        RAISE EXCEPTION 'strict outer anchor % expected % occurrence(s), found %',
          v_i, v_expected_hits[v_i], v_hits;
      END IF;
      v_outer := replace(v_outer, v_anchors[v_i], v_replacements[v_i]);
    END LOOP;
    IF position('v_exact_seat_generation' in v_outer) > 0
       OR position('NOT v_exact_seat_generation' in v_outer) > 0 THEN
      RAISE EXCEPTION 'a generation-blind outer seat fallback survived contraction';
    END IF;
    EXECUTE v_outer;
    END IF;
  END IF;
END;
$strict_contract$;

-- The inner writer is an owner-only implementation detail after contraction.
REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(
  uuid, bigint, jsonb, numeric, numeric, text, numeric
) FROM PUBLIC, anon, authenticated, service_role;

DO $postconditions$
DECLARE
  v_inner text;
  v_outer text;
  v_wrapper text;
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
  ) INTO STRICT v_inner;
  SELECT pg_get_functiondef(
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
  ) INTO STRICT v_outer;
  SELECT p.prosrc
    INTO STRICT v_wrapper
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
     AND p.prosecdef;

  IF position('Exact seat generation is required for every hand settlement participant'
              in v_inner) = 0
     OR md5(v_inner) <> 'edfd095bae13ece6bedc989c3acd0467'
     OR position('v_exact_seat_generation' in v_inner) > 0
     OR position('ts.id = v_exact_seat_id' in v_inner) = 0
     OR position('ts.joined_at = v_exact_seat_joined_at' in v_inner) = 0
     OR position('v_dep_club := v_exact_seat_club' in v_inner) = 0
     OR position('tournament_zero_stack_seat_generations' in v_inner) = 0
     OR position('ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL'
                 in v_inner) > 0 THEN
    RAISE EXCEPTION
      'strict exact-seat stack postconditions failed (inner md5 %, outer md5 %)',
      md5(v_inner),md5(v_outer);
  END IF;
  IF position('exact_stack_seat_generation_required' in v_outer) = 0
     OR md5(v_outer) <> '022f0de6ed0fb51ff3fbe5f3ff36f6d0'
     OR position('exact_time_bank_seat_generation_required' in v_outer) = 0
     OR position('A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK' in v_outer) = 0
     OR position('post_commit_request_hash' in v_outer) = 0
     OR position('post_commit_payload_hash' in v_outer) = 0
     OR position('ca:tournament-terminal-settlement:v1' in v_outer) = 0
     OR position('v_exact_seat_generation' in v_outer) > 0
     OR position('s.id = (v_item->>''seat_id'')::uuid' in v_outer) = 0
     OR position('s.joined_at = (v_item->>''seat_joined_at'')::timestamptz' in v_outer) = 0 THEN
    RAISE EXCEPTION 'strict exact-seat time-bank postconditions failed (source md5 %)',
      md5(v_outer);
  END IF;

  IF md5(v_wrapper) <> '9d6a12c82aa260c22e1c013e95faca0e'
     OR position('fn_ca_open_tournament_hand_seat_exit_authority'
                 in v_wrapper)=0
     OR position('fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority'
                 in v_wrapper)=0
     OR position('fn_ca_close_tournament_seat_exit_authority'
                 in v_wrapper)=0 THEN
    RAISE EXCEPTION
      'accepted-hand seat-exit wrapper changed during strict contraction';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'a rolling hand-commit door survived strict exact-seat contraction';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'strict settlement function ACL is wrong';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) a
     WHERE p.oid =
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'the direct stack implementation core is not owner-only';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) a
     WHERE p.oid =
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'the accepted-hand seat-exit wrapper is not owner-only';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) a
     WHERE p.oid =
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee NOT IN (
         p.proowner,
         (SELECT oid FROM pg_roles WHERE rolname = 'service_role')
       )
  ) THEN
    RAISE EXCEPTION 'the exact hand RPC has an unexpected executor';
  END IF;
END;
$postconditions$;

/* The API cache must forget both removed overloads in the same release
   boundary that commits their catalog deletion. */
NOTIFY pgrst, 'reload schema';

COMMIT;
