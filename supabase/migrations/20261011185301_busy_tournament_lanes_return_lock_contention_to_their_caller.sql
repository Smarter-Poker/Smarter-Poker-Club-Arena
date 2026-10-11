-- @live-proof:md5(pg_get_functiondef('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure)) = 'b335c4664d2b029e920e998edd18666f'
-- @live-proof: md5(pg_get_functiondef('public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure)) = '3e35e1835eb8bdcede7f6c4b8f001fb5'
-- @live-proof: md5(pg_get_functiondef('smarter_private.f06_aborted_hand_guard()'::regprocedure)) = '49046cee6eb91ce98c44564e0590e452'
-- @live-proof: md5(pg_get_functiondef('smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure)) = '3219dd0db0c0de9e8f9c02f4609eaaf8'
-- @live-proof: md5(pg_get_functiondef('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)'::regprocedure)) = '2e89f3de1f243ecc22089355df2b1698'
-- @live-proof: md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure)) = '2cb07986223473917ab28dd889ced884'
-- @live-proof: md5(pg_get_functiondef('smarter_private.f06_try_lane(uuid)'::regprocedure)) = 'a0c4e1b564f90f934222cd298c668b2b'

-- Version reserved by scripts/new-migration.mjs. Phase13 live verification blocker.
-- PostgREST14.5 internally repeats custom40001, leaking request-pool capacity.
-- Production18:10-18:45UTC:18852140001 errors; PGRST003/PGRST002 and real stalls.
-- https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b
-- Failed try-locks are55P03 (lock_not_available), retaining F06_RETRY_CANONICAL_LANE
-- so existing bounded engine retries remain authoritative. Two comparisons on
-- rows already FOR UPDATE are55000: repeating the transaction cannot change them.
-- Predicates, locks, messages, custody, money, owner/configuration/ACL are identical.
-- Six F06 bodies and one ticket body change only nine custom SQLSTATE literals.
-- Never retry/replay a migration or remove a guard. Exact postimages make local
-- replay a no-op; an unknown preimage aborts before any definition changes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $install$
DECLARE r record; d text; n text; back text; owner_before oid; security_before boolean;
 config_before text[]; acl_before aclitem[]; changed integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
    ('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)','c647cbdc2efb229423bab9aaf2f8b5f5','b335c4664d2b029e920e998edd18666f','55000',2)
,    ('public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb)','1c45252d2701562fbd9d189927f418aa','3e35e1835eb8bdcede7f6c4b8f001fb5','55P03',1)
,    ('smarter_private.f06_aborted_hand_guard()','56c232740eb495dd2e2164159dfe782c','49046cee6eb91ce98c44564e0590e452','55P03',1)
,    ('smarter_private.f06_cancelled_preparation_writer_guard()','a7467e2cb64bab202a359eed42432299','3219dd0db0c0de9e8f9c02f4609eaaf8','55P03',1)
,    ('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)','4a960ad8ba45a470d23b84b84a60d65f','2e89f3de1f243ecc22089355df2b1698','55P03',1)
,    ('smarter_private.f06_source_guard()','7dcdbb47269833c9fa0fe6cb8568dee9','2cb07986223473917ab28dd889ced884','55P03',2)
,    ('smarter_private.f06_try_lane(uuid)','78a3a191b9991b0a3a343db39de335aa','a0c4e1b564f90f934222cd298c668b2b','55P03',1)
 ) AS pins(signature,preimage,postimage,new_code,expected_changes)
 LOOP
  d:=pg_get_functiondef(r.signature::regprocedure);
  IF md5(d)=r.postimage THEN CONTINUE; END IF;
  IF md5(d)<>r.preimage THEN RAISE EXCEPTION 'tournament lane preimage drift: %',r.signature; END IF;
  SELECT proowner,prosecdef,proconfig,proacl INTO owner_before,security_before,config_before,acl_before
    FROM pg_proc WHERE oid=r.signature::regprocedure;
  IF r.new_code='55P03' THEN
   n:=regexp_replace(d,$re$(RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE'\s+USING ERRCODE=)'40001'$re$,
      $replacement$\1'55P03'$replacement$,'g');
   back:=regexp_replace(n,$re$(RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE'\s+USING ERRCODE=)'55P03'$re$,
      $replacement$\1'40001'$replacement$,'g');
  ELSE
   n:=regexp_replace(d,$re$(RAISE EXCEPTION '(?:ticket admission tournament cache changed|tournament-entry ticket changed during admission)'\s+USING ERRCODE=)'40001'$re$,
      $replacement$\1'55000'$replacement$,'g');
   back:=regexp_replace(n,$re$(RAISE EXCEPTION '(?:ticket admission tournament cache changed|tournament-entry ticket changed during admission)'\s+USING ERRCODE=)'55000'$re$,
      $replacement$\1'40001'$replacement$,'g');
  END IF;
  changed:=(length(d)-length(replace(d,$code$'40001'$code$,'')))/7
          -(length(n)-length(replace(n,$code$'40001'$code$,'')))/7;
  IF changed<>r.expected_changes OR md5(n)<>r.postimage OR back IS DISTINCT FROM d THEN
    RAISE EXCEPTION 'tournament lane substitution drift: %',r.signature;
  END IF;
  EXECUTE n;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=r.signature::regprocedure
    AND proowner=owner_before AND prosecdef=security_before
    AND proconfig IS NOT DISTINCT FROM config_before AND proacl IS NOT DISTINCT FROM acl_before)
   OR md5(pg_get_functiondef(r.signature::regprocedure))<>r.postimage THEN
    RAISE EXCEPTION 'tournament lane metadata/postimage drift: %',r.signature;
  END IF;
 END LOOP;
END $install$;
COMMIT;

