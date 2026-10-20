-- A covered heartbeat observes an existing promise; it does not renew it.
-- Keep the original exclusive transition for every actual extension/refusal.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $patch$
DECLARE
  src text;
  needle constant text := $old$  SELECT li.id, li.state, li.deadline_at, li.hand_id
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;$old$;
  replacement constant text := $new$  -- A covered deadline needs no mutation or custody. This answer linearizes
  -- at this MVCC read, just as any heartbeat answer may become obsolete after
  -- its transaction. It cannot extend a deadline or revive a terminal hand.
  SELECT li.id, li.state, li.deadline_at, li.hand_id
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id;
  IF FOUND AND i.state IN ('dealing', 'settling')
     AND i.deadline_at > v_now AND i.deadline_at >= v_now + v_extend THEN
    RETURN jsonb_build_object('ok', true, 'alive', true, 'instance_id', i.id, 'hand_id', i.hand_id,
                              'state', i.state, 'deadline_at', i.deadline_at);
  END IF;

  -- All other paths retain exclusive custody and re-read the authoritative row.
  SELECT li.id, li.state, li.deadline_at, li.hand_id
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;$new$;
BEGIN
  SELECT pg_get_functiondef('public.fn_lightning_instance_keepalive(uuid,interval,timestamptz)'::regprocedure) INTO src;
  IF md5(src) <> '5f1ffb62c357ce54e781c9a068eec1b3' THEN
    RAISE EXCEPTION 'Lightning keepalive preimage changed';
  END IF;
  IF position(needle IN src) = 0 OR position(needle IN substring(src FROM position(needle IN src) + length(needle))) > 0 THEN
    RAISE EXCEPTION 'Lightning keepalive patch location changed';
  END IF;
  EXECUTE replace(src, needle, replacement);
  SELECT pg_get_functiondef('public.fn_lightning_instance_keepalive(uuid,interval,timestamptz)'::regprocedure) INTO src;
  IF position(replacement IN src) = 0 OR position('UPDATE public.lightning_instance li SET deadline_at = v_deadline WHERE li.id = i.id;' IN src) = 0 THEN
    RAISE EXCEPTION 'Lightning keepalive patch effect missing';
  END IF;
END $patch$;
-- @live-proof: (SELECT position('AND i.deadline_at > v_now AND i.deadline_at >= v_now + v_extend THEN' IN pg_get_functiondef('public.fn_lightning_instance_keepalive(uuid,interval,timestamptz)'::regprocedure))>0)
COMMIT;
