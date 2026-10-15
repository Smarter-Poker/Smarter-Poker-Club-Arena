-- 20261015133250_the_autoledger_never_journals_an_account_to_itself.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE AUTOLEDGER NEVER JOURNALS AN ACCOUNT TO ITSELF (2026-10-15).
--
-- THE DEFECT. public.fn_ca_autoledger() writes one chip_ledger leg per changed
-- balance column, against the counterparty the transaction declared
-- (app.ledger_counterparty / _entity / _label). When one transaction moves
-- chips between two autoledgered columns and declares the DESTINATION account
-- itself as the counterparty, the destination column's own leg is written
-- from that account to that same account:
--
--   * 2026-10-06 15:42:39 UTC, psql transfer of a KF player's chips to three
--     club treasuries: the player_wallet -> club_treasury legs are correct,
--     plus three club_treasury -> club_treasury self-legs of 494,917.55,
--     510,990.88 and 6,222.93 (from_label NULL, to_label clubs.chip_treasury).
--   * 2026-09-17 16:39:14 and 16:41:29 UTC, PostgREST treasury -> promo moves:
--     two promo_wallet -> promo_wallet self-legs, 200.00 in all (from_label
--     NULL, to_label clubs.promo_balance).
--
-- WHY SKIPPING IS INVARIANT-SAFE. Both sides of a self-leg carry the same
-- type, entity and club, so fn_ca_tally_ledger_leg adds +x and -x to the same
-- fn_ca_ledger_tally_key and the commit check (fn_ca_balance_has_its_ledger_row)
-- sees the same net with or without it; fn_ca_tally_balance_move and
-- fn_ca_tally_store_move read no leg at all. fn_ca_leg_accounts resolves
-- club_treasury, union_bank, player_wallet, spin_reserve and agent_wallet to
-- one fixed column, insurance_bank and club_wallet to none, and a club's promo
-- side to clubs.promo_balance, so both sides of those self-legs land on the
-- same account key and net to zero. The leg only doubled ledger rows and
-- inflated gross-flow reports.
--
-- WHAT IS KEPT, AND WHY (measured against chip_ledger history, read-only):
--   * bbj_pool. fn_bbj_move_between_banks (live) declares the pool itself as
--     counterparty, and fn_bbj_reconcile / fn_bbj_open_pool_baseline meter each
--     bank by the bbj_pools.* label on ONE side of a self-leg ("a bank move is
--     two self-legs, one label each"). History: 12 bbj_payout legs 2026-09-08/09
--     and the 2026-09-04 chip-std-migrate pair. Skipping would blind the meters.
--   * union_wallet. Six columns under one key; a bare side is already refused
--     by chip_ledger_a_union_wallet_side_names_its_column, and its self-legs
--     would be the only record of which column moved.
--   * promo_wallet off a club (agents, club_members, unions). One user holds
--     agents.promo_wallet_balance AND club_members.promo_balance, and
--     fn_ca_leg_accounts resolves the bare side by the other side's label, so
--     there a self-leg is the record of a move between two promo columns.
--   * Any labelled counterparty (cplbl NOT NULL): it documents a real
--     sub-balance move.
-- No chips move, nothing is backfilled or deleted; the five historical
-- self-legs stay as written (the journal is append-only).
--
-- fn_ca_autoledger is on fn_ca_guard_watchlist(), so the redefinition is
-- declared in this transaction.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure)) = '620ce72294bdf8e3c8d3c556c8de35c9'

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure)) IS DISTINCT FROM '852f2e9b202459d7450407b71b7cb6f8' THEN
    RAISE EXCEPTION 'AUTOLEDGER_SELF_LEG_PREIMAGE_CHANGED: fn_ca_autoledger is not the definition this migration was written against';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid; cplbl text;
  v_club uuid; v_union uuid; v_entity uuid; v_guc_club uuid;
  actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NEW;
  END IF;

  o  := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  nn := to_jsonb(NEW);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
  cp  := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  /* THE COUNTERPARTY NAMES ITS COLUMN (2026-10-04). A union wallet holds six
     balances and a promo bank lives on three kinds of owner, so the side this
     trigger writes for a declared union_wallet or promo_wallet counterparty
     carries the column the caller declared on app.ledger_counterparty_label.
     A label that cannot belong to the declared counterparty is not written:
     a stale declaration never names the wrong account. */
  cplbl := NULLIF(current_setting('app.ledger_counterparty_label', true), '');
  cplbl := CASE
    WHEN cp = 'union_wallet' AND cplbl LIKE 'union_wallets.%' THEN cplbl
    WHEN cp = 'promo_wallet' AND cplbl IN ('clubs.promo_balance', 'agents.promo_wallet_balance',
                                           'union_wallets.promo_wallet') THEN cplbl
    ELSE NULL END;
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  /* THE JOURNAL LEG NAMES THE CLUB THE MONEY LANDED IN (2026-09-20).
     union_wallets and unions are the only autoledgered tables with no
     club_id column - `nn ? 'club_id'` is key EXISTENCE, so a table
     that has the column takes the arm above even when it is NULL. Before
     today every leg journalled from those two was written club-less, and
     fn_chip_drift_since_baseline filters movements on club_id IS NOT
     NULL while counting the balance they explain, so correctly paid
     union-hosted prizes were reported as member drift.
     A payer that knows the club declares it on
     app.ledger_autoledger_club_id, transaction-scoped, and clears it
     beside the autoskips. It is deliberately NOT app.ledger_club_id:
     that name is taken and decides which club a WALLET credit is paid
     into (atomic_credit_wallet_and_log, atomic_deduct_wallet_and_log,
     log_wallet_transaction), so borrowing it would let a rakeback
     close's club leak onto a union leg and would move real money when
     cleared. Read through an exception guard exactly as cpid is above:
     a malformed value must never abort a chip movement. */
  BEGIN
    v_guc_club := NULLIF(current_setting('app.ledger_autoledger_club_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_guc_club := NULL;
  END;
  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE v_guc_club END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (nn->>'id')::uuid
    WHEN nn ? 'union_id' THEN NULLIF(nn->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME = 'agents' THEN NULLIF(nn->>'user_id','')::uuid
    WHEN TG_TABLE_NAME = 'club_members' THEN NULLIF(nn->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(nn->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := COALESCE(NULLIF(o->>col,'')::numeric, 0);
    newv := COALESCE(NULLIF(nn->>col,'')::numeric, 0);
    d := round(newv - oldv, 2);
    CONTINUE WHEN d = 0;
    /* THE AUTOLEDGER NEVER JOURNALS AN ACCOUNT TO ITSELF (2026-10-15). A leg
       whose counterparty is this very account, unlabelled, is from and to the
       same account (2026-10-06 15:42 KF player to three club treasuries;
       2026-09-17 16:39/16:41 treasury to promo). It nets to zero in every
       tally, so it is not written. A bbj_pool, a union_wallet and a promo bank
       off a club hold more than one column under one key, and their bare
       self-legs are the only record of which column moved: kept. */
    CONTINUE WHEN cp = acct AND cpid IS NOT DISTINCT FROM v_entity AND cplbl IS NULL
              AND acct NOT IN ('bbj_pool', 'union_wallet')
              AND (acct <> 'promo_wallet' OR TG_TABLE_NAME = 'clubs');

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN cplbl ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE cplbl END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN NEW;
END $function$
;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure)) IS DISTINCT FROM '620ce72294bdf8e3c8d3c556c8de35c9' THEN
    RAISE EXCEPTION 'AUTOLEDGER_SELF_LEG_RESULT_CHANGED: fn_ca_autoledger is not the definition this migration writes';
  END IF;
END
$post$;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_autoledger', 'migration 20261015133250_the_autoledger_never_journals_an_account_to_itself');

COMMIT;
