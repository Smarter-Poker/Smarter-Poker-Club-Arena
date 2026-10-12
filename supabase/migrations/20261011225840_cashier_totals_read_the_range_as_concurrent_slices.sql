-- 20261011225840_cashier_totals_read_the_range_as_concurrent_slices.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_cashier_statement_totals intermittently answered signed-in owners and
-- admins with HTTP 500 "canceling statement due to statement timeout" (the
-- authenticated role's 8 s limit). pg_stat_statements on 2026-10-11: 235 calls,
-- mean 2.56 s, max 6.97 s; edge logs show every Post-Deploy E2E call (a fresh
-- admin of Shark Club, default "last 7 days") at 3.1-4.7 s, and the one at
-- 21:42:59 UTC at 8.09 s -> 500 while sp_prune_hand_history ran a 26.5 s job.
-- It failed tests/e2e/production-cashier-statements.spec.ts in Post-Deploy E2E
-- run 38176048197.
--
-- The cause is NOT the shape of the aggregate: #6615 (20261010011934) already
-- made the default owner total a single set-based pass, one directional range
-- per source, index-only on idx_chip_tx_club_time_totals and
-- idx_chip_ledger_cashier_direction_totals. Measured on production, Shark Club
-- owner, last 7 days (395,000 rows):
--   warm: 158 ms, 23,702 buffers, all hits;
--   cold: 3,794 ms, 16,633 hits + 7,059 reads.
-- The 7,059 reads are the covering indexes' leaf pages for the range (4,343 on
-- chip_transactions, 2,761 on chip_ledger). Those pages were created by page
-- splits as the week's rows arrived, so they sit scattered in the index file,
-- and a btree range scan reads them strictly one after another: each leaf names
-- the next. Measured cold: 0.59 ms a page serially (1,799 pages, 1,060 ms), and
-- 0.65 ms a page with SEVEN participants on one parallel index scan (2,462
-- pages, 1,592 ms) - a parallel btree scan hands out the same chain in order,
-- so the workers wait on it rather than read ahead. The current plan therefore
-- reads ~7,000 random pages through at most two chains (one per source), and
-- any disk contention (the prune job) multiplies a 3.8 s total past 8 s.
--
-- THE FIX: the default owner aggregate (totals mode, scope all, no filter) cuts
-- each source range into at most 16 consecutive slices of at least 12 hours
-- (bounds passed as $20; first bound p_from, last p_to, strictly increasing, so
-- the slices partition [p_from, p_to) exactly and each row is read once). Every
-- slice is its own index range scan, so a Parallel Append runs several chains
-- at once; for that one statement the function allows up to six workers (the
-- server default is two) and puts the setting back immediately after.
-- Measured: five cold one-day slices read 3,396 pages in 800 ms with four
-- participants (0.24 ms a page, against 0.62 ms serial); the production plan for
-- Shark Club's week is Parallel Append, Workers Planned 5, Launched 5, with each
-- slice's bounds folded into its Index Cond.
--
-- Nothing else moves: the omitted-mirror set ($19), the NaN arithmetic, every
-- filtered, downline, self, page and export path are byte-identical to #6615.
-- No index, timeout, cache, cron or retry is added. Horses and humans are read
-- by the same predicates.
--
-- PROOF BEFORE APPLY (one Supabase MCP call, one DO block ending in RAISE
-- EXCEPTION, new body created in pg_temp): 120 cases, 80 distinct real callers
-- (10 owner/admin "all" callers x 5 ranges from 4 hours to 92 days, 25 agents,
-- 25 players, plus 20 synthetic "all" viewers in the three busiest clubs),
-- 0 mismatches against the live function's (direction, amount, count) rows.
--
-- Guards: the live pre-image (pg_get_functiondef md5 8a47b11b...) and the
-- totals wrapper (5e500331...) must be exactly #6615's; the helper's whole
-- authority tuple (owner, ACL, SECURITY DEFINER, volatility, search_path) must
-- be unchanged afterwards; the post-image prosrc md5 is asserted. Two-second
-- lock cap. Apply with the Apply Merged Migration workflow, outside :50-:03.
--
-- @live-proof: (SELECT position('A COLD TOTAL WAS ONE LEAF CHAIN PER SOURCE' IN pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)) <> '8a47b11b861fef1357ae8749d1370a11'
     OR md5(pg_get_functiondef('public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)'::regprocedure)) <> '5e50033127ded658f0bb4de87e0a10e6' THEN
    RAISE EXCEPTION 'cashier_source_preimage_changed';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}'
     OR (SELECT proowner FROM pg_proc WHERE oid = 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure) <> (SELECT oid FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'cashier_private_authority_changed';
  END IF;
  PERFORM set_config('ca_cashier_slices.authority_before',
    (SELECT (to_jsonb(p) - 'prosrc')::text FROM pg_proc p WHERE p.oid = 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure), true);
END
$guard$;

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
  v_bounds timestamptz[];
  v_slices integer;
  v_slice integer;
  v_ranged text[] := ARRAY[]::text[];
  v_workers text;
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
    -- A COLD TOTAL WAS ONE LEAF CHAIN PER SOURCE (2026-10-11). A btree range
    -- scan reads its leaf pages one after another, because each page names
    -- the next, and a parallel index scan hands those pages out in the same
    -- order, so its workers wait on the one chain (measured on production: 7
    -- participants, 0.65 ms a page, the same as one). A busy club's week is
    -- ~7,000 such pages, grown by page splits and scattered on disk, so a cold
    -- default total took ~3.8 s and crossed the 8 s statement timeout when the
    -- disk was busy. Each source range is now cut into at most 16 consecutive
    -- slices of at least 12 hours. Every slice is its own range scan, so a
    -- Parallel Append reads several chains at once. The slices partition
    -- [p_from, p_to) exactly (first bound p_from, last bound p_to, strictly
    -- increasing), so each row is still read once and the sums are unchanged.
    v_slices := least(16, greatest(1, ceil(extract(epoch FROM p_to - p_from) / 43200.0)::integer));
    SELECT array_agg(CASE WHEN g = v_slices THEN p_to
                          ELSE p_from + make_interval(secs => (extract(epoch FROM p_to - p_from) * g / v_slices)::double precision)
                     END ORDER BY g)
      INTO v_bounds
      FROM generate_series(0, v_slices) g;
    FOR v_slice IN 1..v_slices LOOP
      v_ranged := v_ranged
        || replace(replace($slice$SELECT CASE WHEN to_user_id=$2 AND from_user_id IS DISTINCT FROM $2 THEN 'in' WHEN from_user_id=$2 AND to_user_id IS DISTINCT FROM $2 THEN 'out' ELSE 'managed' END direction,amount FROM public.chip_transactions WHERE club_id=$1 AND created_at >= @LO@ AND created_at < @HI@$slice$, '@LO@', '$20[' || v_slice || ']'), '@HI@', '$20[' || (v_slice + 1) || ']')
        || replace(replace($slice$SELECT CASE WHEN to_entity_id=$2 AND from_entity_id IS DISTINCT FROM $2 THEN 'in' WHEN from_entity_id=$2 AND to_entity_id IS DISTINCT FROM $2 THEN 'out' ELSE 'managed' END direction,amount FROM public.chip_ledger WHERE club_id=$1 AND created_at >= @LO@ AND created_at < @HI@ AND status='posted' AND category=ANY($17)$slice$, '@LO@', '$20[' || v_slice || ']'), '@HI@', '$20[' || (v_slice + 1) || ']');
    END LOOP;
    v_sql := $narrow$WITH raw_totals AS (SELECT direction,coalesce(sum(abs(amount)) FILTER (WHERE amount <> 'NaN'::numeric),0) amount,count(*) n,count(amount) nn,count(*) FILTER (WHERE amount='NaN'::numeric) nc FROM ($narrow$ || array_to_string(v_ranged, ' UNION ALL ') || $narrow$) ranged GROUP BY direction), omitted AS (SELECT direction,coalesce(sum(abs(amount)) FILTER (WHERE amount <> 'NaN'::numeric),0) amount,count(*) n,count(amount) nn,count(*) FILTER (WHERE amount='NaN'::numeric) nc FROM (SELECT CASE WHEN to_entity_id=$2 AND from_entity_id IS DISTINCT FROM $2 THEN 'in' WHEN from_entity_id=$2 AND to_entity_id IS DISTINCT FROM $2 THEN 'out' ELSE 'managed' END direction,amount FROM public.chip_ledger WHERE club_id=$1 AND created_at >= $3 AND created_at < $4 AND status='posted' AND category=ANY($17) AND id=ANY($19)) removed GROUP BY direction) SELECT NULL::timestamptz,NULL::text,NULL::uuid,r.direction,CASE WHEN r.nc-coalesce(o.nc,0)>0 THEN 'NaN'::numeric WHEN r.nn-coalesce(o.nn,0)=0 THEN NULL::numeric ELSE r.amount-coalesce(o.amount,0) END,jsonb_build_object('count',r.n-coalesce(o.n,0)) FROM raw_totals r LEFT JOIN omitted o USING(direction) WHERE r.n-coalesce(o.n,0)>0$narrow$;
    -- More chains run at once only if more participants may join: up to six
    -- workers (the server default is two) for this one statement, put back
    -- right after it, so no page or export plan ever sees the change.
    v_workers := current_setting('max_parallel_workers_per_gather');
    IF v_workers::integer BETWEEN 1 AND 5 THEN
      PERFORM set_config('max_parallel_workers_per_gather', '6', true);
    END IF;
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
          v_omitted,                                  -- $19 (totals, scope all)
          v_bounds;                                   -- $20 (default total slice bounds)

  IF v_workers IS NOT NULL THEN
    PERFORM set_config('max_parallel_workers_per_gather', v_workers, true);
  END IF;
END;
$function$;

-- Restate the already-private boundary for the changed-migration security gate.
REVOKE ALL ON FUNCTION public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer) FROM PUBLIC, anon, authenticated;

DO $guard$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)) <> '3e0925223743726b1f175b6da3ab0294'
     OR (SELECT to_jsonb(p) - 'prosrc' FROM pg_proc p WHERE p.oid = 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)
        IS DISTINCT FROM current_setting('ca_cashier_slices.authority_before')::jsonb
     OR md5(pg_get_functiondef('public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)'::regprocedure)) <> '5e50033127ded658f0bb4de87e0a10e6' THEN
    RAISE EXCEPTION 'cashier_postimage_or_authority_changed';
  END IF;
END
$guard$;

COMMIT;
