-- This migration creates no object - it replaces three function bodies - so it
-- states what a reader would run to see it is live, in its own words.
-- @live-proof: position('FROM union_eco_ledger l' in pg_get_functiondef('public.fn_union_club_invoice(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('union_squareup_eco_disagrees_with_record' in pg_get_functiondef('public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) > 0
-- @live-proof: position('app.ledger_autoledger_club_id' in pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure)) > 0

/* THE SQUARE-UP QUOTES THE RECORDED ECO, AND THE RAKE LEG NAMES ITS CLUB
   (2026-09-21)

   ==========================================================================
   Reserve a version with `node scripts/new-migration.mjs` (CLAUDE.md 4.5).
   Apply OUTSIDE :50-:03 UTC: ca_break_window_refuses_ddl aborts the whole
   transaction inside the break window (production DDL policy rule 8).
   ==========================================================================

   ------------------------------------------------------------------ DEFECT A
   A WEEKLY SQUARE-UP DUNNED A CLUB FOR MONEY THE ECO LEDGER DOES NOT SUPPORT.

   Measured on production 2026-09-21. settlement_invoices 7deff43f-efce-45a1-
   8c72-78dfc3862705 (union_weekly_squareup, club a41434bb SHARK CLUB, union
   week 2026-09-07T07:00Z -> 2026-09-14T07:00Z, status overdue) states

       rake_generated 303310.89   rakeback_due 272979.79   union_fee_kept 30331.10

   all three agreeing exactly with union_eco_ledger, and then

       eco_amount / net_amount / gross_amount   11244.03

   where the recorded union_eco_ledger row for the same union, club and period
   says eco_base 112428.18, eco_rate 0.10, eco_amount -11242.82
   (112428.18 * 0.10 = 11242.818 -> 11242.82). The document overstates the
   club's debt by 1.21. The sibling invoice 294a512f (club a0000000...0001,
   Club JAQK) agrees to the cent on all four figures, so this is not a rounding
   convention: 11244.03 implies an eco_base of 112440.30, which is 12.12 more
   club cash profit than the ledger recorded for the same week.

   WHY. Both numbers come from the SAME settlement transaction and BOTH are
   derived from fn_union_eco_adjustment -> fn_union_pnl_qualified_clubs ->
   fn_union_pnl_evidence_report, which is VOLATILE and recomputes the whole
   week's P&L from live tables on every call. fn_union_settlement_cascade runs
   that recomputation several times in one settlement:

     fn_union_eco_record            calls it twice and WRITES union_eco_ledger
     fn_union_issue_weekly_invoices calls it again for baseline_cash_exact
     fn_union_club_invoice          calls it AGAIN, and that fourth answer is
                                    what the invoice states

   Under READ COMMITTED each statement takes a fresh snapshot, so the fourth
   call is not the third and the third is not the first. eco_base is
   rake_earned - cash_player_pnl; cash_player_pnl is a live sum over
   union_pnl_cash_outcomes participants, and it moved by 12.12 for this one
   club between the write and the read. rake_earned did not move, which is
   exactly why only the ECO figure disagrees.

   THE RULE THIS BREAKS is not "recompute more carefully". A money document
   must QUOTE THE RECORD, not re-derive it. union_eco_ledger is the recorded
   ECO for the period - fn_union_eco_record wrote it moments earlier in the
   same transaction. So:

     1. fn_union_club_invoice reads the recorded union_eco_ledger row for the
        exact (union_id, club_id, period_start, period_end) and states THAT.
        It falls back to the live figure only when nothing is recorded yet,
        which is the read-only preview a union owner sees before settlement.
     2. fn_union_issue_weekly_invoices refuses to WRITE a union_weekly_squareup
        whose ECO is not the recorded one - and, when the union's commercial
        terms have ECO disabled, refuses a non-zero ECO. A settlement that
        cannot quote its own record stops; it does not issue a number.

   This is a refusal added to an existing writer. It is not a second document,
   a second correction authority, a reconciler or a repair job.

   WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. It does not touch the live
   overdue invoice. union_settlement_floor records Dan's 2026-09-20 decision
   that the weeks of 2026-09-07 and 2026-09-14 can never certify, that the
   floor is 2026-09-21T07:00Z, and that those two weeks are NOT written off:
   their obligations stay owed in accounting_deferred_obligations "for a
   separate one-off payment Dan authorises later". Re-pricing one of those two
   documents by 1.21 now would pre-empt that decision, and no chips have moved
   on it (chips_transferred = false, chip_transfer_id null), so there is no
   posted journal leg for fn_accounting_correction_prepare to document either.
   The calculation is fixed here; the disposition of those two weeks remains
   exactly where Dan put it.

   ------------------------------------------------------------------ DEFECT B
   A RAKE JOURNAL LEG COULD NOT NAME THE CLUB IT WAS EARNED IN.

   Measured on production 2026-09-21: for the same union week, chip_ledger
   holds 294,877 rows of to_type='union_wallet', category='rake' totalling
   671514.09, and club_id IS NULL on every single one. It is still happening:
   461 such rows on 2026-09-21 alone, all club-less, after 20260920192513
   installed - that migration taught fn_ca_autoledger to read a declaring
   payer and taught fn_diamond_game_pay_chips to declare, and PRIZE legs stop
   being club-less. Rake legs were not covered.

   The mechanism is the one 20260920192513 documented. atomic_distribute_rake
   routes union rake by UPDATE-ing public.union_wallets.rake_wallet, the
   fn_ca_autoledger trigger journals that delta, and union_wallets has no
   club_id column - so fn_ca_autoledger takes its ELSE branch and writes the
   leg club-less unless the payer declares the club on the transaction-scoped
   GUC. atomic_distribute_rake already declares the ledger category, the
   counterparty, the hand and the settlement key for exactly these legs. It is
   handed p_club_id. It simply never said so.

   So it says so now, next to the other ledger-context declarations, and
   clears it before every return that can follow the declaration. Clearing
   matters: atomic_distribute_rake is called from record_rake,
   fn_ca_process_hand_post_commit_obligations, fn_spin_book_entry and five
   other functions, and a value left set would stamp this hand's club onto any
   later union_wallets or unions leg in the same transaction - an invented
   attribution, which is the defect and not the fix.

   FORWARD ONLY. The 294,877 historical rows are NOT backfilled, and they
   cannot honestly be: for that week every rake_record and every
   rake_distribution_leg names club fade0000-0000-0000-0000-000000000001,
   the union itself, and union_wallet_transactions agrees - 294,877 rows,
   671514.09, club_id = the union. That is the same fact union_settlement_floor
   already records ("the old basis credited the union-as-a-club and zero to the
   member clubs"). The 1517.98 by which those invoices' stated rake_generated
   (366685.22 + 303310.89 = 669996.11) falls short of the journal's 671514.09
   is not rake earned outside both clubs and it is not rake the split dropped:
   the week's club split was produced by a basis that no longer exists and that
   the ledger never recorded. Inferring a member club for those rows would be
   inventing attribution. */

BEGIN;

-- Fail fast rather than queue behind a live writer. Three pg_proc rows change
-- and nothing else is touched, but a migration that can wedge the estate is
-- worse than the defect it repairs.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ===========================================================================
-- STEP 0 -- THE PREIMAGES THIS EDIT WAS WRITTEN AGAINST
-- ===========================================================================
DO $pre$
DECLARE
  v_src text; v_acl text; v_cfg text;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  -- The recorded ECO is addressed by its primary key below; if that key ever
  -- stops identifying one row per club per period the lookup is ambiguous.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.union_eco_ledger'::regclass
                    AND contype = 'p'
                    AND pg_get_constraintdef(oid) = 'PRIMARY KEY (union_id, club_id, period_start)') THEN
    RAISE EXCEPTION 'union_eco_ledger no longer keys one recorded ECO per club and period'
      USING ERRCODE = '55000';
  END IF;

  /* THE PREIMAGE IS ASSERTED BY SHAPE, NOT BY A WHOLE-BODY MD5.
     This file is loaded twice: into production, and into the native accounting
     fixture that scripts/dev/test-full-weekly-accounting-activation.sh builds
     from the weekly-v3 components, whose catalog is deliberately not
     byte-identical to production. A whole-definition md5 would make the
     regression un-runnable in the repository's own fixture, which is worse
     protection, not better. Assert instead exactly what this edit depends on:
     the declared properties that must survive CREATE OR REPLACE, and the
     pre-fix ECO expression the replacement is reasoned against. Every anchor
     this migration substitutes into is separately asserted to appear exactly
     once in STEP 2 and STEP 3. */
  SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl::text,''), COALESCE(p.proconfig::text,'')
    INTO v_src, v_acl, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_club_invoice';
  IF v_src IS NULL OR v_cfg IS DISTINCT FROM '{search_path=public}'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'fn_union_club_invoice'
                       AND p.prosecdef AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'fn_union_club_invoice is not the STABLE SECURITY DEFINER reader this edit replaces (config %)',
      COALESCE(v_cfg,'<missing>') USING ERRCODE = '55000';
  END IF;
  IF position('FROM union_eco_ledger l' in v_src) = 0
     AND (position('FROM fn_union_eco_adjustment(p_union_id, v_start, v_end) e' in v_src) = 0
          OR position('CASE WHEN eco.eco_enabled THEN eco.eco_amount ELSE 0 END' in v_src) = 0) THEN
    RAISE EXCEPTION 'fn_union_club_invoice does not carry the pre-fix ECO expression this edit was reasoned against - re-read it against the current body'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('ca.squareup_prior_invoice_acl', v_acl, true);

  SELECT COALESCE(p.proacl::text,''), COALESCE(p.proconfig::text,'')
    INTO v_acl, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_issue_weekly_invoices';
  IF v_cfg IS DISTINCT FROM '{search_path=public}'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'fn_union_issue_weekly_invoices'
                       AND p.prosecdef) THEN
    RAISE EXCEPTION 'fn_union_issue_weekly_invoices is not the SECURITY DEFINER writer this edit amends (config %)',
      COALESCE(v_cfg,'<missing>') USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('ca.squareup_prior_writer_acl', v_acl, true);

  SELECT COALESCE(p.proacl::text,''), COALESCE(p.proconfig::text,'')
    INTO v_acl, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake';
  IF v_cfg IS DISTINCT FROM '{search_path=public,statement_timeout=30s}'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake'
                       AND p.prosecdef) THEN
    RAISE EXCEPTION 'atomic_distribute_rake is not the SECURITY DEFINER rake producer this edit amends (config %)',
      COALESCE(v_cfg,'<missing>') USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('ca.squareup_prior_rake_acl', v_acl, true);

  /* THE DEPENDENCY THIS DECLARATION RESTS ON, AND WHY IT IS NOT ASSERTED HERE.
     STEP 3 makes atomic_distribute_rake DECLARE the earning club; what CONSUMES
     the declaration is the ELSE branch of fn_ca_autoledger's club CASE, which
     20260920192513 installed ("ELSE v_guc_club END;"). That is a separate,
     already-installed contract with its own assertions, and this file is also
     loaded into the native accounting fixture, whose catalog was captured
     before it. Asserting a neighbouring migration's body here would make this
     regression un-runnable in the repository's own fixture without protecting
     anything this transaction changes. The consumer is verified by readback
     against the installed database instead, and this migration's own
     post-conditions in STEP 4 cover everything it does change. */
END
$pre$;

-- ===========================================================================
-- STEP 1 -- THE SQUARE-UP STATES THE RECORDED ECO
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_union_club_invoice(p_union_id uuid, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
RETURNS TABLE(club_id uuid, club_name text, period_start timestamp with time zone, period_end timestamp with time zone, rake_generated numeric, union_fee_kept numeric, rakeback_due numeric, players_won numeric, player_pnl_net numeric, eco_amount numeric, eco_enabled boolean, presettled numeric, settled_in_chips numeric, outstanding numeric, net_position numeric, direction text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := COALESCE(p_start, fn_union_week_start());
  v_end   timestamptz := COALESCE(p_end, now());
BEGIN
  RETURN QUERY
  WITH eco AS (
    SELECT e.club_id, e.club_name, e.players_won, e.rake_generated,
           e.rake_earned, e.eco_base, e.eco_amount, e.eco_enabled
      FROM fn_union_eco_adjustment(p_union_id, v_start, v_end) e
  ),
  recorded AS (
    /* THE DOCUMENT QUOTES THE RECORD (2026-09-21). fn_union_eco_adjustment is
       a VOLATILE recomputation of the whole week; fn_union_eco_record wrote
       its answer to union_eco_ledger earlier in this same settlement, and a
       second recomputation is a second answer. On 2026-09-14 that cost club
       a41434bb 1.21 of overstated debt on an invoice whose other three
       figures matched the ledger exactly. Read what was recorded. */
    SELECT l.club_id, l.eco_amount
      FROM union_eco_ledger l
     WHERE l.union_id = p_union_id
       AND l.period_start = v_start
       AND l.period_end   = v_end
  ),
  pre AS (
    -- Unapplied cash held against the running balance. Closed out by
    -- applied_settlement_id, never by age: a payment made during a week that
    -- did not settle must still reach the club's next statement.
    SELECT p.club_id, COALESCE(SUM(p.amount), 0) AS amt
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.received_at < v_end
       AND p.applied_settlement_id IS NULL
     GROUP BY p.club_id
  ),
  calc AS (
    /* Phase 6 (20260907): rakeback_due IS round 1's payout for the club - the
       same fn_union_club_rake_basis rows, per game type, truncated to the
       cent - not a flat rate applied to a different rake total. */
    SELECT eco.club_id, eco.club_name,
           eco.rake_generated,
           round(eco.rake_generated - eco.rake_earned, 2) AS union_fee_kept,
           eco.rake_earned                                AS rakeback_due,
           eco.players_won,
           round(eco.players_won + eco.rake_generated, 2) AS player_pnl_net,
           /* The recorded ECO when the settlement has recorded one; the live
              figure only for the read-only preview of a week that has not
              been settled yet, which has no record to quote. */
           CASE WHEN eco.eco_enabled
                  THEN COALESCE(rec.eco_amount, eco.eco_amount)
                ELSE 0 END AS eco_amount,
           eco.eco_enabled,
           COALESCE(pre.amt, 0) AS presettled
      FROM eco
      LEFT JOIN recorded rec ON rec.club_id = eco.club_id
      LEFT JOIN pre          ON pre.club_id = eco.club_id
  )
  SELECT calc.club_id, calc.club_name, v_start, v_end,
         calc.rake_generated, calc.union_fee_kept, calc.rakeback_due,
         calc.players_won, calc.player_pnl_net,
         calc.eco_amount, calc.eco_enabled, calc.presettled,
         round(calc.player_pnl_net + calc.rakeback_due, 2) AS settled_in_chips,
         round(calc.eco_amount + calc.presettled, 2)       AS outstanding,
         round(calc.player_pnl_net + calc.rakeback_due
               + calc.eco_amount + calc.presettled, 2)     AS net_position,
         CASE WHEN round(calc.eco_amount + calc.presettled, 2) > 0
                THEN 'union owes club'
              WHEN round(calc.eco_amount + calc.presettled, 2) < 0
                THEN 'club owes union'
              ELSE 'square' END::text
    FROM calc
   ORDER BY calc.club_name;
END;
$function$;

-- CREATE OR REPLACE preserves the ACL this function already carries, and STEP 4
-- asserts it is unchanged. Restate it anyway, as 20260907221210 did: a reader of
-- this file should not have to look elsewhere to learn that a SECURITY DEFINER
-- reader of union reconciliation is service-only, and GRANT/REVOKE does not
-- reload PostgREST (production DDL policy rule 5).
REVOKE ALL ON FUNCTION public.fn_union_club_invoice(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_invoice(uuid, timestamptz, timestamptz) TO service_role;

-- ===========================================================================
-- STEP 2 -- THE WRITER REFUSES A SQUARE-UP THAT DOES NOT QUOTE ITS RECORD
-- ===========================================================================
DO $inv$
DECLARE
  v_src text; v_new text; v_anchor text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_issue_weekly_invoices';

  IF position('union_squareup_eco_disagrees_with_record' in v_src) > 0 THEN
    RAISE NOTICE 'fn_union_issue_weekly_invoices already quotes the recorded ECO; skipping';
  ELSE
    v_anchor := '  v_out jsonb := ''[]''::jsonb;';
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the declaration anchor appears % times in fn_union_issue_weekly_invoices, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_src, v_anchor,
      v_anchor || E'\n' ||
      '  v_recorded_eco numeric;' || E'\n' ||
      '  v_eco_recorded boolean;');

    v_anchor := '    v_msg := NULL;' || E'\n' ||
                '    v_invoice_id := NULL;' || E'\n' ||
                '    v_already_sent := false;';
    v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the per-club reset anchor appears % times in fn_union_issue_weekly_invoices, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_new, v_anchor,
      v_anchor || E'\n' ||
      '' || E'\n' ||
      '    /* THE DOCUMENT QUOTES THE RECORDED ECO (2026-09-21). union_eco_ledger' || E'\n' ||
      '       is the recorded ECO for this period; fn_union_eco_record wrote it' || E'\n' ||
      '       earlier in this settlement. fn_union_club_invoice now reads it, so' || E'\n' ||
      '       this refusal should never fire - it exists because a square-up that' || E'\n' ||
      '       cannot quote its own record must STOP, not state a number. On' || E'\n' ||
      '       2026-09-14 a second live recomputation billed club a41434bb 11244.03' || E'\n' ||
      '       against a recorded -11242.82. With ECO terms disabled nothing is' || E'\n' ||
      '       recorded and nothing may be stated. */' || E'\n' ||
      '    SELECT l.eco_amount INTO v_recorded_eco' || E'\n' ||
      '      FROM union_eco_ledger l' || E'\n' ||
      '     WHERE l.union_id = p_union_id AND l.club_id = r.club_id' || E'\n' ||
      '       AND l.period_start = v_from AND l.period_end = v_to;' || E'\n' ||
      '    v_eco_recorded := FOUND;' || E'\n' ||
      '    IF r.eco_enabled AND NOT v_eco_recorded THEN' || E'\n' ||
      '      RAISE EXCEPTION ''union_squareup_eco_not_recorded'' USING ERRCODE = ''23514'',' || E'\n' ||
      '        DETAIL = jsonb_build_object(''union_id'', p_union_id, ''club_id'', r.club_id,' || E'\n' ||
      '          ''period_start'', v_from, ''period_end'', v_to, ''stated_eco'', r.eco_amount)::text;' || E'\n' ||
      '    END IF;' || E'\n' ||
      '    IF round(COALESCE(r.eco_amount, 0), 2)' || E'\n' ||
      '       IS DISTINCT FROM round(COALESCE(v_recorded_eco, 0), 2) THEN' || E'\n' ||
      '      RAISE EXCEPTION ''union_squareup_eco_disagrees_with_record'' USING ERRCODE = ''23514'',' || E'\n' ||
      '        DETAIL = jsonb_build_object(''union_id'', p_union_id, ''club_id'', r.club_id,' || E'\n' ||
      '          ''period_start'', v_from, ''period_end'', v_to,' || E'\n' ||
      '          ''stated_eco'', r.eco_amount, ''recorded_eco'', v_recorded_eco)::text;' || E'\n' ||
      '    END IF;');

    IF v_new = v_src THEN RAISE EXCEPTION 'the square-up refusal substitution produced no change'; END IF;
    EXECUTE v_new;
  END IF;
END
$inv$;

-- ===========================================================================
-- STEP 3 -- THE RAKE LEG NAMES THE CLUB IT WAS EARNED IN
-- ===========================================================================
DO $rake$
DECLARE
  v_src text; v_new text; v_anchor text; v_n int; v_guc constant text := 'app.ledger_autoledger_club_id';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake';

  IF position(v_guc in v_src) > 0 THEN
    RAISE NOTICE 'atomic_distribute_rake already declares its earning club; skipping';
  ELSE
    -- The declaration goes with the other ledger-context declarations this
    -- function already makes for exactly these legs.
    v_anchor := '  -- PHASE 6.4 (2026-09-05): the rake''s legs name the hand when it is known.' || E'\n' ||
                '  PERFORM set_config(''app.ledger_hand_id'', COALESCE(p_hand_id::text, ''''), true);';
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the ledger-context anchor appears % times in atomic_distribute_rake, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_src, v_anchor,
      v_anchor || E'\n' ||
      '  /* THE RAKE LEG NAMES THE CLUB IT WAS EARNED IN (2026-09-21). Union rake' || E'\n' ||
      '     is routed by UPDATE-ing union_wallets.rake_wallet; the fn_ca_autoledger' || E'\n' ||
      '     trigger journals that delta, and union_wallets has no club_id column,' || E'\n' ||
      '     so every union rake leg was written club-less - 294,877 rows and' || E'\n' ||
      '     671514.09 in the week of 2026-09-07 alone, and still happening.' || E'\n' ||
      '     20260920192513 taught the autoledger to read a declaring payer and' || E'\n' ||
      '     fixed the PRIZE legs; this is the rake payer saying the same thing.' || E'\n' ||
      '     NOT app.ledger_club_id: that name decides which club a WALLET credit' || E'\n' ||
      '     is paid into (atomic_credit_wallet_and_log) and is set and restored by' || E'\n' ||
      '     the rakeback close, so clearing it here would move money. */' || E'\n' ||
      '  PERFORM set_config(''' || v_guc || ''', COALESCE(p_club_id::text, ''''), true);');
    IF v_new = v_src THEN RAISE EXCEPTION 'the rake club declaration produced no change'; END IF;

    -- Clear it before every return that can follow the declaration. This
    -- function is called from record_rake and seven other bodies; a value left
    -- set would stamp this hand's club onto a later union_wallets or unions leg
    -- in the same transaction, which is an invented attribution.
    v_anchor := '      RETURN QUERY SELECT false, true, false, v_dup_id, 0::numeric,';
    v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the duplicate-hand return appears % times in atomic_distribute_rake, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_new, v_anchor,
      '      PERFORM set_config(''' || v_guc || ''', '''', true);' || E'\n' || v_anchor);

    v_anchor := '  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,';
    v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the final return appears % times in atomic_distribute_rake, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_new, v_anchor,
      '  PERFORM set_config(''' || v_guc || ''', '''', true);' || E'\n' || v_anchor);

    -- Exactly three: the declaration and its two clears. The comment names the
    -- OTHER GUC, app.ledger_club_id, which is not a substring of this one.
    v_n := (length(v_new) - length(replace(v_new, v_guc, ''))) / length(v_guc);
    IF v_n <> 3 THEN
      RAISE EXCEPTION 'expected the new atomic_distribute_rake to name the declaring GUC three times (set, two clears), found %', v_n
        USING ERRCODE = '55000';
    END IF;
    EXECUTE v_new;
  END IF;
END
$rake$;

-- ===========================================================================
-- STEP 4 -- WHAT MUST NOW BE TRUE
-- ===========================================================================
DO $post$
DECLARE
  v_src text; v_n int;
BEGIN
  v_src := pg_get_functiondef('public.fn_union_club_invoice(uuid,timestamptz,timestamptz)'::regprocedure);
  IF position('FROM union_eco_ledger l' in v_src) = 0
     OR position('COALESCE(rec.eco_amount, eco.eco_amount)' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_union_club_invoice does not quote the recorded ECO' USING ERRCODE = '55000';
  END IF;
  -- STEP 1 restated this reader's grants, so its post-state is asserted
  -- absolutely: a SECURITY DEFINER reader of union reconciliation is
  -- service-only, and no caller without an account may reach it.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_union_club_invoice'
                    AND p.prosecdef AND p.provolatile = 's'
                    AND p.proconfig::text = '{search_path=public}')
     OR has_function_privilege('anon', 'public.fn_union_club_invoice(uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_union_club_invoice(uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_union_club_invoice(uuid,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_union_club_invoice lost a guarantee across CREATE OR REPLACE' USING ERRCODE = '55000';
  END IF;

  v_src := pg_get_functiondef('public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure);
  IF position('union_squareup_eco_not_recorded' in v_src) = 0
     OR position('union_squareup_eco_disagrees_with_record' in v_src) = 0
     OR position('union_squareup_eco_disagrees_with_record' in v_src) > position('INSERT INTO settlement_invoices' in v_src) THEN
    RAISE EXCEPTION 'the square-up refusal is missing or does not precede the document write' USING ERRCODE = '55000';
  END IF;
  -- This writer's grants are not restated here, so they must be exactly what
  -- STEP 0 found before the substitution ran.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_union_issue_weekly_invoices'
                    AND p.prosecdef AND p.proconfig::text = '{search_path=public}'
                    AND COALESCE(p.proacl::text,'')
                        = current_setting('ca.squareup_prior_writer_acl', true)) THEN
    RAISE EXCEPTION 'fn_union_issue_weekly_invoices lost a guarantee across CREATE OR REPLACE' USING ERRCODE = '55000';
  END IF;

  v_src := pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure);
  v_n := (length(v_src) - length(replace(v_src, 'app.ledger_autoledger_club_id', '')))
         / length('app.ledger_autoledger_club_id');
  IF v_n <> 3
     OR position('set_config(''app.ledger_autoledger_club_id'', COALESCE(p_club_id::text' in v_src) = 0 THEN
    RAISE EXCEPTION 'atomic_distribute_rake does not declare and clear its earning club' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake'
                    AND p.prosecdef
                    AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
                    AND COALESCE(p.proacl::text,'')
                        = current_setting('ca.squareup_prior_rake_acl', true)) THEN
    RAISE EXCEPTION 'atomic_distribute_rake lost a guarantee across CREATE OR REPLACE' USING ERRCODE = '55000';
  END IF;

  -- The weekly coordinator's discovery cursors are Dan's 2026-09-20 decision.
  -- Nothing here moves them; say so out loud so a future reader of this file
  -- knows it was checked rather than ignored.
  IF EXISTS (SELECT 1 FROM public.union_settlement_floor
              WHERE union_id = 'fade0000-0000-0000-0000-000000000001'
                AND earliest_period_start IS DISTINCT FROM '2026-09-21 07:00:00+00'::timestamptz) THEN
    RAISE EXCEPTION 'the union settlement floor is not where this migration found it' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
