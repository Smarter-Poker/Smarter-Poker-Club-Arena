-- Refuse new transfers involving authoritative deleted identities under the
-- existing ordered profile locks. Recover already-committed receipts first.
-- No settlement, confiscation, balance rewrite or changed friendship/cap policy.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $patch$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
 SELECT pg_get_functiondef('public.send_wallet_diamond_transfer(uuid,integer,text,text)'::regprocedure) INTO v_definition;
 IF md5(v_definition)<>'8d5b95d8ad2a74c1ba85339168349606' THEN
   RAISE EXCEPTION 'Diamond transfer preimage changed; qualify current source';
 END IF;
 v_old := $old$  -- Rechecked at the writer, even when the UI selected an accepted friend.$old$;
 v_new := $new$  -- Receipt replay precedes this refusal; profile deletion shares these locks.
  IF EXISTS (SELECT 1 FROM public.profiles
             WHERE id IN (v_sender, p_recipient_id) AND status = 'deleted') THEN
    RETURN jsonb_build_object('success', false, 'code', 'transfer_player_deleted',
      'error', 'This Player Is No Longer Available.');
  END IF;

  -- Rechecked at the writer, even when the UI selected an accepted friend.$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Diamond transfer guard preimage missing'; END IF;
 EXECUTE replace(v_definition,v_old,v_new);
END
$patch$;
COMMIT;
