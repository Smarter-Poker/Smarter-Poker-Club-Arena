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
