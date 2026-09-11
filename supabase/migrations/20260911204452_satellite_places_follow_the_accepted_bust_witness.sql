-- A newly settled modern satellite must award places by the accepted bust
-- witness, using the cash authority's 2026-09-11 ordering contract. A late
-- recording sequence cannot move an earlier bust ahead of a later hand.
-- Accepted hand commit time wins; after pruning use the hand's earliest
-- candidate capture; within one hand smaller starting stack, then user id,
-- busts first. With no eliminated generation, retain finite eliminated_at.
-- Unknown/nonfinite evidence refuses the entire transaction before awards.
-- Hand-for-hand simultaneity and split tied prizes are unchanged and outside
-- this ordering contract. The last-survivor winner rule is unchanged.
--
-- Apply AFTER the composed D9 + current Phase 3 manager core, body 6eb5860.
-- Only the modern ranking block changes. Legacy seals, exact source/seat and
-- manager capabilities, paid-header/public-receipt replay and function
-- metadata remain byte-identical. No existing rows are rewritten by this DDL.
-- The native rank probe is a focused statement proof, not a full current
-- manager/financial/certificate qualification; that integration is separate.
-- Reserved migration version supplied by the owning integration task.
-- DO NOT APPLY INSIDE MINUTE :50-:03 UTC (the hourly DDL break window).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $satellite_bust_witness$
DECLARE
  v_oid oid := to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)');
  v_body text;
  v_definition text;
  v_before jsonb;
  v_after jsonb;
  v_old text := $old_rank$  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- No evidence exists, so numeric positions can be rebuilt from the durable
  -- transition order without relabelling a payment.
  UPDATE public.tournament_players tp
     SET position = NULL
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  WITH ranked AS (
    SELECT tp.id,
           row_number() OVER (
             ORDER BY tp.elimination_sequence DESC, tp.id ASC
           )::integer + 1 AS final_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  UPDATE public.tournament_players tp
     SET position = ranked.final_position
    FROM ranked
   WHERE tp.id = ranked.id;
$old_rank$;
  v_new text := $accepted_rank$  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- Freeze the accepted bust order once, before any settlement header or
  -- award exists. The legacy seal above and paid-header replays stay unchanged.
  DECLARE
    v_bust_places jsonb;
    v_invalid_busts integer;
  BEGIN
    WITH busts AS (
      SELECT tp.id, tp.elimination_sequence,
             COALESCE(
               COALESCE(a.committed_at,
                        (SELECT min(g.created_at)
                           FROM public.tournament_knockout_candidates g
                          WHERE g.tournament_id = c.tournament_id
                            AND g.table_id = c.table_id
                            AND g.hand_number = c.hand_number
                            AND g.hand_id = c.hand_id))
               + (SELECT count(*)
                    FROM public.tournament_knockout_candidates s
                   WHERE s.tournament_id = c.tournament_id
                     AND s.table_id = c.table_id
                     AND s.hand_number = c.hand_number
                     AND s.hand_id = c.hand_id
                     AND (s.stack_before, s.eliminated_user_id)
                         < (c.stack_before, c.eliminated_user_id))::integer
                 * interval '1 microsecond',
               tp.eliminated_at) AS bust_at,
             NOT EXISTS (
               SELECT 1 FROM public.tournament_knockout_candidates s
                WHERE s.tournament_id = c.tournament_id
                  AND s.table_id = c.table_id
                  AND s.hand_number = c.hand_number
                  AND s.hand_id = c.hand_id
                  AND (s.stack_before IS NULL
                    OR s.stack_before::text IN ('NaN','Infinity','-Infinity')
                    OR s.created_at IS NULL OR NOT isfinite(s.created_at))
             ) AS finite_generation
        FROM public.tournament_players tp
        LEFT JOIN LATERAL (
          SELECT k.tournament_id, k.table_id, k.hand_number,
                 k.hand_id, k.stack_before, k.eliminated_user_id
            FROM public.tournament_knockout_candidates k
           WHERE k.tournament_id = tp.tournament_id
             AND k.eliminated_user_id = tp.user_id
             AND k.state = 'eliminated'
           ORDER BY k.hand_number DESC, k.id DESC
           LIMIT 1
        ) c ON true
        LEFT JOIN public.hand_atomic_commits a
          ON a.table_id = c.table_id
         AND a.hand_number = c.hand_number
         AND a.hand_id = c.hand_id
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ), ranked AS (
      SELECT b.id, b.bust_at, b.finite_generation,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS final_position
        FROM busts b
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', ranked.id, 'position', ranked.final_position)
             ORDER BY ranked.final_position), '[]'::jsonb),
           count(*) FILTER (WHERE ranked.bust_at IS NULL
             OR NOT isfinite(ranked.bust_at) OR NOT ranked.finite_generation)
      INTO v_bust_places, v_invalid_busts
      FROM ranked;
    IF v_invalid_busts <> 0 THEN
      RAISE EXCEPTION
        'satellite % has % eliminated player(s) with no finite accepted bust witness',
        p_tournament_id, v_invalid_busts USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    UPDATE public.tournament_players tp
       SET position = (p.value->>'position')::integer
      FROM jsonb_array_elements(v_bust_places) p(value)
     WHERE tp.id = (p.value->>'id')::uuid
       AND tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> v_eliminated_count THEN
      RAISE EXCEPTION 'satellite % did not write its exact captured bust order',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END;
$accepted_rank$;
BEGIN
  SELECT prosrc, pg_get_functiondef(oid), to_jsonb(p)-'prosrc'
    INTO v_body, v_definition, v_before FROM pg_proc p WHERE oid = v_oid;
  IF v_oid IS NULL
     OR md5(v_body) NOT IN ('6eb5860aad223fd1cfd14a48de2064bb','6d6637426f916cb766e606764af5e0a8')
     OR (v_before->>'proowner')::oid IS DISTINCT FROM 'postgres'::regrole::oid
     OR (v_before->>'prosecdef')::boolean IS DISTINCT FROM true
     OR (v_before->'proconfig') IS DISTINCT FROM
        to_jsonb(ARRAY['search_path=public','statement_timeout=30s']::text[])
     OR (v_before->'proacl') IS DISTINCT FROM to_jsonb(ARRAY['postgres=X/postgres']::text[])
     OR has_function_privilege('anon',v_oid,'EXECUTE')
     OR has_function_privilege('authenticated',v_oid,'EXECUTE')
     OR has_function_privilege('service_role',v_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'satellite accepted bust core source or owner metadata differs';
  END IF;
  IF md5(v_body) = '6eb5860aad223fd1cfd14a48de2064bb' THEN
    IF length(v_body)-length(replace(v_body,v_old,'')) <> length(v_old) THEN
      RAISE EXCEPTION 'satellite modern ranking anchor is not exact and unique';
    END IF;
    EXECUTE replace(v_definition, v_body, replace(v_body, v_old, v_new));
  END IF;
  SELECT prosrc, to_jsonb(p)-'prosrc' INTO v_body, v_after FROM pg_proc p WHERE oid = v_oid;
  IF md5(v_body) IS DISTINCT FROM '6d6637426f916cb766e606764af5e0a8'
     OR v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'satellite accepted bust core source or metadata postimage differs';
  END IF;
END $satellite_bust_witness$;
COMMIT;
