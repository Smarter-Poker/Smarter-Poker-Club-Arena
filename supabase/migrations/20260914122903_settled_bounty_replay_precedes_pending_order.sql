-- R34: exact settled-marker replay precedes admission-only PKO ordering.
-- Reserved with scripts/reserve-migration-version.sh. No money, receipt,
-- generation, lane, pending-order or privilege rules change.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE
  target oid := 'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure;
  source_text text; definition text; before_metadata jsonb; after_metadata jsonb;
  pending_order text := $order$  IF o.mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=o.tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark THEN
      RETURN jsonb_build_object('ok',false,'reason','pko_order_already_advanced',
                                'last_settled_hand_number',v_pko_watermark);
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations prior
       WHERE prior.tournament_id=o.tournament_id AND prior.mode='pko'
         AND prior.state='pending' AND prior.hand_number<o.hand_number
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','pending_pko_predecessor');
    END IF;
  END IF;
$order$;
  anchor text := '  -- Ignore caller ordering/weights.';
BEGIN
  SELECT p.prosrc,pg_get_functiondef(p.oid),
    jsonb_build_object('owner',r.rolname,'acl',p.proacl::text,'config',p.proconfig,
                       'definer',p.prosecdef,'volatility',p.provolatile)
    INTO source_text,definition,before_metadata
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=target;
  IF before_metadata IS DISTINCT FROM
      '{"owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"definer":true,"volatility":"v"}'::jsonb THEN
    RAISE EXCEPTION 'settled bounty replay refused: function privileges or metadata changed';
  END IF;
  IF md5(source_text)='6dcaf498835e691b15384aa5aabcfdfe' THEN
    RAISE NOTICE 'settled bounty replay postimage already installed';
    RETURN;
  END IF;
  IF md5(source_text)<>'b684f48642dcaa9541a326eca06e7a2c' THEN
    RAISE EXCEPTION 'settled bounty replay refused: unreviewed source %',md5(source_text);
  END IF;
  IF (length(source_text)-length(replace(source_text,pending_order,'')))/length(pending_order)<>1
     OR (length(source_text)-length(replace(source_text,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'settled bounty replay refused: ordering anchors changed';
  END IF;
  definition:=replace(definition,pending_order,'');
  definition:=replace(definition,anchor,pending_order||E'\n'||anchor);
  EXECUTE definition;
  SELECT p.prosrc,jsonb_build_object('owner',r.rolname,'acl',p.proacl::text,
    'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)
    INTO source_text,after_metadata
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=target;
  IF md5(source_text)<>'6dcaf498835e691b15384aa5aabcfdfe'
     OR before_metadata IS DISTINCT FROM after_metadata THEN
    RAISE EXCEPTION 'settled bounty replay postimage or privileges mismatch';
  END IF;
END;
$migration$;
COMMIT;
