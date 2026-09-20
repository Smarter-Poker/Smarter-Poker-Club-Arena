/* THE JOURNAL LEG NAMES THE CLUB THE PRIZE LANDED IN (2026-09-20)

   ==========================================================================
   DO NOT APPLY THIS FILE FROM THE outputs/ FOLDER.
   Reserve a version first (CLAUDE.md 4.5, BINDING - never hand-pick one):

       node scripts/new-migration.mjs "the journal leg names the club the prize landed in"

   then paste this body into the file it creates under supabase/migrations/.

   WHEN: not between :50 and :03 UTC. Two reasons, both of which abort the
   whole transaction and write nothing:
     - ca_break_window_refuses_ddl refuses the two CREATE OR REPLACEs
       (production DDL policy rule 8);
     - zz_freeze_guard on chip_ledger refuses STEP 2's UPDATE with SQLSTATE
       55006 while fn_platform_frozen() is true (:55-:00). This migration
       asserts that up front so the failure names itself.
   ==========================================================================

   WHAT WAS WRONG

   fn_chip_integrity_report's drift_since_baseline check reported one member
   adrift and climbing. It was not a lost chip. Nobody was short and nobody
   was over - the meter was blind.

   fn_chip_drift_since_baseline compares a member's BALANCE against the
   MOVEMENTS that should explain it:

       moves AS (... FROM public.chip_ledger cl, span
                 WHERE cl.club_id IS NOT NULL      <-- here
                   AND cl.created_at >= span.t0
                   AND (cl.to_type = 'player_wallet' OR cl.from_type = 'player_wallet')
                 GROUP BY cl.club_id, <player>)

   A ledger row with club_id IS NULL is invisible to that CTE while the
   credit it describes is fully visible in club_members.chip_balance. The
   difference is reported as drift.

   Union-hosted diamond-game prizes are paid by fn_diamond_game_pay_chips.
   It declares ARRAY['club_members'] as ledger autoskip, so the leg the
   fn_ca_autoledger trigger actually journals is the HOST debit - and for a
   union host that is public.union_wallets. fn_ca_autoledger derives the club
   from the row it is journalling:

       v_club := CASE
         WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
         WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
         ELSE NULL END;

   union_wallets has no club_id column, so the ELSE is taken and every such
   leg was written club-less. (A CLUB-hosted diamond game debits public.clubs
   and is caught by the first WHEN, which is why only union-hosted games
   produced this.)

   MEASURED ON PRODUCTION, 2026-09-20

     18:07 UTC   12 rows / 75.08 club-less, backfilled by hand
     19:07 UTC    3 rows / 100.50 club-less again - the writer had kept going
     19:14 UTC   fn_chip_integrity_report drift_since_baseline: 1 member,
                 worst 100.50, severity critical
     affected    club a41434bb-8d0c-400a-8f0d-e8b3d65afed4
                 user 47965354-0e56-43ef-931c-ddaab82af765
     categories  wheel_prize (2), crossing_prize (1) - the category is
                 whatever the game declares, so plinko/crash/mines and every
                 future diamond game share the defect; it is not per-game.

   The hand backfill was the band-aid law 10.11/10.12 forbids: it repaired
   the rows and left the writer producing more. This changes the writer.

   THE FIX (two functions, one transaction)

   1. fn_diamond_game_pay_chips SAYS which club the prize landed in, on a
      transaction-scoped GUC, cleared in the same block that already clears
      the autoskips.
   2. fn_ca_autoledger reads it as the ELSE of the club CASE.

   THE GUC IS app.ledger_autoledger_club_id, NOT app.ledger_club_id.

   This is a deliberate correction to the obvious design and it matters.
   app.ledger_club_id ALREADY EXISTS and is load-bearing for MONEY, not for
   a meter. Six functions reference it:

     SET by   fn_close_settlement_period        (rakeback close)
              fn_process_credit_invoice_payment (saves and restores it)
     READ by  atomic_credit_wallet_and_log      - decides which club wallet a
                                                  rakeback payout is paid INTO
              atomic_deduct_wallet_and_log      - decides which club a debit
                                                  is charged AGAINST
              log_wallet_transaction            - decides which club a
                                                  tournament entry receipt
                                                  names
              fn_player_spendable_balance       (documents the same contract)

   Borrowing that name would have been wrong twice over:
     - INBOUND: fn_close_settlement_period sets it to the rakeback period's
       club for the duration of the credit. Any union_wallets or unions write
       later in that same transaction would then be stamped with a club that
       has nothing to do with it - an invented attribution, exactly the class
       of defect CLAUDE.md 10.5 was written about.
     - OUTBOUND: fn_diamond_game_pay_chips would clear it to '' at the end of
       its block. fn_process_credit_invoice_payment saves and RESTORES the
       previous value precisely because these calls nest, so clearing it
       would change which club a later atomic_credit_wallet_and_log pays
       into. That moves somebody's money.

   app.ledger_autoledger_club_id is referenced by nothing in the database
   (verified: 0 of 3,713-migration-deep pg_proc bodies mention it). Its blast
   radius is therefore exactly the ELSE branch changed below.

   BLAST RADIUS OF THE ELSE BRANCH

   fn_ca_autoledger is the trigger function behind 11 triggers on 8 tables:
   agents, bbj_pools, club_members, club_wallets, clubs, spin_bonus_pools,
   union_wallets, unions.

   The ELSE is reachable from exactly TWO of them. `nn ? 'club_id'` is key
   EXISTENCE on to_jsonb(NEW), and a column that exists but is NULL still
   produces the key - so any table WITH a club_id column takes the second
   WHEN and never reaches the ELSE, NULL value or not. Only union_wallets and
   unions have no club_id column at all, and clubs is caught by the first
   WHEN. STEP 1.0 asserts that set is still exactly {union_wallets, unions};
   if a ninth table is ever autoledgered without a club_id column this
   migration refuses rather than silently widening.

   IF THE GUC LEAKED: a union_wallets or unions leg journalled later in the
   same transaction would carry the diamond payout's club. It cannot leak
   here - it is set with is_local = true (transaction-scoped, rolled back
   with any abort) and cleared beside the autoskips it mirrors, which carry
   that same warning in their existing comment. The read is wrapped in an
   exception guard, copying how cpid is read three lines above it, so a
   malformed value returns NULL instead of aborting a live chip movement.

   THE BACKFILL, AND WHY THE APPEND-ONLY GUARD ADMITS IT

   The rows already written club-less are corrected in STEP 2. This is an
   attribution correction, not a restatement of history, and three separate
   mechanisms were read to confirm the journal's own guards agree:

   1. fn_ca_journal_append_only's allowed-update list for chip_ledger pins
      amount, from_type, from_entity_id, to_type, to_entity_id, category,
      created_at, chain_seq, prev_hash, row_hash, idempotency_key,
      correlation_id, settlement_id and epoch_id. club_id is NOT in it, so
      the UPDATE takes the v_allowed_update branch and returns NEW before any
      maintenance, mutation-log or incident logic is reached.

   2. row_hash is not recomputed on UPDATE (fn_ca_chip_ledger_enrich is
      BEFORE INSERT only), and club_id is not in its preimage:
        'v1'|chain_seq|epoch_id|amount|from_type:from_entity_id|
        to_type:to_entity_id|category|idempotency_key|correlation_id|created_at
      So NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash holds, and any
      verifier that recomputes the hash still agrees.

   3. The day manifest (fn_ca_ledger_day_manifest) digests
        id|amount|from_type:from|>to_type:to|category|epoch(created_at)|row_hash
      The string 'club_id' does not occur anywhere in that function's source.
      There is also no manifest row for 2026-09-20 (newest is 2026-09-19).
      fn_ca_attested_day_is_restated returns NULL immediately unless
      app.ledger_maintenance is set, and this migration does not set it -
      STEP 2.0 asserts it is unset, so no spurious restatement or
      unauthorized_adjustment incident is raised for a correction that
      changes no attested value.

      NOTE FOR ANYONE RE-VERIFYING THIS: do NOT assert whole-day digest
      stability. Measured 2026-09-20, the 2026-09-20 digest changes between
      two snapshots two seconds apart WITH NO WRITE AT ALL - 12 legs landed
      in that gap on a ~100,600-leg day. STEP 2.4 therefore asserts the
      digest over the FIXED set of affected row ids, which concurrent inserts
      cannot touch.

   The other four BEFORE UPDATE guards on chip_ledger
   (fn_terminal_tournament_evidence_is_immutable,
    fn_cancelled_tournament_evidence_is_immutable,
    fn_satellite_transfer_ledger_is_immutable,
    fn_accounting_tournament_recognized_evidence_immutable)
   all return early for a row with no tournament identity. STEP 2.1 asserts
   every affected row is clean for all four rather than trusting it.

   PROVED BEFORE IT WAS WRITTEN

   The substitution anchors and the whole of STEP 2 were executed on
   production inside a single transaction that ended in RAISE EXCEPTION
   (CLAUDE.md 11.5 rule 1), so nothing committed. It returned:

     anchors a=1 b=1 c=1 d=1
     else_branch_tables=[union_wallets,unions]
     clubless_before=3 sum=100.50
     drifting_before club=a41434bb... user=47965354... amt=100.50
     updated=3  clubless_after=0
     drift_rows_after=0  worst_after=0.00

   NOT A REPAIR JOB (10.12). Nothing here is scheduled, nothing sweeps and
   nothing re-runs. The line that produced the wrong outcome is the line that
   changes; the rows it already wrote are corrected once, in the same
   transaction, after the writer is fixed so the set cannot grow underneath
   it.

   FOLLOW-UP REQUIRED, NOT IN THIS MIGRATION (10.11 rule 4): a law test
   pinning that every autoledgered table without a club_id column is covered
   by a declaring payer, so the next club-less money table cannot reopen
   this. */

BEGIN;

-- Fail fast rather than queue behind a live writer. The DDL touches two
-- pg_proc rows and the DML touches a handful of chip_ledger rows, but a
-- migration that can wedge the estate is worse than the bug it fixes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';


-- ===========================================================================
-- STEP 1 -- THE ROOT FIX
-- ===========================================================================
DO $mig$
DECLARE
  v_src text; v_new text; v_chk text;
  v_a text; v_b text; v_c text; v_d text; v_rep text;
  v_n int;
  v_else_tables text;
  v_oid oid; v_secdef boolean; v_config text; v_owner text; v_acl text; v_trg int;
  v_oid2 oid; v_secdef2 boolean; v_config2 text; v_owner2 text; v_acl2 text; v_trg2 int;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  -------------------------------------------------------------------------
  -- 1.0  THE ELSE BRANCH IS STILL ONLY REACHABLE FROM union_wallets/unions
  --
  -- `nn ? 'club_id'` is key existence, and to_jsonb(NEW) emits a key for a
  -- NULL column, so every autoledgered table that HAS the column takes the
  -- second WHEN. If a new club-less money table has been autoledgered since
  -- this was written, the ELSE now means something wider than it did and
  -- this edit must be re-reasoned rather than applied.
  -------------------------------------------------------------------------
  SELECT string_agg(t.tbl, ',' ORDER BY t.tbl) INTO v_else_tables
  FROM (SELECT DISTINCT c.relname AS tbl
          FROM pg_trigger tg
          JOIN pg_class c ON c.oid = tg.tgrelid
          JOIN pg_proc  p ON p.oid = tg.tgfoid
         WHERE p.proname = 'fn_ca_autoledger' AND NOT tg.tgisinternal
           AND c.relname <> 'clubs'
           AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                            WHERE a.attrelid = c.oid AND a.attname = 'club_id'
                              AND a.attnum > 0 AND NOT a.attisdropped)) t;
  IF COALESCE(v_else_tables, '') <> 'union_wallets,unions' THEN
    RAISE EXCEPTION
      'the autoledger ELSE branch is reachable from [%] but this migration was written for exactly [union_wallets,unions]. Re-derive the blast radius before applying.',
      COALESCE(v_else_tables, '<none>') USING ERRCODE = '55000';
  END IF;

  -- Snapshot every guarantee that must survive CREATE OR REPLACE on a
  -- SECURITY DEFINER trigger function that sits on eight money tables.
  SELECT p.oid, p.prosecdef, COALESCE(p.proconfig::text,''), pg_get_userbyid(p.proowner),
         COALESCE(p.proacl::text,''),
         (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal)
    INTO v_oid, v_secdef, v_config, v_owner, v_acl, v_trg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_autoledger';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'fn_ca_autoledger not found'; END IF;
  IF v_trg <> 11 THEN
    RAISE EXCEPTION 'fn_ca_autoledger backs % triggers, expected 11 - the journal wiring changed', v_trg
      USING ERRCODE = '55000';
  END IF;

  SELECT p.oid, p.prosecdef, COALESCE(p.proconfig::text,''), pg_get_userbyid(p.proowner),
         COALESCE(p.proacl::text,''), 0
    INTO v_oid2, v_secdef2, v_config2, v_owner2, v_acl2, v_trg2
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_game_pay_chips';
  IF v_oid2 IS NULL THEN RAISE EXCEPTION 'fn_diamond_game_pay_chips not found'; END IF;

  -------------------------------------------------------------------------
  -- 1.1  THE PAYER SAYS WHICH CLUB THE PRIZE LANDED IN
  -------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_game_pay_chips';

  IF position('app.ledger_autoledger_club_id' in v_src) > 0 THEN
    RAISE NOTICE 'fn_diamond_game_pay_chips already declares its club; skipping';
  ELSE
    -- Anchor C: the two lines that latch the cover, immediately before the
    -- promo and bank blocks. One declaration covers both legs.
    v_c := '  promo_after := v_lock.o_promo;' || E'\n' ||
           '  bank_after  := v_lock.o_bank;';
    v_n := (length(v_src) - length(replace(v_src, v_c, ''))) / length(v_c);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the cover latch appears % times in fn_diamond_game_pay_chips, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n
        USING ERRCODE = '55000';
    END IF;

    -- Anchor D: the existing transaction-scoped clear block.
    v_d := '  PERFORM set_config(''app.ledger_idempotency_key'', '''', true);';
    v_n := (length(v_src) - length(replace(v_src, v_d, ''))) / length(v_d);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the idempotency-key clear appears % times in fn_diamond_game_pay_chips, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;

    v_rep := v_c || E'\n' ||
      '' || E'\n' ||
      '  /* THE JOURNAL LEG NAMES THE CLUB THE PRIZE LANDED IN (2026-09-20).' || E'\n' ||
      '     club_members is autoskipped below, so the leg fn_ca_autoledger' || E'\n' ||
      '     actually journals is the HOST debit - and for a union host that is' || E'\n' ||
      '     union_wallets, which has no club_id column. Every union-hosted prize' || E'\n' ||
      '     was therefore journalled club-less, and fn_chip_drift_since_baseline' || E'\n' ||
      '     filters movements on club_id IS NOT NULL while counting the balance' || E'\n' ||
      '     they explain: 15 correctly paid prizes read as 175.58 of member' || E'\n' ||
      '     drift. The prize lands in p_club. Say so.' || E'\n' ||
      '     NOT app.ledger_club_id: that name decides which club a WALLET' || E'\n' ||
      '     credit is paid into (atomic_credit_wallet_and_log) and is set and' || E'\n' ||
      '     restored by the rakeback close. Clearing it here would move money. */' || E'\n' ||
      '  PERFORM set_config(''app.ledger_autoledger_club_id'', COALESCE(p_club::text, ''''), true);';

    v_new := replace(v_src, v_c, v_rep);
    IF v_new = v_src THEN RAISE EXCEPTION 'declaration substitution produced no change'; END IF;

    -- Clear it with the autoskips. Left set, a later union_wallets or unions
    -- write in this transaction would inherit this payout's club.
    v_new := replace(v_new, v_d,
      v_d || E'\n' ||
      '  PERFORM set_config(''app.ledger_autoledger_club_id'', '''', true);');

    v_n := (length(v_new) - length(replace(v_new, 'app.ledger_autoledger_club_id', '')))
           / length('app.ledger_autoledger_club_id');
    -- Exactly two: the declaration and its clear. (The comment names the
    -- OTHER GUC, app.ledger_club_id, which is not a substring of this one.)
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'expected the new fn_diamond_game_pay_chips to name the GUC twice (set, clear), found %', v_n
        USING ERRCODE = '55000';
    END IF;
    IF md5(v_new) = md5(v_src) THEN RAISE EXCEPTION 'fn_diamond_game_pay_chips definition did not change'; END IF;

    EXECUTE v_new;
  END IF;

  -------------------------------------------------------------------------
  -- 1.2  THE AUTOLEDGER LISTENS
  -------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_autoledger';

  IF position('app.ledger_autoledger_club_id' in v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_autoledger already reads the declared club; skipping';
  ELSE
    -- Anchor A: the declaration line. v_guc_club is read through an
    -- exception guard, so it needs a variable; a CASE arm cannot carry one.
    v_a := '  v_club uuid; v_union uuid; v_entity uuid;';
    v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the autoledger DECLARE line appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n
        USING ERRCODE = '55000';
    END IF;

    -- Anchor B: the whole club CASE. The block is replaced entire rather
    -- than by its ELSE arm, because `ELSE NULL END;` also terminates the
    -- v_union CASE four lines below and would match twice.
    v_b := '  v_club := CASE' || E'\n' ||
           '    WHEN TG_TABLE_NAME = ''clubs'' THEN (nn->>''id'')::uuid' || E'\n' ||
           '    WHEN nn ? ''club_id'' THEN NULLIF(nn->>''club_id'','''')::uuid' || E'\n' ||
           '    ELSE NULL END;';
    v_n := (length(v_src) - length(replace(v_src, v_b, ''))) / length(v_b);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the autoledger club CASE appears % times, expected exactly 1', v_n
        USING ERRCODE = '55000';
    END IF;

    v_new := replace(v_src, v_a,
      '  v_club uuid; v_union uuid; v_entity uuid; v_guc_club uuid;');
    IF v_new = v_src THEN RAISE EXCEPTION 'autoledger DECLARE substitution produced no change'; END IF;

    v_rep :=
      '  /* THE JOURNAL LEG NAMES THE CLUB THE MONEY LANDED IN (2026-09-20).' || E'\n' ||
      '     union_wallets and unions are the only autoledgered tables with no' || E'\n' ||
      '     club_id column - `nn ? ''club_id''` is key EXISTENCE, so a table' || E'\n' ||
      '     that has the column takes the arm above even when it is NULL. Before' || E'\n' ||
      '     today every leg journalled from those two was written club-less, and' || E'\n' ||
      '     fn_chip_drift_since_baseline filters movements on club_id IS NOT' || E'\n' ||
      '     NULL while counting the balance they explain, so correctly paid' || E'\n' ||
      '     union-hosted prizes were reported as member drift.' || E'\n' ||
      '     A payer that knows the club declares it on' || E'\n' ||
      '     app.ledger_autoledger_club_id, transaction-scoped, and clears it' || E'\n' ||
      '     beside the autoskips. It is deliberately NOT app.ledger_club_id:' || E'\n' ||
      '     that name is taken and decides which club a WALLET credit is paid' || E'\n' ||
      '     into (atomic_credit_wallet_and_log, atomic_deduct_wallet_and_log,' || E'\n' ||
      '     log_wallet_transaction), so borrowing it would let a rakeback' || E'\n' ||
      '     close''s club leak onto a union leg and would move real money when' || E'\n' ||
      '     cleared. Read through an exception guard exactly as cpid is above:' || E'\n' ||
      '     a malformed value must never abort a chip movement. */' || E'\n' ||
      '  BEGIN' || E'\n' ||
      '    v_guc_club := NULLIF(current_setting(''app.ledger_autoledger_club_id'', true), '''')::uuid;' || E'\n' ||
      '  EXCEPTION WHEN OTHERS THEN v_guc_club := NULL;' || E'\n' ||
      '  END;' || E'\n' ||
      '  v_club := CASE' || E'\n' ||
      '    WHEN TG_TABLE_NAME = ''clubs'' THEN (nn->>''id'')::uuid' || E'\n' ||
      '    WHEN nn ? ''club_id'' THEN NULLIF(nn->>''club_id'','''')::uuid' || E'\n' ||
      '    ELSE v_guc_club END;';

    v_new := replace(v_new, v_b, v_rep);

    -- The ELSE arm must now be the declared club, and NULL must no longer be
    -- the club fallback. v_union's own `ELSE NULL END;` is untouched, so
    -- exactly one occurrence of it remains.
    IF position('    ELSE v_guc_club END;' in v_new) = 0 THEN
      RAISE EXCEPTION 'autoledger club CASE substitution did not take';
    END IF;
    v_n := (length(v_new) - length(replace(v_new, '    ELSE NULL END;', '')))
           / length('    ELSE NULL END;');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'expected exactly 1 remaining `ELSE NULL END;` (the union CASE), found %', v_n
        USING ERRCODE = '55000';
    END IF;
    IF md5(v_new) = md5(v_src) THEN RAISE EXCEPTION 'fn_ca_autoledger definition did not change'; END IF;

    EXECUTE v_new;
  END IF;

  -------------------------------------------------------------------------
  -- 1.3  POST-CONDITIONS: EVERY GUARD AROUND THE TRIGGER SURVIVED
  -------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_chk
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_autoledger';
  IF v_chk IS NULL OR position('ELSE v_guc_club END;' in v_chk) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: fn_ca_autoledger does not read the declared club. Nothing written.';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_chk
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_game_pay_chips';
  IF v_chk IS NULL
     OR position('set_config(''app.ledger_autoledger_club_id'', COALESCE(p_club::text' in v_chk) = 0
     OR position('set_config(''app.ledger_autoledger_club_id'', '''', true)' in v_chk) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: fn_diamond_game_pay_chips must both declare AND clear the club. Nothing written.';
  END IF;

  -- CREATE OR REPLACE must not have moved the oid (which would orphan the 11
  -- triggers), nor dropped SECURITY DEFINER, the pinned search_path, the
  -- owner or the grants.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_autoledger'
       AND (p.oid <> v_oid OR p.prosecdef IS DISTINCT FROM v_secdef
            OR COALESCE(p.proconfig::text,'') <> v_config
            OR pg_get_userbyid(p.proowner) <> v_owner
            OR COALESCE(p.proacl::text,'') <> v_acl)) THEN
    RAISE EXCEPTION 'post-condition failed: fn_ca_autoledger lost an identity, security or grant property. Nothing written.';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_oid AND NOT t.tgisinternal) <> 11 THEN
    RAISE EXCEPTION 'post-condition failed: fn_ca_autoledger no longer backs its 11 triggers. Nothing written.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_game_pay_chips'
       AND (p.oid <> v_oid2 OR p.prosecdef IS DISTINCT FROM v_secdef2
            OR COALESCE(p.proconfig::text,'') <> v_config2
            OR pg_get_userbyid(p.proowner) <> v_owner2
            OR COALESCE(p.proacl::text,'') <> v_acl2)) THEN
    RAISE EXCEPTION 'post-condition failed: fn_diamond_game_pay_chips lost an identity, security or grant property. Nothing written.';
  END IF;

  RAISE NOTICE 'the writer now names the club on every union-hosted diamond prize';
END $mig$;


-- ===========================================================================
-- STEP 2 -- THE ROWS ALREADY WRITTEN CLUB-LESS
--
-- Runs AFTER step 1 on purpose: the writer is fixed first, so the set cannot
-- grow underneath the correction. Rows are matched to their club by the
-- union_wallet_transactions receipt written by the SAME statement of the SAME
-- transaction as the ledger leg - identical created_at, union, wallet,
-- amount, post-balance, category and player. That receipt is the witness that
-- was there; nothing is inferred from the player's club memberships (the
-- affected player belongs to four clubs, so a guess would have been wrong
-- three times in four).
-- ===========================================================================
DO $fix$
DECLARE
  v_n bigint; v_sum numeric; v_updated bigint; v_left bigint;
  v_orphans bigint; v_ambiguous bigint; v_unsafe bigint;
  v_ids uuid[];
  v_sha_before text; v_sha_after text;
  v_drift_rows bigint; v_worst numeric;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  -------------------------------------------------------------------------
  -- 2.0  THE TWO CONDITIONS THAT WOULD MAKE THIS WRITE MEAN SOMETHING ELSE
  -------------------------------------------------------------------------
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'the platform is on its scheduled maintenance break; zz_freeze_guard would refuse this UPDATE (55006). Apply after :03 UTC.'
      USING ERRCODE = '55000';
  END IF;
  IF NULLIF(current_setting('app.ledger_maintenance', true), '') IS NOT NULL THEN
    RAISE EXCEPTION
      'app.ledger_maintenance is set to "%". This correction changes no pinned column, so it must take fn_ca_journal_append_only''s allowed-update branch rather than the maintenance branch - which would file a mutation-log row and raise an unauthorized_adjustment incident for a change that alters nothing attested.',
      current_setting('app.ledger_maintenance', true) USING ERRCODE = '55000';
  END IF;

  -------------------------------------------------------------------------
  -- 2.1  WHAT IS AFFECTED, AND THAT EVERY ROW IS SAFE TO CORRECT
  -------------------------------------------------------------------------
  CREATE TEMP TABLE _clubless ON COMMIT DROP AS
  SELECT l.id, l.amount, l.category, l.created_at, l.union_id, l.post_from_balance,
         l.from_label, l.to_entity_id, l.tournament_id, l.from_type, l.idempotency_key,
         l.metadata
    FROM public.chip_ledger l
   WHERE l.club_id IS NULL
     AND l.to_type = 'player_wallet'
     AND l.from_label LIKE 'union_wallets.%'
     AND l.created_at >= (SELECT min(taken_at) FROM public.ca_chip_baseline);

  SELECT count(*), COALESCE(sum(amount), 0) INTO v_n, v_sum FROM _clubless;
  RAISE NOTICE 'club-less union-wallet player legs since the baseline: % rows, % chips', v_n, v_sum;

  IF v_n = 0 THEN
    RAISE NOTICE 'nothing to correct; the writer fix above is the whole change';
    RETURN;
  END IF;

  -- Measured 2026-09-20 19:07 UTC: 3 rows / 100.50, on top of 12 rows / 75.08
  -- already corrected by hand at 18:07. The set can only have GROWN between
  -- then and apply time (the writer was still producing them until step 1),
  -- never shrunk, so a smaller set means somebody else corrected rows in the
  -- meantime and this migration must be re-derived rather than applied blind.
  IF v_n < 3 OR v_sum < 100.50 THEN
    RAISE EXCEPTION
      'expected at least the measured 3 rows / 100.50 chips still club-less, found % rows / %. The board moved; re-measure before applying.',
      v_n, v_sum USING ERRCODE = '55000';
  END IF;

  -- Every one of the four BEFORE UPDATE immutability guards on chip_ledger
  -- returns early only for a row with no tournament identity. Assert it
  -- rather than trust it: a refusal mid-migration is a 55000 nobody can read.
  SELECT count(*) INTO v_unsafe FROM _clubless c
   WHERE c.tournament_id IS NOT NULL
      OR c.from_type = 'prize_liability'
      OR COALESCE(c.idempotency_key,'') LIKE 'tourney:%'
      OR (c.metadata->>'satellite_id') IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.accounting_tournament_fee_recognitions r
                  WHERE r.bank_journal_id = c.id);
  IF v_unsafe > 0 THEN
    RAISE EXCEPTION
      '% club-less leg(s) carry a tournament, satellite or recognized-fee identity. Those are immutable evidence and this migration will not touch them.',
      v_unsafe USING ERRCODE = '55000';
  END IF;

  -- Exactly one witness per row, or we are guessing.
  SELECT count(*) INTO v_orphans FROM _clubless c
   WHERE NOT EXISTS (
     SELECT 1 FROM public.union_wallet_transactions t
      WHERE t.union_id = c.union_id AND t.created_at = c.created_at
        AND t.direction = 'debit' AND t.amount = c.amount
        AND t.balance_after = c.post_from_balance AND t.tx_type = c.category
        AND t.created_by = c.to_entity_id
        AND c.from_label = 'union_wallets.' || t.wallet
        AND t.club_id IS NOT NULL);
  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      '% club-less leg(s) have no union_wallet_transactions receipt naming a club. A club_id is an assertion about where a prize landed and will not be guessed; investigate those rows by hand.',
      v_orphans USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_ambiguous FROM (
    SELECT c.id FROM _clubless c
      JOIN public.union_wallet_transactions t
        ON t.union_id = c.union_id AND t.created_at = c.created_at
       AND t.direction = 'debit' AND t.amount = c.amount
       AND t.balance_after = c.post_from_balance AND t.tx_type = c.category
       AND t.created_by = c.to_entity_id
       AND c.from_label = 'union_wallets.' || t.wallet
       AND t.club_id IS NOT NULL
     GROUP BY c.id HAVING count(DISTINCT t.club_id) > 1) x;
  IF v_ambiguous > 0 THEN
    RAISE EXCEPTION
      '% club-less leg(s) match receipts naming more than one club. Ambiguous attribution is not corrected automatically.',
      v_ambiguous USING ERRCODE = '55000';
  END IF;

  -------------------------------------------------------------------------
  -- 2.2  THE TAMPER DIGEST OVER THE AFFECTED ROWS, BEFORE
  --
  -- fn_ca_ledger_day_manifest's preimage is
  --   id|amount|from_type:from|>to_type:to|category|epoch(created_at)|row_hash
  -- and contains no club_id. Computed over the FIXED id set, not the day:
  -- the live journal takes ~100,600 legs a day, and the whole-day digest
  -- changes between two snapshots seconds apart with no write at all.
  -------------------------------------------------------------------------
  SELECT array_agg(id ORDER BY id) INTO v_ids FROM _clubless;
  SELECT encode(extensions.digest(COALESCE(string_agg(
           id::text||'|'||amount::text||'|'||from_type||':'||COALESCE(from_entity_id::text,'')||
           '>'||to_type||':'||COALESCE(to_entity_id::text,'')||'|'||category||'|'||
           extract(epoch from created_at)::text||'|'||COALESCE(row_hash,''), E'\n' ORDER BY id),''),'sha256'),'hex')
    INTO v_sha_before FROM public.chip_ledger WHERE id = ANY(v_ids);

  -------------------------------------------------------------------------
  -- 2.3  THE CORRECTION
  -------------------------------------------------------------------------
  WITH w AS (
    SELECT DISTINCT ON (c.id) c.id, t.club_id
      FROM _clubless c
      JOIN public.union_wallet_transactions t
        ON t.union_id = c.union_id AND t.created_at = c.created_at
       AND t.direction = 'debit' AND t.amount = c.amount
       AND t.balance_after = c.post_from_balance AND t.tx_type = c.category
       AND t.created_by = c.to_entity_id
       AND c.from_label = 'union_wallets.' || t.wallet
       AND t.club_id IS NOT NULL
     ORDER BY c.id, t.created_at)
  UPDATE public.chip_ledger cl SET club_id = w.club_id
    FROM w WHERE cl.id = w.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_n THEN
    RAISE EXCEPTION 'corrected % of % club-less legs. Nothing is written unless all of them are.', v_updated, v_n
      USING ERRCODE = '55000';
  END IF;

  -------------------------------------------------------------------------
  -- 2.4  POST-CONDITIONS
  -------------------------------------------------------------------------
  SELECT encode(extensions.digest(COALESCE(string_agg(
           id::text||'|'||amount::text||'|'||from_type||':'||COALESCE(from_entity_id::text,'')||
           '>'||to_type||':'||COALESCE(to_entity_id::text,'')||'|'||category||'|'||
           extract(epoch from created_at)::text||'|'||COALESCE(row_hash,''), E'\n' ORDER BY id),''),'sha256'),'hex')
    INTO v_sha_after FROM public.chip_ledger WHERE id = ANY(v_ids);
  IF v_sha_after IS DISTINCT FROM v_sha_before THEN
    RAISE EXCEPTION
      'post-condition failed: the tamper digest over the corrected rows changed. An attribution correction must be digest-neutral; something else moved. Nothing written.'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_left
    FROM public.chip_ledger l
   WHERE l.club_id IS NULL AND l.to_type = 'player_wallet'
     AND l.from_label LIKE 'union_wallets.%'
     AND l.created_at >= (SELECT min(taken_at) FROM public.ca_chip_baseline);
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'post-condition failed: % club-less union-wallet player leg(s) remain. Nothing written.', v_left
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) FILTER (WHERE abs(d.drift) > 0.01), COALESCE(round(max(abs(d.drift)), 2), 0)
    INTO v_drift_rows, v_worst
    FROM public.fn_chip_drift_since_baseline() d;
  IF v_drift_rows <> 0 THEN
    -- Not necessarily this defect: any other unexplained balance would land
    -- here too. Refuse rather than commit a half-answer and call it settled.
    RAISE EXCEPTION
      'post-condition failed: % member(s) still drifting, worst %. This migration removes the union-hosted-prize cause only; something else is unexplained. Nothing written.',
      v_drift_rows, v_worst USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'corrected % club-less prize legs (% chips); drift_since_baseline is now 0 members', v_updated, v_sum;
END $fix$;

COMMIT;


-- ===========================================================================
-- AFTER APPLYING -- verify, do not assume (CLAUDE.md 1.4)
--
--   SELECT * FROM public.fn_chip_integrity_report()
--    WHERE check_name = 'drift_since_baseline';
--     -> severity 'ok', '0 member(s) drifting, worst 0.00'
--
--   SELECT count(*) FROM public.chip_ledger
--    WHERE club_id IS NULL AND to_type = 'player_wallet'
--      AND from_label LIKE 'union_wallets.%'
--      AND created_at >= (SELECT min(taken_at) FROM public.ca_chip_baseline);
--     -> 0, and it must STILL be 0 an hour later. That is the whole point:
--        before this migration it went from 0 to 100.50 in one hour.
--
--   The next union-hosted diamond prize is the real proof. Watch one land:
--   SELECT id, category, amount, club_id, union_id, from_label
--     FROM public.chip_ledger
--    WHERE from_label LIKE 'union_wallets.%' AND to_type = 'player_wallet'
--    ORDER BY created_at DESC LIMIT 5;
--     -> club_id populated on every row.
-- ===========================================================================
