-- 20261025151354_lightning_top_up_original_intents_finish_at_the_final_hand_b.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- Function DDL and new private tables only; no trigger/table DDL on hot
-- relations. Pinned replacements preserve existing trigger order and ACLs.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- An accepted Lightning request is an UNCHARGED intent until every hand that
-- owns its anchor has ended. No foreign keys or DDL locks on hot tables.
-- The original amount, operation id and occupancy never change. Existing
-- atomic_table_addon owns the only eventual wallet debit, ledger and baseline.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure))='7b61caed8bde5127d965292c73e57915') AND (SELECT md5(pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure))='5c93a296a71bcb65508b4ad9b1a4a303') AND (SELECT md5(pg_get_functiondef('public.fn_table_seats_lightning_pool_follows_seat()'::regprocedure))='0f738b5541890d55753de110b23d3dc7') AND (SELECT md5(pg_get_functiondef('public.fn_lightning_instance_releases_its_reservations()'::regprocedure))='8b237f0f6891ff1bd1abb6008b343498') AND to_regclass('smarter_private.lightning_top_up_intents') IS NOT NULL AND has_function_privilege('service_role','public.fn_lightning_top_up_request(uuid,uuid,text,numeric)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_lightning_top_up_request(uuid,uuid,text,numeric)','EXECUTE')

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '20s';

CREATE TABLE smarter_private.lightning_top_up_intents (
  table_id uuid NOT NULL, user_id uuid NOT NULL, request_id text NOT NULL,
  anchor_seat_id uuid NOT NULL, occupancy_id uuid NOT NULL,
  pool_session_id uuid NOT NULL, cluster_id uuid NOT NULL, cash_session_id uuid NOT NULL,
  requested numeric NOT NULL CHECK (requested > 0 AND requested = round(requested,2) AND requested::text NOT IN ('NaN','Infinity','-Infinity')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','refused')),
  applied numeric NOT NULL DEFAULT 0 CHECK (applied >= 0 AND applied <= requested),
  reason text, stack_after numeric, balance_after numeric,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (table_id,user_id,request_id),
  CHECK (request_id ~ '^[A-Za-z0-9-]{8,64}$'),
  CHECK ((status='pending' AND completed_at IS NULL AND applied=0)
      OR (status<>'pending' AND completed_at IS NOT NULL)),
  CHECK (status<>'refused' OR applied=0)
);
CREATE TABLE smarter_private.lightning_top_up_sessions (
 pool_session_id uuid PRIMARY KEY,
 applied_count bigint NOT NULL DEFAULT 0 CHECK(applied_count>=0)
);
ALTER TABLE smarter_private.lightning_top_up_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.lightning_top_up_sessions FROM PUBLIC,anon,authenticated,service_role;

CREATE INDEX lightning_top_up_own_completed ON smarter_private.lightning_top_up_intents(pool_session_id,created_at DESC,request_id DESC) WHERE status<>'pending';
CREATE INDEX lightning_top_up_own_pending ON smarter_private.lightning_top_up_intents(pool_session_id,created_at,request_id) WHERE status='pending';
CREATE INDEX lightning_top_up_anchor_pending ON smarter_private.lightning_top_up_intents(anchor_seat_id) WHERE status='pending';
CREATE INDEX lightning_top_up_table_player_pending ON smarter_private.lightning_top_up_intents(table_id,user_id,created_at,request_id) WHERE status='pending';
CREATE INDEX lightning_top_up_cluster_player_pending ON smarter_private.lightning_top_up_intents(cluster_id,user_id) WHERE status='pending';
CREATE UNIQUE INDEX lightning_top_up_one_pending_occupancy
  ON smarter_private.lightning_top_up_intents(occupancy_id) WHERE status='pending';
ALTER TABLE smarter_private.lightning_top_up_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.lightning_top_up_intents FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.lightning_top_up_receipt(r smarter_private.lightning_top_up_intents)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,smarter_private,pg_temp AS $function$
 SELECT jsonb_build_object('success',r.status<>'refused','status',r.status,
   'queued',r.status='pending','charged',r.status='applied','requested',r.requested,
   'applied',r.applied,'request_id',r.request_id,'table_id',r.table_id,'user_id',r.user_id,
   'pool_session_id',r.pool_session_id,'occupancy_id',r.occupancy_id,
   'stack',r.stack_after,'balance',r.balance_after,'reason',r.reason,
   'error',CASE WHEN r.status='refused' THEN 'Lightning Top Up Refused: '||coalesce(r.reason,'refused') END);
$function$;
REVOKE ALL ON FUNCTION smarter_private.lightning_top_up_receipt(smarter_private.lightning_top_up_intents) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.lightning_top_up_finish(p_table uuid,p_user uuid,p_cancel text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,smarter_private,pg_temp AS $function$
DECLARE r smarter_private.lightning_top_up_intents%ROWTYPE; s public.table_seats%ROWTYPE;
 ps public.lightning_pool_session%ROWTYPE; maximum numeric; amount numeric; why text;
 balance numeric; final_stack numeric; err text;
BEGIN
 -- Request and funding take the anchor BEFORE the intent. Completion already
 -- owns these anchor locks; cancellation never takes a seat or moves chips.
 IF p_cancel IS NULL THEN
   SELECT * INTO s FROM public.table_seats
     WHERE table_id=p_table AND user_id=p_user AND left_at IS NULL FOR UPDATE;
 END IF;
 FOR r IN SELECT * FROM smarter_private.lightning_top_up_intents
   WHERE table_id=p_table AND user_id=p_user AND status='pending'
   ORDER BY created_at,request_id FOR UPDATE
 LOOP
   SELECT * INTO ps FROM public.lightning_pool_session WHERE id=r.pool_session_id;
   why:=p_cancel; amount:=0; balance:=NULL; final_stack:=NULL;
   IF why IS NULL THEN
     SELECT * INTO ps FROM public.lightning_pool_session WHERE id=r.pool_session_id;
     IF s.id IS DISTINCT FROM r.anchor_seat_id OR s.occupancy_id IS DISTINCT FROM r.occupancy_id
        OR s.left_at IS NOT NULL OR s.leave_pending IS TRUE
        OR ps.exited_at IS NOT NULL OR ps.state IN ('closed','leaving')
        OR ps.cash_player_session_id IS DISTINCT FROM r.cash_session_id
        OR NOT EXISTS (SELECT 1 FROM public.cash_player_session c WHERE c.id=r.cash_session_id
                       AND c.closed_at IS NULL) THEN why:='occupancy_or_session_closed';
     ELSIF public.fn_platform_frozen() THEN why:='maintenance';
     ELSIF public.fn_lightning_player_live_hand(p_user,r.cluster_id) IS NOT NULL THEN
       CONTINUE;
     ELSE
       SELECT t.max_buy_in INTO maximum FROM public.tables t WHERE t.id=p_table;
       amount:=CASE WHEN maximum IS NOT NULL AND maximum>0
         THEN round(least(r.requested,greatest(0,maximum-s.stack)),2)
         ELSE r.requested END;
       IF amount<=0 THEN why:='table_maximum';
       ELSE
         BEGIN
           -- The original platform money transaction, with an immutable key.
           balance:=public.atomic_table_addon(p_user,p_table,amount,true,
             'lightning-addon:'||p_table::text||':'||p_user::text||':'||r.request_id);
           SELECT stack INTO final_stack FROM public.table_seats WHERE id=r.anchor_seat_id;
         EXCEPTION WHEN OTHERS THEN
           -- Subtransaction rolls back EVERY debit/credit/ledger write. A
           -- top-up refusal must never undo an otherwise valid settled hand.
           GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
           why:='funding_refused:'||SQLSTATE||':'||left(err,160); amount:=0;
         END;
       END IF;
     END IF;
   END IF;
   UPDATE smarter_private.lightning_top_up_intents SET
     status=CASE WHEN why IS NULL THEN 'applied' ELSE 'refused' END,
     applied=CASE WHEN why IS NULL THEN amount ELSE 0 END,reason=why,
     stack_after=final_stack,balance_after=balance,completed_at=clock_timestamp()
   WHERE table_id=r.table_id AND user_id=r.user_id AND request_id=r.request_id
   RETURNING * INTO r;
   IF r.status='applied' THEN
     INSERT INTO smarter_private.lightning_top_up_sessions(pool_session_id,applied_count)
     VALUES(r.pool_session_id,1) ON CONFLICT(pool_session_id) DO UPDATE
       SET applied_count=lightning_top_up_sessions.applied_count+1;
   END IF;
   INSERT INTO public.cash_cluster_events(game_id,kind,payload,cluster_epoch)
   SELECT r.cluster_id,'lightning_top_up_completed',
     smarter_private.lightning_top_up_receipt(r)-'balance',ps.cluster_epoch;
 END LOOP;
END
$function$;
REVOKE ALL ON FUNCTION smarter_private.lightning_top_up_finish(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.lightning_top_up_finish(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.fn_lightning_top_up_request(p_table_id uuid,p_user_id uuid,p_request_id text,p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,smarter_private,pg_temp AS $function$
DECLARE s public.table_seats%ROWTYPE; ps public.lightning_pool_session%ROWTYPE;
 r smarter_private.lightning_top_up_intents%ROWTYPE;
BEGIN
 IF p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9-]{8,64}$'
    OR p_amount IS NULL OR p_amount<=0 OR p_amount<>round(p_amount,2)
    OR p_amount::text IN ('NaN','Infinity','-Infinity') THEN
   RETURN jsonb_build_object('success',false,'error','Invalid Lightning Top Up Request');
 END IF;
 SELECT * INTO s FROM public.table_seats WHERE table_id=p_table_id AND user_id=p_user_id
   AND left_at IS NULL FOR UPDATE;
 SELECT * INTO r FROM smarter_private.lightning_top_up_intents
   WHERE table_id=p_table_id AND user_id=p_user_id AND request_id=p_request_id;
 IF FOUND THEN
   IF r.requested IS DISTINCT FROM p_amount THEN
     RETURN jsonb_build_object('success',false,'error','Top Up Request Payload Changed');
   END IF;
   RETURN smarter_private.lightning_top_up_receipt(r)||jsonb_build_object('replayed',true);
 END IF;
 IF s.id IS NULL OR s.occupancy_id IS NULL OR s.leave_pending IS TRUE OR public.fn_platform_frozen() THEN
   RETURN jsonb_build_object('success',false,'error','Lightning Seat Is Unavailable');
 END IF;
 SELECT * INTO ps FROM public.lightning_pool_session WHERE anchor_seat_id=s.id
   AND player_id=p_user_id AND exited_at IS NULL;
 IF NOT FOUND OR ps.state NOT IN ('active','sit_out') OR ps.cash_player_session_id IS NULL THEN
   RETURN jsonb_build_object('success',false,'error','Lightning Session Is Unavailable');
 END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.lightning_top_up_intents WHERE occupancy_id=s.occupancy_id AND status='pending') THEN
   RETURN jsonb_build_object('success',false,'error','A Lightning Top Up Is Already Pending');
 END IF;
 INSERT INTO smarter_private.lightning_top_up_intents
   (table_id,user_id,request_id,anchor_seat_id,occupancy_id,pool_session_id,cluster_id,cash_session_id,requested)
 VALUES(p_table_id,p_user_id,p_request_id,s.id,s.occupancy_id,ps.id,ps.cluster_id,ps.cash_player_session_id,p_amount);
 PERFORM smarter_private.lightning_top_up_finish(p_table_id,p_user_id);
 SELECT * INTO STRICT r FROM smarter_private.lightning_top_up_intents
   WHERE table_id=p_table_id AND user_id=p_user_id AND request_id=p_request_id;
 RETURN smarter_private.lightning_top_up_receipt(r);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_lightning_top_up_request(uuid,uuid,text,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_top_up_request(uuid,uuid,text,numeric) TO service_role;

CREATE FUNCTION public.fn_lightning_top_up_receipts(p_pool_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,smarter_private,pg_temp AS $function$
DECLARE ps public.lightning_pool_session%ROWTYPE; result jsonb;
BEGIN
 SELECT * INTO ps FROM public.lightning_pool_session WHERE id=p_pool_session_id AND player_id=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'own Lightning session required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('pool_session_id',ps.id,'user_id',ps.player_id,
   'baseline',c.baseline,'balance',cm.chip_balance,
   'applied_count',coalesce((SELECT applied_count FROM smarter_private.lightning_top_up_sessions z WHERE z.pool_session_id=ps.id),0),
   'receipts',coalesce((SELECT jsonb_agg(smarter_private.lightning_top_up_receipt(r) ORDER BY r.created_at)
     FROM (SELECT * FROM smarter_private.lightning_top_up_intents x
           WHERE x.pool_session_id=ps.id AND x.status='pending'
           UNION ALL
           (SELECT * FROM smarter_private.lightning_top_up_intents x
            WHERE x.pool_session_id=ps.id AND x.status<>'pending'
            ORDER BY x.created_at DESC,x.request_id DESC LIMIT 32)) r),'[]'::jsonb))
 INTO result FROM public.cash_player_session c
 JOIN public.table_seats s ON s.id=ps.anchor_seat_id
 JOIN public.club_members cm ON cm.club_id=s.club_id AND cm.user_id=ps.player_id
 WHERE c.id=ps.cash_player_session_id;
 RETURN result;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_lightning_top_up_receipts(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_top_up_receipts(uuid) TO authenticated,service_role;

CREATE FUNCTION smarter_private.lightning_top_up_pending(p_anchor uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,smarter_private,pg_temp AS $function$
 SELECT EXISTS (SELECT 1 FROM smarter_private.lightning_top_up_intents
   WHERE anchor_seat_id=p_anchor AND status='pending');
$function$;
REVOKE ALL ON FUNCTION smarter_private.lightning_top_up_pending(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.lightning_top_up_pending(uuid) TO service_role;

CREATE FUNCTION pg_temp.lightning_top_up_patch(sig text,pre text,post text,a text,b text)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE before text:=pg_get_functiondef(sig::regprocedure); after text; security_before jsonb;
BEGIN
 IF md5(before)<>pre OR (length(before)-length(replace(before,a,'')))/length(a)<>1 THEN
   RAISE EXCEPTION 'Lightning top up preimage or anchor refused: % %',sig,md5(before);
 END IF;
 SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) INTO security_before
 FROM pg_proc WHERE oid=sig::regprocedure;
 after:=replace(before,a,b);
 IF md5(after)<>post THEN RAISE EXCEPTION 'Lightning top up derived postimage refused'; END IF;
 EXECUTE after;
 IF md5(pg_get_functiondef(sig::regprocedure))<>post OR
   (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
    FROM pg_proc WHERE oid=sig::regprocedure) IS DISTINCT FROM security_before THEN
   RAISE EXCEPTION 'Lightning top up postimage or security refused';
 END IF;
END
$function$;

SELECT pg_temp.lightning_top_up_patch('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)','9dfe2626d4dbed01843f67cc69c430ad','f6def524c80911265ec0508901dd6d56',$old$       AND public.fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, g.id, ps.player_id)$old$,$new$       AND public.fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, g.id, ps.player_id)
       AND NOT smarter_private.lightning_top_up_pending(ps.anchor_seat_id)$new$);

SELECT pg_temp.lightning_top_up_patch('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)','12f205a7d67fa3662ec3e88dcad1f506','5c93a296a71bcb65508b4ad9b1a4a303',$old$        WHEN coalesce(public.fn_lightning_pool_stack(f.pool_session_id), 0) <= 0 THEN 'NO_STACK'$old$,$new$        WHEN smarter_private.lightning_top_up_pending(f.anchor_seat_id) THEN 'TOP_UP_PENDING'
        WHEN coalesce(public.fn_lightning_pool_stack(f.pool_session_id), 0) <= 0 THEN 'NO_STACK'$new$);

SELECT pg_temp.lightning_top_up_patch('public.fn_table_seats_lightning_pool_follows_seat()','c813c6ea7e46dbada0b9164405ee11b1','0f738b5541890d55753de110b23d3dc7',$old$  IF NEW.left_at IS NULL AND NEW.user_id IS NOT NULL$old$,$new$  IF TG_OP='UPDATE' AND ((OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
      OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    PERFORM smarter_private.lightning_top_up_finish(OLD.table_id,OLD.user_id,'seat_left');
  END IF;

  IF NEW.left_at IS NULL AND NEW.user_id IS NOT NULL$new$);

SELECT pg_temp.lightning_top_up_patch('public.fn_lightning_instance_releases_its_reservations()','c939c6325086f93f6b9fce077348125d','8b237f0f6891ff1bd1abb6008b343498',$old$  RETURN NULL;$old$,$new$  -- One authoritative terminal boundary, including early folders no longer
  -- holding a reservation. The final outstanding hand applies; abandonment
  -- cancels the uncharged request without touching wallet or seat.
  PERFORM smarter_private.lightning_top_up_finish(q.table_id,q.user_id,
    CASE WHEN NEW.state='abandoned' THEN 'hand_abandoned' END)
  FROM (SELECT DISTINCT r.table_id,r.user_id
    FROM smarter_private.lightning_top_up_intents r
    WHERE r.cluster_id=NEW.cluster_id AND r.status='pending'
      AND (r.user_id=ANY(v_players) OR EXISTS
        (SELECT 1 FROM public.lightning_hand_player hp
         WHERE hp.hand_id=NEW.hand_id AND hp.player_id=r.user_id))
    ORDER BY r.user_id,r.table_id) q;
  RETURN NULL;$new$);

SELECT pg_temp.lightning_top_up_patch('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)','f6def524c80911265ec0508901dd6d56','7b61caed8bde5127d965292c73e57915',$old$  -- BARRIER STEP 1, AND THE LOCK THAT MAKES IT MEAN SOMETHING.$old$,$new$  -- A stale plan is checked under the same anchor locks as its stack.
  -- A funded request is not needed here: this is an uncharged original intent.
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps
      WHERE ps.cluster_id=g.id AND ps.player_id=ANY(v_cand)
        AND ps.exited_at IS NULL AND smarter_private.lightning_top_up_pending(ps.anchor_seat_id)) THEN
    RETURN jsonb_build_object('ok',true,'formed',false,'retry',true,'reason','top_up_pending');
  END IF;

  -- BARRIER STEP 1, AND THE LOCK THAT MAKES IT MEAN SOMETHING.$new$);

COMMIT;
