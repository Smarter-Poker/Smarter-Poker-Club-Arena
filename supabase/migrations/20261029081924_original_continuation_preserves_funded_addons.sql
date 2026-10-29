-- Same original hand, plus a separately funded immutable post-anchor add-on.
-- Never rewrite the original private controller, prehand baseline, chairs or live stacks.
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)') AND md5(p.prosrc)='d9ab367cbbb8e7a1ae67f83fb23dfe13' AND md5(pg_get_functiondef(p.oid))='e8802ea2c324d58caf4d53e95e6f85fa' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $addon$ DECLARE f regprocedure:='public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure;d text;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(p.prosrc)='42dc66013ad08ec677bf1bd0c2fd6fe6' AND md5(pg_get_functiondef(p.oid))='90ddd69be6ba6378789f2e4ab0aa6fea' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_ADDON_PREIMAGE_CHANGED' USING ERRCODE='55000';END IF;
 IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_tournament_accounting_evidence_immutable()'::regprocedure AND md5(p.prosrc)='45d556a440dc8cb930ef48f291a395dd' AND p.proowner='postgres'::regrole) AND (SELECT count(*)=2 FROM pg_trigger t WHERE t.tgrelid='public.tournament_participant_funding_receipts'::regclass AND t.tgname IN('original_evidence_immutable','original_evidence_no_truncate') AND t.tgfoid='public.fn_ca_tournament_accounting_evidence_immutable()'::regprocedure AND t.tgenabled='O' AND NOT t.tgisinternal)) THEN RAISE EXCEPTION 'HAND_CONTINUATION_ADDON_EVIDENCE_CHANGED' USING ERRCODE='55000';END IF;
 d:=pg_get_functiondef(f);IF length(d)-length(replace(d,'AND s.stack = (x->>''stack_before'')::numeric)) THEN',''))<>length('AND s.stack = (x->>''stack_before'')::numeric)) THEN') THEN RAISE EXCEPTION 'HAND_CONTINUATION_ADDON_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,'AND s.stack = (x->>''stack_before'')::numeric)) THEN','AND (s.stack = (x->>''stack_before'')::numeric
                  OR EXISTS (
                    -- An add-on bought after this original was retained is
                    -- outside the hand. Its immutable funded receipt proves
                    -- the exact credit; delta settlement preserves it.
                    SELECT 1 FROM public.tournament_players tp
                    JOIN public.tournament_participant_funding_receipts r
                      ON r.registration_id=tp.id AND r.tournament_id=tp.tournament_id
                     AND r.user_id=tp.user_id
                    WHERE tp.tournament_id=p_tournament_id AND tp.user_id=s.user_id
                      AND tp.table_id=s.table_id AND tp.seat_number=s.seat_number
                      AND tp.add_on IS TRUE AND tp.chips=s.stack
                      AND r.operation=''addon'' AND r.observed_at>c.created_at
                      AND r.purchase_key=''tourney:''||p_tournament_id::text||'':addon:''||s.user_id::text
                      AND r.custody_result->>''success''=''true''
                      AND r.registration_snapshot->>''id''=tp.id::text
                      AND r.registration_snapshot->>''tournament_id''=p_tournament_id::text
                      AND r.registration_snapshot->>''user_id''=s.user_id::text
                      AND r.registration_snapshot->>''table_id''=s.table_id::text
                      AND (r.registration_snapshot->>''seat_number'')::integer=s.seat_number
                      AND r.registration_snapshot->>''add_on''=''true''
                      AND (r.registration_snapshot->>''chips'')::numeric=s.stack
                      AND r.tournament_snapshot->>''id''=p_tournament_id::text
                      AND (r.tournament_snapshot->>''addon_chips'')::numeric>0
                      AND r.amount=(r.tournament_snapshot->>''addon_cost'')::numeric
                      AND s.stack=(x->>''stack_before'')::numeric
                        +(r.tournament_snapshot->>''addon_chips'')::numeric)))) THEN');
 IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)') AND md5(p.prosrc)='d9ab367cbbb8e7a1ae67f83fb23dfe13' AND md5(pg_get_functiondef(p.oid))='e8802ea2c324d58caf4d53e95e6f85fa' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])) THEN RAISE EXCEPTION 'HAND_CONTINUATION_ADDON_POSTIMAGE_CHANGED';END IF;
END $addon$;
COMMIT;
