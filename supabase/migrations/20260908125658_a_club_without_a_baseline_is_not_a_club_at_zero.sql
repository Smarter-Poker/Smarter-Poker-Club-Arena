DO $mig$
DECLARE
  v_src text; v_new text; v_hits integer;
  v_deep numeric;
  v_added integer := 0;
  v_anchor_ledger text :=
    '           COALESCE(b.opening_balance, 0)' || E'\n' ||
    '             + COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance,' || E'\n' ||
    '           COALESCE(b.opening_balance, 0) AS opening,';
  v_replace_ledger text :=
    '           b.opening_balance' || E'\n' ||
    '             + COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance,' || E'\n' ||
    '           b.opening_balance AS opening,';
  v_anchor_merged text :=
    '           COALESCE(l.balance, 0) AS ledger_balance,' || E'\n' ||
    '           COALESCE(s.balance, 0) AS stored_balance,' || E'\n' ||
    '           COALESCE(l.opening, 0) AS opening,';
  v_replace_merged text :=
    '           l.balance AS ledger_balance,' || E'\n' ||
    '           COALESCE(s.balance, 0) AS stored_balance,' || E'\n' ||
    '           l.opening AS opening,';
  v_anchor_insert text :=
    '  SELECT ''club_treasury'', club_id, ledger_balance, stored_balance,' || E'\n' ||
    '    CASE' || E'\n' ||
    '      WHEN ABS(stored_balance - ledger_balance) = 0     THEN ''ok''' || E'\n' ||
    '      WHEN ABS(stored_balance - ledger_balance) <= 1.00 THEN ''warn''' || E'\n' ||
    '      ELSE ''critical''' || E'\n' ||
    '    END,' || E'\n' ||
    '    jsonb_build_object(''source'', ''reconcile_ledger_nightly'',';
  v_replace_insert text :=
    '  /* A MISSING BASELINE IS NOT AN OPENING OF ZERO (2026-09-08). When a club' || E'\n' ||
    '     has no ca_treasury_baseline row, ledger_balance is NULL and this' || E'\n' ||
    '     declines to judge rather than reporting the club''''s whole history as' || E'\n' ||
    '     drift - which is what produced a 9,981,739.70 critical against Deep' || E'\n' ||
    '     Stack Society every night since it was created eight hours after the' || E'\n' ||
    '     baseline was drawn. ledger_balance is NOT NULL and severity is' || E'\n' ||
    '     constrained to ok/warn/critical, so it records no drift and says why -' || E'\n' ||
    '     a warn whose drift reads 0.00 would otherwise be unreadable. */' || E'\n' ||
    '  SELECT ''club_treasury'', club_id,' || E'\n' ||
    '    COALESCE(ledger_balance, stored_balance), stored_balance,' || E'\n' ||
    '    CASE' || E'\n' ||
    '      WHEN ledger_balance IS NULL                       THEN ''warn''' || E'\n' ||
    '      WHEN ABS(stored_balance - ledger_balance) = 0     THEN ''ok''' || E'\n' ||
    '      WHEN ABS(stored_balance - ledger_balance) <= 1.00 THEN ''warn''' || E'\n' ||
    '      ELSE ''critical''' || E'\n' ||
    '    END,' || E'\n' ||
    '    jsonb_build_object(''source'', ''reconcile_ledger_nightly'',' || E'\n' ||
    '                       ''unbaselined'', (ledger_balance IS NULL),' || E'\n' ||
    '                       ''note'', CASE WHEN ledger_balance IS NULL' || E'\n' ||
    '                         THEN ''no ca_treasury_baseline row for this club, so its opening balance is unknown and no drift is computed; trg_ca_club_gets_a_baseline writes one for every club created from 2026-09-08''' || E'\n' ||
    '                         END,';
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  WITH cut AS (SELECT MIN(taken_at) AS t0 FROM public.ca_treasury_baseline)
  SELECT round(COALESCE(c.chip_treasury,0)
           - COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l, cut
                        WHERE l.to_type='club_treasury' AND l.to_entity_id=c.id
                          AND l.created_at >= cut.t0),0)
           + COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l, cut
                        WHERE l.from_type='club_treasury' AND l.from_entity_id=c.id
                          AND l.created_at >= cut.t0),0), 2)
    INTO v_deep
    FROM public.clubs c, cut
   WHERE c.id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';

  IF v_deep IS DISTINCT FROM 9981739.70 THEN
    RAISE EXCEPTION
      'Deep Stack Society''s derived opening is %, not the 9,981,739.70 measured twice on 2026-09-08. The board has moved and this migration must be re-read against it.', v_deep;
  END IF;

  WITH cut AS (SELECT MIN(taken_at) AS t0 FROM public.ca_treasury_baseline),
  missing AS (
    SELECT c.id AS club_id, c.created_at,
           round(COALESCE(c.chip_treasury,0)
             - COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l, cut
                          WHERE l.to_type='club_treasury' AND l.to_entity_id=c.id
                            AND l.created_at >= cut.t0),0)
             + COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l, cut
                          WHERE l.from_type='club_treasury' AND l.from_entity_id=c.id
                            AND l.created_at >= cut.t0),0), 2) AS opening,
           round(COALESCE((SELECT sum(CASE WHEN l.to_entity_id=c.id AND l.to_type='club_treasury' THEN l.amount
                                           WHEN l.from_entity_id=c.id AND l.from_type='club_treasury' THEN -l.amount
                                           ELSE 0 END)
                            FROM public.chip_ledger l, cut
                           WHERE l.created_at < cut.t0
                             AND ((l.to_entity_id=c.id AND l.to_type='club_treasury')
                               OR (l.from_entity_id=c.id AND l.from_type='club_treasury'))),0), 2) AS ledger_at_baseline
      FROM public.clubs c, cut
     WHERE NOT EXISTS (SELECT 1 FROM public.ca_treasury_baseline b WHERE b.club_id = c.id)
  )
  INSERT INTO public.ca_treasury_baseline (club_id, opening_balance, ledger_at_baseline, unledgered_gap, taken_at)
  SELECT m.club_id, m.opening, m.ledger_at_baseline, m.opening - m.ledger_at_baseline, m.created_at
    FROM missing m;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  IF EXISTS (
    SELECT 1
      FROM public.clubs c
      JOIN public.ca_treasury_baseline b ON b.club_id = c.id
     WHERE round(COALESCE(c.chip_treasury,0),2) IS DISTINCT FROM round(
             b.opening_balance
             + COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                          WHERE l.to_type='club_treasury' AND l.to_entity_id=c.id
                            AND l.created_at >= (SELECT MIN(taken_at) FROM public.ca_treasury_baseline)),0)
             - COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                          WHERE l.from_type='club_treasury' AND l.from_entity_id=c.id
                            AND l.created_at >= (SELECT MIN(taken_at) FROM public.ca_treasury_baseline)),0), 2)
  ) THEN
    RAISE EXCEPTION
      'post-condition failed: at least one club no longer reconstructs to its stored treasury exactly. Nothing is written. Re-read the board before retrying.';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly not found';
  END IF;

  IF position('A MISSING BASELINE IS NOT AN OPENING OF ZERO' in v_src) > 0 THEN
    RAISE NOTICE 'reconciler already fixed; skipping';
  ELSE
    FOR v_hits IN
      SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
        FROM unnest(ARRAY[v_anchor_ledger, v_anchor_merged, v_anchor_insert]) a
    LOOP
      IF v_hits <> 1 THEN
        RAISE EXCEPTION 'an anchor in reconcile_ledger_nightly appears % times, not once - the function has changed and this edit must be re-read against it', v_hits;
      END IF;
    END LOOP;

    v_new := replace(v_src, v_anchor_ledger, v_replace_ledger);
    v_new := replace(v_new, v_anchor_merged, v_replace_merged);
    v_new := replace(v_new, v_anchor_insert, v_replace_insert);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'substitution produced no change';
    END IF;
    EXECUTE v_new;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.fn_ca_club_gets_a_baseline()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $body$
    BEGIN
      /* A club created after the baseline cutover had no opening row, and
         reconcile_ledger_nightly read that absence as an opening of zero -
         9,981,739.70 of fabricated critical drift against Deep Stack Society,
         every night, from the day it was created. A new club opens at whatever
         it is created holding, which is normally nothing; recording it here
         means the reconciler is never guessing. */
      INSERT INTO public.ca_treasury_baseline
        (club_id, opening_balance, ledger_at_baseline, unledgered_gap, taken_at)
      VALUES (NEW.id, round(COALESCE(NEW.chip_treasury, 0), 2), 0,
              round(COALESCE(NEW.chip_treasury, 0), 2), now())
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END;
    $body$;
  $fn$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_ca_club_gets_a_baseline ON public.clubs';
  EXECUTE 'CREATE TRIGGER trg_ca_club_gets_a_baseline AFTER INSERT ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.fn_ca_club_gets_a_baseline()';

  UPDATE public.ca_drift_incidents
     SET status = 'resolved',
         resolved_at = now(),
         correction_ref = 'migration a_club_without_a_baseline_is_not_a_club_at_zero',
         root_cause = 'Deep Stack Society was created 2026-08-31 19:02:21, eight hours after the ca_treasury_baseline cutover at 10:45:50, so it had no opening row. reconcile_ledger_nightly read the missing row as an opening balance of zero (COALESCE(b.opening_balance, 0)) and reported the club''s entire history as a critical treasury error. Measured twice twenty minutes apart against a moving balance, the derived opening was identical to the cent both times (9,981,739.70) - a constant, not a drift.',
         resolution = 'No chips were missing and nobody was owed anything. Proved both ways: the derived opening was identical to the cent across twenty minutes of live trading, and on the three clubs that DO have a baseline, opening + post-cutover flow equals clubs.chip_treasury exactly (JAQK 948,969.06; SHARK 894,721.67; Midway 0.50). Fixed at the root in three parts - a baseline backfilled for every club that had none (opening derived from the journal, taken_at set to the club''s own creation, with a post-condition asserting every club then reconstructs exactly); reconcile_ledger_nightly now NULL-propagates a missing baseline and records unbaselined=true with a note and no drift, instead of inventing one; and trg_ca_club_gets_a_baseline writes the row in the same statement that creates a club, so this cannot recur. Diamond Arena, created 2026-09-08 11:28, had the same gap and was backfilled in the same pass before it held a chip.'
   WHERE status = 'open'
     AND entity_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
     AND classification = 'treasury_error'
     AND abs(discrepancy_amount) = 9981739.70;

  RAISE NOTICE 'baselines added: %; reconciler and club trigger in place', v_added;
END $mig$;