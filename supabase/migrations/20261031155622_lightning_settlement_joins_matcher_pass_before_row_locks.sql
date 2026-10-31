-- A matcher retains anchors across multiple real formations in one pass.
-- Seat ordering within each group cannot order the whole transaction. A
-- settlement joins the existing matcher gate in SHARED mode BEFORE taking
-- any instance, anchor or slot row, while disjoint settlements stay parallel.
-- Native current-source multi-group regression reproduces 40P01 without it.
-- Request hashes, physical money writes, receipts and ACLs are unchanged.
-- @live-proof: (SELECT md5(prosrc) = '6d66c432d60034302d04258ca9c5f67f' FROM pg_proc WHERE oid = 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
DO $pass_admission$
DECLARE b text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)
    IS DISTINCT FROM '11a27ab2e92d129ceab9201cbe2737f9' THEN
  RAISE EXCEPTION 'lightning_pass_admission_preimage_changed';
 END IF;
 SELECT pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure) INTO b;
 b := replace(b, '  v_instance uuid;', E'  v_instance uuid;\n  v_cluster  uuid;');
 b := replace(b,
   'SELECT lh.lightning_instance_id INTO v_instance FROM public.lightning_hand lh WHERE lh.hand_id = p_hand_id;',
   'SELECT lh.lightning_instance_id, lh.cluster_id INTO v_instance, v_cluster FROM public.lightning_hand lh WHERE lh.hand_id = p_hand_id;');
 b := replace(b,
   '  SELECT li.id, li.state, li.started_at, li.abandon_reason, li.cluster_id, li.cluster_epoch',
$admission$  -- A matcher retains anchors across every group in its transaction. Join
  -- its pass gate before any instance/anchor/slot lock; settlers share it.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('lightning_matcher:' || v_cluster::text, 0));
  SELECT li.id, li.state, li.started_at, li.abandon_reason, li.cluster_id, li.cluster_epoch$admission$);
 EXECUTE b;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)
    IS DISTINCT FROM '6d66c432d60034302d04258ca9c5f67f' THEN
  RAISE EXCEPTION 'lightning_pass_admission_postimage_changed';
 END IF;
END $pass_admission$;
COMMIT;
