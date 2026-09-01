-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 2: WHY EVERY RAKE VIOLATION LOOKED SMALLER THAN IT WAS
--
-- reconcile_ledger_nightly opens with
--     DELETE FROM ledger_reconcile_log WHERE run_date = CURRENT_DATE;
-- so it can rewrite today's findings from scratch. That is correct for the
-- eight entity types it writes. It is not the only writer: fn_rake_law_check
-- inserts entity_type='rake_law' rows hourly, and the reconciler runs every
-- six hours, so the rake evidence for the current day was destroyed up to
-- four times a day by a function that never wrote it.
--
-- MEASURED: zero rake_law rows have ever survived in ledger_reconcile_log.
-- Every other entity_type has rows. The 2026-08-31 incidents therefore
-- reported "4 hands took a drop with no flop, 0.80 chips total" because that
-- was the last two-hour window before the wipe. The real population over the
-- same period was 30 no_flop_no_drop hands, 22 board_not_recorded and 9
-- over_cap -- and the over_cap class had produced no incident at all.
--
-- The previous agent's resolution was not dishonest. The evidence had been
-- truncated underneath it. That is worse than a wrong number: it is a
-- reporting layer that makes a money defect look fourteen times smaller.
--
-- Four changes, one transaction. See docs/changelog/2026-09-01-the-reconciler
-- -stops-eating-the-rake-evidence.md for the full reasoning.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_reconcile_owned_entity_types()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY['player_wallet','seat_stack_exit','club_treasury','chip_circulation',
               'bomb_award_ledger_gap','frozen_wallets_pool','insurance_bank',
               'negative_balance']::text[];
$fn$;

COMMENT ON FUNCTION public.fn_ca_reconcile_owned_entity_types() IS
  'The entity types reconcile_ledger_nightly writes, and therefore the only ones it may clear. Any other writer of ledger_reconcile_log (fn_rake_law_check writes rake_law) must NOT appear here.';

-- The reconciler is patched in place rather than re-declared, because it is a
-- 600-line function owned by another workstream and re-pasting it here would
-- silently revert whatever landed in it since. The guard raises if the DELETE
-- is not where this migration expects it.
DO $patch$
DECLARE
  v_def text;
  v_old text := 'DELETE FROM public.ledger_reconcile_log WHERE run_date = CURRENT_DATE;';
  v_new text := 'DELETE FROM public.ledger_reconcile_log WHERE run_date = CURRENT_DATE '
             || 'AND entity_type = ANY (public.fn_ca_reconcile_owned_entity_types());';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly not found';
  END IF;
  IF position(v_old in v_def) = 0 THEN
    IF position('fn_ca_reconcile_owned_entity_types' in v_def) > 0 THEN
      RAISE NOTICE 'already scoped; nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION 'the unscoped DELETE is not where this migration expects it; read the function before re-running';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $patch$;

REVOKE ALL ON FUNCTION public.fn_ca_reconcile_owned_entity_types() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reconcile_owned_entity_types() TO service_role;

-- ── 2. An illegal rake is not a reporting mismatch ─────────────────────────
-- Every rake_law row was filed as 'reporting_mismatch' at layer 'reporting'
-- regardless of kind. That is why a hand raked with no flop read as a
-- harmless evidence gap and got shrugged off. Three of the five kinds are
-- money taken off a player that the rules never owed the house.
CREATE OR REPLACE FUNCTION public.fn_ca_reconcile_log_to_incident()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_class text; v_layer text; v_club uuid; v_kind text; v_illegal boolean;
BEGIN
  IF NEW.severity NOT IN ('warn','critical') THEN RETURN NEW; END IF;

  v_kind := NEW.metadata->>'kind';
  v_illegal := NEW.entity_type = 'rake_law'
               AND v_kind IN ('no_flop_no_drop','over_cap','over_percent');

  v_class := CASE
    WHEN v_illegal THEN 'incorrect_rake'
    ELSE CASE NEW.entity_type
      WHEN 'club_treasury' THEN 'treasury_error'
      WHEN 'frozen_wallets_pool' THEN 'unauthorized_adjustment'
      WHEN 'seat_stack_exit' THEN 'missing_payment'
      WHEN 'negative_balance' THEN 'ledger_imbalance'
      WHEN 'insurance_bank' THEN 'settlement_error'
      WHEN 'insurance_offer_unresolved' THEN 'settlement_error'
      WHEN 'cashout_escrow_stuck' THEN 'settlement_error'
      WHEN 'over_claimed_send' THEN 'duplicate_payment'
      WHEN 'bomb_award_ledger_gap' THEN 'reporting_mismatch'
      WHEN 'rake_law' THEN 'reporting_mismatch'
      ELSE 'unknown' END
  END;

  v_layer := CASE
    WHEN v_illegal THEN 'settlement'
    WHEN NEW.entity_type IN ('bomb_award_ledger_gap','rake_law') THEN 'reporting'
    ELSE 'ledger' END;

  BEGIN v_club := NULLIF(NEW.metadata->>'club_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN v_club := NULL; END;
  IF v_club IS NULL AND NEW.entity_type = 'club_treasury' THEN v_club := NEW.entity_id; END IF;

  PERFORM public.fn_ca_raise_drift_incident(
    p_source => 'ledger_reconcile_log:' || COALESCE(NEW.metadata->>'source', v_kind, '?'),
    p_classification => v_class,
    p_severity => CASE WHEN v_illegal THEN 'critical'
                       WHEN NEW.severity = 'critical' THEN 'critical'
                       ELSE 'warning' END,
    p_dedupe_key => 'lrl:' || NEW.entity_type || ':' || COALESCE(NEW.entity_id::text,'-') || ':' ||
      COALESCE(NEW.metadata->>'exit_id', NEW.metadata->>'hand_history_id',
               NEW.metadata->>'hand_id', NEW.metadata->>'escrow_id', ''),
    p_discrepancy => COALESCE(NEW.stored_balance,0) - COALESCE(NEW.ledger_balance,0),
    p_expected => NEW.ledger_balance,
    p_actual => NEW.stored_balance,
    p_layer => v_layer,
    p_entity_type => NEW.entity_type,
    p_entity_id => NEW.entity_id,
    p_club_id => v_club,
    p_suspected_cause => COALESCE(NEW.metadata->>'rule', v_kind),
    p_metadata => COALESCE(NEW.metadata,'{}'::jsonb));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_reconcile_log_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$;

-- ── 3. A daily wide scan, so an outage does not bury a violation ───────────
-- The hourly job keeps its 2h window. This one re-reads a full day; the
-- hand_id dedupe inside fn_rake_law_check means nothing is filed twice.
SELECT cron.schedule('rake-law-wide-daily', '50 7 * * *',
  $$SELECT public.fn_rake_law_check('26 hours'::interval);$$);

-- ── 4. The rake law becomes a ratchet at zero ──────────────────────────────
INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note) VALUES
  ('rake_law_violations_24h', 0,
   'Illegal rake in the last 24h (no_flop_no_drop, over_cap, over_percent). Clean since 2026-08-31 16:12. Baseline zero: the next one raises an incident by itself, rather than waiting for a nightly report that used to be deleted before anyone read it.')
ON CONFLICT (ratchet) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_ratchet_watch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row record; v_current integer; v_out jsonb := '[]'::jsonb;
BEGIN
  FOR v_row IN SELECT * FROM public.ca_ratchet_baselines ORDER BY ratchet LOOP
    IF v_row.ratchet = 'unledgered_insert_paths' THEN
      SELECT count(*)::int INTO v_current FROM public.fn_ca_unledgered_insert_paths();
    ELSIF v_row.ratchet = 'undeclared_money_paths' THEN
      SELECT count(*)::int INTO v_current FROM public.fn_ca_undeclared_money_paths();
    ELSIF v_row.ratchet = 'rake_law_violations_24h' THEN
      SELECT count(*)::int INTO v_current
        FROM public.fn_rake_law_violations('24 hours'::interval)
       WHERE kind IN ('no_flop_no_drop','over_cap','over_percent');
    ELSE
      CONTINUE;
    END IF;

    IF v_current > v_row.baseline THEN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source          => 'fn_ca_ratchet_watch',
        p_classification  => CASE WHEN v_row.ratchet = 'rake_law_violations_24h'
                                  THEN 'incorrect_rake' ELSE 'unauthorized_adjustment' END,
        p_severity        => CASE WHEN v_row.ratchet = 'rake_law_violations_24h'
                                  THEN 'critical' ELSE 'warning' END,
        p_dedupe_key      => 'ratchet:' || v_row.ratchet || ':above:' || v_row.baseline
                             || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        p_discrepancy     => (v_current - v_row.baseline)::numeric,
        p_expected        => v_row.baseline::numeric,
        p_actual          => v_current::numeric,
        p_layer           => CASE WHEN v_row.ratchet = 'rake_law_violations_24h'
                                  THEN 'settlement' ELSE 'ledger' END,
        p_suspected_cause => CASE
          WHEN v_row.ratchet = 'rake_law_violations_24h' THEN
            'Chips were raked that the rules did not owe the house. Read the hands with '
            || 'SELECT * FROM fn_rake_law_violations(''24 hours''). Players are owed the excess back.'
          ELSE
            'A new money path was added that does not declare its ledger counterparty, '
            || 'or a balance table gained an INSERT path that bypasses chip_ledger. '
            || 'Read the offending rows with SELECT * FROM ' || v_row.ratchet || '.' END,
        p_ledger_balanced => true,
        p_metadata        => jsonb_build_object('ratchet', v_row.ratchet,
                                                'baseline', v_row.baseline,
                                                'current',  v_current));
    ELSIF v_current < v_row.baseline THEN
      UPDATE public.ca_ratchet_baselines
         SET baseline = v_current, tightened_at = now()
       WHERE ratchet = v_row.ratchet;
    END IF;

    v_out := v_out || jsonb_build_object('ratchet', v_row.ratchet,
                                         'baseline', v_row.baseline, 'current', v_current);
  END LOOP;

  RETURN jsonb_build_object('checked_at', now(), 'ratchets', v_out);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_ratchet_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ratchet_watch() TO service_role;
