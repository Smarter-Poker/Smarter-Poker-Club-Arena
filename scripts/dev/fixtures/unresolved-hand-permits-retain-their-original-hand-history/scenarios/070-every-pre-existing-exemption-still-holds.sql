-- KEPT. (e) Every exemption the live body already had, unchanged. Each hand
-- here is past the boundary and horse-only, so age and classification alone
-- would doom it; it survives only because of the exemption under test. A
-- regression in any one of these is a data loss this repair must not cause.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('exemptions');
        spin uuid := probe.table_of('exempt-spin', 'spin', 'SPIN', 'RUNNING');
        spin_done uuid := probe.table_of('exempt-spin-done', 'spin', 'SPIN', 'COMPLETED');
        blank uuid := probe.table_of('exempt-blank', '  ', 'MTT', 'RUNNING');
        h_bbj uuid; h_outbox uuid; h_ko uuid; h_spin uuid; h_spin_done uuid;
        h_blank uuid; h_human uuid; h_reported uuid;
        b bigint; a bigint;
BEGIN
  -- 1. a bad-beat jackpot payout for this exact (table_id, hand_number)
  h_bbj := probe.hand(t, 13000001, interval '9 days');
  INSERT INTO public.bbj_payouts (table_id, hand_number) VALUES (t, 13000001);
  -- 2. an undelivered projection outbox row for this hand
  h_outbox := probe.hand(t, 13000002, interval '9 days');
  INSERT INTO public.hand_projection_outbox (hand_id) VALUES (h_outbox);
  -- 3. a still-pending tournament knockout candidate
  h_ko := probe.hand(t, 13000003, interval '9 days');
  INSERT INTO public.tournament_knockout_candidates (hand_id, state) VALUES (h_ko, 'pending');
  -- 4. a known Spin whose canonical terminal state has NOT committed
  h_spin := probe.hand(spin, 13000004, interval '9 days');
  -- 5. blank variant classification
  h_blank := probe.hand(blank, 13000005, interval '9 days');
  -- 6. a hand already flagged as having a human
  h_human := probe.hand(t, 13000006, interval '9 days');
  UPDATE public.hand_history SET has_human = true WHERE id = h_human;
  -- 7. a reported hand
  h_reported := probe.hand(t, 13000007, interval '9 days');
  UPDATE public.hand_history SET reported = true WHERE id = h_reported;
  -- 8. a COMPLETED Spin WITH its terminal settlement: this one must still go
  h_spin_done := probe.hand(spin_done, 13000008, interval '9 days');
  INSERT INTO public.tournament_terminal_settlements (tournament_id)
  SELECT tournament_id FROM public.tables WHERE id = spin_done;

  b := probe.rows(h_bbj) + probe.rows(h_outbox) + probe.rows(h_ko) + probe.rows(h_spin)
     + probe.rows(h_blank) + probe.rows(h_human) + probe.rows(h_reported);
  PERFORM probe.prune();
  a := probe.rows(h_bbj) + probe.rows(h_outbox) + probe.rows(h_ko) + probe.rows(h_spin)
     + probe.rows(h_blank) + probe.rows(h_human) + probe.rows(h_reported);

  PERFORM probe.census('e_pre_existing_exemptions', b, a);
  PERFORM probe.check(probe.rows(h_bbj) = 6, 'the bbj_payouts exemption still holds');
  PERFORM probe.check(probe.rows(h_outbox) = 6, 'the hand_projection_outbox exemption still holds');
  PERFORM probe.check(probe.rows(h_ko) = 6, 'the pending tournament_knockout_candidates exemption still holds');
  PERFORM probe.check(probe.rows(h_spin) = 6, 'the non-terminal Spin exemption still holds');
  PERFORM probe.check(probe.rows(h_blank) = 6, 'the blank-classification exemption still holds');
  PERFORM probe.check(probe.rows(h_human) = 6, 'the has_human exemption still holds');
  PERFORM probe.check(probe.rows(h_reported) = 6, 'the reported exemption still holds');
  PERFORM probe.check(b = 42 AND a = 42,
    'all seven pre-existing exemptions still retain their hands (was ' || b || ', now ' || a || ')');
  -- and the Spin that DID commit its terminal state is still pruned
  PERFORM probe.check(probe.rows(h_spin_done) = 0,
    'a COMPLETED Spin with its terminal settlement is still DELETED');
END $s$;
