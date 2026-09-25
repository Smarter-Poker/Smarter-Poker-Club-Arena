-- 20260925145748_the_union_send_door_credits_one_owner_and_the_squareup_check.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: position('union_send_club_owner_is_ambiguous' in pg_get_functiondef('public.fn_union_send_chips_to_club(uuid,uuid,numeric,text)'::regprocedure)) > 0
-- @live-proof: position('app.union_send_chips_op_id' in pg_get_functiondef('public.fn_union_send_chips_to_club(uuid,uuid,numeric,text)'::regprocedure)) > 0
-- @live-proof: position('union_squareup_eco_record_fails_its_own_arithmetic' in pg_get_functiondef('public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) > 0

/* THE UNION SEND DOOR CREDITS ONE OWNER, AND THE SQUARE-UP CHECKS THE ECO
   RECORD'S OWN ARITHMETIC (2026-09-25)

   ==========================================================================
   Reserve a version with `node scripts/new-migration.mjs` (CLAUDE.md 4.5).
   Apply OUTSIDE :50-:03 UTC: ca_break_window_refuses_ddl aborts the whole
   transaction inside the break window (production DDL policy rule 8).
   ==========================================================================

   ------------------------------------------------------------------ DEFECT A
   A CHIP-MINTING TRANSFER WITH NONE OF THE THREE GUARDS.

   public.fn_union_send_chips_to_club resolves ONE club owner with LIMIT 1 and
   no ORDER BY, and then credits EVERY matching row:

     SELECT user_id INTO v_owner_user_id
       FROM club_members WHERE club_id = p_club_id AND role = 'owner' LIMIT 1;
     ...
     UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + p_amount
      WHERE club_id = p_club_id AND role = 'owner';

   The union wallet is debited ONCE. A club carrying two role='owner' rows
   therefore receives 2 x p_amount for a 1 x p_amount debit, and the
   difference is minted. It has no authorization check of any kind, no
   idempotency key, and it writes no chip_ledger row of its own.

   NOT EXPLOITABLE TODAY, AND THE REASON MATTERS. Verified on production
   2026-09-25: proacl is {postgres=X/postgres} - not service_role, not
   authenticated, not anon - because 20260903201301 closed this door as one of
   two orphan money doors with zero callers and zero rows in 30 days, and
   registered it `closed` in ca_money_rpc_registry. Zero clubs carry more than
   one role='owner' row, chip_ledger holds no 'union_send' leg from it, and
   union_wallet_transactions holds no 'send_to_club' row. It is a loaded gun,
   not a live fire. tests/a-money-door-nothing-calls-is-closed.law.test.ts
   keeps it revoked from PUBLIC, anon, authenticated and service_role, and
   fn_ca_money_rpc_drift raises an incident if any of those roles regains a
   key. THIS MIGRATION DOES NOT GRANT IT BACK. CREATE OR REPLACE preserves the
   ACL, the closed registration stands, and the revokes are restated below so a
   reader of this file does not have to look elsewhere. GRANT/REVOKE does not
   reload PostgREST (production DDL policy rule 5).

   EVERY CALLER, CHECKED FIRST. There are none. In this repository the name
   appears only in supabase/migrations (its own three historical definitions,
   the two closure migrations and 20260428000004's comment), in the schema
   manifest, in the RLS and accounting seed registries that enumerate money
   RPCs, in tests/a-money-door-nothing-calls-is-closed.law.test.ts, in .memory
   history, and in one CODE COMMENT in src/pages/UnionDashboardPage.tsx line
   2168 that records the 2026-07-21 union audit's decision to call
   fn_union_send_to_club_atomic instead. No quoted supabase.rpc() call exists
   in src/, server/src/ or supabase/functions/ - the law test above proves that
   on every run. In the database no pg_proc body, no pg_cron command and no
   view references it.

   SO THE DESTINATION IS DECIDED ON EVIDENCE, NOT PRESERVED OUT OF HABIT. The
   canonical union-to-club send is fn_union_send_to_club_atomic (World Hub
   union-wallet.js): union_bank -> clubs.chip_treasury, one declared journal
   row keyed on the operation. .agent/architecture/CLUB-MONEY-LEDGERS-
   CANONICAL.md lists "union send-to-club" as a chip_treasury credit. This door
   instead pays a union distribution into a person's pocket, which is why the
   closure migration called it out by name. It keeps that destination here -
   changing where the chips land would make this a second payer with different
   semantics, which is not a bug fix - but it may no longer GUESS whose pocket:

     1. The owner is resolved from clubs.owner_id, which is the platform's
        single authoritative owner: the deferred constraint trigger
        trg_club_owner_has_a_player_wallet guarantees that user a club_members
        row with role owner or co_owner, and fn_sync_mfa_required_on_club_owner
        follows the same column. LIMIT 1 over role='owner' with no ORDER BY is
        not a resolution, it is a coin toss.
     2. If club_members holds anything other than exactly one role='owner' row,
        or that one row is not clubs.owner_id, the transfer REFUSES. An
        ambiguous owner is the minting condition; a money mover that cannot
        name its payee stops.
     3. Exactly that one row is credited, by user_id. The 'WHERE role=owner'
        UPDATE is gone.

   AND IT CARRIES THE THREE GUARDS THIS CODEBASE REQUIRES OF A MONEY MOVER:

     AUTHORIZATION, the house pattern. fn_execute_union_rakeback gates on
     fn_caller_is_engine() OR actor = unions.owner_id; fn_union_fund_promo_from
     _bank gates on auth.role()='service_role' OR owner; fn_wallet_type_transfer
     refuses a NULL auth.uid(). This uses fn_caller_is_engine() OR the union's
     owner, and additionally requires the club to be IN the union
     (fn_union_send_to_club_atomic's check, which this door never had).

     IDEMPOTENCY. chip_ledger carries a UNIQUE partial index on
     idempotency_key, which is how fn_union_send_to_club_atomic makes a repeat
     send a 'duplicate' rather than a second payment. That function takes its
     operation id as a parameter. This one CANNOT grow a parameter: a fifth
     argument would create a new overload with default PUBLIC EXECUTE, which is
     precisely the closed door reopening, and the law test pins the four-argument
     signature. So the operation id is declared on the transaction-scoped
     app.union_send_chips_op_id, and a caller that declares none is REFUSED. A
     money mover does not invent its own uniqueness: gen_random_uuid() here
     would make every retry a fresh payment.

     THE LEDGER LEG. club_members.chip_balance is journalled by
     fn_club_members_ledger_writer, which takes its category and counterparty
     from the declaration but writes NO idempotency_key, and union_wallets by
     fn_ca_autoledger - so an undeclared send wrote two anonymous
     settlement_suspense adjustments and no key. Both journals are stood down
     with the one autoskip contract, exactly as fn_settle_accounting_rakeback
     _stage does, and this function writes ONE leg itself: union_bank ->
     player_wallet, category 'union_send', carrying the key, the pre/post
     balances on both sides, and club_id declared per the pattern
     atomic_distribute_rake and fn_settle_tournament_rake establish (the
     receiving club, named explicitly, because union_wallets has no club_id
     column and an undeclared leg is written club-less).

   AND THE DOOR WAS ALSO JAMMED, WHICH IS WHY NO CHIP EVER WENT THROUGH IT.
   Found while rehearsing this change on production's exact catalog 2026-09-25:
   step 6 of the predecessor inserts its audit row with wallet='main', and

     union_wallet_transactions_wallet_check CHECK (wallet = ANY (ARRAY[
       'chip_balance','rake_wallet','bbj_wallet','promo_wallet',
       'insurance_wallet','spin_reserve_wallet']))

   is VALIDATED on production and does not contain 'main'. So every call this
   function has ever received aborted at that INSERT with SQLSTATE 23514 and
   rolled the debit, the double credit and the audit row back together. That is
   the real reason union_wallet_transactions holds no 'send_to_club' row and
   chip_ledger holds no leg from it - not only that nothing calls it. The
   2026-04-15 BUG 011 fix moved this INSERT to the right table and left the
   wrong wallet name in it, and nothing has called the function since to find
   out. The column that actually moves is union_wallets.chip_balance, which is
   what fn_union_send_to_club_atomic and fn_union_fund_promo_from_bank both
   record, so that is what it records now. This is corrected in the same change
   because a money mover whose own audit row cannot be written is not fixed.

   NOT SECURITY DEFINER. It is not one today, and making it one would be the
   one change here that could widen what a future grant reaches. The smallest
   correct fix leaves the invoker's own table privileges in force.

   ------------------------------------------------------------------ DEFECT B
   A GUARD THAT CANNOT FIRE, AND THE ONE THAT CAN.

   fn_union_issue_weekly_invoices raises union_squareup_eco_disagrees_with
   _record when a square-up's ECO disagrees with union_eco_ledger. Since
   20260921023420 (installed as 20260921040847) fn_union_club_invoice RETURNS
   the recorded ECO:

     CASE WHEN eco.eco_enabled
            THEN COALESCE(rec.eco_amount, eco.eco_amount)
          ELSE 0 END AS eco_amount

   so for an ECO-enabled club with a recorded row - the only arm that reaches
   the comparison, because the arm without a record is already refused by
   union_squareup_eco_not_recorded - r.eco_amount IS v_recorded_eco. The
   comparison is the record against itself. Proven in the Sept 28 rehearsal:
   mutating a recorded eco_amount by 0.01 produced an invoice restating the
   mutated figure with the guard silent.

   THE NAIVE FIX IS THE 2026-09-14 DEFECT. Comparing against a fresh
   fn_union_eco_adjustment call would resurrect exactly what 20260921023420
   removed: fn_union_pnl_evidence_report is VOLATILE, each call takes its own
   READ COMMITTED snapshot, and on 2026-09-14 the fourth recomputation of one
   week billed club a41434bb 11244.03 against a recorded -11242.82. That is NOT
   reintroduced here, and nothing added below reads fn_union_eco_adjustment,
   fn_union_pnl_qualified_clubs or fn_union_pnl_evidence_report.

   OPTION (a): GIVE THE COMPARISON A GENUINELY INDEPENDENT, NON-VOLATILE BASIS.
   One exists, and it is in the record already. union_eco_ledger stores
   eco_base, eco_rate and eco_amount side by side, all three NOT NULL, and the
   producer's definition of the amount is, verbatim from
   fn_union_pnl_evidence_report:

     'eco_amount', CASE WHEN v_terms_value->'eco_enabled'='true'::jsonb
       THEN round(-(v_terms_value->>'eco_rate')::numeric*eco_base,2) ELSE 0 END

   So round(-eco_rate * eco_base, 2) = eco_amount is an invariant OF THE
   RECORD. Checking it reads three stored numerics, recomputes nothing about
   the week, takes no new snapshot, and cannot move between calls. It holds on
   all 14 rows union_eco_ledger carries on production today (verified
   2026-09-25, every row exact to the cent). And it is the check the rehearsal's
   tamper needed: a mutated eco_amount no longer matches its own base and rate.

   NOTHING IS WEAKENED. The two arms that CAN fire are kept, restructured but
   behaviourally identical, under their existing error name so the existing
   fixture assertion still reads:

     - ECO enabled: the document must quote the recorded amount. A tautology
       inside one transaction today; it is the contract fn_union_club_invoice
       is held to, and it fires the day a recomputation returns there.
     - ECO disabled: the document states 0, and no non-zero ECO may be
       recorded for the period. This arm is NOT dead - it is the one live arm
       of the old comparison, and it is why the branch is restructured rather
       than deleted.

   The new refusal is union_squareup_eco_record_fails_its_own_arithmetic. Like
   its neighbours it is raised BEFORE settlement_invoices is written, so a
   square-up that cannot support its own number issues no document.

   NO SECOND PAYER, NO WATCHER, NO REPAIR LOOP, NO HISTORICAL ROW TOUCHED. Both
   parts are refusals added to existing writers. Neither touches the two weeks
   union_settlement_floor puts behind the 2026-09-21T07:00Z floor, and neither
   changes any discovery cursor. */

BEGIN;

-- ===========================================================================
-- PART A -- THE UNION SEND DOOR CREDITS ONE OWNER, OR IT REFUSES
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_union_send_chips_to_club(
  p_union_id uuid,
  p_club_id  uuid,
  p_amount   numeric,
  p_notes    text DEFAULT NULL::text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor         uuid := auth.uid();
  v_union_balance numeric;
  v_union_after   numeric;
  v_owner_user_id uuid;
  v_owner_rows    integer;
  v_owner_before  numeric;
  v_op            text;
  v_key           text;
BEGIN
  -- 1. Validate amount
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'union_send_amount_must_be_positive' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('union_id', p_union_id, 'club_id', p_club_id,
                                  'amount', p_amount)::text;
  END IF;

  /* 2. AUTHORIZATION. The house pattern: the engine and every server-side job
        (fn_caller_is_engine), or the union's own owner. fn_execute_union_rakeback
        and fn_union_fund_promo_from_bank gate the union's money this way; this
        door had no check of any kind. */
  IF NOT public.fn_caller_is_engine() THEN
    IF v_actor IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.unions u
                       WHERE u.id = p_union_id AND u.owner_id = v_actor) THEN
      RAISE EXCEPTION 'union_send_not_authorized' USING ERRCODE = '42501',
        DETAIL = jsonb_build_object('union_id', p_union_id, 'club_id', p_club_id)::text,
        HINT   = 'Only the union owner or a server-side caller may send union chips to a club.';
    END IF;
  END IF;

  -- The club must be in THIS union. fn_union_send_to_club_atomic's check.
  IF NOT EXISTS (SELECT 1 FROM public.union_clubs uc
                  WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id) THEN
    RAISE EXCEPTION 'union_send_club_not_in_union' USING ERRCODE = '23514',
      DETAIL = jsonb_build_object('union_id', p_union_id, 'club_id', p_club_id)::text;
  END IF;

  /* 3. IDEMPOTENCY KEY, declared by the caller and never invented here. The
        four-argument signature is pinned by the closed-door law test and cannot
        grow a fifth parameter without creating an overload that PUBLIC could
        execute, so the operation id arrives on a transaction-scoped setting.
        gen_random_uuid() would make every retry a second payment. */
  v_op := NULLIF(current_setting('app.union_send_chips_op_id', true), '');
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'union_send_requires_operation_id' USING ERRCODE = '23514',
      DETAIL = jsonb_build_object('union_id', p_union_id, 'club_id', p_club_id,
                                  'amount', p_amount)::text,
      HINT   = 'SET LOCAL app.union_send_chips_op_id = ''<operation uuid>''; a repeat of the same operation is then refused by ux_chip_ledger_idempotency_key.';
  END IF;
  v_key := 'union_send_chips_to_club:' || v_op;

  /* 4. THE ONE OWNER, resolved from clubs.owner_id - the authoritative single
        owner that trg_club_owner_has_a_player_wallet keeps a member row for -
        and refused outright when club_members disagrees. */
  SELECT c.owner_id INTO v_owner_user_id
    FROM public.clubs c
   WHERE c.id = p_club_id AND c.is_union IS NOT TRUE;
  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'union_send_club_owner_not_recorded' USING ERRCODE = '23514',
      DETAIL = jsonb_build_object('union_id', p_union_id, 'club_id', p_club_id)::text;
  END IF;

  SELECT count(*) INTO v_owner_rows
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.role = 'owner';
  IF v_owner_rows <> 1
     OR NOT EXISTS (SELECT 1 FROM public.club_members cm
                     WHERE cm.club_id = p_club_id
                       AND cm.user_id = v_owner_user_id
                       AND cm.role = 'owner') THEN
    RAISE EXCEPTION 'union_send_club_owner_is_ambiguous' USING ERRCODE = '23514',
      DETAIL = jsonb_build_object('union_id', p_union_id, 'club_id', p_club_id,
                                  'clubs_owner_id', v_owner_user_id,
                                  'owner_member_rows', v_owner_rows)::text,
      HINT   = 'A union distribution is paid to exactly one owner. Resolve the club''s ownership before sending chips.';
  END IF;

  -- 5. Lock + check the union wallet balance
  SELECT chip_balance INTO v_union_balance
    FROM public.union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_union_balance IS NULL THEN
    RAISE EXCEPTION 'Union wallet not found for union %', p_union_id;
  END IF;
  IF v_union_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient union chip balance. Available: %, Requested: %',
      v_union_balance, p_amount;
  END IF;

  SELECT COALESCE(cm.chip_balance, 0) INTO v_owner_before
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_owner_user_id
     FOR UPDATE;

  /* 6. Declare the route and stand BOTH anonymous journals down. This function
        writes its own leg below, with the key, the club and the balances that
        only it knows - the one autoskip contract fn_settle_accounting_rakeback
        _stage and fn_union_send_to_club_atomic both use. */
  PERFORM public.fn_ca_declare_ledger('union_send', 'union_bank', p_union_id, NULL,
    v_key, ARRAY['union_wallets', 'club_members']);

  -- 7. Atomic: debit the union wallet ONCE
  UPDATE public.union_wallets
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE union_id = p_union_id
   RETURNING chip_balance INTO v_union_after;

  -- 8. Atomic: credit EXACTLY the one resolved owner, by user_id
  UPDATE public.club_members
     SET chip_balance = COALESCE(chip_balance, 0) + p_amount
   WHERE club_id = p_club_id AND user_id = v_owner_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'union_send_club_owner_is_ambiguous' USING ERRCODE = '23514',
      DETAIL = jsonb_build_object('union_id', p_union_id, 'club_id', p_club_id,
                                  'clubs_owner_id', v_owner_user_id,
                                  'owner_member_rows', 0)::text;
  END IF;

  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_club_members', '', true);

  /* 9. ONE journal leg, keyed on the operation, naming the receiving club the
        way atomic_distribute_rake and fn_settle_tournament_rake name theirs. A
        repeat of the same operation violates ux_chip_ledger_idempotency_key and
        aborts the whole transfer, which is what makes the key a guard. */
  INSERT INTO public.chip_ledger (
    performed_by, from_type, from_entity_id, to_type, to_entity_id,
    amount, category, club_id, union_id, description, notes, idempotency_key,
    pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
  VALUES (
    COALESCE(v_actor, '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'union_bank', p_union_id, 'player_wallet', v_owner_user_id,
    p_amount, 'union_send', p_club_id, p_union_id,
    'Union chip distribution to the club owner (fn_union_send_chips_to_club)',
    COALESCE(NULLIF(p_notes, ''), 'Union chip distribution'), v_key,
    v_union_balance, v_union_after, v_owner_before, v_owner_before + p_amount);

  /* 10. The existing union audit row (BUG 011 FIX - was union_transactions),
        with the wallet named the way the CHECK permits. wallet='main' is not in
        union_wallet_transactions_wallet_check and never was, so this INSERT
        aborted every call this door ever received - see the header. The column
        that moved is union_wallets.chip_balance, which is what
        fn_union_send_to_club_atomic and fn_union_fund_promo_from_bank record. */
  INSERT INTO public.union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes
  ) VALUES (
    p_union_id, 'chip_balance', 'debit', p_amount, v_union_after, 'send_to_club',
    p_club_id, COALESCE(p_notes, 'Union chip distribution')
  );

  RETURN TRUE;
END;
$function$;

/* The door stays CLOSED. 20260903201301 revoked it from every role after
   finding zero callers and zero rows in 30 days, registered it `closed` in
   ca_money_rpc_registry, and fn_ca_money_rpc_drift raises an incident if anon,
   authenticated or service_role regains a key. CREATE OR REPLACE preserves the
   ACL; this restates the revoke so the guarded body above is not mistaken for
   an invitation to call it. Verified on production 2026-09-25: proacl is
   {postgres=X/postgres}. */
REVOKE ALL ON FUNCTION public.fn_union_send_chips_to_club(uuid, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_union_send_chips_to_club(uuid, uuid, numeric, text) IS
  'CLOSED money door (20260903201301: zero callers, zero rows). Union bank -> the '
  'ONE club owner resolved from clubs.owner_id, refusing an ambiguous owner. '
  'Requires fn_caller_is_engine() or the union owner, an operation id on '
  'app.union_send_chips_op_id, and writes one keyed chip_ledger leg naming the '
  'receiving club. The live union-to-club route is fn_union_send_to_club_atomic '
  '(union_bank -> clubs.chip_treasury).';

-- ===========================================================================
-- PART B -- THE SQUARE-UP CHECKS THE ECO RECORD'S OWN ARITHMETIC
-- ===========================================================================
DO $inv$
DECLARE
  v_src text; v_new text; v_anchor text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_issue_weekly_invoices';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_union_issue_weekly_invoices is not installed' USING ERRCODE = '55000';
  END IF;

  IF position('union_squareup_eco_record_fails_its_own_arithmetic' in v_src) > 0 THEN
    RAISE NOTICE 'fn_union_issue_weekly_invoices already checks the ECO record arithmetic; skipping';
  ELSE
    -- The two new locals go beside the ones 20260921023420 added.
    v_anchor := '  v_recorded_eco numeric;' || E'\n' ||
                '  v_eco_recorded boolean;';
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the ECO declaration anchor appears % times in fn_union_issue_weekly_invoices, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_src, v_anchor,
      v_anchor || E'\n' ||
      '  v_recorded_base numeric;' || E'\n' ||
      '  v_recorded_rate numeric;');

    -- The record is read once; take its base and rate in the same statement.
    v_anchor := '    SELECT l.eco_amount INTO v_recorded_eco' || E'\n' ||
                '      FROM union_eco_ledger l' || E'\n' ||
                '     WHERE l.union_id = p_union_id AND l.club_id = r.club_id' || E'\n' ||
                '       AND l.period_start = v_from AND l.period_end = v_to;';
    v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the recorded-ECO read anchor appears % times in fn_union_issue_weekly_invoices, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_new, v_anchor,
      '    SELECT l.eco_amount, l.eco_base, l.eco_rate' || E'\n' ||
      '      INTO v_recorded_eco, v_recorded_base, v_recorded_rate' || E'\n' ||
      '      FROM union_eco_ledger l' || E'\n' ||
      '     WHERE l.union_id = p_union_id AND l.club_id = r.club_id' || E'\n' ||
      '       AND l.period_start = v_from AND l.period_end = v_to;');

    /* The tautological comparison becomes three checks, one of which is new and
       can actually fire. Nothing here reads fn_union_eco_adjustment,
       fn_union_pnl_qualified_clubs or fn_union_pnl_evidence_report: the
       2026-09-14 overstatement came from exactly that recomputation and is not
       coming back. */
    v_anchor := '    IF round(COALESCE(r.eco_amount, 0), 2)' || E'\n' ||
                '       IS DISTINCT FROM round(COALESCE(v_recorded_eco, 0), 2) THEN' || E'\n' ||
                '      RAISE EXCEPTION ''union_squareup_eco_disagrees_with_record'' USING ERRCODE = ''23514'',' || E'\n' ||
                '        DETAIL = jsonb_build_object(''union_id'', p_union_id, ''club_id'', r.club_id,' || E'\n' ||
                '          ''period_start'', v_from, ''period_end'', v_to,' || E'\n' ||
                '          ''stated_eco'', r.eco_amount, ''recorded_eco'', v_recorded_eco)::text;' || E'\n' ||
                '    END IF;';
    v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the ECO comparison anchor appears % times in fn_union_issue_weekly_invoices, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_new, v_anchor,
      '    /* THE RECORD ANSWERS FOR ITS OWN ARITHMETIC (2026-09-25). The' || E'\n' ||
      '       comparison below it - the document against union_eco_ledger - is' || E'\n' ||
      '       the record against itself since 20260921040847 taught' || E'\n' ||
      '       fn_union_club_invoice to RETURN the recorded amount, and a' || E'\n' ||
      '       rehearsal proved it silent while a recorded value was mutated by' || E'\n' ||
      '       0.01. The independent basis is IN the record: eco_base, eco_rate' || E'\n' ||
      '       and eco_amount are stored side by side, all NOT NULL, and the' || E'\n' ||
      '       producer defines the amount as round(-eco_rate*eco_base,2)' || E'\n' ||
      '       (fn_union_pnl_evidence_report). Three stored numerics, no' || E'\n' ||
      '       recomputation of the week, no second snapshot - so this can fire' || E'\n' ||
      '       without resurrecting the 2026-09-14 overstatement that a second' || E'\n' ||
      '       VOLATILE recomputation caused. The two arms below it are kept and' || E'\n' ||
      '       are not weakened: the ECO-disabled arm is the one arm of the old' || E'\n' ||
      '       comparison that could always fire. */' || E'\n' ||
      '    IF r.eco_enabled AND v_eco_recorded' || E'\n' ||
      '       AND (v_recorded_base IS NULL OR v_recorded_rate IS NULL' || E'\n' ||
      '            OR round(-v_recorded_rate * v_recorded_base, 2)' || E'\n' ||
      '               IS DISTINCT FROM round(COALESCE(v_recorded_eco, 0), 2)) THEN' || E'\n' ||
      '      RAISE EXCEPTION ''union_squareup_eco_record_fails_its_own_arithmetic'' USING ERRCODE = ''23514'',' || E'\n' ||
      '        DETAIL = jsonb_build_object(''union_id'', p_union_id, ''club_id'', r.club_id,' || E'\n' ||
      '          ''period_start'', v_from, ''period_end'', v_to,' || E'\n' ||
      '          ''recorded_eco'', v_recorded_eco, ''recorded_base'', v_recorded_base,' || E'\n' ||
      '          ''recorded_rate'', v_recorded_rate,' || E'\n' ||
      '          ''base_times_rate'', round(-v_recorded_rate * v_recorded_base, 2))::text,' || E'\n' ||
      '        HINT = ''union_eco_ledger.eco_amount must equal round(-eco_rate*eco_base,2). A record that does not support its own figure cannot be invoiced.'';' || E'\n' ||
      '    END IF;' || E'\n' ||
      '    IF round(COALESCE(r.eco_amount, 0), 2)' || E'\n' ||
      '       IS DISTINCT FROM round(COALESCE(v_recorded_eco, 0), 2) THEN' || E'\n' ||
      '      RAISE EXCEPTION ''union_squareup_eco_disagrees_with_record'' USING ERRCODE = ''23514'',' || E'\n' ||
      '        DETAIL = jsonb_build_object(''union_id'', p_union_id, ''club_id'', r.club_id,' || E'\n' ||
      '          ''period_start'', v_from, ''period_end'', v_to,' || E'\n' ||
      '          ''stated_eco'', r.eco_amount, ''recorded_eco'', v_recorded_eco)::text;' || E'\n' ||
      '    END IF;' || E'\n' ||
      '    IF NOT r.eco_enabled AND round(COALESCE(v_recorded_eco, 0), 2) <> 0 THEN' || E'\n' ||
      '      RAISE EXCEPTION ''union_squareup_eco_disagrees_with_record'' USING ERRCODE = ''23514'',' || E'\n' ||
      '        DETAIL = jsonb_build_object(''union_id'', p_union_id, ''club_id'', r.club_id,' || E'\n' ||
      '          ''period_start'', v_from, ''period_end'', v_to,' || E'\n' ||
      '          ''stated_eco'', r.eco_amount, ''recorded_eco'', v_recorded_eco,' || E'\n' ||
      '          ''eco_enabled'', false)::text;' || E'\n' ||
      '    END IF;');

    IF v_new = v_src THEN
      RAISE EXCEPTION 'the ECO record arithmetic substitution produced no change' USING ERRCODE = '55000';
    END IF;
    EXECUTE v_new;
  END IF;
END
$inv$;

-- ===========================================================================
-- STEP C -- READBACK ASSERTIONS, INSIDE THE SAME TRANSACTION
-- ===========================================================================
DO $check$
DECLARE v_src text; v_acl text;
BEGIN
  SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl::text, '')
    INTO v_src, v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_send_chips_to_club';

  -- The minting UPDATE is gone and the credit is by user_id.
  IF position('WHERE club_id = p_club_id AND user_id = v_owner_user_id' in v_src) = 0 THEN
    RAISE EXCEPTION 'the union send door does not credit one resolved owner' USING ERRCODE = '55000';
  END IF;
  -- The old minting UPDATE ended on this exact unqualified predicate. Every
  -- role='owner' read in the new body is qualified (cm.role), so this is zero.
  IF position('AND role = ''owner''' in v_src) > 0 THEN
    RAISE EXCEPTION 'the union send door still credits every owner row' USING ERRCODE = '55000';
  END IF;
  -- The three guards.
  IF position('fn_caller_is_engine()' in v_src) = 0
     OR position('union_send_not_authorized' in v_src) = 0 THEN
    RAISE EXCEPTION 'the union send door carries no authorization check' USING ERRCODE = '55000';
  END IF;
  IF position('app.union_send_chips_op_id' in v_src) = 0
     OR position('union_send_requires_operation_id' in v_src) = 0
     OR position('idempotency_key' in v_src) = 0 THEN
    RAISE EXCEPTION 'the union send door carries no idempotency key' USING ERRCODE = '55000';
  END IF;
  IF position('INSERT INTO public.chip_ledger' in v_src) = 0
     OR position('''union_send'', p_club_id, p_union_id' in v_src) = 0 THEN
    RAISE EXCEPTION 'the union send door writes no club-declaring chip_ledger leg' USING ERRCODE = '55000';
  END IF;
  -- And its own audit row can be written: the wallet it names is one the CHECK
  -- permits. wallet='main' aborted every call this door ever received.
  IF position('''main'', ''debit''' in v_src) > 0 THEN
    RAISE EXCEPTION 'the union send door still records its audit row against wallet=main' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.union_wallet_transactions'::regclass
                    AND conname = 'union_wallet_transactions_wallet_check'
                    AND pg_get_constraintdef(oid) LIKE '%''chip_balance''%') THEN
    RAISE EXCEPTION 'union_wallet_transactions_wallet_check does not permit chip_balance' USING ERRCODE = '55000';
  END IF;
  -- And it is still closed to every client role: this is the invariant
  -- fn_ca_money_rpc_drift raises on, restated where the change is made.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) g(role)
              WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g.role)
                AND has_function_privilege(g.role,
                      'public.fn_union_send_chips_to_club(uuid,uuid,numeric,text)'::regprocedure,
                      'EXECUTE')) THEN
    RAISE EXCEPTION 'the closed union send door is executable by a client role again (acl %)', v_acl
      USING ERRCODE = '55000';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE oid = 'public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure;
  IF position('union_squareup_eco_record_fails_its_own_arithmetic' in v_src) = 0
     OR position('union_squareup_eco_not_recorded' in v_src) = 0
     OR position('union_squareup_eco_disagrees_with_record' in v_src) = 0
     OR position('union_squareup_eco_record_fails_its_own_arithmetic' in v_src)
        > position('INSERT INTO settlement_invoices' in v_src) THEN
    RAISE EXCEPTION 'the square-up refusals are not all in place before the document is written' USING ERRCODE = '55000';
  END IF;
  -- The volatile recomputation is NOT back in the writer's ECO check. The
  -- writer still calls fn_union_eco_adjustment ONCE, for baseline_cash_exact,
  -- before the loop; the ECO refusals read only union_eco_ledger.
  IF (length(v_src) - length(replace(v_src, 'fn_union_eco_adjustment', '')))
     / length('fn_union_eco_adjustment') <> 1 THEN
    RAISE EXCEPTION 'the ECO check reads a volatile recomputation again' USING ERRCODE = '55000';
  END IF;

  -- Every ECO already recorded satisfies the new invariant, so no settled or
  -- pending week is newly refused by this migration.
  IF EXISTS (SELECT 1 FROM public.union_eco_ledger l
              WHERE round(-l.eco_rate * l.eco_base, 2) IS DISTINCT FROM round(l.eco_amount, 2)) THEN
    RAISE EXCEPTION 'a recorded ECO row does not satisfy round(-eco_rate*eco_base,2) = eco_amount' USING ERRCODE = '55000';
  END IF;
END
$check$;

COMMIT;
