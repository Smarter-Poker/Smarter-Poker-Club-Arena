-- Preserve the BBJ meter's complete financial result while separating cumulative
-- bank totals from the recent interval counters in one SQL statement/snapshot.
-- Natural cron155 failed eight consecutive hours after narrow pool indexes;
-- the actual backend repeatedly waited on DataFilePrefetch with no observed
-- blockers. Canonical incoming bank labels use bounded covering values; every
-- exceptional/NULL label, outgoing/self/cross-pool leg keeps original semantics.
-- No baseline reset, financial write, timeout, schedule or caller changes.
-- Build scripts/ops/build-bbj-cumulative-bank-indexes-concurrently.sql first,
-- as independently owned top-level concurrent statements, never in this batch.
-- @live-proof: (SELECT position('WITH cumulative_legs AS (' in pg_get_functiondef('public.fn_bbj_reconcile(uuid)'::regprocedure))>0 AND (SELECT count(*)=4 FROM (VALUES ('chip_ledger_bbj_to_pool_meter', 'CREATE INDEX chip_ledger_bbj_to_pool_meter ON public.chip_ledger USING btree (to_entity_id, created_at) WHERE ((to_type = ''bbj_pool''::text) AND ((to_label ~~ ''bbj_pools.%''::text) OR (from_label ~~ ''bbj_pools.%''::text)))'),       ('chip_ledger_bbj_from_pool_meter', 'CREATE INDEX chip_ledger_bbj_from_pool_meter ON public.chip_ledger USING btree (from_entity_id, created_at) WHERE ((from_type = ''bbj_pool''::text) AND ((to_label ~~ ''bbj_pools.%''::text) OR (from_label ~~ ''bbj_pools.%''::text)))'),       ('chip_ledger_bbj_incoming_banks_cover', 'CREATE INDEX chip_ledger_bbj_incoming_banks_cover ON public.chip_ledger USING btree (to_entity_id, created_at) INCLUDE (to_label, amount) WHERE ((to_type = ''bbj_pool''::text) AND (to_label = ANY (ARRAY[''bbj_pools.main_balance''::text, ''bbj_pools.backup_balance''::text, ''bbj_pools.promo_balance''::text])) AND (octet_length(to_label) <= 64))'),       ('chip_ledger_bbj_incoming_other_labels', 'CREATE INDEX chip_ledger_bbj_incoming_other_labels ON public.chip_ledger USING btree (to_entity_id, created_at) WHERE ((to_type = ''bbj_pool''::text) AND ((to_label ~~ ''bbj_pools.%''::text) OR (from_label ~~ ''bbj_pools.%''::text)) AND (((to_label = ANY (ARRAY[''bbj_pools.main_balance''::text, ''bbj_pools.backup_balance''::text, ''bbj_pools.promo_balance''::text])) AND (octet_length(to_label) <= 64)) IS NOT TRUE))')) w(name,definition) JOIN pg_class c ON c.oid=to_regclass('public.'||w.name) JOIN pg_index i ON i.indexrelid=c.oid WHERE i.indisvalid AND i.indisready AND i.indislive AND pg_get_indexdef(c.oid)=w.definition))
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $migration$
DECLARE
  v_oid oid := 'public.fn_bbj_reconcile(uuid)'::regprocedure;
  v_src text; v_next text; v_acl aclitem[]; v_owner oid; v_config text[]; v_bad text;
BEGIN
  SELECT pg_get_functiondef(oid),proacl,proowner,proconfig INTO v_src,v_acl,v_owner,v_config
    FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) IS DISTINCT FROM 'df98293beac30ceff81db8779a9fb6f2'
    OR v_acl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    OR v_owner IS DISTINCT FROM 'postgres'::regrole::oid
    OR v_config IS DISTINCT FROM ARRAY['search_path=public']::text[] THEN
    RAISE EXCEPTION 'BBJ_CUMULATIVE_SOURCE_OR_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a JOIN (VALUES
      ('to_entity_id','uuid'),('from_entity_id','uuid'),('created_at','timestamp with time zone'),
      ('amount','numeric(15,2)'),('to_label','text'),('from_label','text')
    ) w(name,typ) ON a.attname=w.name AND format_type(a.atttypid,a.atttypmod)=w.typ
    WHERE a.attrelid='public.chip_ledger'::regclass AND NOT a.attisdropped)<>6 THEN
    RAISE EXCEPTION 'BBJ_CUMULATIVE_LEDGER_TYPES_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT string_agg(w.name,', ' ORDER BY w.name) INTO v_bad FROM (VALUES
      ('chip_ledger_bbj_to_pool_meter', 'CREATE INDEX chip_ledger_bbj_to_pool_meter ON public.chip_ledger USING btree (to_entity_id, created_at) WHERE ((to_type = ''bbj_pool''::text) AND ((to_label ~~ ''bbj_pools.%''::text) OR (from_label ~~ ''bbj_pools.%''::text)))'),
      ('chip_ledger_bbj_from_pool_meter', 'CREATE INDEX chip_ledger_bbj_from_pool_meter ON public.chip_ledger USING btree (from_entity_id, created_at) WHERE ((from_type = ''bbj_pool''::text) AND ((to_label ~~ ''bbj_pools.%''::text) OR (from_label ~~ ''bbj_pools.%''::text)))'),
      ('chip_ledger_bbj_incoming_banks_cover', 'CREATE INDEX chip_ledger_bbj_incoming_banks_cover ON public.chip_ledger USING btree (to_entity_id, created_at) INCLUDE (to_label, amount) WHERE ((to_type = ''bbj_pool''::text) AND (to_label = ANY (ARRAY[''bbj_pools.main_balance''::text, ''bbj_pools.backup_balance''::text, ''bbj_pools.promo_balance''::text])) AND (octet_length(to_label) <= 64))'),
      ('chip_ledger_bbj_incoming_other_labels', 'CREATE INDEX chip_ledger_bbj_incoming_other_labels ON public.chip_ledger USING btree (to_entity_id, created_at) WHERE ((to_type = ''bbj_pool''::text) AND ((to_label ~~ ''bbj_pools.%''::text) OR (from_label ~~ ''bbj_pools.%''::text)) AND (((to_label = ANY (ARRAY[''bbj_pools.main_balance''::text, ''bbj_pools.backup_balance''::text, ''bbj_pools.promo_balance''::text])) AND (octet_length(to_label) <= 64)) IS NOT TRUE))')
    ) w(name,definition)
    LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||w.name)
    LEFT JOIN pg_index i ON i.indexrelid=c.oid
    WHERE i.indexrelid IS NULL OR NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
       OR i.indrelid<>'public.chip_ledger'::regclass
       OR pg_get_indexdef(c.oid) IS DISTINCT FROM w.definition;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'BBJ_CUMULATIVE_INDEX_NOT_QUALIFIED: %',v_bad USING ERRCODE='55000';
  END IF;
  v_next := replace(v_src,$old$  WITH legs AS (
    SELECT l.category,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END AS signed,
           (l.created_at > v_prev.taken_at) AS in_interval,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.to_label
                WHEN l.from_label LIKE 'bbj_pools.%' THEN l.from_label END AS lbl,
           l.amount, l.from_type, l.to_type
      FROM public.chip_ledger l
     WHERE ((l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') OR (l.from_entity_id = p_pool_id AND l.from_type = 'bbj_pool'))
       -- FROM THE OPENING BALANCE, NOT THE LAST READING: a leg that
       -- straddles one reading is inside the next, instead of falling
       -- between two windows and never being counted at all. No upper
       -- bound: this statement's own snapshot is the bound.
       AND l.created_at > v_base.taken_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
  )
  , banks AS (
    SELECT COALESCE(main_balance, 0) AS m, COALESCE(backup_balance, 0) AS b, COALESCE(promo_balance, 0) AS p
      FROM public.bbj_pools WHERE id = p_pool_id
  )
  SELECT banks.m, banks.b, banks.p,
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.main_balance'), 0),
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.backup_balance'), 0),
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.promo_balance'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'bbj_contribution' AND to_type = 'bbj_pool' AND from_type <> 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'bbj_payout' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'promo' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'transfer' AND to_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND from_type = 'bbj_pool' AND to_type = 'bbj_pool'), 0) / 2
    INTO v_main, v_backup, v_promo, jm, jb, jp, v_drops, v_pay, v_sweep, v_fund, v_moves
    FROM banks LEFT JOIN legs ON true
   GROUP BY banks.m, banks.b, banks.p;

$old$,$new$  -- The banks, cumulative journal and recent flow counters share one snapshot.
  -- Canonical incoming labels have bounded index values. The exceptional
  -- incoming branch and outgoing branch preserve arbitrary and NULL labels.
  WITH cumulative_legs AS (
    SELECT l.amount AS signed, l.to_label AS lbl
      FROM public.chip_ledger l
     WHERE l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool'
       AND l.created_at > v_base.taken_at
       AND (l.to_label IN ('bbj_pools.main_balance', 'bbj_pools.backup_balance', 'bbj_pools.promo_balance') AND octet_length(l.to_label) <= 64)
    UNION ALL
    SELECT CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.to_label
                WHEN l.from_label LIKE 'bbj_pools.%' THEN l.from_label END
      FROM public.chip_ledger l
     WHERE l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool'
       AND l.created_at > v_base.taken_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
       AND (l.to_label IN ('bbj_pools.main_balance', 'bbj_pools.backup_balance', 'bbj_pools.promo_balance') AND octet_length(l.to_label) <= 64) IS NOT TRUE
    UNION ALL
    SELECT CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.to_label
                WHEN l.from_label LIKE 'bbj_pools.%' THEN l.from_label END
      FROM public.chip_ledger l
     WHERE l.from_entity_id = p_pool_id AND l.from_type = 'bbj_pool'
       AND (l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') IS NOT TRUE
       AND l.created_at > v_base.taken_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
  ), cumulative AS (
    SELECT COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.main_balance'), 0) AS m,
           COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.backup_balance'), 0) AS b,
           COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.promo_balance'), 0) AS p
      FROM cumulative_legs
  ), recent AS (
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.category = 'bbj_contribution' AND l.to_type = 'bbj_pool' AND l.from_type <> 'bbj_pool'), 0) AS drops,
           COALESCE(sum(l.amount) FILTER (WHERE l.category = 'bbj_payout' AND l.from_type = 'bbj_pool'), 0) AS payouts,
           COALESCE(sum(l.amount) FILTER (WHERE l.category = 'promo' AND l.from_type = 'bbj_pool'), 0) AS sweeps,
           COALESCE(sum(l.amount) FILTER (WHERE l.category = 'transfer' AND l.to_type = 'bbj_pool'), 0) AS funding,
           COALESCE(sum(l.amount) FILTER (WHERE l.from_type = 'bbj_pool' AND l.to_type = 'bbj_pool'), 0) / 2 AS moves
      FROM public.chip_ledger l
     WHERE ((l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') OR (l.from_entity_id = p_pool_id AND l.from_type = 'bbj_pool'))
       AND l.created_at > v_base.taken_at AND l.created_at > v_prev.taken_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
  ), banks AS (
    SELECT COALESCE(main_balance, 0) AS m, COALESCE(backup_balance, 0) AS b, COALESCE(promo_balance, 0) AS p
      FROM public.bbj_pools WHERE id = p_pool_id
  )
  SELECT banks.m, banks.b, banks.p, cumulative.m, cumulative.b, cumulative.p,
         recent.drops, recent.payouts, recent.sweeps, recent.funding, recent.moves
    INTO v_main, v_backup, v_promo, jm, jb, jp, v_drops, v_pay, v_sweep, v_fund, v_moves
    FROM banks CROSS JOIN cumulative CROSS JOIN recent;


$new$);
  IF v_next=v_src OR md5(v_next) IS DISTINCT FROM '48bb2fe0db2df27ffb0776970dc528b6' THEN
    RAISE EXCEPTION 'BBJ_CUMULATIVE_REPLACEMENT_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_next;
  IF NOT EXISTS(SELECT FROM pg_proc WHERE oid=v_oid AND proowner=v_owner
      AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_config
      AND prosecdef AND provolatile='v' AND pg_get_functiondef(oid)=v_next) THEN
    RAISE EXCEPTION 'BBJ_CUMULATIVE_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
END
$migration$;
COMMIT;
