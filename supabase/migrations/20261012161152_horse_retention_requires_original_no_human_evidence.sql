-- NULL/missing has_human means the original controller supplied no dealt
-- roster. A current horse profile cannot prove an old hand had no humans.
-- Require original explicit JSON boolean false for retained request payloads,
-- and explicit history false for pruning. Preserve all existing guards.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $patch$
DECLARE sig text; expected text; anchor text; replacement text;
 target oid; source text; metadata jsonb; actual jsonb;
BEGIN
 FOR sig,expected,anchor,replacement IN
 SELECT * FROM (VALUES
  ('smarter_private.horse_request_payload_disposable(uuid)',
   '693a294213e52267aaac2890832cc9e4',
   $old$ IF s.request#>>'{p_hand_row,has_human}'='true'$old$,
   $new$ IF (s.request#>'{p_hand_row,has_human}') IS DISTINCT FROM 'false'::jsonb$new$),
  ('public.sp_prune_hand_history(integer)',
   'f8c87e2f7d6cc4d31e9329c0adefd35c',
   $old$       WHERE hh.has_human IS DISTINCT FROM true$old$,
   $new$       WHERE hh.has_human IS FALSE
         AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submissions original
           WHERE original.table_id=hh.table_id AND original.hand_number=hh.hand_number
             AND (original.request#>'{p_hand_row,has_human}') IS DISTINCT FROM 'false'::jsonb)$new$)
 ) AS edits(signature,hash,old_text,new_text)
 LOOP
  target:=sig::regprocedure;
  SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',p.proowner,'acl',p.proacl,'secdef',p.prosecdef,'settings',p.proconfig)
  INTO source,metadata FROM pg_proc p WHERE p.oid=target;
  IF md5(source) IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'HORSE_RETENTION_CLASSIFICATION_SOURCE_CHANGED_OR_ALREADY_INSTALLED: %',sig USING ERRCODE='55000'; END IF;
  IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'HORSE_RETENTION_CLASSIFICATION_ANCHOR_CHANGED: %',sig USING ERRCODE='55000'; END IF;
  EXECUTE replace(source,anchor,replacement);
  SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'secdef',p.prosecdef,'settings',p.proconfig)
  INTO actual FROM pg_proc p WHERE p.oid=target;
  IF actual IS DISTINCT FROM metadata THEN
   RAISE EXCEPTION 'HORSE_RETENTION_CLASSIFICATION_AUTHORITY_CHANGED: %',sig USING ERRCODE='55000'; END IF;
 END LOOP;
END $patch$;
COMMIT;
