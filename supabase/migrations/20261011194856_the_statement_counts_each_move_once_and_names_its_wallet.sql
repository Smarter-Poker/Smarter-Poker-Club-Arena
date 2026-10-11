-- 20261011194856_the_statement_counts_each_move_once_and_names_its_wallet.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (cashier launch audit, 2026-10-09):
--
-- The Cashier Statement (fn_cashier_statement_page / _totals / _export_*, all
-- read through the one owner-only row query fn_cashier_statement_rows) printed
-- some moves twice, counted a cash out against the player twice, charged the
-- operator for every Club Bank send, named every horse, printed real names and
-- printed storage paths as names. Production's live body (md5 8a47b11b861fef1357ae8749d1370a11,
-- installed by 20261010011934_cashier_totals_count_directional_ranges_without_rescanning,
-- #6615, read back read-only on 2026-10-11) was reproduced byte for byte in a
-- private PostgreSQL 17 copy of the statement fixture; the regression
-- tests/fixtures/cashier-statements/db-one-move-once.sql fails there and
-- passes all of its assertions after this file.
--
-- REBASED (2026-10-11). This file was first written as 20261009223439 against
-- the body before #6615 (md5 72d29ab402ff75ae3f240ce40a750437). #6615 then
-- installed a fast path for the default all-scope totals (one directional
-- range per source, minus the omitted legs in $19). This file is that live
-- body with the changes below and nothing else: #6615's fast path is kept,
-- its omitted set ($19) gains the mirrored legs of 1, and its receipt range
-- is split by the viewer's side so a receipt's kind decides its direction
-- (2 and 3) exactly as on every other path. The default totals still read
-- one range per source plus the viewer's own receipts.
--
-- 1. ONE MOVE, ONE ENTRY. A door that writes a receipt also journals the same
--    move as a chip_ledger leg in the same transaction (same club, the
--    transaction's now(), same amount). The statement printed both whenever
--    the leg's category is one it reads and the receipt did not carry the
--    leg's idempotency key. Production, read-only, 2026-10-09: 2,054 BBJ promo
--    sweeps in the last 14 days (bbj_promo_sweep receipt + promo leg; 5,750
--    more since 2026-09-02), add-on refunds (addon_refund + player_funding),
--    and every promo, pot and reversal door the launch opens
--    (fn_promo_wallet_send_core_20261004, fn_club_promo_send_core_20261004,
--    fn_union_promo_send, fn_union_clawback_promo_from_club,
--    fn_promo_disburse, fn_club_bank_reverse_core_20261004 stamp the leg's
--    correlation id as the receipt's op_id). A leg of a category a receipt
--    writer journals ('promo', 'promo_send', 'treasury_transfer', 'transfer', 'player_funding', 'reversal', 'refund', 'correction', 'adjustment') is now left out when a receipt of the same
--    club and instant, for the same amount, carries its correlation id as
--    op_id, or names nobody, or names the leg's holder on one side and
--    contradicts it on neither (an operator who pressed the button for a pot,
--    see 3, is not a side). A prize, spin, buy-in or bounty leg is never
--    read against a receipt. The idempotency and restore rules are unchanged.
--    Pages, exports and the self and downline totals probe per leg; the
--    all-scope totals (the filtered path and #6615's default fast path
--    alike) subtract the mirrored legs, read first into $19 from the small
--    partial index idx_chip_ledger_statement_mirror_legs (the legs of those categories,
--    ~280 a day), so the aggregate stays a parallel index-only scan.
-- 2. A CASH OUT IS COUNTED WHERE ITS CHIPS MOVE (fn_cashier_cashout_transition
--    writes hold player->assigned agent, approval player->approver, refunds
--    actor->player). The hold is the player's out, the approval the
--    approver's in, a denial, cancellation or expiry refund the player's in;
--    every other side is managed. Before: a 30 cash out read out 60 for the
--    player and in 60 for the agent, and a cancelled one read managed.
-- 3. A POT IS NOT THE OPERATOR'S WALLET. club_bank_send, club_promo_send,
--    promo_disbursement, union_member_send and union_promo_send pay a member
--    from a pot; club_bank_claim, admin_removal and club_bank_reversal return
--    a member's chips to the Club Bank; union_promo_to_club and
--    union_promo_clawback move one pot to another, and a mint
--    (mint, treasury_mint, treasury_burn) moves none of the operator's chips.
--    The pot is printed as the side (club_treasury, promo_wallet or
--    union_wallet, the chip_ledger account types), the member keeps the in or
--    the out, and the operator who pressed the button reads managed. The
--    all-scope totals (#6615's default fast path included) now read the
--    receipts a viewer is a side of from the (club, user, time) covering
--    indexes, which carry the kind; every other receipt is managed and is
--    still counted from the club-time index (idx_chip_tx_club_time_totals).
-- 4. NOTHING NAMES A HORSE. A treasury-funded seat (horse_treasury_funding,
--    65,659 rows) printed as the kind 'treasury_funding', which no human row
--    ever has, so one filter listed every horse. It prints as the Club Bank
--    send it is, in the shape a Club Bank send now has: from the Club
--    Treasury, no operation id, no stock note.
-- 5. THE ARENA NAME, NEVER A REAL NAME. Labels, the counterparty and the
--    counterparty search read public.fn_arena_name (alias, username, a
--    display name that is not the real name, 'Player'), never display_name
--    first (CLAUDE.md, tests/theArenaIsAlwaysTheAlias.law.test.ts).
-- 6. NO STORAGE PATH IS A NAME. A chip_ledger label that is a storage path or
--    an identifier (spin_bonus_pools.balance on ~90,000 legs in 3 days,
--    bbj_pools.promo_balance, union_wallets.rake_wallet) is printed as null;
--    the side's account type names it.
-- 7. WALLET FAMILIES. tournament_refund and late_seat_debit_reversed are
--    table; treasury_mint, treasury_burn, club_opening_grant and
--    leave_club_chip_return are bank; overlay_funding is union;
--    bbj_promo_payout and club_promo_send are promo; chip_credit and buyin are
--    player.
--
-- Not changed: the scope rule, the doors, the keyset and cursor, the included
-- category list (idx_chip_ledger_cashier_totals_cover keys on it), any grant,
-- statement_timeout, and every table and money row. The page, totals and
-- export doors are unchanged and stay pinned by
-- scripts/verification-harness/cashier-release-contract.sql.
--
-- QUALIFICATION: scripts/ci/test-cashier-statement-db-postgres.py (PostgreSQL
-- 17): the live body reproduced (md5), the regression failing before and
-- passing after, totals equal to their own pages for every viewer, scope and
-- filter (the default totals take #6615's fast path, the filtered ones the
-- per-branch path, and both agree with the rows), every other statement
-- function byte-identical, rollback and replay refusal, and the all-scope
-- totals plan (index-only scans, #6615's direction cover, the new index).
-- #6615's own native qualification
-- (tests/fixtures/cashier-statements/direction-totals-native.py) runs on the
-- rebased body as well.
--
-- LOCKING: the index is built CONCURRENTLY, alone, before BEGIN (the
-- apply-merged-migration installer sends it on its own and reads it back
-- VALID). The transaction replaces one owner-only function body, pinned by md5
-- before and after, with lock_timeout 2s.
--
-- @live-proof: (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_chip_ledger_statement_mirror_legs' AND i.indisvalid) = 1
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)) = '88cb4d660916a2c78b9cf7333c5b3b45')

-- The legs a receipt writer journals, by club and instant: the all-scope
-- totals read the mirrored ones from here instead of the heap.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_statement_mirror_legs
  ON public.chip_ledger (club_id, created_at)
  INCLUDE (id, amount, from_entity_id, to_entity_id, correlation_id)
  WHERE status = 'posted'
    AND category = ANY (ARRAY['promo', 'promo_send', 'treasury_transfer', 'transfer', 'player_funding', 'reversal', 'refund', 'correction', 'adjustment']::text[]);

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- The body below is production's live text with the substitutions named in
-- the header and nothing else. Refuse if it is not that text (a replay is
-- refused, never re-run), or if the index the totals read is not valid.
DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure))
       IS DISTINCT FROM '8a47b11b861fef1357ae8749d1370a11' THEN
    RAISE EXCEPTION 'fn_cashier_statement_rows is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure))
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_chip_ledger_statement_mirror_legs' AND c.relnamespace = 'public'::regnamespace
       AND i.indrelid = 'public.chip_ledger'::regclass AND i.indisvalid AND i.indisready
  ) THEN
    RAISE EXCEPTION 'idx_chip_ledger_statement_mirror_legs is missing or not valid; drop an invalid build (DROP INDEX CONCURRENTLY public.idx_chip_ledger_statement_mirror_legs) and dispatch again'
      USING ERRCODE = '55000';
  END IF;
END $pre$;

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
  v_receipt_directions text[];
  v_receipt_direction text;
  v_mirror_probe text;
  v_i integer;
BEGIN
  IF p_club_id IS NULL OR p_viewer IS NULL OR p_from IS NULL OR p_to IS NULL
     OR p_scope IS NULL OR p_scope NOT IN ('all', 'downline', 'self') THEN
    RETURN;
  END IF;

  IF p_scope = 'all' AND v_totals_only THEN
    -- THE ALL-SCOPE TOTALS READ RECEIPTS BY THE VIEWER'S SIDE (2026-10-09).
    -- A receipt's direction depends on its kind (a cash out, a pot), and a
    -- kind the club-time covering index does not carry would send every
    -- receipt to the heap. A receipt the viewer is not a side of is managed
    -- whatever its kind, so it is counted from that index as before; the
    -- viewer's own receipts come from the (club, user, time) indexes, which
    -- carry the kind.
    v_receipt_branches := ARRAY[
      'ct.from_user_id IS DISTINCT FROM $2 AND ct.to_user_id IS DISTINCT FROM $2',
      'ct.from_user_id = $2',
      'ct.to_user_id = $2 AND ct.from_user_id IS DISTINCT FROM $2'];
    v_receipt_directions := ARRAY['''managed''::text', NULL, NULL];
    v_movement_branches := ARRAY['true'];
  ELSIF p_scope = 'all' THEN
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
         @DIRECTION@ AS direction,
         abs(ct.amount) AS amount,
         k.kind,
         CASE
           WHEN k.kind LIKE 'agent\_wallet%' OR k.kind = 'commission_claim' THEN 'agent'
           WHEN k.kind LIKE 'promo%' OR k.kind IN ('bbj_promo_sweep', 'bbj_promo_payout', 'club_promo_send') THEN 'promo'
           WHEN k.kind LIKE 'club\_bank%' OR k.kind IN ('mint', 'treasury_debit', 'treasury_credit', 'treasury_funding', 'treasury_mint', 'treasury_burn', 'club_opening_grant', 'leave_club_chip_return') THEN 'bank'
           WHEN k.kind LIKE 'union%' OR k.kind = 'overlay_funding' THEN 'union'
           WHEN k.kind LIKE 'tournament\_ticket%' THEN 'ticket'
           WHEN k.kind LIKE 'cashout%' THEN 'cashout'
           WHEN k.kind IN ('tournament_buyin', 'late_seat_debit', 'late_seat_credit', 'addon_refund', 'seat_credit_restored', 'tournament_refund', 'late_seat_debit_reversed') THEN 'table'
           WHEN k.kind IN ('peer_transfer', 'topup', 'rakeback', 'plinko_prize', 'wheel_prize', 'crash_prize', 'mines_prize', 'crossing_prize', 'admin_removal', 'chip_credit', 'buyin') THEN 'player'
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
         CASE
           WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding') THEN 'club_treasury'
           WHEN ct.transaction_type IN ('club_promo_send', 'union_promo_clawback') THEN 'promo_wallet'
           WHEN ct.transaction_type IN ('union_promo_to_club', 'union_member_send', 'union_promo_send') THEN 'union_wallet'
           WHEN ct.transaction_type = 'promo_disbursement' THEN
             CASE WHEN ct.metadata ->> 'source_kind' = 'union' THEN 'union_wallet' ELSE 'promo_wallet' END
           WHEN ct.from_user_id IS NOT NULL THEN 'user'
         END AS from_type,
         CASE
           WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding', 'club_promo_send', 'union_promo_clawback') THEN ct.club_id
           WHEN ct.transaction_type IN ('union_promo_to_club', 'promo_disbursement', 'union_member_send', 'union_promo_send') THEN
             CASE WHEN coalesce(ct.metadata ->> 'source_id', ct.metadata ->> 'union_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN coalesce(ct.metadata ->> 'source_id', ct.metadata ->> 'union_id')::uuid END
           ELSE ct.from_user_id
         END AS from_id,
         NULL::text AS from_ledger_label,
         CASE
           WHEN ct.transaction_type IN ('club_bank_claim', 'admin_removal', 'club_bank_reversal') THEN 'club_treasury'
           WHEN ct.transaction_type = 'union_promo_to_club' THEN 'promo_wallet'
           WHEN ct.transaction_type = 'union_promo_clawback' THEN 'union_wallet'
           WHEN ct.transaction_type = 'promo_disbursement' AND ct.to_user_id IS NULL THEN 'promo_wallet'
           WHEN ct.to_user_id IS NOT NULL THEN 'user'
         END AS to_type,
         CASE
           WHEN ct.transaction_type IN ('club_bank_claim', 'admin_removal', 'club_bank_reversal', 'union_promo_to_club') THEN ct.club_id
           WHEN ct.transaction_type = 'union_promo_clawback' THEN
             CASE WHEN ct.metadata ->> 'union_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (ct.metadata ->> 'union_id')::uuid END
           WHEN ct.transaction_type = 'promo_disbursement' AND ct.to_user_id IS NULL THEN
             CASE WHEN ct.metadata ->> 'target_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (ct.metadata ->> 'target_id')::uuid END
           ELSE ct.to_user_id
         END AS to_id,
         NULL::text AS to_ledger_label,
         @SEARCH@ AS search_text,
         CASE WHEN ct.notes !~* 'horse' AND NOT (k.kind = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN ct.notes END AS notes,
         NULL::numeric AS balance_after,
         ct.table_id,
         NULL::uuid AS tournament_id,
         NULL::uuid AS hand_id,
         CASE WHEN ct.metadata ->> 'op_id' !~* 'horse' AND k.kind <> 'club_bank_send' THEN ct.metadata ->> 'op_id' END AS op_id,
         CASE WHEN ct.metadata ->> 'idempotency_key' !~* 'horse' THEN ct.metadata ->> 'idempotency_key' END AS idempotency_key,
         CASE WHEN ct.metadata ->> 'correlation_id' !~* 'horse' THEN ct.metadata ->> 'correlation_id' END AS correlation_id,
         CASE WHEN ct.metadata ->> 'chip_ledger_id' !~* 'horse' THEN ct.metadata ->> 'chip_ledger_id' END AS ledger_id,
         ct.related_cashout_id::text AS cashout_id,
         CASE WHEN ct.metadata ->> 'ticket_id' !~* 'horse' THEN ct.metadata ->> 'ticket_id' END AS ticket_id
    FROM public.chip_transactions ct
    CROSS JOIN LATERAL (
      SELECT CASE WHEN ct.transaction_type ~* 'horse' THEN 'club_bank_send' ELSE ct.transaction_type END AS kind
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
         CASE WHEN cl.from_label !~* 'horse' AND cl.from_label !~ '^[a-z0-9_]+([.+][a-z0-9_]+)*$' THEN cl.from_label END AS from_ledger_label,
         cl.to_type,
         cl.to_entity_id AS to_id,
         CASE WHEN cl.to_label !~* 'horse' AND cl.to_label !~ '^[a-z0-9_]+([.+][a-z0-9_]+)*$' THEN cl.to_label END AS to_ledger_label,
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
     )@MIRROR@
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

  -- ONE MOVE, ONE ENTRY (2026-10-09). A door that writes a receipt writes the
  -- chip_ledger leg of the same move in the same transaction: same club, same
  -- instant (the transaction's now()), same amount. Such a leg is the receipt
  -- again, so it is left out when a receipt of that instant either carries
  -- the leg's correlation id as its operation id (the promo, pot and reversal
  -- doors), or names nobody (a sweep), or names the leg's holder on one side
  -- and contradicts it on neither, an operator who pressed the button for a
  -- pot not counting as a side. Only the
  -- leg categories a receipt writer journals are probed, so a prize, a spin
  -- or a buy-in leg is never read against a receipt.
  v_mirror_probe := $mirror$
     AND NOT (
       cl.category = ANY (ARRAY['promo', 'promo_send', 'treasury_transfer', 'transfer', 'player_funding', 'reversal', 'refund', 'correction', 'adjustment']::text[])
       AND EXISTS (
         SELECT 1
           FROM public.chip_transactions mirror
         CROSS JOIN LATERAL (
           SELECT CASE WHEN mirror.transaction_type IN ('club_bank_send', 'horse_treasury_funding', 'club_promo_send', 'promo_disbursement', 'union_member_send', 'union_promo_send', 'union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn')
                       THEN NULL ELSE mirror.from_user_id END AS f,
                  CASE WHEN mirror.transaction_type IN ('club_bank_claim', 'admin_removal', 'club_bank_reversal', 'union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn')
                       THEN NULL ELSE mirror.to_user_id END AS t
         ) side
          WHERE mirror.club_id = cl.club_id
            AND mirror.created_at = cl.created_at
            AND abs(mirror.amount) = abs(cl.amount)
            AND ((mirror.metadata ? 'op_id' AND (mirror.metadata ->> 'op_id') = cl.correlation_id::text)
                 OR (mirror.from_user_id IS NULL AND mirror.to_user_id IS NULL)
                 OR ((side.f = cl.from_entity_id OR side.t = cl.to_entity_id)
                     AND (side.f IS NULL OR cl.from_entity_id IS NULL OR side.f = cl.from_entity_id)
                     AND (side.t IS NULL OR cl.to_entity_id IS NULL OR side.t = cl.to_entity_id)))
       )
     )$mirror$;
  v_movement_base := replace(v_movement_base, '@MIRROR@',
    CASE WHEN v_totals_only AND p_scope = 'all' THEN '' ELSE v_mirror_probe END);

  -- WHERE A RECEIPT'S CHIPS MOVE (2026-10-09). A cash out takes the player's
  -- chips at the hold (the agent it names has received nothing), pays the
  -- approver at the approval, and returns the player's chips on a denial, a
  -- cancellation or an expiry. A Club Bank, promo or union pot pays or
  -- receives the member; the operator who pressed the button is not a side,
  -- and a move from one pot to another (or a mint into the treasury) moves no
  -- member's chips.
  v_receipt_direction := $direction$CASE
           WHEN ct.transaction_type = 'cashout_request_escrow' THEN
             CASE WHEN ct.from_user_id = $2 THEN 'out' ELSE 'managed' END
           WHEN ct.transaction_type IN ('cashout_approved', 'cashout_denied', 'cashout_cancelled', 'cashout_expired_refund') THEN
             CASE WHEN ct.to_user_id = $2 THEN 'in' ELSE 'managed' END
           WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding', 'club_promo_send', 'promo_disbursement', 'union_member_send', 'union_promo_send') THEN
             CASE WHEN ct.to_user_id = $2 THEN 'in' ELSE 'managed' END
           WHEN ct.transaction_type IN ('club_bank_claim', 'admin_removal', 'club_bank_reversal') THEN
             CASE WHEN ct.from_user_id = $2 THEN 'out' ELSE 'managed' END
           WHEN ct.transaction_type IN ('union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn') THEN 'managed'
           WHEN ct.to_user_id = $2 AND ct.from_user_id IS DISTINCT FROM $2 THEN 'in'
           WHEN ct.from_user_id = $2 AND ct.to_user_id IS DISTINCT FROM $2 THEN 'out'
           ELSE 'managed'
         END$direction$;

  IF v_labels_inside THEN
    v_receipt_base := replace(replace(v_receipt_base,
      '@JOINS@', E'\n    LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id\n      AND ct.transaction_type NOT IN (''club_bank_send'', ''horse_treasury_funding'', ''club_promo_send'', ''union_promo_clawback'', ''union_promo_to_club'', ''promo_disbursement'', ''union_member_send'', ''union_promo_send'')\n    LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id\n      AND ct.transaction_type NOT IN (''club_bank_claim'', ''admin_removal'', ''club_bank_reversal'')'),
      '@SEARCH@', 'concat_ws(chr(31), CASE WHEN pf.id IS NOT NULL THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END, CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END)');
    v_movement_base := replace(replace(v_movement_base,
      '@JOINS@', E'\n    LEFT JOIN public.profiles pf ON pf.id = cl.from_entity_id\n    LEFT JOIN public.profiles pt ON pt.id = cl.to_entity_id'),
      '@SEARCH@', E'concat_ws(chr(31), CASE WHEN pf.id IS NOT NULL THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,\n                   CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END,\n                   CASE WHEN cl.from_label !~* ''horse'' AND cl.from_label !~ ''^[a-z0-9_]+([.+][a-z0-9_]+)*$'' THEN cl.from_label END,\n                   CASE WHEN cl.to_label !~* ''horse'' AND cl.to_label !~ ''^[a-z0-9_]+([.+][a-z0-9_]+)*$'' THEN cl.to_label END)');
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

  FOR v_i IN 1 .. cardinality(v_receipt_branches) LOOP
    v_parts := v_parts || ('(' || replace(replace(v_receipt_base, '@BRANCH@', '(' || v_receipt_branches[v_i] || ')'),
                                          '@DIRECTION@', coalesce(v_receipt_directions[v_i], v_receipt_direction))
                              || v_filters_sql || v_order_sql || E'\n)');
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
 UNION
 SELECT l.id FROM public.chip_ledger l
 WHERE l.club_id=$1 AND l.created_at >= $3 AND l.created_at < $4
   AND l.status='posted'
   AND l.category = ANY (ARRAY['promo', 'promo_send', 'treasury_transfer', 'transfer', 'player_funding', 'reversal', 'refund', 'correction', 'adjustment']::text[])
   AND EXISTS (
     SELECT 1 FROM public.chip_transactions mirror
     CROSS JOIN LATERAL (
           SELECT CASE WHEN mirror.transaction_type IN ('club_bank_send', 'horse_treasury_funding', 'club_promo_send', 'promo_disbursement', 'union_member_send', 'union_promo_send', 'union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn')
                       THEN NULL ELSE mirror.from_user_id END AS f,
                  CASE WHEN mirror.transaction_type IN ('club_bank_claim', 'admin_removal', 'club_bank_reversal', 'union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn')
                       THEN NULL ELSE mirror.to_user_id END AS t
         ) side
     WHERE mirror.club_id=$1 AND mirror.created_at=l.created_at
       AND abs(mirror.amount)=abs(l.amount)
       AND ((mirror.metadata ? 'op_id' AND (mirror.metadata ->> 'op_id') = l.correlation_id::text)
            OR (mirror.from_user_id IS NULL AND mirror.to_user_id IS NULL)
            OR ((side.f = l.from_entity_id OR side.t = l.to_entity_id)
                AND (side.f IS NULL OR l.from_entity_id IS NULL OR side.f = l.from_entity_id)
                AND (side.t IS NULL OR l.to_entity_id IS NULL OR side.t = l.to_entity_id))))
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
           CASE WHEN pf.id IS NOT NULL
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name)
                ELSE p.from_ledger_label END AS from_label,
           CASE WHEN pt.id IS NOT NULL
                THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name)
                ELSE p.to_ledger_label END AS to_label
      FROM page p
      LEFT JOIN public.profiles pf ON pf.id = p.from_id
      LEFT JOIN public.profiles pt ON pt.id = p.to_id
  ) e
 ORDER BY e.at DESC, e.source COLLATE "C" ASC, e.id DESC
$sql$;
  END IF;

  IF v_totals_only AND p_scope='all' AND v_wallet IS NULL AND v_direction IS NULL AND v_state IS NULL AND p_filters->>'operation' IS NULL AND v_counterparty_id IS NULL AND v_counterparty_pattern IS NULL AND p_filters->>'reference' IS NULL THEN
    -- A receipt the viewer is not a side of is managed whatever its kind, so
    -- it is still counted from the club-time range; the viewer's own receipts
    -- come from the (club, user, time) indexes, which carry the kind that
    -- decides their direction (a cash out, a pot; 2026-10-11).
    v_sql := replace($narrow$WITH raw_totals AS (SELECT direction,coalesce(sum(abs(amount)) FILTER (WHERE amount <> 'NaN'::numeric),0) amount,count(*) n,count(amount) nn,count(*) FILTER (WHERE amount='NaN'::numeric) nc FROM (SELECT 'managed'::text direction,amount FROM public.chip_transactions WHERE club_id=$1 AND created_at >= $3 AND created_at < $4 AND from_user_id IS DISTINCT FROM $2 AND to_user_id IS DISTINCT FROM $2 UNION ALL SELECT @DIRECTION@ direction,ct.amount FROM public.chip_transactions ct WHERE ct.club_id=$1 AND ct.from_user_id=$2 AND ct.created_at >= $3 AND ct.created_at < $4 UNION ALL SELECT @DIRECTION@ direction,ct.amount FROM public.chip_transactions ct WHERE ct.club_id=$1 AND ct.to_user_id=$2 AND ct.from_user_id IS DISTINCT FROM $2 AND ct.created_at >= $3 AND ct.created_at < $4 UNION ALL SELECT CASE WHEN to_entity_id=$2 AND from_entity_id IS DISTINCT FROM $2 THEN 'in' WHEN from_entity_id=$2 AND to_entity_id IS DISTINCT FROM $2 THEN 'out' ELSE 'managed' END direction,amount FROM public.chip_ledger WHERE club_id=$1 AND created_at >= $3 AND created_at < $4 AND status='posted' AND category=ANY($17)) ranged GROUP BY direction), omitted AS (SELECT direction,coalesce(sum(abs(amount)) FILTER (WHERE amount <> 'NaN'::numeric),0) amount,count(*) n,count(amount) nn,count(*) FILTER (WHERE amount='NaN'::numeric) nc FROM (SELECT CASE WHEN to_entity_id=$2 AND from_entity_id IS DISTINCT FROM $2 THEN 'in' WHEN from_entity_id=$2 AND to_entity_id IS DISTINCT FROM $2 THEN 'out' ELSE 'managed' END direction,amount FROM public.chip_ledger WHERE club_id=$1 AND created_at >= $3 AND created_at < $4 AND status='posted' AND category=ANY($17) AND id=ANY($19)) removed GROUP BY direction) SELECT NULL::timestamptz,NULL::text,NULL::uuid,r.direction,CASE WHEN r.nc-coalesce(o.nc,0)>0 THEN 'NaN'::numeric WHEN r.nn-coalesce(o.nn,0)=0 THEN NULL::numeric ELSE r.amount-coalesce(o.amount,0) END,jsonb_build_object('count',r.n-coalesce(o.n,0)) FROM raw_totals r LEFT JOIN omitted o USING(direction) WHERE r.n-coalesce(o.n,0)>0$narrow$, '@DIRECTION@', v_receipt_direction);
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

-- It stays an owner-only helper, exactly as production holds it
-- ({postgres=X/postgres}); restated so no reader has to take a default on trust.
REVOKE ALL ON FUNCTION public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;

-- The installed text is exactly the reviewed text, and it stays an owner-only
-- SECURITY DEFINER helper that no browser role can execute.
DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)) IS DISTINCT FROM '88cb4d660916a2c78b9cf7333c5b3b45' THEN
    RAISE EXCEPTION 'fn_cashier_statement_rows is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) OR has_function_privilege('anon', 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure, 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure, 'EXECUTE')
    OR has_function_privilege('service_role', 'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_cashier_statement_rows lost its owner-only SECURITY DEFINER posture' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
