-- This migration creates no object - it replaces one function body - so it
-- states what a reader would run to see it is live, in its own words.
-- @live-proof: position('app.ledger_autoledger_club_id' in pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure)) > 0

/* THE TOURNAMENT RAKE LEG NAMES THE CLUB IT WAS EARNED IN (2026-09-21)

   ==========================================================================
   Reserve a version with `node scripts/new-migration.mjs` (CLAUDE.md 4.5).
   Apply OUTSIDE :50-:03 UTC: ca_break_window_refuses_ddl aborts the whole
   transaction inside the break window (production DDL policy rule 8).
   ==========================================================================

   ------------------------------------------------------------------- MEASURED

   20260921040847 (the installed bytes of
   20260921023420_the_squareup_quotes_the_recorded_eco_and_the_rake_leg_names_)
   taught atomic_distribute_rake to declare the earning club on
   app.ledger_autoledger_club_id, and the union CASH rake leg has named its
   club ever since it committed at ~04:08Z on 2026-09-21. Measured on
   production at 06:50Z, chip_ledger category='rake', to_type='union_wallet',
   in ten-minute buckets:

       03:40-04:09   every leg club-less   (pre-fix)
       04:10-06:50   435 legs, 1 club-less

   A rolling three-hour window still straddles that cutover, which is what
   makes the fix look partial: at exactly 06:40Z the window 03:40Z-06:40Z
   held 461 legs of which 39 were club-less, and 38 of those 39 were written
   BEFORE the fix existed. They are not a surviving producer. The rate after
   the cutover is 1 in 436.

   THE ONE. chip_ledger 7c1236b3-5b71-4859-9c30-d0c5dd8bce15, 2026-09-21
   04:36:41.744289Z, 80.00, club_id NULL.

   ---------------------------------------------------- THE DISTINGUISHING FACT

   Every union rake leg in the window - club-ful and club-less, before and
   after the cutover - carries the identical shape: description
   'auto-ledgered union_wallets.rake_wallet delta N', idempotency_key NULL,
   metadata NULL. There is no second producer of this category and to_type;
   there is one, fn_ca_autoledger, journalling a delta on
   union_wallets.rake_wallet. What separates the legs is from_type, and
   from_type on a credit IS the payer's declared app.ledger_counterparty:

       from_type='table_stack'       435 post-cutover legs, 0 club-less
       from_type='prize_liability'     2 legs in six hours, 2 club-less

   'table_stack' is atomic_distribute_rake, the cash-table payer, fixed.
   'prize_liability' is fn_settle_tournament_rake, the tournament payer, and
   it is the only caller of increment_union_wallet. It declares the ledger
   category, the counterparty and the counterparty entity for exactly these
   legs, then UPDATEs union_wallets.rake_wallet through increment_union_wallet.
   union_wallets has no club_id column, so fn_ca_autoledger takes the ELSE
   branch of its club CASE and reads app.ledger_autoledger_club_id, which this
   payer never set. Same mechanism as 20260920192513 and 20260921040847
   documented; a third door, not a new defect class.

   ------------------------------- IT IS A DEFECT, NOT A UNION-SCOPED LEG

   The honest question is whether tournament rake credited to a union wallet
   has a member club at all, or whether it is union-scoped and NULL is
   telling the truth. It is not. On this path the club is known, proven
   non-null, and already written down twice:

     * fn_settle_tournament_rake refuses the transfer outright two statements
       earlier - IF v_t.club_id IS NULL THEN RAISE EXCEPTION
       'tournament_fee_bank_club_required' - so the declaration below can
       never be empty on any path that reaches it.
     * it hands that same club to increment_union_wallet, which writes
       union_wallet_transactions.club_id. For leg 7c1236b3 that sibling row
       (2c9a2574-5576-439e-ab10-6d3b46ef7da6) says club_id
       fade0000-0000-0000-0000-000000000001, and tournament_rake_settlements
       for tournament 5b0403d1-7d8e-4c3f-8da9-c44c42d20e0b says the same.

   That club is Midway Union's own clubs row - the union-as-a-club, a real
   row with a real primary key, the same one union_settlement_floor records
   the 2026-09-07 basis as having credited. So the leg is not "union-scoped
   with no club": it has a club, the writer held it, and the journal dropped
   it. Zero of the measured legs are legitimately club-less. Nothing here
   invents a scope word or a reason string, because none is needed - the
   answer was already in the transaction.

   ------------------------------------------------------------- FORWARD ONLY

   No historical row is backfilled. The 294,877 legs of the week of
   2026-09-07 and the 201,584 club-less legs of the week of 2026-09-14 stay
   exactly as they are, for the reason 20260921040847 already recorded: the
   week's club split came from a basis that no longer exists and that the
   ledger never recorded, so inferring a member club for those rows would be
   inventing attribution. This migration changes one function body and
   touches no data.

   ---------------------------------------------- WHAT IS DELIBERATELY NOT DONE

   increment_union_wallet has a fallback that declares category 'rake' and
   counterparty 'table_stack' when its caller declared nothing. That fallback
   cannot name a club either, and it would mint a club-less leg that looks
   like a cash-table one. It is unreachable today - fn_settle_tournament_rake
   is its only caller and always declares first, so the fallback is always
   skipped - and putting a second club declaration in a shared helper would
   create a second attribution authority for no live path. It is recorded
   here instead, and the regression below asserts the property at the payers
   that own the decision. */

BEGIN;

-- Fail fast rather than queue behind a live writer. One pg_proc row changes
-- and nothing else is touched, but a migration that can wedge the estate is
-- worse than the defect it repairs.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ===========================================================================
-- STEP 0 -- THE PREIMAGE THIS EDIT WAS WRITTEN AGAINST
-- ===========================================================================
DO $pre$
DECLARE
  v_src text; v_acl text; v_cfg text;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  /* THE PREIMAGE IS ASSERTED BY SHAPE, NOT BY A WHOLE-BODY MD5, for the
     reason 20260921023420 gave: this file is loaded twice, into production
     and into the native accounting fixture that
     scripts/dev/test-full-weekly-accounting-activation.sh builds, whose
     catalog is deliberately not byte-identical to production. Assert exactly
     what this edit depends on - the declared properties that must survive
     CREATE OR REPLACE, and the refusal the declaration's non-emptiness rests
     on. Each anchor is separately asserted to appear exactly once in STEP 1. */
  SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl::text,''), COALESCE(p.proconfig::text,'')
    INTO v_src, v_acl, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_rake';
  IF v_src IS NULL
     OR v_cfg IS DISTINCT FROM '{"search_path=public, pg_temp",statement_timeout=30s}'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_rake'
                       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake is not the VOLATILE SECURITY DEFINER settler this edit amends (config %)',
      COALESCE(v_cfg,'<missing>') USING ERRCODE = '55000';
  END IF;

  /* THE DECLARATION BELOW IS ONLY HONEST IF THE CLUB CANNOT BE NULL THERE.
     This is the refusal that makes it so. If it ever stops guarding the
     transfer, a club-less declaration becomes reachable and this edit must be
     re-reasoned rather than replayed. */
  IF position('IF v_t.club_id IS NULL THEN RAISE EXCEPTION ''tournament_fee_bank_club_required''' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake no longer refuses a club-less tournament fee bank, so the club declaration this edit adds could be empty'
      USING ERRCODE = '55000';
  END IF;

  /* The counterparty this whole diagnosis rests on: it is what becomes
     from_type on the credit leg, and it is how the defective producer was
     told apart from the fixed one on production rows. */
  IF position('set_config(''app.ledger_counterparty'',''prize_liability'',true)' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake no longer declares the prize_liability counterparty this edit joins'
      USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('ca.tourney_rake_prior_acl', v_acl, true);

  /* THE CONSUMER THIS DECLARATION RESTS ON, AND WHY IT IS NOT ASSERTED HERE.
     What reads the declaration is the ELSE branch of fn_ca_autoledger's club
     CASE, installed by 20260920192513. That is a separate, already-installed
     contract with its own assertions, and this file is also loaded into the
     native accounting fixture whose catalog was captured before it - the
     identical situation 20260921023420 recorded for the same reason. The
     consumer is verified by readback against the installed database instead,
     and STEP 2 covers everything this transaction changes. */
END
$pre$;

-- ===========================================================================
-- STEP 1 -- THE TOURNAMENT PAYER DECLARES THE CLUB, AND CLEARS IT
-- ===========================================================================
DO $rake$
DECLARE
  v_src text; v_new text; v_anchor text; v_n int;
  v_guc constant text := 'app.ledger_autoledger_club_id';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_rake';

  IF position(v_guc in v_src) > 0 THEN
    RAISE NOTICE 'fn_settle_tournament_rake already declares its earning club; skipping';
  ELSE
    -- The declaration goes with the other ledger-context declarations this
    -- function already makes for exactly these legs.
    v_anchor := '  PERFORM set_config(''app.ledger_counterparty_entity'',p_tournament_id::text,true);';
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the ledger-context anchor appears % times in fn_settle_tournament_rake, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_src, v_anchor,
      v_anchor || E'\n' ||
      '  /* THE TOURNAMENT RAKE LEG NAMES THE CLUB IT WAS EARNED IN (2026-09-21).' || E'\n' ||
      '     The union fee is routed by UPDATE-ing union_wallets.rake_wallet through' || E'\n' ||
      '     increment_union_wallet; fn_ca_autoledger journals that delta, and' || E'\n' ||
      '     union_wallets has no club_id column, so every tournament union rake leg' || E'\n' ||
      '     was written club-less. 20260920192513 taught the autoledger to read a' || E'\n' ||
      '     declaring payer and fixed the PRIZE legs; 20260921040847 made the' || E'\n' ||
      '     cash-table rake payer declare; this is the tournament rake payer saying' || E'\n' ||
      '     the same thing. v_t.club_id is refused NULL above, and is the same club' || E'\n' ||
      '     handed to increment_union_wallet for union_wallet_transactions.club_id,' || E'\n' ||
      '     so the leg and its sibling receipt name one club or the fee does not' || E'\n' ||
      '     move at all. NOT app.ledger_club_id: that name decides which club a' || E'\n' ||
      '     WALLET credit is paid into (atomic_credit_wallet_and_log) and is set and' || E'\n' ||
      '     restored by the rakeback close, so clearing it here would move money. */' || E'\n' ||
      '  PERFORM set_config(''' || v_guc || ''',COALESCE(v_t.club_id::text,''''),true);');
    IF v_new = v_src THEN RAISE EXCEPTION 'the tournament rake club declaration produced no change'; END IF;

    /* Clear it at the close of the fee block, which is the only exit that can
       follow the declaration: every statement between here and there either
       succeeds or RAISEs, and a RAISE aborts the settlement. Bounding it here
       rather than at the final RETURN keeps fn_recognize_accounting_tournament_fees
       out of the declared window, and - because the declaration is made only
       when a positive fee moves - means this function never clears a value it
       did not set, so a zero-fee close cannot wipe an outer payer's context. */
    v_anchor := ' ELSE v_dest:=''none''; END IF;';
    v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the fee-block close appears % times in fn_settle_tournament_rake, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_new, v_anchor,
      '  PERFORM set_config(''' || v_guc || ''','''',true);' || E'\n' || v_anchor);

    -- Exactly two: the declaration and its clear. The comment names the OTHER
    -- GUC, app.ledger_club_id, which is not a substring of this one.
    v_n := (length(v_new) - length(replace(v_new, v_guc, ''))) / length(v_guc);
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'expected the new fn_settle_tournament_rake to name the declaring GUC twice (set, clear), found %', v_n
        USING ERRCODE = '55000';
    END IF;
    EXECUTE v_new;
  END IF;
END
$rake$;

-- ===========================================================================
-- STEP 2 -- WHAT MUST NOW BE TRUE
-- ===========================================================================
DO $post$
DECLARE
  v_src text; v_n int;
BEGIN
  v_src := pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure);
  v_n := (length(v_src) - length(replace(v_src, 'app.ledger_autoledger_club_id', '')))
         / length('app.ledger_autoledger_club_id');
  IF v_n <> 2
     OR position('set_config(''app.ledger_autoledger_club_id'',COALESCE(v_t.club_id::text' in v_src) = 0
     OR position('set_config(''app.ledger_autoledger_club_id'','''',true)' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake does not declare and clear its earning club' USING ERRCODE = '55000';
  END IF;
  -- The declaration must sit inside the fee block, before the credit it
  -- describes, and the clear must follow it. Order is the whole contract:
  -- a declaration after the credit would journal nothing. Match the CALL,
  -- 'public.increment_union_wallet(', not the bare name: the declaration's own
  -- comment names the helper too, and position() would find the comment first.
  IF position('set_config(''app.ledger_autoledger_club_id'',COALESCE(v_t.club_id::text' in v_src)
       > position('public.increment_union_wallet(' in v_src)
     OR position('set_config(''app.ledger_autoledger_club_id'','''',true)' in v_src)
       < position('public.increment_union_wallet(' in v_src) THEN
    RAISE EXCEPTION 'the club declaration and its clear do not bracket the union credit' USING ERRCODE = '55000';
  END IF;
  -- This settler's grants are not restated here, so they must be exactly what
  -- STEP 0 found before the substitution ran.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_rake'
                    AND p.prosecdef AND p.provolatile = 'v'
                    AND p.proconfig::text = '{"search_path=public, pg_temp",statement_timeout=30s}'
                    AND COALESCE(p.proacl::text,'')
                        = current_setting('ca.tourney_rake_prior_acl', true)) THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake lost a guarantee across CREATE OR REPLACE' USING ERRCODE = '55000';
  END IF;

  -- The cash-table payer 20260921040847 fixed must still declare. This
  -- migration does not touch it; say so out loud, because a union rake leg
  -- naming its club is now a property of BOTH payers and a later edit that
  -- silently removed one would leave this file's claim false.
  v_src := pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure);
  IF position('set_config(''app.ledger_autoledger_club_id'', COALESCE(p_club_id::text' in v_src) = 0 THEN
    RAISE EXCEPTION 'the cash-table rake payer no longer declares its earning club' USING ERRCODE = '55000';
  END IF;

  -- The weekly coordinator's discovery cursors are Dan's 2026-09-20 decision,
  -- and the Sept 21-28 book is the first settleable one. Nothing here moves
  -- them; say so out loud so a future reader knows it was checked.
  IF EXISTS (SELECT 1 FROM public.union_settlement_floor
              WHERE union_id = 'fade0000-0000-0000-0000-000000000001'
                AND earliest_period_start IS DISTINCT FROM '2026-09-21 07:00:00+00'::timestamptz) THEN
    RAISE EXCEPTION 'the union settlement floor is not where this migration found it' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
