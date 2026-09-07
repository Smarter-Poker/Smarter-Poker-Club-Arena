-- SUPERSEDED BY 20260907195116
--
-- A HAND CARRIES WHAT IT TAKES TO BANK ITS OWN RAKE
--
-- 2026-09-07. Applied to production at 19:28:43 UTC.
--
-- Superseded the same day, and the file is here because it ran, not because it
-- stands. Read 20260907195116 too before changing either.
--
-- The marker on the first line is read by scripts/ci/check-migrations-applied.mjs.
-- That gate asks "does what this migration declares exist in the live schema
-- NOW", which is the right question for new work and the wrong one for a
-- migration that was correctly undone hours later: the three columns below are
-- deliberately gone. The marker must NAME the superseding migration and that
-- file must exist in this directory, or the exemption does not apply - "it was
-- superseded" is the easiest lie to tell about a migration that never ran.
--
-- What this was for: ~49 cash hands a day recorded rake in `hand_history` and
-- were banked with `rake_records.hand_id => NULL`, so `rake_attributions` -
-- which keys on hand_id - held nothing for them and nobody at the table earned
-- anything from the hand. `fn_rake_repair_unbanked` could re-bank the chips but
-- passed `p_contributions => NULL`, so a repaired hand stayed unattributed. The
-- three columns below were meant to let a hand rebuild its own attribution.
--
-- Why it was superseded: the null was the whole defect, and it had a root. The
-- engine called `atomic_distribute_rake` BEFORE `hand_history` had come back
-- with an id. Minting the hand's uuid at settlement removes the null instead of
-- feeding a repair that reads around it (CLAUDE.md 10.12), which makes these
-- three columns 1.3 GB a month of storage - on a 3.6 GB table taking 221k rows
-- a day - for a repair that should never fire again.

BEGIN;
SET LOCAL lock_timeout = '8s';

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS player_contributions jsonb,
  ADD COLUMN IF NOT EXISTS returned_uncalled    jsonb,
  ADD COLUMN IF NOT EXISTS rake_method          text;

COMMENT ON COLUMN public.hand_history.player_contributions IS
  'Eligible chips each player put in, the map atomic_distribute_rake needs to attribute rake per player. Written by the engine in the SAME statement as the hand row (CLAUDE.md 10.12: the live path must be restartable from its OWN record). Before this, a process death between settlement step 8a and 8b left the hand recorded and the rake unbanked, and the hourly repair could only re-bank it with p_contributions NULL - so ~49 hands a day earned nobody VIP points, agent commission or rakeback. NULL on every hand written before 2026-09-07.';

COMMENT ON COLUMN public.hand_history.returned_uncalled IS
  'Uncalled bets handed back, per player. Paired with player_contributions so a repaired hand attributes exactly what the live path would have.';

COMMENT ON COLUMN public.hand_history.rake_method IS
  'WEIGHTED_CONTRIBUTED or DEALT_EQUAL, as the engine decided it at settlement. Recorded rather than re-derived: fn_rake_repair_unbanked used to guess it from a date cutover.';

CREATE OR REPLACE FUNCTION public.fn_rake_repair_unbanked(p_since_hours integer DEFAULT 48, p_limit integer DEFAULT 200)
RETURNS TABLE(hand_id uuid, club_id uuid, amount numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '540s'
AS $function$
DECLARE
  r record;
  v_repaired int := 0;
  v_chips numeric := 0;
  v_with_attribution int := 0;
BEGIN
  FOR r IN
    SELECT hh.id AS h_id, hh.table_id, t.club_id AS c_id, hh.hand_number,
           hh.rake_amount, COALESCE(hh.bbj_amount, 0) AS bbj, hh.pot_size,
           hh.created_at AS h_at,
           hh.player_contributions, hh.returned_uncalled,
           COALESCE(hh.rake_method,
                    CASE WHEN hh.created_at >= '2026-08-29 14:41+00'::timestamptz
                         THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END) AS method
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.tournament_id IS NULL
       AND t.tournament_id IS NULL
       AND hh.rake_amount > 0
       AND hh.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_since_hours, 48), 1))
       AND hh.created_at < now() - interval '5 minutes'
       AND t.club_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = hh.id)
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr2
                        WHERE rr2.table_id = hh.table_id
                          AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                 AND hh.created_at + interval '12 hours'
                          AND rr2.metadata->>'hand_number' = hh.hand_number::text)
       AND NOT EXISTS (SELECT 1 FROM public.pending_fee_distributions p
                        WHERE p.resolved_at IS NULL AND p.kind = 'rake'
                          AND (p.hand_id = hh.id OR p.hand_number = hh.hand_number))
     ORDER BY hh.created_at
     LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  LOOP
    BEGIN
      PERFORM public.atomic_distribute_rake(
        r.table_id, r.c_id, r.h_id, r.hand_number::integer, r.rake_amount,
        r.bbj, r.pot_size,
        CASE WHEN r.player_contributions IS NULL THEN NULL
             ELSE (SELECT count(*)::int FROM jsonb_object_keys(r.player_contributions)) END,
        r.player_contributions, NULL, r.returned_uncalled, r.method);
      v_repaired := v_repaired + 1;
      v_chips := v_chips + r.rake_amount;
      IF r.player_contributions IS NOT NULL THEN
        v_with_attribution := v_with_attribution + 1;
      END IF;
      hand_id := r.h_id; club_id := r.c_id; amount := r.rake_amount;
      RETURN NEXT;
    EXCEPTION WHEN others THEN
      NULL; -- next cycle retries; the candidate predicate re-evaluates
    END;
  END LOOP;

  IF v_repaired > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at)
    VALUES (CASE WHEN v_chips > 50 THEN 'warning' ELSE 'info' END,
            'fn_rake_repair_unbanked',
            'Recovered ' || v_repaired || ' unbanked rake hand(s) totalling ' ||
              round(v_chips, 2) || ' chips (engine did not survive to bank them). ' ||
              v_with_attribution || ' of them carried their own contributions map and were ' ||
              'attributed per player; the rest predate hand_history.player_contributions ' ||
              'and were banked with none. CLAUDE.md 10.12: every fire here is a P0 - the ' ||
              'live path failed and something else served the player afterwards.',
            jsonb_build_object('repaired', v_repaired, 'chips', round(v_chips, 2),
                               'with_attribution', v_with_attribution),
            (v_chips <= 50), CASE WHEN v_chips <= 50 THEN now() ELSE NULL END);
  END IF;

  RETURN;
END $function$;

REVOKE ALL ON FUNCTION public.fn_rake_repair_unbanked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_repair_unbanked(integer, integer) TO service_role;

DO $$
DECLARE v_cols int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema='public' AND table_name='hand_history'
     AND column_name IN ('player_contributions','returned_uncalled','rake_method');
  IF v_cols <> 3 THEN RAISE EXCEPTION 'expected all three columns on hand_history, got %', v_cols; END IF;

  IF has_function_privilege('anon', 'public.fn_rake_repair_unbanked(integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_rake_repair_unbanked(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can drive the rake repair';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_rake_repair_unbanked(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the repair cron can no longer run';
  END IF;
END $$;

COMMIT;
