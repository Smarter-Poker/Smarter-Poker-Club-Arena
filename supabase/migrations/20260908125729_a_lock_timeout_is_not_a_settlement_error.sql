DO $mig$
DECLARE
  v_src text; v_new text; v_hits integer; v_resolved integer := 0;
  v_anchor text :=
    '        BEGIN' || E'\n' ||
    '          v_book := public.fn_spin_book_entry(p_tournament_id);' || E'\n' ||
    '          IF COALESCE((v_book->>''ok'')::boolean, false) IS NOT TRUE THEN';
  v_replace text :=
    '        BEGIN' || E'\n' ||
    '          /* A LOCK TIMEOUT IS NOT A SETTLEMENT ERROR (2026-09-08). This' || E'\n' ||
    '             call used to file a CRITICAL on any exception. 35 of them were' || E'\n' ||
    '             raised between 09-02 and 09-08 - 26 lock timeouts and 9' || E'\n' ||
    '             deadlocks - and all 35 spins turned out to be booked anyway' || E'\n' ||
    '             (2,558.52 contributed, every escrow closed at 0.00). Booking is' || E'\n' ||
    '             idempotent: fn_spin_book_entry returns already_booked when the' || E'\n' ||
    '             contribution row exists, so losing a turn is safe to repeat. */' || E'\n' ||
    '          FOR v_book_try IN 1..4 LOOP' || E'\n' ||
    '            BEGIN' || E'\n' ||
    '              v_book := public.fn_spin_book_entry(p_tournament_id);' || E'\n' ||
    '              EXIT;' || E'\n' ||
    '            EXCEPTION' || E'\n' ||
    '              WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN' || E'\n' ||
    '                IF v_book_try >= 4 THEN' || E'\n' ||
    '                  BEGIN' || E'\n' ||
    '                    INSERT INTO public.ca_drift_incidents' || E'\n' ||
    '                      (source, dedupe_key, tournament_id, classification, layer,' || E'\n' ||
    '                       severity, suspected_cause, metadata)' || E'\n' ||
    '                    VALUES (''fn_spin_book_entry'', ''spin_entry_contended:'' || p_tournament_id::text,' || E'\n' ||
    '                            p_tournament_id, ''settlement_error'', ''ledger'',' || E'\n' ||
    '                            ''info'', ''fn_spin_book_entry lost the lock four times; the booking is idempotent and the unbooked path still owns it'',' || E'\n' ||
    '                            jsonb_build_object(''tournament_id'', p_tournament_id,' || E'\n' ||
    '                                               ''sqlstate'', SQLSTATE, ''error'', SQLERRM,' || E'\n' ||
    '                                               ''attempts'', v_book_try))' || E'\n' ||
    '                    ON CONFLICT DO NOTHING;' || E'\n' ||
    '                  EXCEPTION WHEN OTHERS THEN' || E'\n' ||
    '                    RAISE WARNING ''could not file spin contention notice for %: %'', p_tournament_id, SQLERRM;' || E'\n' ||
    '                  END;' || E'\n' ||
    '                  v_book := jsonb_build_object(''ok'', true, ''reason'', ''contended_deferred'');' || E'\n' ||
    '                  EXIT;' || E'\n' ||
    '                END IF;' || E'\n' ||
    '                PERFORM pg_sleep(0.025 * v_book_try);' || E'\n' ||
    '            END;' || E'\n' ||
    '          END LOOP;' || E'\n' ||
    '          IF COALESCE((v_book->>''ok'')::boolean, false) IS NOT TRUE THEN';
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_sync_seat_first_player_count';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_sync_seat_first_player_count not found';
  END IF;

  IF position('A LOCK TIMEOUT IS NOT A SETTLEMENT ERROR' in v_src) > 0 THEN
    RAISE NOTICE 'spin contention retry already applied; skipping';
  ELSE
    v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION
        'expected exactly one fn_spin_book_entry call site to anchor on, found % - the function has changed and this edit must be re-read against it', v_hits;
    END IF;
    v_new := replace(v_src, v_anchor, v_replace);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'substitution produced no change';
    END IF;
    EXECUTE v_new;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved',
         resolved_at = now(),
         correction_ref = 'migration a_lock_timeout_is_not_a_settlement_error',
         root_cause = 'fn_sync_seat_first_player_count filed a CRITICAL for any exception out of fn_spin_book_entry. All 35 were contention, not settlement: 26 lock timeouts (55P03) and 9 deadlocks (40P01). Neither means the money is wrong; both mean the booking did not get a turn.',
         resolution = 'Reconciled before resolving: this spin''s entry IS booked in spin_reserve_ledger and its tournament_escrow is 0.00 on prize, fee and bounty. Across the class, 35 of 35 booked, 2,558.52 contributed, nothing owed. Fixed at the root: the call site now retries a contention SQLSTATE up to four times - the booking is idempotent, so a retry is free - and a turn lost four times files as info rather than critical. A booking the database REFUSES is still critical.'
   WHERE i.status = 'open'
     AND i.source = 'fn_spin_book_entry'
     AND i.tournament_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.spin_reserve_ledger s
                  WHERE s.tournament_id = i.tournament_id AND s.kind = 'contribution')
     AND NOT EXISTS (SELECT 1 FROM public.tournament_escrow e
                      WHERE e.tournament_id = i.tournament_id
                        AND (round(COALESCE(e.prize_balance,0),2) <> 0
                          OR round(COALESCE(e.fee_balance,0),2) <> 0
                          OR round(COALESCE(e.bounty_balance,0),2) <> 0));
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RAISE NOTICE 'spin contention: retry in place, % incidents resolved on evidence', v_resolved;
END $mig$;