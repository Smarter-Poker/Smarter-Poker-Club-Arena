-- 20260905083654_the_drift_check_reads_the_balance_and_the_shadow_at_the_same.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard, 2026-09-05 08:36 UTC):
--
-- fn_ca_escrow_balance_drift filed escrow-balance-drift:b31fad9e... at 08:35:
-- balance prize 15.00 against shadow prize 0.00 with the reserve terms. The
-- row had been read by the loop's cursor at 08:35:00; the spin's payout landed
-- at 08:35:45 while the loop was still running over 1,200 rows, and the shadow
-- (computed from the operational rows under READ COMMITTED) saw the payout
-- while the row in hand did not. The 2-minute mid-flight guard cannot catch a
-- write that lands DURING the loop. The balance itself was exact: the row read
-- 0.00 / 0.00 / 0.00 the moment the loop finished.
--
-- The loop now re-reads the balance row immediately before computing the
-- shadow, so the two reads are milliseconds apart. The false finding is
-- resolved with this migration as its correction.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_balance_drift(p_hours integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; e record; v_n int := 0; v_bad int := 0; v_list jsonb := '[]'::jsonb;
BEGIN
  FOR r IN SELECT x.* FROM public.tournament_escrow x
            WHERE x.updated_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 3), 1))
              AND x.updated_at < now() - interval '2 minutes'   -- a row mid-flight is not a finding
            ORDER BY x.updated_at DESC LIMIT 5000
  LOOP
    v_n := v_n + 1;
    /* Same instant (2026-09-05): the cursor read this row when the loop began,
       and the loop takes tens of seconds over thousands of rows; a payout that
       lands in between moves the shadow and not the row in hand. Re-read the
       balance right before the shadow so both reads are milliseconds apart. */
    SELECT * INTO r FROM public.tournament_escrow x WHERE x.tournament_id = r.tournament_id;
    SELECT * INTO e FROM public.fn_ca_tournament_escrow(r.tournament_id);
    IF abs(r.prize_balance - (e.prize_balance - r.reserve_out + r.reserve_in)) > 0.01 OR abs(r.bounty_balance - e.bounty_balance) > 0.01 OR abs(r.fee_balance - e.fee_balance) > 0.01 THEN
      v_bad := v_bad + 1;
      IF v_bad <= 20 THEN
        v_list := v_list || jsonb_build_object('tournament_id', r.tournament_id,
                    'balance', jsonb_build_object('prize', r.prize_balance, 'bounty', r.bounty_balance, 'fee', r.fee_balance),
                    'shadow', jsonb_build_object('prize', e.prize_balance - r.reserve_out + r.reserve_in, 'bounty', e.bounty_balance, 'fee', e.fee_balance));
      END IF;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_escrow_balance_drift', 'settlement_error', 'warning',
        'escrow-balance-drift:' || r.tournament_id::text,
        round((r.prize_balance + r.bounty_balance + r.fee_balance) - (e.prize_balance - r.reserve_out + r.reserve_in + e.bounty_balance + e.fee_balance), 2),
        round(e.prize_balance - r.reserve_out + r.reserve_in + e.bounty_balance + e.fee_balance, 2), round(r.prize_balance + r.bounty_balance + r.fee_balance, 2),
        'ledger', 'tournament', r.tournament_id, NULL, NULL, NULL, r.tournament_id, NULL, NULL, NULL, NULL,
        format('the maintained escrow balance (prize %s, bounty %s, fee %s) disagrees with the shadow (prize %s, bounty %s, fee %s): a path wrote an operational row the escrow triggers do not read, or the other way round',
               r.prize_balance, r.bounty_balance, r.fee_balance, e.prize_balance, e.bounty_balance, e.fee_balance),
        false, jsonb_build_object('tournament_id', r.tournament_id));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_n, 'disagree', v_bad, 'sample', v_list);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_balance_drift(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_balance_drift(integer) TO service_role;

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260905083654_the_drift_check_reads_the_balance_and_the_shadow_at_the_same',
       root_cause = 'the hourly balance-vs-shadow loop read the escrow row at cursor time and computed the shadow tens of seconds later; a spin payout (15.00) landed in between, so the shadow saw it and the row in hand did not. The balance was exact (0.00 after the payout); the finding was a read race, not a movement',
       resolution = 'the loop re-reads the balance row immediately before the shadow'
 WHERE dedupe_key = 'escrow-balance-drift:b31fad9e-a8e0-4322-9732-7f81a93db566' AND status = 'open';

DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_escrow_balance_drift') NOT LIKE '%SELECT * INTO r FROM public.tournament_escrow x WHERE x.tournament_id = r.tournament_id;%' THEN
    RAISE EXCEPTION 'the drift check does not re-read the balance';
  END IF;
END $$;

COMMIT;
