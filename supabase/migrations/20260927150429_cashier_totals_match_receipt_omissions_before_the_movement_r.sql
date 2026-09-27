-- Cashier totals resolve mirrored identities before reading the movement range.
-- A real default-week browser request hit the unchanged 8s deadline in totals.
-- The old movement scan performed receipt anti-lookups per candidate ledger row.
-- Reuse the existing receipt key/type indexes and ledger key index to identify
-- only the mirrored movement IDs first, then anti-join those IDs once.
-- All scopes, filters, signs, refund windows and financial rows are unchanged.
-- Self/downline totals and all paged reads/exports retain their original probes.
-- No new index, grants,
-- timeout setting, schedule, table setting or financial write is introduced.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='8s';
SET LOCAL search_path=public,pg_temp;
DO $cashier$
DECLARE
  v_old text;
  v_new text;
  v_meta jsonb;
  v_after jsonb;
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_cashier_statement_downline(uuid,uuid)','f98d60a45ab3aa1110964e1c57958349'),
    ('public.fn_cashier_statement_export_cancel(uuid)','7772e8238e42f490c20e2235d1358ce2'),
    ('public.fn_cashier_statement_export_page(uuid,integer,integer)','3ab1d903bbd15f1b8c97e6bc168bc466'),
    ('public.fn_cashier_statement_export_start(uuid,timestamp with time zone,timestamp with time zone,jsonb,uuid)','64d8ce9fac09f83bb04105cded1e6177'),
    ('public.fn_cashier_statement_filters(timestamp with time zone,timestamp with time zone,jsonb)','e6117573c33ba2cfbaf8060f083b906d'),
    ('public.fn_cashier_statement_page(uuid,timestamp with time zone,timestamp with time zone,jsonb,jsonb,integer)','06493bb58a2199b8aaed0f950bafe2c2'),
    ('public.fn_cashier_statement_prune_expired()','a87705b0a595ffa4a22fe88b18ee3d8a'),
    ('public.fn_cashier_statement_rows(uuid,uuid,text,timestamp with time zone,timestamp with time zone,jsonb,timestamp with time zone,text,uuid,integer)','d6152f4bb944489aa4e1dfaf5417fc00'),
    ('public.fn_cashier_statement_scope(uuid)','5c3180605b76db07957f261b39914f8d'),
    ('public.fn_cashier_statement_totals(uuid,timestamp with time zone,timestamp with time zone,jsonb)','5e50033127ded658f0bb4de87e0a10e6')
  ) pins(signature, fingerprint) LOOP
    IF to_regprocedure(r.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(r.signature))) IS DISTINCT FROM r.fingerprint THEN
      RAISE EXCEPTION 'CASHIER_TOTALS_SOURCE_CHANGED: %',r.signature USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'fn\_cashier\_statement\_%'
      AND (p.proowner <> 'postgres'::regrole OR p.proacl IS DISTINCT FROM
        CASE WHEN p.proname IN ('fn_cashier_statement_rows','fn_cashier_statement_downline','fn_cashier_statement_filters','fn_cashier_statement_prune_expired')
        THEN '{postgres=X/postgres}'::aclitem[]
        ELSE '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] END)
  ) THEN RAISE EXCEPTION 'CASHIER_TOTALS_AUTHORITY_CHANGED'; END IF;
  -- The existing SQL NOT(refund AND type AND EXISTS) has two-valued category
  -- and type inputs. Refuse schema drift instead of changing NULL semantics.
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.chip_ledger'::regclass
      AND attname IN ('id','category','to_type') AND attnotnull AND NOT attisdropped) <> 3 THEN
    RAISE EXCEPTION 'CASHIER_TOTALS_NULL_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.ux_chip_ledger_idempotency_key')
    AND indrelid='public.chip_ledger'::regclass AND indisvalid AND indisready AND indislive
    AND pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)')
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_chip_tx_type_user_created')
    AND indrelid='public.chip_transactions'::regclass AND indisvalid AND indisready AND indislive
    AND pg_get_indexdef(indexrelid)='CREATE INDEX idx_chip_tx_type_user_created ON public.chip_transactions USING btree (transaction_type, to_user_id, created_at)') THEN
    RAISE EXCEPTION 'CASHIER_TOTALS_EXISTING_LOOKUP_INDEX_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT pg_get_functiondef(oid),jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'security',prosecdef,'volatility',provolatile)
    INTO v_old,v_meta FROM pg_proc WHERE oid='public.fn_cashier_statement_rows(uuid,uuid,text,timestamp with time zone,timestamp with time zone,jsonb,timestamp with time zone,text,uuid,integer)'::regprocedure;
  v_new := replace(v_old, $old_anchor$  IF v_labels_inside THEN$old_anchor$, $new_anchor$
  IF v_totals_only AND p_scope='all' THEN
    -- Compute the small set of receipt-mirrored identities first. Page/export
    -- branches retain their existing bounded per-row probes and keyset plans.
    v_movement_base := replace(v_movement_base, $omission$     AND NOT EXISTS (
       SELECT 1
         FROM public.chip_transactions represented
        WHERE represented.metadata ? 'idempotency_key'
          AND (represented.metadata ->> 'idempotency_key') = cl.idempotency_key
          AND represented.club_id = $1
          AND represented.created_at >= $3 - interval '1 day'
          AND represented.created_at < $4 + interval '1 day'
     )
     -- Restore mirrors (production, all 319 pairs): a seat_credit_restored
     -- receipt <-> a refund movement to the same player's wallet, same user,
     -- same club, sub-second gap. The +-1 minute window is the safety margin;
     -- the probe runs for refunds to a player_wallet only, on the player
     -- wallet (club_id, to_user_id, created_at) index.
     AND NOT (
       cl.category = 'refund'
       AND cl.to_type = 'player_wallet'
       AND EXISTS (
         SELECT 1
         FROM public.chip_transactions restored
         WHERE restored.transaction_type = 'seat_credit_restored'
           AND restored.to_user_id = cl.to_entity_id
           AND restored.created_at >= cl.created_at - interval '1 minute'
           AND restored.created_at <= cl.created_at + interval '1 minute'
           AND restored.club_id = cl.club_id
           AND restored.metadata ? 'restore_key'
           AND (restored.metadata->>'restore_key') = cl.idempotency_key
       )
     )$omission$,
      '     AND NOT EXISTS (SELECT 1 FROM omitted_movements omitted WHERE omitted.id = cl.id)');
  END IF;

  IF v_labels_inside THEN$new_anchor$);
  v_new := replace(v_new,$old_totals$    v_sql := E'SELECT NULL::timestamptz$old_totals$,$new_totals$    v_sql := CASE WHEN p_scope='all' THEN $omissions$WITH omitted_movements AS MATERIALIZED (
 SELECT matched.id FROM public.chip_transactions represented
 JOIN LATERAL (
   SELECT cl.id FROM public.chip_ledger cl
   WHERE cl.idempotency_key=represented.metadata->>'idempotency_key'
     AND cl.club_id=$1 AND cl.created_at >= $3 AND cl.created_at < $4
   OFFSET 0
 ) matched ON true
 WHERE represented.metadata ? 'idempotency_key'
   AND represented.club_id=$1
   AND represented.created_at >= $3-interval '1 day'
   AND represented.created_at < $4+interval '1 day'
 UNION
 SELECT matched.id FROM public.chip_transactions restored
 JOIN LATERAL (
   SELECT cl.id FROM public.chip_ledger cl
   WHERE cl.idempotency_key=restored.metadata->>'restore_key'
     AND cl.category='refund' AND cl.to_type='player_wallet'
     AND cl.to_entity_id=restored.to_user_id AND cl.club_id=restored.club_id
     AND cl.created_at >= $3 AND cl.created_at < $4
     AND restored.created_at >= cl.created_at-interval '1 minute'
     AND restored.created_at <= cl.created_at+interval '1 minute'
   OFFSET 0
 ) matched ON true
 WHERE restored.transaction_type='seat_credit_restored'
   AND restored.metadata ? 'restore_key' AND restored.club_id=$1
   AND restored.created_at >= $3-interval '1 minute'
   AND restored.created_at < $4+interval '1 minute'
)

$omissions$ ELSE '' END || E'SELECT NULL::timestamptz$new_totals$);
  IF v_new=v_old THEN RAISE EXCEPTION 'CASHIER_TOTALS_REWRITE_MISSING'; END IF;
  EXECUTE v_new;
  SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'security',prosecdef,'volatility',provolatile)
    INTO v_after FROM pg_proc WHERE oid='public.fn_cashier_statement_rows(uuid,uuid,text,timestamp with time zone,timestamp with time zone,jsonb,timestamp with time zone,text,uuid,integer)'::regprocedure;
  IF v_after IS DISTINCT FROM v_meta THEN RAISE EXCEPTION 'CASHIER_TOTALS_AUTHORITY_CHANGED'; END IF;
END
$cashier$;
COMMIT;
