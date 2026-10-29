-- Preserve original CHIPS-funded add-ons using their immutable canonical funding triplet.
-- DIAMONDS still requires successful custody. Missing/failed/pending evidence never qualifies.
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)') AND md5(p.prosrc)='a083d06d4906dc350350b847faf1c73f' AND md5(pg_get_functiondef(p.oid))='b92400fc1ddc2908cdd42866f547ede6' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $chips$ DECLARE f regprocedure:='public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure;d text;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(p.prosrc)='d9ab367cbbb8e7a1ae67f83fb23dfe13' AND md5(pg_get_functiondef(p.oid))='e8802ea2c324d58caf4d53e95e6f85fa' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHIP_FUNDING_PREIMAGE_CHANGED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)'::regprocedure AND md5(pg_get_functiondef(p.oid))='6cfd4af7307ce31460fd62c5b3f38bef' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_tournament_accounting_evidence_immutable()'::regprocedure AND md5(p.prosrc)='45d556a440dc8cb930ef48f291a395dd' AND p.proowner='postgres'::regrole) OR (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.tournament_participant_funding_receipts'::regclass AND t.tgname IN('original_evidence_immutable','original_evidence_no_truncate') AND t.tgenabled='O' AND t.tgfoid='public.fn_ca_tournament_accounting_evidence_immutable()'::regprocedure)<>2 THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHIP_FUNDING_OWNER_CHANGED' USING ERRCODE='55000';END IF;
 d:=pg_get_functiondef(f);IF length(d)-length(replace(d,'r.custody_result->>''success''=''true''',''))<>length('r.custody_result->>''success''=''true''') THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHIP_FUNDING_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,'r.custody_result->>''success''=''true''','((r.asset=''diamonds'' AND r.custody_result->>''success''=''true'')
                        OR (r.asset=''chips'' AND r.amount>0 AND r.custody_result IS NULL
                          AND r.entitlement_id IS NOT NULL AND r.ledger_id IS NOT NULL
                          AND r.wallet_transaction_id IS NOT NULL AND r.funding_club_id IS NOT NULL
                          AND r.entitlement_snapshot->>''id''=r.entitlement_id::text
                          AND r.entitlement_snapshot->>''entitlement_kind''=''wallet_charge''
                          AND r.entitlement_snapshot->>''charge_category''=''addon''
                          AND r.entitlement_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.entitlement_snapshot->>''user_id''=r.user_id::text
                          AND (r.entitlement_snapshot->>''gross'')::numeric=r.amount
                          AND r.entitlement_snapshot->>''source_ledger_id''=r.ledger_id::text
                          AND r.entitlement_snapshot->>''refund_wallet_club_id''=r.funding_club_id::text
                          AND r.ledger_snapshot->>''id''=r.ledger_id::text
                          AND r.ledger_snapshot->>''status''=''posted''
                          AND r.ledger_snapshot->>''from_type''=''player_wallet''
                          AND r.ledger_snapshot->>''to_type''=''prize_liability''
                          AND r.ledger_snapshot->>''category''=''addon''
                          AND r.ledger_snapshot->>''from_entity_id''=r.user_id::text
                          AND r.ledger_snapshot->>''to_entity_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''club_id''=r.funding_club_id::text
                          AND (r.ledger_snapshot->>''amount'')::numeric=r.amount
                          AND r.wallet_snapshot->>''id''=r.wallet_transaction_id::text
                          AND r.wallet_snapshot->>''type''=''debit''
                          AND r.wallet_snapshot->>''category''=''addon''
                          AND r.wallet_snapshot->>''user_id''=r.user_id::text
                          AND r.wallet_snapshot->>''related_entity_id''=r.tournament_id::text
                          AND (r.wallet_snapshot->>''amount'')::numeric=r.amount))');
 IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)') AND md5(p.prosrc)='a083d06d4906dc350350b847faf1c73f' AND md5(pg_get_functiondef(p.oid))='b92400fc1ddc2908cdd42866f547ede6' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])) THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHIP_FUNDING_POSTIMAGE_CHANGED';END IF;
END $chips$;
COMMIT;
