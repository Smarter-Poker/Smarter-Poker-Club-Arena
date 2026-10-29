-- KINGS CLUB promo wallet moved -770; the journal reader counted -400.
-- All seven sends exist in the immutable journal. Four player sends total
-- 270 and one agent cash-wallet send is 100; their NULL source label made
-- them unkeyable because the reader depended on a recipient promo label.
-- Name the source at the payer and carry its declaration through the member
-- trigger. Read historical unlabelled promo sides by their actual club owner.
-- No journal rewrite, wallet adjustment, recurring repair or engine restart.
-- Exact preimages and reverse-body checks preserve all other behavior/ACLs.
-- @live-proof: position('club_members.chip_balance'' ELSE cplbl' in pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE d text; before text; a text;
BEGIN
  d := pg_get_functiondef('public.fn_ca_leg_accounts(timestamp with time zone,timestamp with time zone)'::regprocedure);
  IF md5(d) <> '7dfdfdaa9170b26d701ef055e767a433' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_PREIMAGE_CHANGED: fn_ca_leg_accounts'; END IF;
  SELECT proacl::text INTO a FROM pg_proc WHERE oid='public.fn_ca_leg_accounts(timestamp with time zone,timestamp with time zone)'::regprocedure;
  IF a IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_ACL_CHANGED'; END IF;
  before := d;
  d := replace(d, 'CASE WHEN s.other_lbl LIKE ''%promo%'' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)', 'CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)');
  EXECUTE d;
  d := pg_get_functiondef('public.fn_ca_leg_accounts(timestamp with time zone,timestamp with time zone)'::regprocedure);
  d := replace(d, 'CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)', 'CASE WHEN s.other_lbl LIKE ''%promo%'' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)');
  IF d IS DISTINCT FROM before OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_leg_accounts(timestamp with time zone,timestamp with time zone)'::regprocedure) IS DISTINCT FROM a THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_POSTIMAGE_CHANGED'; END IF;
  d := pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamp with time zone,pg_snapshot)'::regprocedure);
  IF md5(d) <> '5f683348ef884af04382a46fb70955d9' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_PREIMAGE_CHANGED: fn_ca_leg_accounts_since_snapshot'; END IF;
  SELECT proacl::text INTO a FROM pg_proc WHERE oid='public.fn_ca_leg_accounts_since_snapshot(timestamp with time zone,pg_snapshot)'::regprocedure;
  IF a IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_ACL_CHANGED'; END IF;
  before := d;
  d := replace(d, 'CASE WHEN s.other_lbl LIKE ''%promo%'' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)', 'CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)');
  EXECUTE d;
  d := pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamp with time zone,pg_snapshot)'::regprocedure);
  d := replace(d, 'CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)', 'CASE WHEN s.other_lbl LIKE ''%promo%'' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)');
  IF d IS DISTINCT FROM before OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_leg_accounts_since_snapshot(timestamp with time zone,pg_snapshot)'::regprocedure) IS DISTINCT FROM a THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_POSTIMAGE_CHANGED'; END IF;
  d := pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamp with time zone,pg_snapshot,uuid[])'::regprocedure);
  IF md5(d) <> '316009375b55fd4b4f1f30033c245cbd' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_PREIMAGE_CHANGED: fn_ca_leg_accounts_since_snapshot_for'; END IF;
  SELECT proacl::text INTO a FROM pg_proc WHERE oid='public.fn_ca_leg_accounts_since_snapshot_for(timestamp with time zone,pg_snapshot,uuid[])'::regprocedure;
  IF a IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_ACL_CHANGED'; END IF;
  before := d;
  d := replace(d, 'CASE WHEN s.other_lbl LIKE ''%promo%'' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)', 'CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)');
  EXECUTE d;
  d := pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamp with time zone,pg_snapshot,uuid[])'::regprocedure);
  d := replace(d, 'CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)', 'CASE WHEN s.other_lbl LIKE ''%promo%'' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)');
  IF d IS DISTINCT FROM before OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_leg_accounts_since_snapshot_for(timestamp with time zone,pg_snapshot,uuid[])'::regprocedure) IS DISTINCT FROM a THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_POSTIMAGE_CHANGED'; END IF;
  d := pg_get_functiondef('public.fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure);
  IF md5(d) <> '6b1f531d0ce49ecc2defaab3481a91c2' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_PREIMAGE_CHANGED: fn_club_promo_send_core_20261004'; END IF;
  SELECT proacl::text INTO a FROM pg_proc WHERE oid='public.fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure;
  IF a IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_ACL_CHANGED'; END IF;
  before := d;
  d := replace(d, '''club_promo_send:'' || v_op_id::text, array[''clubs'']);', '''club_promo_send:'' || v_op_id::text, array[''clubs'']);
  perform set_config(''app.ledger_counterparty_label'', ''clubs.promo_balance'', true);');
  EXECUTE d;
  d := pg_get_functiondef('public.fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure);
  d := replace(d, '''club_promo_send:'' || v_op_id::text, array[''clubs'']);
  perform set_config(''app.ledger_counterparty_label'', ''clubs.promo_balance'', true);', '''club_promo_send:'' || v_op_id::text, array[''clubs'']);');
  IF d IS DISTINCT FROM before OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure) IS DISTINCT FROM a THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_POSTIMAGE_CHANGED'; END IF;
  d := pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure);
  IF md5(d) <> 'd9b0429e6c88b7a2dc4e732edab6ed10' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_PREIMAGE_CHANGED: fn_club_members_ledger_writer'; END IF;
  SELECT proacl::text INTO a FROM pg_proc WHERE oid='public.fn_club_members_ledger_writer()'::regprocedure;
  IF a IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_ACL_CHANGED'; END IF;
  before := d;
  d := replace(d, '  cpid  uuid;', '  cpid  uuid;
  cplbl text;');
  d := replace(d, '  BEGIN
    INSERT INTO public.chip_ledger', '  cplbl := NULLIF(current_setting(''app.ledger_counterparty_label'', true), '''');
  cplbl := CASE
    WHEN cp = ''union_wallet'' AND cplbl LIKE ''union_wallets.%'' THEN cplbl
    WHEN cp = ''promo_wallet'' AND cplbl IN (''clubs.promo_balance'', ''agents.promo_wallet_balance'',
                                           ''union_wallets.promo_wallet'') THEN cplbl
    ELSE NULL END;

  BEGIN
    INSERT INTO public.chip_ledger');
  d := replace(d, '(performed_by, from_type, from_entity_id, to_type, to_entity_id,', '(performed_by, from_type, from_entity_id, from_label, to_type, to_entity_id, to_label,');
  d := replace(d, 'CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,', 'CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN cplbl ELSE ''club_members.chip_balance'' END,');
  d := replace(d, 'CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,', 'CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      CASE WHEN d > 0 THEN ''club_members.chip_balance'' ELSE cplbl END,');
  EXECUTE d;
  d := pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure);
  d := replace(d, 'CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      CASE WHEN d > 0 THEN ''club_members.chip_balance'' ELSE cplbl END,', 'CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,');
  d := replace(d, 'CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN cplbl ELSE ''club_members.chip_balance'' END,', 'CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,');
  d := replace(d, '(performed_by, from_type, from_entity_id, from_label, to_type, to_entity_id, to_label,', '(performed_by, from_type, from_entity_id, to_type, to_entity_id,');
  d := replace(d, '  cplbl := NULLIF(current_setting(''app.ledger_counterparty_label'', true), '''');
  cplbl := CASE
    WHEN cp = ''union_wallet'' AND cplbl LIKE ''union_wallets.%'' THEN cplbl
    WHEN cp = ''promo_wallet'' AND cplbl IN (''clubs.promo_balance'', ''agents.promo_wallet_balance'',
                                           ''union_wallets.promo_wallet'') THEN cplbl
    ELSE NULL END;

  BEGIN
    INSERT INTO public.chip_ledger', '  BEGIN
    INSERT INTO public.chip_ledger');
  d := replace(d, '  cpid  uuid;
  cplbl text;', '  cpid  uuid;');
  IF d IS DISTINCT FROM before OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_members_ledger_writer()'::regprocedure) IS DISTINCT FROM a THEN RAISE EXCEPTION 'CLUB_PROMO_SOURCE_POSTIMAGE_CHANGED'; END IF;
END $patch$;
COMMIT;
