BEGIN;
SET LOCAL lock_timeout = '8s';

/* THE ROOT WAS THE NULL, AND THE NULL IS GONE FROM THE ENGINE.
   ---------------------------------------------------------------------------
   20260907192843 (three hours' work earlier today) gave `hand_history` three
   columns so a REPAIR could rebuild the per-player attribution of a hand whose
   rake had been banked against a null hand id. That treated the symptom.

   Measured on production, 2026-09-07, 24 hours of live cash play:

     - 173 cash hands banked rake with `rake_records.hand_id IS NULL`, and
       ZERO of them had a single `rake_attributions` row. `atomic_distribute_rake`
       writes that ledger only `IF v_first_claim AND p_hand_id IS NOT NULL`, so
       nobody at those tables earned VIP points, agent or super-agent
       commission, or any rakeback basis. Horses and humans alike (10.5).
     - 36 hands in seven days carried two or three copies of their own rake
       row: `uq_rake_records_hand_id` is UNIQUE (hand_id) WHERE hand_id IS NOT
       NULL, so it deduped nothing and an in-line retry booked again.
     - 384 hands between 2026-09-02 and 2026-09-07 were booked TWICE - once by
       the live path with a null id, once by the 15-minute re-drive with the
       hand id it resolved afterwards. `v_leg_key` is
       COALESCE(p_hand_id, md5('rake:'||table||':'||hand_number)), so the two
       calls took DIFFERENT leg keys, `rake_distribution_legs` could not dedupe
       them, and `club_wallets` was incremented twice: 719.49 chips of rake and
       93.14 of BBJ drop that no pot ever paid.

   All three are one cause: the engine called `atomic_distribute_rake` before
   `hand_history` had returned an id. `ServerTableEngineSettlement` now MINTS
   the hand's uuid at settlement and hands the same value to the insert, to the
   rake, and to the BBJ contribution - so the id exists whether the row lands in
   line, from the retry queue five minutes later, or never.

   With the null gone the three columns buy nothing. They would cost about
   1.3 GB a month on a table already at 3.6 GB taking 221k rows a day, to feed a
   repair that must never fire again (CLAUDE.md 10.12: a repair job is not
   allowed to exist as the fix). `rake_records.player_contributions` already
   holds the same map, per hand, written live. So: dropped, and
   fn_rake_repair_unbanked restored byte-for-byte to its 20260829211853 body.

   DROP COLUMN here is metadata-only - Postgres marks the attribute dropped and
   rewrites nothing - so this does not touch the 3.6 GB. Nothing has read these
   columns: they existed for three hours and no deploy shipped against them. */

ALTER TABLE public.hand_history
  DROP COLUMN IF EXISTS player_contributions,
  DROP COLUMN IF EXISTS returned_uncalled,
  DROP COLUMN IF EXISTS rake_method;

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
BEGIN
  FOR r IN
    SELECT hh.id AS h_id, hh.table_id, t.club_id AS c_id, hh.hand_number,
           hh.rake_amount, COALESCE(hh.bbj_amount, 0) AS bbj, hh.pot_size,
           hh.created_at AS h_at,
           CASE WHEN hh.created_at >= '2026-08-29 14:41+00'::timestamptz
                THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END AS method
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.tournament_id IS NULL
       AND t.tournament_id IS NULL
       AND hh.rake_amount > 0
       AND hh.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_since_hours, 48), 1))
       AND hh.created_at < now() - interval '5 minutes'
       AND t.club_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = hh.id)
       -- time-bounded so the probe rides the created_at index: a hand's rake
       -- row is written within minutes (re-drives within hours) of the hand
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
        r.bbj, r.pot_size, NULL, NULL, NULL, NULL, r.method);
      v_repaired := v_repaired + 1;
      v_chips := v_chips + r.rake_amount;
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
              'Attribution not invented: contributions were lost with the engine.',
            jsonb_build_object('repaired', v_repaired, 'chips', round(v_chips, 2)),
            (v_chips <= 50), CASE WHEN v_chips <= 50 THEN now() ELSE NULL END);
  END IF;

  RETURN;
END $function$;

REVOKE ALL ON FUNCTION public.fn_rake_repair_unbanked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_repair_unbanked(integer, integer) TO service_role;

DO $$
DECLARE v_cols int; v_src text;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema='public' AND table_name='hand_history'
     AND column_name IN ('player_contributions','returned_uncalled','rake_method');
  IF v_cols <> 0 THEN RAISE EXCEPTION 'the three columns are still on hand_history (%)', v_cols; END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_rake_repair_unbanked';
  IF v_src LIKE '%player_contributions%' THEN
    RAISE EXCEPTION 'the repair still reads a column that no longer exists';
  END IF;
  IF v_src NOT LIKE '%Attribution not invented%' THEN
    RAISE EXCEPTION 'the repair was not restored to its 20260829211853 body';
  END IF;

  IF has_function_privilege('anon', 'public.fn_rake_repair_unbanked(integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_rake_repair_unbanked(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can drive the rake repair';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_rake_repair_unbanked(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the repair cron can no longer run';
  END IF;
END $$;

COMMIT;
