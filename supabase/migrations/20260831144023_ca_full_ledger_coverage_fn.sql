-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift directive).
-- This file is the byte-exact mirror of the applied migration.
-- NOTE: the trg_ca_autoledger attaches were applied to production as
-- separate short transactions immediately after this migration (deadlock
-- avoidance against live traffic); they are included below so a fresh
-- environment reaches the same state.
-- ZERO-DRIFT PART 3a: generic auto-ledger writer (trigger attaches follow in
-- separate short transactions to avoid deadlocking against live traffic;
-- see ca_full_ledger_coverage repo migration for the full set).
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid;
  v_club uuid; v_union uuid; v_entity uuid;
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
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE NULL END;
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

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.chip_ledger
          (performed_by, from_type, from_entity_id, from_label,
           to_type, to_entity_id, to_label,
           amount, category, club_id, union_id, description,
           pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
        VALUES (actor,
          CASE WHEN d > 0 THEN 'settlement_suspense' ELSE acct END,
          CASE WHEN d > 0 THEN NULL ELSE v_entity END,
          CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
          CASE WHEN d > 0 THEN acct ELSE 'settlement_suspense' END,
          CASE WHEN d > 0 THEN v_entity ELSE NULL END,
          CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
          abs(d), 'adjustment', v_club, v_union,
          'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text
            || ' (category ' || cat || ' or counterparty ' || cp || ' rejected)',
          CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
          CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        BEGIN
          INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
          VALUES (v_club, v_entity, d, v_st,
                  'fn_ca_autoledger ' || TG_TABLE_NAME || '.' || col || ': ' || v_msg);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END;
    END;
  END LOOP;

  RETURN NEW;
END $$;

-- ── Attach to every balance store ──────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.clubs;
CREATE TRIGGER trg_ca_autoledger
  AFTER INSERT OR UPDATE OF chip_treasury, chip_pool, promo_balance, insurance_balance
  ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger(
    'chip_treasury=club_treasury', 'chip_pool=club_treasury',
    'promo_balance=promo_wallet', 'insurance_balance=insurance_bank');

DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.club_wallets;
CREATE TRIGGER trg_ca_autoledger
  AFTER INSERT OR UPDATE OF chip_balance, insurance_balance
  ON public.club_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger(
    'chip_balance=club_wallet', 'insurance_balance=insurance_bank');

DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.union_wallets;
CREATE TRIGGER trg_ca_autoledger
  AFTER INSERT OR UPDATE OF chip_balance, rake_wallet, bbj_wallet, promo_wallet,
                            insurance_wallet, spin_reserve_wallet
  ON public.union_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger(
    'chip_balance=union_bank', 'rake_wallet=union_wallet', 'bbj_wallet=union_wallet',
    'promo_wallet=union_wallet', 'insurance_wallet=union_wallet',
    'spin_reserve_wallet=union_wallet');

DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.unions;
CREATE TRIGGER trg_ca_autoledger
  AFTER UPDATE OF chip_balance, rake_wallet, main_bbj_balance, backup_bbj_balance,
                  promo_fund_balance, insurance_balance
  ON public.unions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger(
    'chip_balance=union_bank', 'rake_wallet=union_wallet',
    'main_bbj_balance=bbj_pool', 'backup_bbj_balance=bbj_pool',
    'promo_fund_balance=promo_wallet', 'insurance_balance=insurance_bank');

DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.agents;
CREATE TRIGGER trg_ca_autoledger
  AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance
  ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger(
    'agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet');

DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.bbj_pools;
CREATE TRIGGER trg_ca_autoledger
  AFTER INSERT OR UPDATE OF main_balance, backup_balance, promo_balance, pool_amount
  ON public.bbj_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger(
    'main_balance=bbj_pool', 'backup_balance=bbj_pool',
    'promo_balance=bbj_pool', 'pool_amount=bbj_pool');

DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.spin_bonus_pools;
CREATE TRIGGER trg_ca_autoledger
  AFTER INSERT OR UPDATE OF balance
  ON public.spin_bonus_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger('balance=spin_reserve');

DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.club_members;
CREATE TRIGGER trg_ca_autoledger
  AFTER UPDATE OF promo_balance
  ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger('promo_balance=promo_wallet');
