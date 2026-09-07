BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

/* PHASE 6 OF 8 (UNION ACCOUNTING) - ONE SOURCE OF TRUTH, PART 1:
   TOURNAMENT RAKE IS ATTRIBUTED ONCE, AND A VIP CREDIT IS THE RAKE SHARE.
   ---------------------------------------------------------------------------
   THE WRITTEN RULE. 20260831100610 "VIP POINTS: RAKE PAID IS RAKE EARNED": a
   player's VIP credit is that player's share of the rake, and a source is
   claimed once (the ledger's unique (user_id, source_type, source_id)).

   WHAT THE TRIGGER DID INSTEAD, measured on production 2026-09-07 21:xx UTC.

   1. The DEALT_EQUAL branch awarded the RAW VALUE of player_contributions,
      never the rake share. That column holds pot contributions for cash
      hands and BUY-INS for spin entries (fn_spin_book_entry writes the three
      seats' buy-ins). So:
        cash DEALT_EQUAL rows, 2026-09-06 12:00-18:00 UTC:
          34 rows, 46.19 rake, 122.00 VIP credit          (2.64x the rake)
        cash DEALT_EQUAL rows before 2026-08-29 (300 sampled):
          779.31 rake, 27,990.79 of contributions          (36x)
        spin entries, week 2026-08-31 .. 2026-09-06:
          32,690 rows, 178,864.32 rake, 2,235,804.00 VIP credit at insert
                                                           (12.5x the rake)
      The WEIGHTED_CONTRIBUTED branch went through fn_allocate_rake_credits
      and was exact: 12,152 rows, 22,433.93 rake, 22,413.11 credit.

   2. A tournament rake row was credited TWICE: once here at insert (the
      buy-in figure above) and once more, correctly, at settlement, where
      fn_settle_tournament_rake -> fn_attribute_tournament_rake awards every
      tournament rake row's share by metadata.user_id (or spreads a userless
      row across tournament_players). 200 spins settled 2026-09-05/06:
      1,207.68 rake -> 15,096.00 credited at insert + 1,207.68 at settlement.
      Tournament settlement coverage is complete (117,163 settlements,
      587,261.01 of 592,171.58 lifetime tournament rake; 3 rows / 15.40 in the
      retry queue), so settlement is the one door and this trigger has no
      business on a tournament row.

   THE FIX. One allocator for every method (fn_allocate_rake_credits is the
   single source of share math on this platform - fn_rake_shares_for_record,
   fn_rakeback_recompute_day and atomic_distribute_rake already use it), and
   no award at all on a tournament row.

   THE OVER-AWARD STAYS WITH THE PLAYERS. CLAUDE.md 10.9 rule 3: overpay our
   defect caused is absorbed, reported, and left alone. It is reported below
   as a resolved financial_alerts row with the measured figures. VIP points
   are not chips; nothing is clawed back. */

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_award_vip_points_from_rake()'::regprocedure))
     <> '93e676910c6ff3b3f5e461849c6756bd' THEN
    RAISE EXCEPTION 'fn_award_vip_points_from_rake changed since the 2026-09-07 21:40 UTC audit; re-read before applying';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  rec record;
BEGIN
  /* Tournament rake (entry fees, rebuys, satellite seats, spin books) is
     attributed ONCE, at settlement: fn_settle_tournament_rake ->
     fn_attribute_tournament_rake, by metadata.user_id or spread across the
     field. Awarding here as well credited every spin twice (2026-09-07). */
  IF COALESCE(NEW.is_tournament, false) OR NEW.tournament_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.player_contributions IS NULL OR jsonb_typeof(NEW.player_contributions) <> 'object'
     OR COALESCE(NEW.rake_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  /* RAKE PAID IS RAKE EARNED (20260831100610): the credit is the player's
     share of NEW.rake_amount under the hand's own method, from the one
     allocator. Never the raw contribution - that is a pot figure, not rake. */
  FOR rec IN
    SELECT a.user_id, a.credit
      FROM public.fn_allocate_rake_credits(
             NEW.rake_amount, NEW.player_contributions,
             COALESCE(NEW.rake_method, 'DEALT_EQUAL')) a
  LOOP
    BEGIN
      PERFORM public.fn_award_vip_credit(rec.user_id, rec.credit, 'rake', NEW.id, 'Rake generated');
    EXCEPTION WHEN others THEN
      -- The rake is banked whether or not the points land; the ledger row
      -- is the audit and a warning is the trace.
      RAISE WARNING 'fn_award_vip_points_from_rake: % for user % on %', SQLERRM, rec.user_id, NEW.id;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

/* THE PROBE - inside its own subtransaction, rolled back by the sentinel.
   A tournament row must award nothing here; a cash DEALT_EQUAL row must award
   the equal split of the RAKE, not the contributions. */
DO $probe$
DECLARE
  v_club uuid; v_u1 uuid; v_u2 uuid; v_rr uuid; v_n int; v_sum numeric; v_c1 numeric; v_c2 numeric;
BEGIN
  BEGIN
    SELECT c.id INTO v_club FROM public.clubs c WHERE c.union_id IS NULL ORDER BY c.created_at LIMIT 1;
    SELECT p.id INTO v_u1 FROM public.profiles p ORDER BY p.id LIMIT 1;
    SELECT p.id INTO v_u2 FROM public.profiles p WHERE p.id <> v_u1 ORDER BY p.id LIMIT 1;
    IF v_club IS NULL OR v_u1 IS NULL OR v_u2 IS NULL THEN
      RAISE EXCEPTION 'probe fixtures unavailable';
    END IF;

    -- 1. a tournament row: nothing awarded at insert
    INSERT INTO public.rake_records (club_id, rake_amount, player_contributions, is_tournament, source, rake_method, metadata)
    VALUES (v_club, 0.24, jsonb_build_object(v_u1::text, 10.00, v_u2::text, 10.00), true, 'phase6_probe', 'DEALT_EQUAL', '{}'::jsonb)
    RETURNING id INTO v_rr;
    SELECT count(*) INTO v_n FROM public.vip_points_ledger WHERE source_type = 'rake' AND source_id = v_rr;
    IF v_n <> 0 THEN RAISE EXCEPTION 'probe: tournament row awarded % VIP rows at insert', v_n; END IF;

    -- 2. a cash DEALT_EQUAL row: contributions 100 / 300, rake 1.00 -> 0.50 / 0.50
    INSERT INTO public.rake_records (club_id, rake_amount, player_contributions, is_tournament, source, rake_method, metadata)
    VALUES (v_club, 1.00, jsonb_build_object(v_u1::text, 100.00, v_u2::text, 300.00), false, 'phase6_probe', 'DEALT_EQUAL', '{}'::jsonb)
    RETURNING id INTO v_rr;
    SELECT count(*), COALESCE(sum(credit), 0) INTO v_n, v_sum FROM public.vip_points_ledger WHERE source_type = 'rake' AND source_id = v_rr;
    SELECT credit INTO v_c1 FROM public.vip_points_ledger WHERE source_type = 'rake' AND source_id = v_rr AND user_id = v_u1;
    SELECT credit INTO v_c2 FROM public.vip_points_ledger WHERE source_type = 'rake' AND source_id = v_rr AND user_id = v_u2;
    IF v_n <> 2 OR v_sum <> 1.00 OR v_c1 <> 0.50 OR v_c2 <> 0.50 THEN
      RAISE EXCEPTION 'probe: DEALT_EQUAL cash row credited % rows summing % (% / %), expected 2 rows, 1.00, 0.50 / 0.50', v_n, v_sum, v_c1, v_c2;
    END IF;

    -- 3. a cash WEIGHTED row: 100 / 300 of 1.00 -> 0.25 / 0.75
    INSERT INTO public.rake_records (club_id, rake_amount, player_contributions, is_tournament, source, rake_method, metadata)
    VALUES (v_club, 1.00, jsonb_build_object(v_u1::text, 100.00, v_u2::text, 300.00), false, 'phase6_probe', 'WEIGHTED_CONTRIBUTED', '{}'::jsonb)
    RETURNING id INTO v_rr;
    SELECT credit INTO v_c1 FROM public.vip_points_ledger WHERE source_type = 'rake' AND source_id = v_rr AND user_id = v_u1;
    SELECT credit INTO v_c2 FROM public.vip_points_ledger WHERE source_type = 'rake' AND source_id = v_rr AND user_id = v_u2;
    IF v_c1 <> 0.25 OR v_c2 <> 0.75 THEN
      RAISE EXCEPTION 'probe: WEIGHTED cash row credited % / %, expected 0.25 / 0.75', v_c1, v_c2;
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'FIXTURE_ROLLBACK' THEN RAISE; END IF;
  END;
END $probe$;

DO $assert$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_award_vip_points_from_rake' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_allocate_rake_credits%' OR v_src LIKE '%jsonb_each_text%' THEN
    RAISE EXCEPTION 'the trigger still has a second share formula';
  END IF;
  IF v_src NOT LIKE '%NEW.is_tournament%' THEN
    RAISE EXCEPTION 'the trigger still fires on tournament rows';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_award_vip_points_from_rake' AND tgrelid = 'public.rake_records'::regclass) THEN
    RAISE EXCEPTION 'trg_award_vip_points_from_rake is gone';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rake_records WHERE source = 'phase6_probe') THEN
    RAISE EXCEPTION 'the probe committed its fixtures';
  END IF;
END $assert$;

INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
VALUES ('warning', 'fn_award_vip_points_from_rake.contribution_not_share',
  'VIP credit on rake was awarded as the raw player_contributions value on every DEALT_EQUAL row (pot contributions for cash, buy-ins for spins) and every tournament rake row was credited again at settlement. Week 2026-08-31..2026-09-06: 32,690 spin entries carrying 178,864.32 of rake were credited 2,235,804.00 at insert and 178,864.32 again at settlement; 530 cash DEALT_EQUAL rows carrying 999.15 of rake were credited 2,576.00. WEIGHTED_CONTRIBUTED rows were exact.',
  jsonb_build_object('window', '2026-08-31..2026-09-06',
    'spin_rows', 32690, 'spin_rake', 178864.32, 'spin_vip_credit_at_insert', 2235804.00,
    'cash_dealt_equal_rows', 530, 'cash_dealt_equal_rake', 999.15, 'cash_dealt_equal_vip_credit', 2576.00,
    'weighted_sample', jsonb_build_object('rows', 12152, 'rake', 22433.93, 'credit', 22413.11),
    'rule', '20260831100610 rake paid is rake earned',
    'fix', 'one allocator for every method; no award on tournament rows (settlement is the one door)'),
  true, now(),
  'Fixed forward in the same migration. The over-awarded VIP points stay with the players under CLAUDE.md 10.9 rule 3 (overpay our defect caused is absorbed, reported, left alone); VIP points are not chips.');

COMMIT;
