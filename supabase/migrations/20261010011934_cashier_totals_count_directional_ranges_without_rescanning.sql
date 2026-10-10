-- Version reserved by scripts/new-migration.mjs.
-- Reduce the default owner total to one directional range per source; retain
-- exact omitted movements, NaN semantics and every filtered/page fallback.
-- Apply Merged Migration builds this preamble alone, validates it, then runs
-- the guarded transaction and records this exact file in migration history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_cashier_direction_totals ON public.chip_ledger(club_id,created_at DESC) INCLUDE(amount,from_entity_id,to_entity_id) WHERE status='posted' AND category=ANY(ARRAY['buyin','addon','rebuy','tournament_prize','bounty','refund','spin_entry','spin_prize','promo','promo_send','treasury_transfer','transfer','player_funding','agent_funding','overlay','reversal','correction','adjustment','leaderboard_payout']::text[]);
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $guard$
DECLARE ix record; cols text[];
BEGIN
 IF md5(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)) <> '72d29ab402ff75ae3f240ce40a750437'
 OR md5(pg_get_functiondef('public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)'::regprocedure)) <> '5e50033127ded658f0bb4de87e0a10e6'
 THEN RAISE EXCEPTION 'cashier_source_preimage_changed'; END IF;
 IF (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}'
 OR (SELECT proowner FROM pg_proc WHERE oid='public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)<>(SELECT oid FROM pg_roles WHERE rolname='postgres')
 THEN RAISE EXCEPTION 'cashier_private_authority_changed'; END IF;
 SELECT i.*,c.relowner,c.relpersistence,c.reloptions,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.idx_chip_ledger_cashier_direction_totals');
 IF NOT FOUND THEN RAISE EXCEPTION 'cashier_direction_cover_missing'; END IF;
 SELECT array_agg(a.attname::text ORDER BY k.ord) INTO cols
 FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
 JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum;
 IF ix.indrelid <> 'public.chip_ledger'::regclass OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.indnkeyatts<>2 OR ix.indnatts<>5
 OR ix.indexprs IS NOT NULL OR ix.amname<>'btree' OR ix.relpersistence<>'p' OR ix.reloptions IS NOT NULL
 OR ix.relowner<>(SELECT oid FROM pg_roles WHERE rolname='postgres')
 OR cols IS DISTINCT FROM ARRAY['club_id','created_at','amount','from_entity_id','to_entity_id']::text[]
 OR ix.indoption[0]<>0 OR ix.indoption[1]<>3
 OR ix.indcollation[0]<>0 OR ix.indcollation[1]<>0
 OR ix.indclass[0]<>(SELECT o.oid FROM pg_opclass o JOIN pg_am a ON a.oid=o.opcmethod WHERE a.amname='btree' AND o.opcdefault AND o.opcintype='uuid'::regtype)
 OR ix.indclass[1]<>(SELECT o.oid FROM pg_opclass o JOIN pg_am a ON a.oid=o.opcmethod WHERE a.amname='btree' AND o.opcdefault AND o.opcintype='timestamptz'::regtype)
 OR pg_get_expr(ix.indpred,ix.indrelid) IS DISTINCT FROM $predicate$((status = 'posted'::text) AND (category = ANY (ARRAY['buyin'::text, 'addon'::text, 'rebuy'::text, 'tournament_prize'::text, 'bounty'::text, 'refund'::text, 'spin_entry'::text, 'spin_prize'::text, 'promo'::text, 'promo_send'::text, 'treasury_transfer'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'overlay'::text, 'reversal'::text, 'correction'::text, 'adjustment'::text, 'leaderboard_payout'::text])))$predicate$
 THEN RAISE EXCEPTION 'cashier_direction_cover_shape_changed'; END IF;
 PERFORM set_config('ca_cashier_repair.authority_before',
   (SELECT (to_jsonb(p)-'prosrc')::text FROM pg_proc p WHERE p.oid='public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure),true);
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_cashier_statement_rows(p_club_id uuid, p_viewer uuid, p_scope text, p_from timestamp with time zone, p_to timestamp with time zone, p_filters jsonb, p_after_at timestamp with time zone, p_after_source text, p_after_id uuid, p_limit integer)
 RETURNS TABLE(entry_at timestamp with time zone, entry_source text, entry_id uuid, entry_direction text, entry_amount numeric, entry jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_receipt_branches text[];
  v_movement_branches text[];
  v_receipt_keyset text := '';
  v_movement_keyset text := '';
  v_labels_inside boolean;
  v_counterparty text := p_filters ->> 'counterparty';
  v_counterparty_id uuid;
  v_counterparty_pattern text;
  v_wallet text := nullif(p_filters ->> 'wallet', 'any');
  v_direction text := nullif(p_filters ->> 'direction', 'any');
  v_state text := nullif(p_filters ->> 'state', 'any');
  v_limit integer := CASE WHEN p_limit > 0 THEN p_limit END;
  v_totals_only boolean := coalesce(p_limit = 0, false);
  v_receipt_base text;
  v_movement_base text;
  v_filters_sql text;
  v_order_sql text;
  v_parts text[] := ARRAY[]::text[];
  v_branch text;
  v_sql text;
  v_omitted uuid[] := '{}'::uuid[];
BEGIN
  IF p_club_id IS NULL OR p_viewer IS NULL OR p_from IS NULL OR p_to IS NULL
     OR p_scope IS NULL OR p_scope NOT IN ('all', 'downline', 'self') THEN
    RETURN;
  END IF;

  IF p_scope = 'all' THEN
    v_receipt_branches := ARRAY['true'];
    v_movement_branches := ARRAY['true'];
  ELSIF p_scope = 'self' THEN
    v_receipt_branches := ARRAY[
      'ct.from_user_id = $2',
      'ct.to_user_id = $2 AND ct.from_user_id IS DISTINCT FROM $2'];
    v_movement_branches := ARRAY[
      'cl.from_entity_id = $2',
      'cl.to_entity_id = $2 AND cl.from_entity_id IS DISTINCT FROM $2'];
  ELSE
    v_ids := public.fn_cashier_statement_downline(p_club_id, p_viewer);
    v_receipt_branches := ARRAY[
      'ct.from_user_id = ANY($5)',
      'ct.to_user_id = ANY($5) AND NOT coalesce(ct.from_user_id = ANY($5), false)'];
    v_movement_branches := ARRAY[
      'cl.from_entity_id = ANY($5)',
      'cl.to_entity_id = ANY($5) AND NOT coalesce(cl.from_entity_id = ANY($5), false)'];
  END IF;

  -- The keyset, per source. Order is at DESC, source ASC ('movement' before
  -- 'receipt'), id DESC. Both scans are bounded above by the cursor instant,
  -- so a later page starts each index at the cursor instead of at p_to.
  IF p_after_at IS NOT NULL THEN
    IF p_after_source = 'receipt' THEN
      v_receipt_keyset := ' AND ct.created_at <= $6 AND (ct.created_at < $6 OR ct.id < $8)';
      v_movement_keyset := ' AND cl.created_at < $6';
    ELSE
      v_receipt_keyset := ' AND ct.created_at <= $6';
      v_movement_keyset := ' AND cl.created_at <= $6 AND (cl.created_at < $6 OR cl.id < $8)';
    END IF;
  END IF;

  IF v_counterparty ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_counterparty_id := v_counterparty::uuid;
  ELSIF v_counterparty IS NOT NULL THEN
    v_counterparty_pattern := '%' || replace(replace(replace(v_counterparty, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;
  -- A counterparty text search matches labels, so only then are profiles
  -- joined inside the branches (still bounded: the scan stops at the limit).
  v_labels_inside := v_counterparty_pattern IS NOT NULL;

  v_receipt_base := $sql$
SELECT r.* FROM (
  SELECT ct.created_at AS at,
         'receipt'::text AS source,
         ct.id,
         CASE
           WHEN ct.to_user_id = $2 AND ct.from_user_id IS DISTINCT FROM $2 THEN 'in'
           WHEN ct.from_user_id = $2 AND ct.to_user_id IS DISTINCT FROM $2 THEN 'out'
           ELSE 'managed'
         END AS direction,
         abs(ct.amount) AS amount,
         k.kind,
         CASE
           WHEN k.kind LIKE 'agent\_wallet%' OR k.kind = 'commission_claim' THEN 'agent'
           WHEN k.kind LIKE 'promo%' OR k.kind = 'bbj_promo_sweep' THEN 'promo'
           WHEN k.kind LIKE 'club\_bank%' OR k.kind IN ('mint', 'treasury_debit', 'treasury_credit', 'treasury_funding') THEN 'bank'
           WHEN k.kind LIKE 'union%' THEN 'union'
           WHEN k.kind LIKE 'tournament\_ticket%' THEN 'ticket'
           WHEN k.kind LIKE 'cashout%' THEN 'cashout'
           WHEN k.kind IN ('tournament_buyin', 'late_seat_debit', 'late_seat_credit', 'addon_refund', 'seat_credit_restored') THEN 'table'
           WHEN k.kind IN ('peer_transfer', 'topup', 'rakeback', 'plinko_prize', 'wheel_prize', 'crash_prize', 'mines_prize', 'crossing_prize', 'admin_removal') THEN 'player'
           ELSE 'other'
         END AS wallet,
         CASE
           WHEN coalesce(ct.clawed_back, false) THEN 'clawed_back'
           WHEN coalesce(ct.is_reversed, false) THEN 'reversed'
           WHEN ct.transaction_type = 'cashout_request_escrow' AND ct.related_cashout_id IS NOT NULL THEN
             CASE
               WHEN NOT EXISTS (
                 SELECT 1
                   FROM public.chip_transactions terminal
                  WHERE terminal.club_id = ct.club_id
                    AND terminal.created_at BETWEEN ct.created_at AND $4 + interval '1 day'
                    AND terminal.related_cashout_id = ct.related_cashout_id
                    AND terminal.transaction_type IN ('cashout_approved', 'cashout_denied', 'cashout_cancelled', 'cashout_expired_refund')
               ) THEN 'pending'
               WHEN ct.reversible_until > now() THEN 'reversible'
               ELSE 'posted'
             END
           WHEN ct.reversible_until > now() THEN 'reversible'
           ELSE 'posted'
         END AS state,
         CASE WHEN ct.from_user_id IS NOT NULL THEN 'user' END AS from_type,
         ct.from_user_id AS from_id,
         NULL::text AS from_ledger_label,
         CASE WHEN ct.to_user_id IS NOT NULL THEN 'user' END AS to_type,
         ct.to_user_id AS to_id,
         NULL::text AS to_ledger_label,
         @SEARCH@ AS search_text,
         CASE WHEN ct.notes !~* 'horse' THEN ct.notes END AS notes,
         NULL::numeric AS balance_after,
         ct.table_id,
         NULL::uuid AS tournament_id,
         NULL::uuid AS hand_id,
         CASE WHEN ct.metadata ->> 'op_id' !~* 'horse' THEN ct.metadata ->> 'op_id' END AS op_id,
         CASE WHEN ct.metadata ->> 'idempotency_key' !~* 'horse' THEN ct.metadata ->> 'idempotency_key' END AS idempotency_key,
         CASE WHEN ct.metadata ->> 'correlation_id' !~* 'horse' THEN ct.metadata ->> 'correlation_id' END AS correlation_id,
         CASE WHEN ct.metadata ->> 'chip_ledger_id' !~* 'horse' THEN ct.metadata ->> 'chip_ledger_id' END AS ledger_id,
         ct.related_cashout_id::text AS cashout_id,
         CASE WHEN ct.metadata ->> 'ticket_id' !~* 'horse' THEN ct.metadata ->> 'ticket_id' END AS ticket_id
    FROM public.chip_transactions ct
    CROSS JOIN LATERAL (
      SELECT CASE WHEN ct.transaction_type ~* 'horse' THEN 'treasury_funding' ELSE ct.transaction_type END AS kind
    ) k@JOINS@
   WHERE ct.club_id = $1
     AND ct.created_at >= $3
     AND ct.created_at < $4@KEYSET@
     AND @BRANCH@
) r$sql$;

  v_movement_base := $sql$
SELECT r.* FROM (
  SELECT cl.created_at AS at,
         'movement'::text AS source,
         cl.id,
         CASE
           WHEN cl.to_entity_id = $2 AND cl.from_entity_id IS DISTINCT FROM $2 THEN 'in'
           WHEN cl.from_entity_id = $2 AND cl.to_entity_id IS DISTINCT FROM $2 THEN 'out'
           ELSE 'managed'
         END AS direction,
         abs(cl.amount) AS amount,
         cl.category AS kind,
         CASE
           WHEN 'escrow' IN (cl.from_type, cl.to_type) THEN 'cashout'
           WHEN 'table_stack' IN (cl.from_type, cl.to_type)
                OR cl.category IN ('buyin', 'addon', 'rebuy', 'tournament_prize', 'bounty') THEN 'table'
           WHEN cl.from_type IN ('union_bank', 'union_wallet') OR cl.to_type IN ('union_bank', 'union_wallet') THEN 'union'
           WHEN 'promo_wallet' IN (cl.from_type, cl.to_type) OR cl.category IN ('promo', 'promo_send') THEN 'promo'
           WHEN 'agent_wallet' IN (cl.from_type, cl.to_type) THEN 'agent'
           WHEN 'player_wallet' IN (cl.from_type, cl.to_type) THEN 'player'
           WHEN cl.from_type IN ('club_treasury', 'club_wallet', 'issuance_reserve', 'system_mint')
                OR cl.to_type IN ('club_treasury', 'club_wallet', 'issuance_reserve', 'system_mint')
                OR cl.category = 'treasury_transfer' THEN 'bank'
           ELSE 'other'
         END AS wallet,
         'posted'::text AS state,
         cl.from_type,
         cl.from_entity_id AS from_id,
         CASE WHEN cl.from_label !~* 'horse' THEN cl.from_label END AS from_ledger_label,
         cl.to_type,
         cl.to_entity_id AS to_id,
         CASE WHEN cl.to_label !~* 'horse' THEN cl.to_label END AS to_ledger_label,
         @SEARCH@ AS search_text,
         CASE WHEN cl.notes !~* 'horse' THEN cl.notes END AS notes,
         CASE
           WHEN cl.to_entity_id = $2 THEN cl.post_to_balance
           WHEN cl.from_entity_id = $2 THEN cl.post_from_balance
         END AS balance_after,
         cl.table_id,
         cl.tournament_id,
         cl.hand_id,
         CASE WHEN cl.metadata ->> 'op_id' !~* 'horse' THEN cl.metadata ->> 'op_id' END AS op_id,
         CASE WHEN cl.idempotency_key !~* 'horse' THEN cl.idempotency_key END AS idempotency_key,
         cl.correlation_id::text AS correlation_id,
         cl.id::text AS ledger_id,
         CASE WHEN coalesce(cl.metadata ->> 'cashout_request_id', cl.metadata ->> 'cashout_id') !~* 'horse'
              THEN coalesce(cl.metadata ->> 'cashout_request_id', cl.metadata ->> 'cashout_id') END AS cashout_id,
         CASE WHEN cl.metadata ->> 'ticket_id' !~* 'horse' THEN cl.metadata ->> 'ticket_id' END AS ticket_id
    FROM public.chip_ledger cl@JOINS@
   WHERE cl.club_id = $1
     AND cl.created_at >= $3
     AND cl.created_at < $4@KEYSET@
     AND cl.status = 'posted'
     AND cl.category = ANY($17)
     AND @BRANCH@
     AND NOT EXISTS (
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
     )
) r$sql$;


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
      '     AND cl.id <> ALL ($19)');
  END IF;

  IF v_labels_inside THEN
    v_receipt_base := replace(replace(v_receipt_base,
      '@JOINS@', E'\n    LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id\n    LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id'),
      '@SEARCH@', 'concat_ws(chr(31), pf.alias, pf.display_name, pf.username, pt.alias, pt.display_name, pt.username)');
    v_movement_base := replace(replace(v_movement_base,
      '@JOINS@', E'\n    LEFT JOIN public.profiles pf ON pf.id = cl.from_entity_id\n    LEFT JOIN public.profiles pt ON pt.id = cl.to_entity_id'),
      '@SEARCH@', E'concat_ws(chr(31), pf.alias, pf.display_name, pf.username, pt.alias, pt.display_name, pt.username,\n                   CASE WHEN cl.from_label !~* ''horse'' THEN cl.from_label END,\n                   CASE WHEN cl.to_label !~* ''horse'' THEN cl.to_label END)');
  ELSE
    v_receipt_base := replace(replace(v_receipt_base, '@JOINS@', ''), '@SEARCH@', 'NULL::text');
    v_movement_base := replace(replace(v_movement_base, '@JOINS@', ''), '@SEARCH@', 'NULL::text');
  END IF;
  v_receipt_base := replace(v_receipt_base, '@KEYSET@', v_receipt_keyset);
  v_movement_base := replace(v_movement_base, '@KEYSET@', v_movement_keyset);

  v_filters_sql := $sql$
 WHERE ($10::text IS NULL OR r.wallet = $10)
   AND ($11::text IS NULL OR r.direction = $11)
   AND ($12::text IS NULL OR r.state = $12)
   AND ($13::text IS NULL OR r.kind = $13)
   AND ($14::uuid IS NULL OR r.from_id = $14 OR r.to_id = $14)
   AND ($15::text IS NULL OR r.search_text ILIKE $15)
   AND ($18::text IS NULL OR $18 IN (r.id::text, r.op_id, r.idempotency_key, r.correlation_id, r.ledger_id, r.cashout_id, r.ticket_id))$sql$;
  v_order_sql := CASE WHEN v_totals_only THEN '' ELSE E'\n ORDER BY r.at DESC, r.id DESC\n LIMIT $9' END;

  FOREACH v_branch IN ARRAY v_receipt_branches LOOP
    v_parts := v_parts || ('(' || replace(v_receipt_base, '@BRANCH@', '(' || v_branch || ')') || v_filters_sql || v_order_sql || E'\n)');
  END LOOP;
  FOREACH v_branch IN ARRAY v_movement_branches LOOP
    v_parts := v_parts || ('(' || replace(v_movement_base, '@BRANCH@', '(' || v_branch || ')') || v_filters_sql || v_order_sql || E'\n)');
  END LOOP;

  IF v_totals_only THEN
    IF p_scope='all' THEN
      -- THE MIRRORED SET IS READ FIRST, SO THE TOTALS CAN RUN IN PARALLEL
      -- (2026-10-07). Read as a materialized common table expression beside
      -- the two range scans, this set made the whole aggregate serial (a CTE
      -- scan is parallel-restricted), so a cold call for a busy club read its
      -- ~6,000 index pages one at a time: 8.5 s for Shark Club's seven days
      -- against the 8 s statement timeout. The same arms, run first under the
      -- same snapshot (this function is STABLE), become $19, and both covering
      -- index scans may share parallel workers.
      EXECUTE $omissions$SELECT coalesce(array_agg(omitted.id), '{}'::uuid[]) FROM (
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
) omitted$omissions$
        INTO v_omitted
        USING p_club_id, p_viewer, p_from, p_to;
    END IF;
    v_sql := E'SELECT NULL::timestamptz, NULL::text, NULL::uuid, t.direction, sum(t.amount), jsonb_build_object(''count'', count(*))\n  FROM (\n'
          || array_to_string(v_parts, E'\nUNION ALL\n')
          || E'\n  ) t\n GROUP BY t.direction';
  ELSE
    v_sql := E'WITH candidates AS (\n'
          || array_to_string(v_parts, E'\nUNION ALL\n')
          || $sql$
), page AS (
  SELECT c.*
    FROM candidates c
   ORDER BY c.at DESC, c.source COLLATE "C" ASC, c.id DESC
   LIMIT $9
)
SELECT e.at,
       e.source,
       e.id,
       e.direction,
       e.amount,
       jsonb_build_object(
         'source', e.source,
         'id', e.id,
         'at', to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         'kind', e.kind,
         'wallet', e.wallet,
         'direction', e.direction,
         'amount', to_char(round(e.amount, 2), 'FM999999999999999990.00'),
         'from', jsonb_build_object('type', e.from_type, 'id', e.from_id, 'label', e.from_label),
         'to', jsonb_build_object('type', e.to_type, 'id', e.to_id, 'label', e.to_label),
         'counterparty', CASE e.direction WHEN 'in' THEN e.from_label WHEN 'out' THEN e.to_label END,
         'notes', e.notes,
         'state', e.state,
         'reference', jsonb_build_object(
           'id', e.id,
           'source', e.source,
           'op_id', e.op_id,
           'idempotency_key', e.idempotency_key,
           'correlation_id', e.correlation_id,
           'ledger_id', e.ledger_id,
           'cashout_id', e.cashout_id,
           'ticket_id', e.ticket_id
         ),
         'balance_after', to_char(round(e.balance_after, 2), 'FM999999999999999990.00'),
         'table_id', e.table_id,
         'tournament_id', e.tournament_id,
         'hand_id', e.hand_id
       )
  FROM (
    SELECT p.*,
           coalesce(pf.alias, pf.display_name, pf.username, p.from_ledger_label) AS from_label,
           coalesce(pt.alias, pt.display_name, pt.username, p.to_ledger_label) AS to_label
      FROM page p
      LEFT JOIN public.profiles pf ON pf.id = p.from_id
      LEFT JOIN public.profiles pt ON pt.id = p.to_id
  ) e
 ORDER BY e.at DESC, e.source COLLATE "C" ASC, e.id DESC
$sql$;
  END IF;

  IF v_totals_only AND p_scope='all' AND v_wallet IS NULL AND v_direction IS NULL AND v_state IS NULL AND p_filters->>'operation' IS NULL AND v_counterparty_id IS NULL AND v_counterparty_pattern IS NULL AND p_filters->>'reference' IS NULL THEN
    v_sql := $narrow$WITH raw_totals AS (SELECT direction,coalesce(sum(abs(amount)) FILTER (WHERE amount <> 'NaN'::numeric),0) amount,count(*) n,count(amount) nn,count(*) FILTER (WHERE amount='NaN'::numeric) nc FROM (SELECT CASE WHEN to_user_id=$2 AND from_user_id IS DISTINCT FROM $2 THEN 'in' WHEN from_user_id=$2 AND to_user_id IS DISTINCT FROM $2 THEN 'out' ELSE 'managed' END direction,amount FROM public.chip_transactions WHERE club_id=$1 AND created_at >= $3 AND created_at < $4 UNION ALL SELECT CASE WHEN to_entity_id=$2 AND from_entity_id IS DISTINCT FROM $2 THEN 'in' WHEN from_entity_id=$2 AND to_entity_id IS DISTINCT FROM $2 THEN 'out' ELSE 'managed' END direction,amount FROM public.chip_ledger WHERE club_id=$1 AND created_at >= $3 AND created_at < $4 AND status='posted' AND category=ANY($17)) ranged GROUP BY direction), omitted AS (SELECT direction,coalesce(sum(abs(amount)) FILTER (WHERE amount <> 'NaN'::numeric),0) amount,count(*) n,count(amount) nn,count(*) FILTER (WHERE amount='NaN'::numeric) nc FROM (SELECT CASE WHEN to_entity_id=$2 AND from_entity_id IS DISTINCT FROM $2 THEN 'in' WHEN from_entity_id=$2 AND to_entity_id IS DISTINCT FROM $2 THEN 'out' ELSE 'managed' END direction,amount FROM public.chip_ledger WHERE club_id=$1 AND created_at >= $3 AND created_at < $4 AND status='posted' AND category=ANY($17) AND id=ANY($19)) removed GROUP BY direction) SELECT NULL::timestamptz,NULL::text,NULL::uuid,r.direction,CASE WHEN r.nc-coalesce(o.nc,0)>0 THEN 'NaN'::numeric WHEN r.nn-coalesce(o.nn,0)=0 THEN NULL::numeric ELSE r.amount-coalesce(o.amount,0) END,jsonb_build_object('count',r.n-coalesce(o.n,0)) FROM raw_totals r LEFT JOIN omitted o USING(direction) WHERE r.n-coalesce(o.n,0)>0$narrow$;
  END IF;

  RETURN QUERY EXECUTE v_sql
    USING p_club_id,                                  -- $1
          p_viewer,                                   -- $2
          p_from,                                     -- $3
          p_to,                                       -- $4
          v_ids,                                      -- $5
          p_after_at,                                 -- $6
          p_after_source,                             -- $7 (keyset branch chosen above)
          p_after_id,                                 -- $8
          v_limit,                                    -- $9
          v_wallet,                                   -- $10
          v_direction,                                -- $11
          v_state,                                    -- $12
          p_filters ->> 'operation',                  -- $13
          v_counterparty_id,                          -- $14
          v_counterparty_pattern,                     -- $15
          v_totals_only,                              -- $16 (mode chosen above)
          ARRAY['buyin', 'addon', 'rebuy', 'tournament_prize', 'bounty', 'refund',
                'spin_entry', 'spin_prize', 'promo', 'promo_send', 'treasury_transfer',
                'transfer', 'player_funding', 'agent_funding', 'overlay', 'reversal',
                'correction', 'adjustment', 'leaderboard_payout']::text[],  -- $17
          p_filters ->> 'reference',                  -- $18
          v_omitted;                                  -- $19 (totals, scope all)
END;
$function$;

-- Restate the already-private boundary for changed-migration authorization checks.
-- The precondition and complete authority postcondition forbid any grant change.
REVOKE ALL ON FUNCTION public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer) FROM PUBLIC, anon, authenticated;

DO $guard$
BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure))<>'45d82a8afb00381ee4e784e7ffdf097d'
 OR (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid='public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)
    IS DISTINCT FROM current_setting('ca_cashier_repair.authority_before')::jsonb
 OR md5(pg_get_functiondef('public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)'::regprocedure))<>'5e50033127ded658f0bb4de87e0a10e6'
 THEN RAISE EXCEPTION 'cashier_postimage_or_authority_changed'; END IF;
END $guard$;
COMMIT;
