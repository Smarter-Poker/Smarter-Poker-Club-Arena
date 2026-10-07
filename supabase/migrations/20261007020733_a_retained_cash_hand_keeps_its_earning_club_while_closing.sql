-- Original cash recovery must use the proven original funding club when its
-- chair was erased/replaced, including shared-union rake attribution. The same
-- accepted transaction must own consumed custody, immutable qualification,
-- original retained request and completed time bank. Unknown ordinary seats
-- keep their existing refusal. Closing cash tables are admitted by the native
-- successor/settlement owner and must be admitted by its custody helper too.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $patch$
DECLARE d text;old text;replacement text;
BEGIN
 IF md5(pg_get_functiondef('smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)'::regprocedure))
 IS DISTINCT FROM '81fb89ad4db51ca9eb68754ebb8f384f' THEN RAISE EXCEPTION 'RETIRED_CASH_ADOPT_PREIMAGE_DRIFT'; END IF;
 d:=pg_get_functiondef('smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)'::regprocedure);
 old:=$a$AND t.lifecycle='live')$a$;
 replacement:=$a$AND t.lifecycle IN('live','breaking'))$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_CLOSING_ANCHOR_DRIFT'; END IF;
 EXECUTE replace(d,old,replacement);
 IF md5(pg_get_functiondef('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure))
 IS DISTINCT FROM 'efb0c06347c4a12f91ec796558f8660d' THEN RAISE EXCEPTION 'RETIRED_CASH_EARNING_PREIMAGE_DRIFT'; END IF;
 d:=pg_get_functiondef('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure);
 old:=$a$ IF p_union_id IS NULL THEN$a$;
 replacement:=$a$ -- Original off-chair custody exists only in the accepted native hand's
 -- transaction. Never derive ownership from today's replacement chair.
 IF started IS NOT NULL AND isfinite(started) AND started<=transaction_timestamp() THEN
  SELECT array_agg(DISTINCT r.funding_club_id) INTO clubs
  FROM smarter_private.retired_cash_hand_custody r
  JOIN smarter_private.retired_cash_hand_qualification q USING(submission_id)
  JOIN smarter_private.hand_submissions s USING(submission_id)
  JOIN smarter_private.hand_submission_handoffs h USING(submission_id)
  JOIN public.hand_atomic_commits a ON a.hand_id=r.submission_id
   AND a.table_id=r.table_id AND a.hand_number=r.hand_number
  WHERE r.submission_id=p_hand_id AND r.table_id=p_table_id AND r.user_id=p_player_id
   AND r.state='consumed' AND r.transaction_id=txid_current()
   AND h.transaction_id=r.transaction_id AND h.request_hash=r.request_hash
   AND s.request_hash=r.request_hash AND q.request_hash=r.request_hash
   AND r.accepted_time_bank=r.original_time_bank AND r.settlement_id IS NOT NULL
   AND (q.table_id,q.hand_number)=(r.table_id,r.hand_number)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.expected->'participants') e
    WHERE (e#>>'{stack,user_id}')::uuid=r.user_id
     AND (e#>>'{stack,seat_id}')::uuid=r.seat_id
     AND (e#>>'{stack,occupancy_id}')::uuid=r.occupancy_id
     AND (e#>>'{stack,seat_joined_at}')::timestamptz=r.seat_joined_at
     AND (e#>>'{stack,stack_before}')::numeric=r.stack_before
     AND (e#>>'{stack,stack}')::numeric=r.stack_after
     AND (e->>'funding_club_id')::uuid=r.funding_club_id);
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN clubs[1]; END IF;
 END IF;
 IF p_union_id IS NULL THEN$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_EARNING_ANCHOR_DRIFT'; END IF;
 EXECUTE replace(d,old,replacement);
END $patch$;
DO $proof$
BEGIN
 IF md5(pg_get_functiondef('smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)'::regprocedure))<>'cb60a3624bb45d03dbd77c4d8cdc3305'
 OR md5(pg_get_functiondef('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure))<>'0327409fe4751720376893776b124c60' THEN
 RAISE EXCEPTION 'RETIRED_CASH_EARNING_POSTIMAGE_DRIFT'; END IF;
END $proof$;
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='cb60a3624bb45d03dbd77c4d8cdc3305' AND md5(prosrc)='576c5a49e39c9d92a52a58c8a65f3a01' AND proowner='postgres'::regrole AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('service_role',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='0327409fe4751720376893776b124c60' AND md5(prosrc)='a1b4a90ef90cc00b7d3fd2b9ae18c067' AND proowner='postgres'::regrole AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure)
COMMIT;
