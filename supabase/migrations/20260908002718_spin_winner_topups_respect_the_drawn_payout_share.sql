-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908002718; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908002718   (the stamp IS the apply time, UTC: 2026-09-08 00:27:18)
--   name        spin_winner_topups_respect_the_drawn_payout_share
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 7189 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908002718 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_backpay_spin_unpaid_winners
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
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

BEGIN;
DO $baseline$ BEGIN
IF md5(pg_get_functiondef('public.fn_backpay_spin_unpaid_winners(boolean,integer,integer)'::regprocedure)) <> '8355ed8527c4dbd814b8eb012b574d25' THEN RAISE EXCEPTION 'Spin winner top-up baseline changed'; END IF;
END $baseline$;
CREATE OR REPLACE FUNCTION public.fn_backpay_spin_unpaid_winners(p_apply boolean DEFAULT false, p_limit integer DEFAULT 200, p_since_hours integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_ok boolean;
  v_settle jsonb; v_settle_paid numeric; v_paid_so_far numeric;
  v_paid integer := 0; v_chips numeric := 0; v_skipped integer := 0;
  v_refused integer := 0;
  v_owed_before numeric; v_owed_after numeric;
  v_event record; v_ladder jsonb; v_recorded jsonb;
  v_drawn numeric; v_entitlement numeric; v_prior_owed numeric;
  v_contract_refused integer := 0; v_winner_complete integer := 0;
BEGIN
  create temp table if not exists _spin_unpaid_snapshot (
    tournament_id uuid,
    chips_short numeric,
    verdict text,
    seats_at_first bigint,
    ended_at timestamptz
  ) on commit drop;
  /* TRUNCATE, not DELETE: the safeupdate library preloaded on the
     authenticator role rejects a DELETE with no WHERE clause outright. */
  truncate _spin_unpaid_snapshot;

  insert into _spin_unpaid_snapshot
  select s.tournament_id, s.chips_short, s.verdict, s.seats_at_first, s.ended_at
    from public.fn_spin_unpaid_settlements(p_since_hours) s
   where s.chips_short > 0.01;

  select coalesce(sum(chips_short), 0) into v_owed_before
    from _spin_unpaid_snapshot;

  FOR r IN
    SELECT s.tournament_id, s.chips_short, s.verdict,
           (SELECT tp.user_id FROM public.tournament_players tp
             WHERE tp.tournament_id = s.tournament_id AND tp.position = 1
             LIMIT 1) AS winner
      FROM _spin_unpaid_snapshot s
     WHERE NOT EXISTS (SELECT 1 FROM public.spin_unpaid_backpay_log l
                        WHERE l.tournament_id = s.tournament_id)
     ORDER BY s.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    IF r.winner IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- A tournament-wide shortfall is not necessarily owed to first place.
    -- Use the recorded drawn ladder and reserve draw before naming a debt.
    -- The tournament lock is the same lock held by the settlement function.
    SELECT t.status, t.spin_multiplier, t.payout_structure
      INTO v_event FROM public.tournaments t
     WHERE t.id = r.tournament_id FOR UPDATE;
    v_ladder := NULL; v_recorded := NULL; v_entitlement := NULL;
    IF FOUND AND v_event.status = 'COMPLETED' THEN
      SELECT l.structure INTO v_ladder FROM public.spin_payout_ladder l
       WHERE l.multiplier = v_event.spin_multiplier;
      BEGIN
        v_recorded := v_event.payout_structure::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN v_recorded := NULL;
      END;
      IF v_ladder IS NOT NULL AND v_recorded IS NOT DISTINCT FROM v_ladder THEN
        SELECT round(sum(-l.amount), 2) INTO v_drawn
          FROM public.spin_reserve_ledger l
         WHERE l.tournament_id = r.tournament_id AND l.kind = 'jackpot_draw';
        SELECT round(v_drawn * (e->>'percentage')::numeric / 100, 2)
          INTO v_entitlement FROM jsonb_array_elements(v_ladder) e
         WHERE (e->>'place')::integer = 1;
      END IF;
    END IF;
    SELECT o.amount_owed INTO v_prior_owed FROM public.tournament_obligations o
     WHERE o.tournament_id = r.tournament_id AND o.kind = 'place' AND o.place = 1;
    IF v_entitlement IS NULL OR v_entitlement <= 0
       OR v_entitlement::text IN ('NaN','Infinity','-Infinity')
       OR COALESCE(v_prior_owed, 0) > v_entitlement THEN
      v_contract_refused := v_contract_refused + 1;
      IF p_apply THEN
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_backpay_spin_unpaid_winners',
          'Spin winner top-up requires reconciliation of the recorded payout contract',
          jsonb_build_object('kind','spin_winner_entitlement_unverified',
            'tournament_id',r.tournament_id,'winner_entitlement',v_entitlement,
            'recorded_owed',v_prior_owed,'tournament_shortfall',r.chips_short),
          r.tournament_id::text);
      END IF;
      CONTINUE;
    END IF;
    v_paid_so_far := public.fn_tournament_obligation_paid_so_far(r.tournament_id, 'place', 1, r.winner);
    IF v_paid_so_far >= v_entitlement THEN
      v_winner_complete := v_winner_complete + 1;
      CONTINUE;
    END IF;

    IF p_apply THEN
      /* ONE SETTLE PATH (Lane A3, 2026-09-02). The winner's place-1 obligation
         is capped at its share of the recorded reserve draw. A whole-event
         shortfall must not increase first place beyond that share. It pays
         that difference once, and a replay pays 0. A refusal (escrow_short,
         place paid to another user, payout frozen) is reported and NOT paid
         through any other path. */
      v_settle := public.fn_settle_tournament_obligation(
        r.tournament_id, 'place', 1, r.winner,
        LEAST(v_entitlement, round(v_paid_so_far + r.chips_short, 2)), 'spin_backpay',
        'Spin winner back-pay (prize drawn from the reserve but never credited)');
      v_ok := COALESCE((v_settle->>'ok')::boolean, false);
      v_settle_paid := round(COALESCE((v_settle->>'paid')::numeric, 0), 2);

      IF v_ok AND v_settle_paid > 0 THEN
        UPDATE public.tournament_players
           SET prize = round(COALESCE(prize, 0) + v_settle_paid, 2)
         WHERE tournament_id = r.tournament_id AND user_id = r.winner;

        INSERT INTO public.spin_unpaid_backpay_log
          (tournament_id, user_id, amount, verdict)
        VALUES (r.tournament_id, r.winner, v_settle_paid, r.verdict)
        ON CONFLICT (tournament_id) DO NOTHING;

        v_paid := v_paid + 1;
        v_chips := v_chips + v_settle_paid;
      ELSIF NOT v_ok THEN
        v_refused := v_refused + 1;
      END IF;
    ELSE
      v_paid := v_paid + 1;
      v_chips := v_chips + LEAST(r.chips_short, v_entitlement - v_paid_so_far);
    END IF;
  END LOOP;

  /* Second measurement, over the SAME window and genuinely re-read. The
     backlog itself must shrink; a count of rows processed proves nothing. */
  SELECT COALESCE(sum(chips_short), 0) INTO v_owed_after
    FROM public.fn_spin_unpaid_settlements(p_since_hours)
   WHERE chips_short > 0.01;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'window_hours', p_since_hours,
    'winners_paid', v_paid, 'chips', round(v_chips, 2),
    'skipped_no_winner', v_skipped,
    'refused_by_obligation', v_refused,
    'refused_unverified_winner_contract', v_contract_refused,
    'skipped_winner_already_paid', v_winner_complete,
    'owed_before', round(v_owed_before, 2), 'owed_after', round(v_owed_after, 2),
    'money_path', 'fn_settle_tournament_obligation');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_backpay_spin_unpaid_winners(boolean,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_spin_unpaid_winners(boolean,integer,integer) TO service_role;
COMMIT;
