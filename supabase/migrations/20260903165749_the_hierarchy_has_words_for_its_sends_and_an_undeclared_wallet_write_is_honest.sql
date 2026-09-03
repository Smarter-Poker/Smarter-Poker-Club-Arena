-- ═══════════════════════════════════════════════════════════════════════════════
--  THE HIERARCHY HAS WORDS FOR ITS SENDS, AND AN UNDECLARED WALLET WRITE IS HONEST
--  Chip Accounting Standard Phase 2, lane 2.4 (audit F3, lane2-hierarchy.md 2.0 / 3.1)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- VOCABULARY AND ONE DEFAULT. No balance write moves, no amount changes, no new
-- refusal. Part 1 of 2; the hierarchy RPC bodies declare in the companion
-- migration (the_hierarchy_sends_are_one_journal_row_each).
--
-- WHAT WAS WRONG. Every hierarchy send (club bank -> agent float / promo float
-- / player wallet, agent float -> player wallet or downline float, agent float
-- -> own seat, promo float -> wallet, union clawback, staff pull, reversal)
-- writes two balance columns and journals nothing itself; the two auto-ledger
-- triggers write one single-leg row per column with whatever was declared,
-- and nothing was declared. Verified on production rows:
--
--   fn_agent_wallet_send 2026-09-01 14:23:18, 10,000.00 to a player:
--     adjustment  agent_wallet -> settlement_suspense   10,000.00  (no key)
--     adjustment  table_stack  -> player_wallet         10,000.00  (no key)
--   fn_club_bank_send 2026-09-01 14:02:19, 3,750,000.00 to an agent float:
--     adjustment  club_treasury       -> settlement_suspense  3,750,000.00
--     adjustment  settlement_suspense -> agent_wallet         3,750,000.00
--
-- 30-day volume through these doors (chip_transactions): agent_wallet_send
-- 416 rows / 12,860,000.00; agent_wallet_self_stake 32 / 320,000.00;
-- club_bank_send 5 / 7,601,001.00; club_bank_reversal 1 / 1.00; admin_removal
-- 1 / 1.00; claim backs, promo sends and clawbacks 0. Every one of them
-- journaled as two unrelated suspense legs, and every send to a player as a
-- phantom `table_stack -> player_wallet` crossing the felt never made.
-- lane2-hierarchy.md measured settlement_suspense net +182,131.56 in 23h.
--
-- THE RULE (standard S3 / P3, R9). A hierarchy send is one row from the
-- sender's account to the receiver's account, in a category that says what it
-- was, keyed on the operation. Suspense is zero at every trial balance. A
-- writer that has not said who the counterparty is does not get to invent one.
--
-- WHAT CHANGES HERE.
--
--   1. chip_ledger_category_check learns the five words the hierarchy lacked:
--      club_bank_send, club_bank_claim, agent_send, agent_claim,
--      union_settlement. (commission, rakeback, promo_send, credit_draw,
--      credit_repayment, reversal were already words.) Dropped and re-added
--      NOT VALID, the same way 20260831233537 and 20260902220500 did: no scan
--      of the journal, no long lock. The counterparties needed (club_treasury,
--      agent_wallet, player_wallet, union_bank, promo_wallet, credit_facility)
--      are already in both type CHECKs.
--
--   2. fn_club_members_ledger_writer stops inventing `table_stack` as the
--      counterparty of an undeclared club_members.chip_balance write and says
--      `settlement_suspense` instead, exactly as fn_ca_autoledger already does
--      for every other balance column. Measured before this change, on the
--      live trigger's own rows: since 2026-09-02 22:45 UTC (the minute after
--      20260902224000 declared the prize / refund / bounty legs) the trigger
--      wrote 57,361 rows across tournament_buyin, tournament_prize, buyin,
--      table_cashout, rebuy, bounty, addon and refund, and ZERO of them relied
--      on the default: every one carries a declared counterparty with an
--      entity id. The last rows that did rely on it were tournament_prize
--      2,225 / refund 160 / bounty 90 in the hours before 22:35 that day, all
--      from paths that now declare. The cash buy-in and cash-out paths
--      declared already (8,433 + 5,356 rows / 24h, entity set on all). So the
--      default is not load-bearing for any felt movement; changing it only
--      changes where a FUTURE undeclared write shows up - in suspense, where
--      R9 will see it, instead of on the felt, where it corrupts the
--      table_stack trial balance line. The third-level fallback (category AND
--      counterparty rejected) invented `table_stack` too and now says
--      suspense for the same reason. Nothing else in the trigger changes: same
--      actor, same category fallback, same three exception levels.
--
-- Grants are untouched: CREATE OR REPLACE keeps the trigger function's ACL,
-- and a trigger function cannot be called as an RPC.

BEGIN;

-- ── 1. the ledger vocabulary learns the hierarchy ──────────────────────────────
ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_category_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_category_check
  CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text, 'club_bank_send'::text, 'club_bank_claim'::text, 'agent_send'::text, 'agent_claim'::text, 'union_settlement'::text])))
  NOT VALID;

-- ── 2. an undeclared club_members.chip_balance write lands in suspense ─────────
CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text);

  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, to_type, to_entity_id,
         amount, category, club_id, tournament_id, description)
      VALUES (
        actor,
        CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
        CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
        CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
        CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
        abs(d), 'adjustment', NEW.club_id, tid,
        'auto-audited club_members.chip_balance delta ' || d::text
          || ' (category ' || cat || ' rejected)');
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.chip_ledger
          (performed_by, from_type, from_entity_id, to_type, to_entity_id,
           amount, category, club_id, tournament_id, description)
        VALUES (
          actor,
          CASE WHEN d > 0 THEN 'settlement_suspense'   ELSE 'player_wallet' END,
          CASE WHEN d > 0 THEN NULL            ELSE NEW.user_id     END,
          CASE WHEN d > 0 THEN 'player_wallet' ELSE 'settlement_suspense'   END,
          CASE WHEN d > 0 THEN NEW.user_id     ELSE NULL            END,
          abs(d), 'adjustment', NEW.club_id, tid,
          'auto-audited club_members.chip_balance delta ' || d::text
            || ' (category ' || cat || ' and counterparty ' || cp || ' rejected)');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
        BEGIN
          INSERT INTO public.ca_ledger_write_failures
            (club_id, user_id, delta, sqlstate, message)
          VALUES (NEW.club_id, NEW.user_id, d, st, msg);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END;
    END;
  END;

  RETURN NEW;
END;
$function$
;

-- ── self-check: the live definitions carry the change ─────────────────────────
DO $chk$
DECLARE
  v_def text;
  v_src text;
  v_w   text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_category_check';
  FOREACH v_w IN ARRAY ARRAY['club_bank_send','club_bank_claim','agent_send','agent_claim','union_settlement',
                             'commission','rakeback','promo_send','credit_draw','credit_repayment','reversal',
                             'adjustment','buyin','table_cashout','tournament_buyin','tournament_prize'] LOOP
    IF v_def NOT LIKE '%''' || v_w || '''%' THEN
      RAISE EXCEPTION 'chip_ledger_category_check lacks %', v_w;
    END IF;
  END LOOP;
  IF v_def NOT LIKE '%NOT VALID' THEN
    RAISE EXCEPTION 'chip_ledger_category_check must be NOT VALID (no scan of the journal)';
  END IF;
  FOREACH v_w IN ARRAY ARRAY['club_treasury','agent_wallet','player_wallet','union_bank','promo_wallet','credit_facility','settlement_suspense'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_from_type_check'
                      AND pg_get_constraintdef(oid) LIKE '%''' || v_w || '''%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_to_type_check'
                      AND pg_get_constraintdef(oid) LIKE '%''' || v_w || '''%') THEN
      RAISE EXCEPTION 'chip_ledger from/to type CHECK lacks counterparty %', v_w;
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_club_members_ledger_writer' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%''table_stack''%' THEN
    RAISE EXCEPTION 'fn_club_members_ledger_writer still invents table_stack';
  END IF;
  IF v_src NOT LIKE '%current_setting(''app.ledger_counterparty'', true), ''''), ''settlement_suspense'')%' THEN
    RAISE EXCEPTION 'fn_club_members_ledger_writer default counterparty is not settlement_suspense';
  END IF;
  IF v_src NOT LIKE '%ca_ledger_write_failures%' OR v_src LIKE '%RAISE EXCEPTION%' THEN
    RAISE EXCEPTION 'fn_club_members_ledger_writer must still swallow, never refuse';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'club_members' AND t.tgname = 'trg_club_members_audit_chip_movement'
                    AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'trg_club_members_audit_chip_movement is not attached and enabled';
  END IF;
END $chk$;

COMMIT;
