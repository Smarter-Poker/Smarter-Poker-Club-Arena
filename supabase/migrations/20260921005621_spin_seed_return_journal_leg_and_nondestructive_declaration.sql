-- 20260921005621_spin_seed_return_journal_leg_and_nondestructive_declaration
--
-- =====================================================================
-- THE SPIN SEED RETURN THAT WAS JOURNALLED NOWHERE
--
--   club     Deep Stack Society  2a1132b9-5ba2-42e6-9f01-30a7fcffebe3
--   incident ca_drift_incidents  c4261d89-4674-459e-b34c-ec3142a984f2
--            (critical, treasury_error, escalation 4, 86 occurrences,
--             detected 2026-09-18 00:55, last seen 2026-09-20 23:52)
--   drift    +2,624.78, stored HIGHER than the journal-derived balance
--
-- ---------------------------------------------------------------------
-- WHY THE PREVIOUS ATTEMPT REFUSED ITSELF, AND WHAT CHANGED
--
-- An earlier revision of this migration aborted in its own Part 1 with
--
--     POST-CONDITION FAILED: expected exactly one fn_ca_declare_ledger
--     call, found 2.
--
-- Nothing was applied: the whole transaction rolled back, the drift stayed
-- at 2,624.78, no repair leg existed and the function was untouched.
--
-- The assertion was wrong about the edit it had just made. It counted
-- occurrences of the bare IDENTIFIER 'fn_ca_declare_ledger' in the new
-- pg_get_functiondef text, while its message spoke about CALLS. The
-- replacement text names the function twice and calls it once: once in the
-- explanatory comment the replacement itself inserts ("fn_ca_declare_ledger
-- set_config's ALL THREE GUCs every call"), and once in the guarded PERFORM.
-- Measured, not inferred:
--
--     production definition, identifier mentions ........... 1
--     production definition, PERFORM call sites ............ 1
--     v_anchor (removed),   identifier mentions ............ 1
--     v_repl   (inserted),  identifier mentions ............ 2
--     v_repl   (inserted),  PERFORM call sites ............. 1
--     => new definition: 1 - 1 + 2 = 2 mentions, but still 1 call
--
-- So the edit was correct and the ruler was not. The function had exactly
-- one call before and exactly one call after; the assertion was reading a
-- word out of a comment it had written itself one statement earlier.
--
-- It is NOT fixed by deleting the comment or by loosening the count to
-- "<= 2", both of which would leave a measurement that cannot tell a real
-- duplicate call site from a prose mention. It is fixed by measuring the
-- thing the sentence claims to measure, and the replacement assertions are
-- strictly STRONGER than the one they replace. Part 2 now proves all four
-- of these, where the old revision proved only a miscounted total:
--
--   1. exactly one CALL SITE  - counts 'PERFORM public.fn_ca_declare_ledger('
--      so a genuine second call is still caught, and prose never is;
--   2. the guarded block landed VERBATIM, exactly once - so the IF and the
--      PERFORM arrived together and neither was mangled;
--   3. the unconditional anchor survives NOWHERE - so no un-guarded
--      declaration is left behind anywhere in the definition;
--   4. the guard text itself is present.
--
-- (2) and (1) together are what actually proves the declaration became
-- non-destructive: the definition contains exactly one call site, and that
-- call site is inside the verbatim-matched IF block. A call outside the
-- guard would make the count 2; a guard without its call would fail the
-- verbatim match. Neither can pass.
--
-- ---------------------------------------------------------------------
-- WHY THE ROOT FIX IS APPLIED LAST (changed from the previous revision)
--
-- CREATE OR REPLACE FUNCTION locks fn_spin_move_owner_wallet's pg_proc row
-- for the rest of the transaction, and that function is on the live spin
-- settle path. The drift measurement is not cheap: EXPLAIN ANALYZE on
-- production measured the reconciler's arithmetic at 3.08 s (the
-- to_type='club_treasury' side has no (to_entity_id, created_at) index and
-- walks 4.85 M rows off idx_chip_ledger_created_at), and this migration
-- runs it twice - once as a pre-condition and once as a post-condition.
--
-- With the DDL first, that lock would be held across ~6.2 s of scanning and
-- every concurrent spin settle would queue behind it. That is the shape of
-- the 2026-09-08 outage and of production DDL policy rule 7: apply DDL in
-- its own short window, never behind a long read. The two parts are one
-- transaction either way, so atomicity is identical and the ordering is
-- purely about how long a hot money RPC is held. Part 1 (the correction,
-- no DDL) therefore runs first and Part 2 (the root fix, the only DDL) runs
-- last, immediately before COMMIT.
--
-- Deliberately NOT done here: adding the missing (to_entity_id, created_at)
-- index. chip_ledger is the hottest money table on the platform and an
-- index build is an unrelated, heavier lock. It is worth its own migration.
--
-- ---------------------------------------------------------------------
-- WHAT HAPPENED
--
-- fn_spin_settle_game repays the spin pool's seed to the treasury that
-- funded it. It declares the movement correctly, by raw set_config:
--
--     app.ledger_category            = 'treasury_transfer'
--     app.ledger_counterparty        = 'club_treasury'
--     app.ledger_counterparty_entity = <club>
--     app.ledger_autoskip_clubs      = '1'
--     app.ledger_autoskip_union_wallets = '1'
--
-- It then calls fn_spin_move_owner_wallet(owner,'club','chip_treasury',
-- +2624.78), whose FIRST statement is an UNCONDITIONAL
--
--     PERFORM public.fn_ca_declare_ledger('rake', 'spin_reserve');
--
-- fn_ca_declare_ledger set_config's all three GUCs every time, including
-- app.ledger_counterparty_entity := COALESCE(p_counterparty_entity::text,'')
-- -- so the caller's category, counterparty AND counterparty entity are all
-- overwritten, while the two autoskips survive untouched.
--
-- The consequence is in that order:
--   1. UPDATE clubs SET chip_treasury = +2624.78   -> autoskip_clubs, no leg.
--      The treasury really did receive the chips; nothing recorded it.
--   2. control returns to fn_spin_settle_game, which does
--      UPDATE spin_bonus_pools SET balance = balance - 2624.78. That one is
--      NOT autoskipped, so fn_ca_autoledger writes it -- with the clobbered
--      context: category 'rake', counterparty 'spin_reserve', entity NULL.
--
-- The leg it produced is e23f4387-495a-4530-8b5d-eef334869ec3:
--      spin_reserve/<pool>  ->  spin_reserve/NULL,  2624.78, 'rake'
-- money leaving the pool and arriving nowhere.
--
-- reconcile_ledger_nightly derives a treasury from
--     ca_treasury_baseline.opening_balance
--       + SUM(amount WHERE to_type  ='club_treasury' AND to_entity_id  =club)
--       - SUM(amount WHERE from_type='club_treasury' AND from_entity_id=club)
-- over created_at >= MIN(ca_treasury_baseline.taken_at). The bad leg names
-- club_treasury on NEITHER side, so it is invisible to both sums: the stored
-- treasury rose by 2624.78 and the derived one did not. Hence stored HIGHER.
--
-- NOBODY IS SHORT. The movement was real and intended -- the spin pool
-- repaying the treasury that seeded it. spin_reserve_ledger recorded it
-- correctly at the same microsecond (kind='seed_return', -2624.78,
-- balance_after 22624.78). Both sides are club-owned house pools. No player
-- wallet, table stack, prize liability or bounty was touched.
-- THIS CORRECTION MOVES METADATA ONLY AND MOVES NO CHIPS.
--
-- ---------------------------------------------------------------------
-- THE 2026-09-06 TWIN IS ALREADY ABSORBED -- DO NOT CORRECT IT
--
-- Exactly TWO legs in 5,068,903 have from_type = to_type with one side's
-- entity NULL, and both are this defect:
--     b037ff3f-...  2026-09-06 03:20:08.443346+00   2523.48
--     e23f4387-...  2026-09-17 21:03:56.252505+00   2624.78
--
-- Only the 09-17 one is corrected here. The 09-06 one is already inside
-- ca_treasury_baseline.opening_balance (9,981,739.70), whose row for this
-- club was back-solved when the "a missing baseline is not an opening of
-- zero" fix landed. The proof is behavioural, decisive, and was re-read
-- from ledger_reconcile_log at the time this migration was written:
--
--     09-01 .. 09-05   drift 9,979,213.44   (no baseline row yet)
--     09-06            drift 9,981,736.92   <- +2,523.48, the 09-06 leg
--     09-07            drift 9,981,736.92
--     09-08 .. 09-17   drift 0.00           <- TEN consecutive runs, 'ok'
--     09-18 .. 09-20   drift 2,624.78       <- the 09-17 leg, and only it
--
-- The baseline absorbed everything up to 09-08, the 09-06 leg included. A
-- leg causing unabsorbed drift cannot produce ten 0.00 readings. Appending
-- a second leg for 09-06 would therefore not fix anything; it would create
-- a FRESH 2,523.48 drift in the opposite direction. Part 1 asserts that no
-- such leg exists before writing.
--
-- ---------------------------------------------------------------------
-- WHY THE LEG IS POSTED AT now() AND NOT BACK-DATED TO 2026-09-17
--
-- 2026-09-17 is a SEALED day: ca_ledger_day_manifests holds row_count
-- 305,849 for it, which equals the live count exactly (re-measured:
-- 305,849 = 305,849). Back-dating would put the live count one ahead of the
-- sealed manifest and the day would read as tampered. The correcting entry
-- is therefore posted in the currently open period, referencing the
-- original event in metadata -- ordinary double-entry practice. The
-- reconciler's window has no upper bound, so the drift still closes.
--
-- ---------------------------------------------------------------------
-- WHY status = 'posted' AND category = 'treasury_transfer'
--
-- All 5,068,903 existing legs are status='posted'; zero rows carry anything
-- else, so 'correction' has never been used. Twelve functions filter
-- chip_ledger on status='posted', including fn_ca_quick_reconcile and
-- fn_chip_integrity_report. A leg marked 'correction' would be the first
-- non-posted row ever written and would be invisible to both -- fixing this
-- detector by breaking two others. The leg records a real, posted movement;
-- its corrective provenance lives in description, notes and metadata.
--
-- category is 'treasury_transfer' because that is what the movement IS,
-- and it is exactly what the caller declared. The leg written below is
-- byte-for-byte the leg that the fixed function now produces.
--
-- ---------------------------------------------------------------------
-- TRIGGERS THAT FIRE ON THIS LEG, AND WHY EACH IS SAFE
--
--   BEFORE INSERT
--     ab_ca_chip_store_declared    both 'spin_reserve' and 'club_treasury'
--                                  are declared in ca_chip_store_coverage,
--                                  both treatment='counted' (re-read) -- so
--                                  this leg is supply-neutral between two
--                                  counted stores.
--     trg_ca_chip_ledger_enrich    stamps epoch, actor, chain_seq, row_hash.
--                                  tournament_id stays NULL: neither side is
--                                  prize_liability and no GUC is set.
--     trg_chip_ledger_performed_by performed_by is the service identity, not
--                                  the all-zero sentinel.
--     zz_chip_ledger_key_is_claimed_once  claims the idempotency key in
--                                  chip_ledger_idem -- a second run raises a
--                                  unique violation. This is the hard
--                                  un-repeatability guarantee.
--     cancelled_/terminal_/satellite_ tournament immutability
--                                  ALL no-op because tournament_id IS NULL.
--                                  *** THIS IS LOAD-BEARING ***: tournament
--                                  49a5cf6a is COMPLETED (re-read), and
--                                  fn_terminal_tournament_evidence_is_immutable
--                                  REFUSES any INSERT naming a terminal
--                                  tournament. Naming it would make this
--                                  migration fail. The event is recorded in
--                                  metadata instead. The satellite guard also
--                                  requires that the idempotency key does not
--                                  match 'tourney:%:seat:%:pool_transfer' and
--                                  that metadata carries no 'satellite_id'.
--     zz_freeze_guard              refuses at depth 1 while frozen -> Part 0.
--
--   AFTER INSERT
--     original_union_pnl_flow      returns immediately: its filter needs
--                                  table_stack/prize_liability on one side.
--     zz_tournament_accounting_credit_ledger  needs from_type='prize_liability'.
--     accounting_transfer_document needs from_type IN (union_wallet,
--                                  union_bank, club_treasury, player_wallet,
--                                  agent_wallet); 'spin_reserve' is not.
--     zz_ca_escrow_reserve_leg     needs category IN ('spin_entry','spin_prize').
--     zz_ca_escrow_overlay_leg / _seat_transfer_leg  need to_type='prize_liability'.
--     zz_ca_issuance_leg_is_registered  needs a mint/burn/issuance store.
--   None of them fires. No side effect beyond the row itself.
-- =====================================================================

-- THIS FILE CREATES NO PERSISTENT OBJECT, so it states its own proof - the
-- convention tests/a-merged-migration-must-be-live.law.test.ts binds from
-- 20260920 onward. Nothing in pg_proc or pg_class appears for a patched
-- function body, a revoked grant or an updated row, so the reader is told
-- exactly what to run. Every expression below was run read-only against
-- production on 2026-09-25 and every one returned true.
-- @live-proof: (SELECT position('app.ledger_counterparty' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_spin_move_owner_wallet')
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

-- ---------------------------------------------------------------------
-- PART 0  The break window, refused early and readably.
--
-- THE WINDOW IS NOT RESTATED HERE, AND THAT IS DELIBERATE.
--
-- A previous revision carried its own copy of the minute arithmetic
-- (v_min >= 50 OR v_min <= 3) alongside the database's own window function,
-- and the two disagreed by a minute. Measured: at 01:03:26 UTC on
-- 2026-09-21, fn_ca_break_window_refuses_migrations(now()) returned NULL --
-- clear -- and fn_platform_frozen() returned false, while the local copy
-- refused with "it is 01:03 UTC, inside the :50-:03 window". Nothing was
-- applied and nothing was spent (Part 0 runs before any DDL, so no
-- PostgREST reload was triggered), but the lesson stands: a migration that
-- carries a sixth private restatement of a constant the law already pins
-- across five surfaces (CLAUDE.md section 13 rule 7,
-- tests/the-break-clocks-agree.law.test.ts) is a drift hazard, not a safety
-- net.
--
-- So this asks the authority instead of re-deriving it.
-- fn_ca_break_window_refuses_migrations is the SAME predicate the event
-- triggers ca_break_window_refuses_ddl and ca_break_window_refuses_drops
-- use to roll a migration back, so Part 0 now refuses exactly when Part 2's
-- DDL would be refused -- never a minute early, never a minute late. Its
-- returned reason is quoted verbatim in the message, so the refusal names
-- its own source rather than this file's opinion of the clock.
-- ---------------------------------------------------------------------
DO $mig0$
DECLARE
  v_why text;
BEGIN
  v_why := public.fn_ca_break_window_refuses_migrations(now());
  IF v_why IS NOT NULL THEN
    RAISE EXCEPTION
      'REFUSED: the database refuses migrations right now. It says: %. The DDL in '
      'Part 2 would be rolled back by ca_break_window_refuses_ddl anyway. Apply this '
      'ONCE when the window is clear - never in a retry loop (CLAUDE.md section 2, '
      'production DDL policy rules 2 and 8).', v_why;
  END IF;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'REFUSED: the platform is frozen for a scheduled maintenance break. '
      'zz_freeze_guard would refuse the chip_ledger INSERT anyway. Retry after the thaw.';
  END IF;
END
$mig0$;

-- ---------------------------------------------------------------------
-- PART 1  THE CORRECTION -- one appended leg, for the 2026-09-17 event only.
--
-- chip_ledger is append-only (trg_ca_append_only, plus three tournament
-- immutability triggers), so the bad leg cannot be edited. This is a new
-- leg that supplies the missing spin_reserve -> club_treasury side.
--
-- This part carries NO DDL, so it runs before the root fix and the pg_proc
-- lock is not held across its two 3-second scans. See the header.
-- ---------------------------------------------------------------------
DO $mig1$
DECLARE
  c_club      CONSTANT uuid    := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_pool      CONSTANT uuid    := '01810895-3a66-45ce-aee7-e2fcb3857384';
  c_bad_leg   CONSTANT uuid    := 'e23f4387-495a-4530-8b5d-eef334869ec3';
  c_absorbed  CONSTANT uuid    := 'b037ff3f-f7dc-4170-ad5a-cfae8c7941d9';
  c_tourney   CONSTANT uuid    := '49a5cf6a-4c04-485f-ac68-47b353f9a770';
  c_actor     CONSTANT uuid    := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_incident  CONSTANT uuid    := 'c4261d89-4674-459e-b34c-ec3142a984f2';
  c_amount    CONSTANT numeric := 2624.78;
  c_when      CONSTANT timestamptz := '2026-09-17 21:03:56.252505+00';
  c_opening   CONSTANT numeric := 9981739.70;
  c_pool_pre  CONSTANT numeric := 25249.56;
  c_pool_post CONSTANT numeric := 22624.78;
  c_key       CONSTANT text    :=
    'spin-settle-seed-return-journal-repair:01810895-3a66-45ce-aee7-e2fcb3857384'
    || ':e23f4387-495a-4530-8b5d-eef334869ec3';
  v_drift numeric;
  v_n     int;
  v_leg   uuid;
BEGIN
  ---------------------------------------------------------------------
  -- A. UN-REPEATABLE. The unique index on idempotency_key and
  --    zz_chip_ledger_key_is_claimed_once are the hard guarantee; this is
  --    the readable message.
  ---------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = c_key) THEN
    RAISE EXCEPTION
      'REFUSED: this correction is already applied - idempotency key % is claimed.', c_key;
  END IF;

  ---------------------------------------------------------------------
  -- B. THE OFFENDING LEG IS EXACTLY WHAT WE MEASURED.
  ---------------------------------------------------------------------
  SELECT count(*) INTO v_n
    FROM public.chip_ledger
   WHERE id = c_bad_leg
     AND amount = c_amount
     AND category = 'rake'
     AND from_type = 'spin_reserve' AND from_entity_id = c_pool
     AND to_type   = 'spin_reserve' AND to_entity_id IS NULL
     AND club_id = c_club
     AND created_at = c_when;
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'REFUSED: leg % is not the destination-less spin_reserve leg this correction '
      'was derived against (matched % rows). Re-read it before applying.', c_bad_leg, v_n;
  END IF;

  ---------------------------------------------------------------------
  -- C. STILL EXACTLY TWO SUCH LEGS IN THE WHOLE JOURNAL, AND THEY ARE THE
  --    TWO KNOWN ONES. A third would mean the defect fired again after
  --    this correction was derived and the whole analysis must be redone.
  ---------------------------------------------------------------------
  SELECT count(*) INTO v_n
    FROM public.chip_ledger
   WHERE from_type = to_type
     AND (from_entity_id IS NULL OR to_entity_id IS NULL);
  IF v_n <> 2 THEN
    RAISE EXCEPTION
      'REFUSED: expected exactly 2 same-store legs with a NULL side in chip_ledger, '
      'found %. The defect has fired again; re-derive the correction.', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.chip_ledger
   WHERE from_type = to_type
     AND (from_entity_id IS NULL OR to_entity_id IS NULL)
     AND id NOT IN (c_bad_leg, c_absorbed);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'REFUSED: an unrecognised destination-less leg is present (% of them).', v_n;
  END IF;

  ---------------------------------------------------------------------
  -- D. THE 2026-09-06 TWIN STAYS UNCORRECTED. Correcting it would create a
  --    fresh 2,523.48 drift in the opposite direction; it is already inside
  --    the baseline's opening balance.
  ---------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM public.chip_ledger
     WHERE idempotency_key LIKE 'spin-settle-seed-return-journal-repair:%'
       AND idempotency_key LIKE '%' || c_absorbed::text) THEN
    RAISE EXCEPTION
      'REFUSED: a repair leg exists for the 2026-09-06 event (%). That event is already '
      'absorbed into ca_treasury_baseline.opening_balance and must NOT be corrected.', c_absorbed;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.ca_treasury_baseline
   WHERE club_id = c_club AND opening_balance = c_opening;
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'REFUSED: the treasury baseline for club % is not the one that absorbs the '
      '2026-09-06 event (expected opening_balance %). Re-derive before applying.',
      c_club, c_opening;
  END IF;

  ---------------------------------------------------------------------
  -- E. RE-MEASURE THE DRIFT, with reconcile_ledger_nightly's own
  --    arithmetic, in ONE statement so both sides share a snapshot.
  --    The absolute balances move constantly on this live club (the stored
  --    treasury fell ~80k/day across 09-18..09-20 while the drift stayed at
  --    exactly 2,624.78), so the DRIFT is the invariant and the drift is
  --    what is asserted.
  ---------------------------------------------------------------------
  WITH cut AS (SELECT MIN(taken_at) AS t0 FROM public.ca_treasury_baseline),
       b AS (SELECT opening_balance FROM public.ca_treasury_baseline WHERE club_id = c_club),
       c AS (SELECT COALESCE(SUM(cl.amount),0) AS amt FROM public.chip_ledger cl, cut
              WHERE cl.to_type = 'club_treasury' AND cl.to_entity_id = c_club
                AND cl.created_at >= cut.t0),
       d AS (SELECT COALESCE(SUM(cl.amount),0) AS amt FROM public.chip_ledger cl, cut
              WHERE cl.from_type = 'club_treasury' AND cl.from_entity_id = c_club
                AND cl.created_at >= cut.t0),
       s AS (SELECT COALESCE(chip_treasury,0) AS bal FROM public.clubs WHERE id = c_club)
  SELECT round(s.bal - (b.opening_balance + c.amt - d.amt), 2)
    INTO v_drift
    FROM b, c, d, s;

  IF v_drift IS NULL THEN
    RAISE EXCEPTION 'REFUSED: could not measure the drift for club % (missing baseline or club row).', c_club;
  END IF;
  IF v_drift <> c_amount THEN
    RAISE EXCEPTION
      'REFUSED: the board moved. Expected drift % for club %, measured %. '
      'Re-measure and re-derive this correction before applying it.',
      c_amount, c_club, v_drift;
  END IF;

  RAISE NOTICE 'PRE-CONDITION: drift for club % measured at % as expected.', c_club, v_drift;

  ---------------------------------------------------------------------
  -- F. APPEND THE MISSING LEG.
  --    This is byte-for-byte the leg that the function fixed in Part 2 now
  --    produces: fn_ca_autoledger on spin_bonus_pools.balance with a
  --    negative delta, under the caller's own declaration
  --    (treasury_transfer / club_treasury / <club>).
  --    tournament_id is deliberately NULL -- see the trigger notes above;
  --    tournament 49a5cf6a is COMPLETED and naming it would be refused.
  ---------------------------------------------------------------------
  INSERT INTO public.chip_ledger
    (performed_by, from_type, from_entity_id, from_label,
     to_type, to_entity_id, to_label,
     amount, category, club_id, union_id,
     description, notes, idempotency_key, status,
     pre_from_balance, post_from_balance, metadata)
  VALUES
    (c_actor,
     'spin_reserve', c_pool, 'spin_bonus_pools.balance',
     'club_treasury', c_club, NULL,
     c_amount, 'treasury_transfer', c_club, NULL,
     'Spin reserve seed instalment returned to the club treasury',
     'The leg fn_spin_settle_game never wrote on 2026-09-17. '
     || 'fn_spin_move_owner_wallet overwrote the caller''s ledger declaration, the '
     || 'clubs UPDATE was autoskipped, and the spin_bonus_pools UPDATE journalled '
     || 'itself as spin_reserve -> spin_reserve with no destination. The chips moved '
     || 'and were real; only the journal entry was missing. Posted in the open period '
     || 'rather than back-dated, because 2026-09-17 is a sealed day manifest.',
     c_key, 'posted',
     c_pool_pre, c_pool_post,
     jsonb_build_object(
       'economic_event',          'spin_seed_return',
       'posted_late',             true,
       'original_movement_at',    c_when,
       'original_tournament_id',  c_tourney,
       'repairs_leg',             c_bad_leg,
       'incident',                c_incident,
       'spin_reserve_ledger',     'kind=seed_return, amount=-2624.78, balance_after=22624.78',
       'balances_are_as_at',      '2026-09-17 (the spin pool either side of the seed return)',
       'moves_chips',             false,
       'note',                    'Metadata-only correction between two club-owned house pools. '
                                  || 'No player wallet, table stack, prize liability or bounty is affected.'))
  RETURNING id INTO v_leg;

  RAISE NOTICE 'CORRECTION: appended leg % (% chips, spin_reserve -> club_treasury).', v_leg, c_amount;

  ---------------------------------------------------------------------
  -- G. POST-CONDITION: exactly one leg carries the key, and
  --    reconcile_ledger_nightly's drift for this club is now 0.00.
  --    Re-measured independently rather than derived by subtraction: the
  --    point is to prove the leg landed where the reconciler actually looks.
  ---------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.chip_ledger WHERE idempotency_key = c_key;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: % legs carry the idempotency key, expected 1.', v_n;
  END IF;

  WITH cut AS (SELECT MIN(taken_at) AS t0 FROM public.ca_treasury_baseline),
       b AS (SELECT opening_balance FROM public.ca_treasury_baseline WHERE club_id = c_club),
       c AS (SELECT COALESCE(SUM(cl.amount),0) AS amt FROM public.chip_ledger cl, cut
              WHERE cl.to_type = 'club_treasury' AND cl.to_entity_id = c_club
                AND cl.created_at >= cut.t0),
       d AS (SELECT COALESCE(SUM(cl.amount),0) AS amt FROM public.chip_ledger cl, cut
              WHERE cl.from_type = 'club_treasury' AND cl.from_entity_id = c_club
                AND cl.created_at >= cut.t0),
       s AS (SELECT COALESCE(chip_treasury,0) AS bal FROM public.clubs WHERE id = c_club)
  SELECT round(s.bal - (b.opening_balance + c.amt - d.amt), 2)
    INTO v_drift
    FROM b, c, d, s;

  IF v_drift IS DISTINCT FROM 0.00 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: reconcile_ledger_nightly drift for club % is % after the '
      'correction, expected 0.00. Nothing is committed.', c_club, v_drift;
  END IF;

  RAISE NOTICE 'POST-CONDITION: reconcile_ledger_nightly drift for club % is now %.', c_club, v_drift;

  ---------------------------------------------------------------------
  -- H. THE RECORD IS PART OF THE FIX (law 10.9).
  --    fn_ca_resolve_cleared_incidents only auto-closes findings from
  --    fn_ca_conservation_sweep, fn_ca_ratchet_watch, fn_bbj_reconcile and
  --    fn_ca_money_rpc_drift. This incident's source is
  --    'ledger_reconcile_log:reconcile_ledger_nightly', which is not on that
  --    list, so it would stay open for ever unless closed here.
  ---------------------------------------------------------------------
  UPDATE public.ca_drift_incidents
     SET status         = 'resolved',
         closure_basis  = 'repair',
         resolved_at    = now(),
         resolved_by    = c_actor,
         root_cause     =
           'fn_spin_move_owner_wallet opened with an unconditional '
           || 'fn_ca_declare_ledger(''rake'',''spin_reserve''), which overwrote the '
           || 'category, counterparty AND counterparty entity that fn_spin_settle_game '
           || 'had just declared for the seed return, while leaving '
           || 'app.ledger_autoskip_clubs set. The clubs UPDATE was therefore suppressed '
           || 'and wrote no leg, and the following spin_bonus_pools UPDATE autoledgered '
           || 'under the clobbered context as leg ' || c_bad_leg || ' - '
           || 'spin_reserve -> spin_reserve, 2624.78, no destination entity. Naming '
           || 'club_treasury on neither side, it was invisible to both of '
           || 'reconcile_ledger_nightly''s sums, so the stored treasury rose and the '
           || 'derived one did not.',
         correction_ref =
           'chip_ledger leg ' || v_leg || ' (idempotency_key ' || c_key || '); '
           || 'root fix: fn_spin_move_owner_wallet declares only when the caller has not.',
         resolution     =
           'NO CHIPS MOVED. The 2,624.78 movement on 2026-09-17 was real and intended - '
           || 'the spin pool repaying the treasury that seeded it, recorded correctly in '
           || 'spin_reserve_ledger as kind=seed_return at the same microsecond. Both sides '
           || 'are club-owned house pools; no player wallet, table stack, prize liability '
           || 'or bounty was ever affected and nobody was short. The missing '
           || 'spin_reserve -> club_treasury journal leg was appended, posted in the open '
           || 'period rather than back-dated because 2026-09-17 is a sealed day manifest, '
           || 'and the drift for this club re-measures to 0.00 in the same transaction. '
           || 'The 2026-09-06 twin (leg ' || c_absorbed || ', 2,523.48) is deliberately '
           || 'left alone: it is already absorbed into '
           || 'ca_treasury_baseline.opening_balance, proven by ten consecutive 0.00 '
           || 'readings from 09-08 to 09-17, and a second leg for it would create a fresh '
           || '2,523.48 drift the other way.'
   WHERE id = c_incident
     AND resolved_at IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE WARNING
      'incident % was not open at closing time (% rows updated) - the correction and the '
      'root fix still stand; check the board by hand.', c_incident, v_n;
  END IF;

  INSERT INTO public.ca_incident_events (incident_id, kind, actor, actor_label, detail)
  VALUES (c_incident, 'resolved', c_actor, 'migration: spin seed return journal leg',
          jsonb_build_object(
            'leg_id',        v_leg,
            'repairs_leg',   c_bad_leg,
            'amount',        c_amount,
            'drift_after',   v_drift,
            'chips_moved',   false,
            'root_fix',      'fn_spin_move_owner_wallet declaration made non-destructive'));
END
$mig1$;

-- ---------------------------------------------------------------------
-- PART 2  THE ROOT FIX (law 10.11 / 10.12: a correction without a root
--         fix is a band-aid). THE ONLY DDL IN THIS MIGRATION, AND IT IS
--         LAST ON PURPOSE -- see the header.
--
-- fn_spin_move_owner_wallet's declaration becomes NON-DESTRUCTIVE: it
-- declares only when the caller has not already declared a counterparty.
--
-- THE DEFAULT COUNTERPARTY IS DELIBERATELY LEFT AS 'spin_reserve'.
-- This function moves the OWNER'S wallet (clubs.chip_treasury or
-- union_wallets.*), not the pool -- and the counterparty of the owner
-- wallet's movement IS the spin reserve. Changing the default to
-- club_treasury/union_wallet with the owner id was considered and is
-- WRONG: in fn_spin_activate the owner-wallet UPDATE would then autoledger
-- as club_treasury/<club> -> club_treasury/<club>, a self-referential leg,
-- which is the very pathology this defect produced. The bug was never the
-- default; it was the overwrite.
--
-- BLAST RADIUS, verified against every caller in pg_proc:
--   fn_spin_settle_game            DECLARES -> behaviour changes (fixed).
--   fn_spin_activate               does not declare -> unchanged.
--   fn_spin_absorb_club_pool_into_union  does not declare -> unchanged.
--   fn_close_club_wallets_on_union_join  does not declare -> unchanged.
--   fn_spin_deactivate             does not declare, and sets all three
--                                  autoskips then writes its leg by hand
--                                  -> unchanged.
-- The only outer caller that both declares and reaches a spin function,
-- fn_complete_club_opening_setup, calls fn_spin_activate BEFORE it declares.
-- So app.ledger_counterparty is unset at every non-declaring call site, and
-- this change is a no-op for them.
--
-- Not retyped by hand: asserted text substitution on pg_get_functiondef.
-- fn_spin_move_owner_wallet is NOT pinned in ca_guard_defs (only
-- fn_ca_autoledger is), so no def_hash needs restamping. It is already
-- status='approved' in ca_money_rpc_registry, so no new registration.
-- ---------------------------------------------------------------------
DO $mig2$
DECLARE
  v_oid    oid;
  v_def    text;
  v_new    text;
  v_anchor text;
  v_repl   text;
  v_n      int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_spin_move_owner_wallet';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'REFUSED: expected exactly one public.fn_spin_move_owner_wallet, found %.', v_n;
  END IF;

  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_spin_move_owner_wallet';

  v_def := pg_get_functiondef(v_oid);

  v_anchor := $a$  PERFORM public.fn_ca_declare_ledger(
    CASE WHEN p_delta >= 0 THEN 'rake' ELSE 'overlay' END, 'spin_reserve');$a$;

  v_repl := $r$  /* NON-DESTRUCTIVE DECLARATION. A caller that has already said what
     this movement is knows more than this function does: fn_spin_settle_game
     declares treasury_transfer / club_treasury / <club> and autoskips clubs,
     because the seed return is ONE transfer represented by two balance-store
     updates. Overwriting that unconditionally is what wrote
     e23f4387-495a-4530-8b5d-eef334869ec3 -- spin_reserve -> spin_reserve with
     no destination entity, 2624.78 leaving the pool and arriving nowhere --
     and left Deep Stack Society reading +2,624.78 of treasury drift from
     2026-09-18. fn_ca_declare_ledger set_config's ALL THREE GUCs every call,
     including the counterparty entity, so the caller lost the entity too.
     The default below stays 'spin_reserve': this function moves the OWNER's
     wallet, whose counterparty genuinely is the spin reserve. */
  IF NULLIF(current_setting('app.ledger_counterparty', true), '') IS NULL THEN
    PERFORM public.fn_ca_declare_ledger(
      CASE WHEN p_delta >= 0 THEN 'rake' ELSE 'overlay' END, 'spin_reserve');
  END IF;$r$;

  -- Not already applied.
  IF position('app.ledger_counterparty' in v_def) > 0 THEN
    RAISE EXCEPTION
      'REFUSED: fn_spin_move_owner_wallet already reads app.ledger_counterparty - '
      'the non-destructive declaration looks applied. Re-read the function before re-running.';
  END IF;

  -- ASSERT ANCHOR COUNT.
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'REFUSED: expected exactly 1 unconditional fn_ca_declare_ledger anchor in '
      'fn_spin_move_owner_wallet, found %. The function is not the one this patch '
      'was derived against; re-derive it.', v_n;
  END IF;

  -- ASSERT COMPOSITION: every other guard is present BEFORE we touch it.
  IF position('unknown union wallet' in v_def) = 0
     OR position('unknown club wallet' in v_def) = 0
     OR position('app.uwt_selfjournal' in v_def) = 0
     OR position('union_wallet_transactions' in v_def) = 0
     OR position($q$'chip_balance','promo_wallet','rake_wallet','spin_reserve_wallet'$q$ in v_def) = 0
     OR position($q$'chip_treasury','promo_balance'$q$ in v_def) = 0
     OR position('SECURITY DEFINER' in v_def) = 0
     OR position($q$SET search_path TO 'public', 'pg_temp'$q$ in v_def) = 0 THEN
    RAISE EXCEPTION
      'REFUSED: fn_spin_move_owner_wallet is not the composition this patch was '
      'written against (a wallet whitelist, the self-journal flag, the union '
      'transaction writer, SECURITY DEFINER or the search_path is missing).';
  END IF;

  v_new := replace(v_def, v_anchor, v_repl);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'REFUSED: the substitution changed nothing.';
  END IF;

  EXECUTE v_new;

  -- POST-CONDITIONS.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_spin_move_owner_wallet';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: the replace created an overload (% now exist).', v_n;
  END IF;

  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_spin_move_owner_wallet';
  v_def := pg_get_functiondef(v_oid);

  IF position($q$NULLIF(current_setting('app.ledger_counterparty', true), '') IS NULL$q$ in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: the non-destructive guard is not in the new definition.';
  END IF;

  ---------------------------------------------------------------------
  -- COUNT THE CALL, NOT THE WORD.
  --
  -- The previous revision of this migration counted occurrences of the bare
  -- identifier 'fn_ca_declare_ledger' here, found 2, and refused its own
  -- correct edit with "expected exactly one fn_ca_declare_ledger call,
  -- found 2". The second occurrence was the word inside the explanatory
  -- comment that v_repl had just inserted, one statement earlier. The
  -- function had one call site before the edit and one after.
  --
  -- Counting the CALL keeps the assertion's teeth - a genuine duplicate
  -- call site still fails it - while prose about the function no longer
  -- registers as a call to it.
  ---------------------------------------------------------------------
  v_n := (length(v_def) - length(replace(v_def, 'PERFORM public.fn_ca_declare_ledger(', '')))
         / length('PERFORM public.fn_ca_declare_ledger(');
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: expected exactly one fn_ca_declare_ledger CALL SITE in the '
      'new definition, found %.', v_n;
  END IF;

  ---------------------------------------------------------------------
  -- THE GUARDED BLOCK LANDED VERBATIM, EXACTLY ONCE.
  --
  -- With the call-site count above, this is what proves the declaration is
  -- now CONDITIONAL rather than merely accompanied by a condition: the
  -- definition holds exactly ONE call site, and that call site is inside
  -- this block. A call left outside the guard would make the count 2; a
  -- guard that arrived without its call would fail this verbatim match.
  ---------------------------------------------------------------------
  v_n := (length(v_def) - length(replace(v_def, v_repl, ''))) / length(v_repl);
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: the guarded declaration block appears % times in the new '
      'definition, expected exactly 1.', v_n;
  END IF;

  ---------------------------------------------------------------------
  -- AND NO UNCONDITIONAL DECLARATION SURVIVES ANYWHERE.
  ---------------------------------------------------------------------
  IF position(v_anchor in v_def) > 0 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: the unconditional fn_ca_declare_ledger anchor is still '
      'present in the new definition.';
  END IF;

  -- EVERY OTHER GUARD SURVIVED.
  IF position('unknown union wallet' in v_def) = 0
     OR position('unknown club wallet' in v_def) = 0
     OR position('app.uwt_selfjournal' in v_def) = 0
     OR position('union_wallet_transactions' in v_def) = 0
     OR position($q$'chip_balance','promo_wallet','rake_wallet','spin_reserve_wallet'$q$ in v_def) = 0
     OR position($q$'chip_treasury','promo_balance'$q$ in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: a pre-existing guard did not survive the substitution.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND prosecdef) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: SECURITY DEFINER was lost.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = v_oid
       AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: the pinned search_path was lost.';
  END IF;

  RAISE NOTICE 'ROOT FIX APPLIED: fn_spin_move_owner_wallet now declares only when the caller has not.';
END
$mig2$;

COMMIT;
