-- Settlement and formation must lock the same economic anchors in seat-id order.
-- Recent 40P01 production logs show settlement vs matcher cycles on table_seats.
-- Only anchor acquisition order changes; request hashes, receipts, deltas and
-- physical settlement are unchanged. No financial records are rewritten.
-- @live-proof: (SELECT md5(prosrc) = '11a27ab2e92d129ceab9201cbe2737f9' FROM pg_proc WHERE oid = 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
DO $anchor_order$
DECLARE b text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)
    IS DISTINCT FROM 'c9cece954b567607c11d7a1016f4eaa2' THEN
  RAISE EXCEPTION 'lightning_anchor_order_preimage_changed';
 END IF;
 SELECT pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure) INTO b;
 b := replace(b, 'ORDER BY (x ->> ''player_id'')::uuid LOOP', 'ORDER BY (x ->> ''anchor_seat_id'')::uuid LOOP');
 b := replace(b, '-- 5. THE ANCHORS, FOR UPDATE, IN PLAYER ORDER, each named in the marker',
                 '-- 5. THE ANCHORS, FOR UPDATE, IN SEAT ORDER, each named in the marker');
 EXECUTE b;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)
    IS DISTINCT FROM '11a27ab2e92d129ceab9201cbe2737f9' THEN
  RAISE EXCEPTION 'lightning_anchor_order_postimage_changed';
 END IF;
END $anchor_order$;
COMMIT;
