-- ═════════════════════════════════════════════════════════════════════════════
-- THE EXTENDED STRUCTURE IS AN APPEND, SO THE LIVE EVENT GETS IT TOO
-- Dan 2026-08-26, follow-up to deep_stack_structure_reaches_a_real_endgame
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The previous migration extended the Deep Stack from 20 levels to 32 and
-- refused to touch any instance with players registered. That guard is the
-- right default - rewriting blinds under a live tournament is not a thing to
-- do - but it was too blunt here, and it cost the one event that matters.
--
-- Five players are ALREADY REGISTERED in the 2026-08-30 event. They are
-- satellite winners, seated by fn_award_satellite_seat: the chain works. So
-- the flagship was going to run the SHORT structure while every future edition
-- got the long one.
--
-- The extension is a pure APPEND. Verified before writing this:
--   live levels 20, schedule levels 32, differing in the first 20: 0
-- Levels 1-20 are byte-identical, including the level-12 rebuy cliff those
-- five players signed up under. What changes is only what happens AFTER level
-- 20, where the alternative is not "the old structure" but the engine's
-- auto-escalation DOUBLING the blinds. Strictly better for everyone already in.
--
-- So this migration allows the update where the previous one refused, but only
-- under a PROOF that it is an append: it aborts unless every existing level of
-- the target matches the replacement exactly.

DO $$
DECLARE
  v_sched jsonb; v_diff integer; v_rows integer;
BEGIN
  SELECT config->'blindStructure' INTO v_sched
  FROM public.tournament_schedules
  WHERE name = 'Sunday $200 Deep Stack' AND active;

  IF v_sched IS NULL OR jsonb_array_length(v_sched) <> 32 THEN
    RAISE EXCEPTION 'the 32-level schedule structure is not in place; run the previous migration first';
  END IF;

  -- PROOF OF APPEND. Every pre-start instance's existing levels must be a
  -- prefix of the replacement. If a single element differs this is a rewrite,
  -- not an extension, and it must not happen under registered players.
  SELECT count(*) INTO v_diff
  FROM public.tournaments t,
       LATERAL generate_series(0, jsonb_array_length(t.blind_structure::jsonb) - 1) i
  WHERE t.name = 'Sunday $200 Deep Stack'
    AND t.status IN ('ANNOUNCED', 'REGISTERING')
    AND t.blind_structure::jsonb->i IS DISTINCT FROM v_sched->i;

  IF v_diff > 0 THEN
    RAISE EXCEPTION
      'refusing: % level(s) would CHANGE rather than be appended. That is a rewrite under live registrations.', v_diff;
  END IF;

  UPDATE public.tournaments t
  SET blind_structure = v_sched::text
  WHERE t.name = 'Sunday $200 Deep Stack'
    AND t.status IN ('ANNOUNCED', 'REGISTERING');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'extended % pre-start Deep Stack instance(s) to 32 levels', v_rows;
END $$;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────

DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.tournaments t
  WHERE t.name = 'Sunday $200 Deep Stack'
    AND t.status IN ('ANNOUNCED','REGISTERING')
    AND jsonb_array_length(t.blind_structure::jsonb) <> 32;
  IF v_bad > 0 THEN RAISE EXCEPTION '% pre-start Deep Stack(s) still on the short structure', v_bad; END IF;

  -- The rebuy cliff those five players entered under is untouched.
  SELECT count(*) INTO v_bad FROM public.tournaments t
  WHERE t.name = 'Sunday $200 Deep Stack'
    AND t.status IN ('ANNOUNCED','REGISTERING')
    AND (t.blind_structure::jsonb->11->>'bigBlind')::numeric <> 1200;
  IF v_bad > 0 THEN RAISE EXCEPTION 'the level-12 rebuy blind changed - that is a rewrite, not an append'; END IF;

  SELECT count(*) INTO v_bad
  FROM public.tournaments t, LATERAL jsonb_array_elements(t.blind_structure::jsonb) lv
  WHERE t.name = 'Sunday $200 Deep Stack'
    AND t.status IN ('ANNOUNCED','REGISTERING')
    AND (lv->>'durationMinutes')::numeric <> 10;
  IF v_bad > 0 THEN RAISE EXCEPTION '% level(s) are not 10 minutes', v_bad; END IF;

  -- Nobody was thrown out of the event by any of this.
  IF (SELECT count(*) FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
      WHERE t.name = 'Sunday $200 Deep Stack') < 5 THEN
    RAISE EXCEPTION 'registered players were lost';
  END IF;
END $$;

-- ROLLBACK: restore the 20-level array onto the schedule and re-run; the
-- append proof above will then refuse, which is correct - shortening a
-- structure under registered players is a rewrite.
