-- 20261024213601_cashier_history_filters_and_totals.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-24: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE"
-- on the Cashier Transaction History follow-ups: type filters (Cash-Outs,
-- Transfers, Games), a date range, true totals, and an agent's downline book
-- (his Club Data ruling: agents see their own plus their downlines).
--
-- 1. fn_cashier_history_page(p_club_id, p_scope, p_kind, p_from, p_to,
--    p_limit, p_offset). The book is decided by the server, never widened by
--    the caller:
--      'club'      owner, co-owner, admin only (everyone else gets 'mine');
--      'downline'  super agent, agent, sub agent only: their own rows and every
--                  row a member of their active cashier downline is a side of;
--      'mine'      the rows the viewer is a side of.
--    p_kind narrows to 'cashout' (the five cashier cash-out legs), 'transfer'
--    (wallet, bank, promo, union, treasury and ticket moves) or 'game'
--    (everything else: table cash-outs, tournament buy-ins, prizes). A
--    treasury-funded seat is a transfer, exactly as it is presented: a Club
--    Bank send. Rows are presented exactly as fn_club_trade_ledger presents
--    them (arena names, a funded seat as a Club Bank send, a send's operator
--    named only to the operator and the member paid).
--
-- 2. fn_cashier_history_totals(p_club_id, p_kind, p_from, p_to). In, Out and
--    Net of the VIEWER'S OWN chips, over the whole filtered book, not the
--    page on screen. Direction is the Full Statement's rule
--    (fn_cashier_statement_rows; tests/the-statement-counts-each-move-once):
--    a cash-out request is out of the player, an accepted cash-out is into
--    the accepter, a refund is into the player, mint/burn/union promo are
--    managed, and a self move is managed. Measured on KINGS CLUB 2026-10-24:
--    the viewer's own book sums in 57 ms; a club-wide sum over 30 days took
--    34 s, so the club's volume is deliberately NOT totalled here.
--
-- 3. idx_chip_tx_club_transfer_created. Measured 2026-10-24 on KINGS CLUB
--    (981k rows): the newest 251 transfers took 7.7 s, because the only
--    ordered path walked 107k game rows to find them. A partial index on
--    exactly the transfer kinds makes that an ordered index scan. It is built
--    CONCURRENTLY in the supported preamble (chip_transactions is written
--    every hand); Cash-Outs already use idx_chip_tx_type_user_created (14 ms)
--    and Games are the bulk of the book, so they need nothing new.
--
-- fn_cashier_transaction_history (20261024195842) is left in place for any
-- client still on the previous bundle.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_tx_club_transfer_created
 ON public.chip_transactions (club_id, created_at DESC, id DESC)
 WHERE transaction_type = ANY ('{agent_wallet_send,agent_wallet_claim_back,agent_wallet_self_stake,club_bank_send,horse_treasury_funding,club_bank_claim,club_bank_reversal,admin_removal,mint,treasury_mint,treasury_burn,treasury_debit,treasury_credit,peer_transfer,promo_wallet_send,club_promo_send,promo_disbursement,club_opening_grant,rakeback,commission_claim,overlay_funding,overlay_rebank,union_transfer,union_transfer_reversal,union_promo_send,union_promo_to_club,union_promo_clawback,union_clawback,leave_club_chip_return,default_mint_correction,promo_closed_on_union_join,tournament_ticket_issue,tournament_ticket_redeem,tournament_ticket_cancel,transfer}'::text[]);

BEGIN;
SET LOCAL lock_timeout = '5s';

-- IF NOT EXISTS is not evidence that an existing index has the right shape or
-- finished its concurrent build: refuse an interrupted or unrelated one.
DO $index_guard$
DECLARE v_def text; v_valid boolean; v_ready boolean;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready
    INTO v_def, v_valid, v_ready
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.idx_chip_tx_club_transfer_created')
     AND i.indrelid = 'public.chip_transactions'::regclass;
  IF v_valid IS DISTINCT FROM true OR v_ready IS DISTINCT FROM true
     OR position('(club_id, created_at DESC, id DESC)' IN v_def) = 0
     OR position('horse_treasury_funding' IN v_def) = 0
     OR position('tournament_ticket_cancel' IN v_def) = 0 THEN
    RAISE EXCEPTION 'idx_chip_tx_club_transfer_created is missing, invalid or not the expected shape: %', v_def;
  END IF;
END $index_guard$;

CREATE OR REPLACE FUNCTION public.fn_cashier_history_page(
  p_club_id uuid,
  p_scope text DEFAULT 'mine',
  p_kind text DEFAULT 'all',
  p_from timestamp with time zone DEFAULT NULL,
  p_to timestamp with time zone DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid, notes text, metadata jsonb, from_name text, to_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  v_scope text := lower(btrim(coalesce(p_scope, 'mine')));
  v_kind text := lower(btrim(coalesce(p_kind, 'all')));
  -- 250 rows on screen plus one sentinel row, as fn_club_trade_ledger.
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 251);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_book text;
  v_people uuid[];
  v_filter text;
  v_pick text;
  -- The kind lists are written into the statement as literals (EXECUTE plans
  -- each call with them as constants), so the transfer list matches the
  -- partial index predicate above exactly. Keep the three copies identical.
  c_cashout constant text := $k$'{cashout_request_escrow,cashout_approved,cashout_denied,cashout_cancelled,cashout_expired_refund}'::text[]$k$;
  c_transfer constant text := $k$'{agent_wallet_send,agent_wallet_claim_back,agent_wallet_self_stake,club_bank_send,horse_treasury_funding,club_bank_claim,club_bank_reversal,admin_removal,mint,treasury_mint,treasury_burn,treasury_debit,treasury_credit,peer_transfer,promo_wallet_send,club_promo_send,promo_disbursement,club_opening_grant,rakeback,commission_claim,overlay_funding,overlay_rebank,union_transfer,union_transfer_reversal,union_promo_send,union_promo_to_club,union_promo_clawback,union_clawback,leave_club_chip_return,default_mint_correction,promo_closed_on_union_join,tournament_ticket_issue,tournament_ticket_redeem,tournament_ticket_cancel,transfer}'::text[]$k$;
  v_sql text;
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN; END IF;
  IF v_scope NOT IN ('club', 'mine', 'downline') THEN
    RAISE EXCEPTION 'transaction_history_scope_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_kind NOT IN ('all', 'cashout', 'transfer', 'game') THEN
    RAISE EXCEPTION 'transaction_history_kind_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'transaction_history_range_invalid' USING ERRCODE = '22023';
  END IF;
  v_role := public.fn_club_bank_role(p_club_id, v_viewer);
  IF v_role IS NULL THEN RETURN; END IF;

  -- The scope can narrow a book, never widen it.
  v_book := CASE
    WHEN v_scope = 'club' AND v_role IN ('owner', 'co_owner', 'admin') THEN 'club'
    WHEN v_scope = 'downline' AND v_role IN ('super_agent', 'agent', 'sub_agent') THEN 'downline'
    ELSE 'mine' END;
  IF v_book = 'downline' THEN
    WITH RECURSIVE dl AS (
      SELECT v_viewer AS user_id
      UNION
      SELECT edge.child
        FROM public.fn_club_active_cashier_edges(p_club_id) edge
        JOIN dl ON edge.parent = dl.user_id
    )
    SELECT array_agg(dl.user_id) INTO v_people FROM dl;
  END IF;

  v_filter := CASE v_kind
         WHEN 'cashout' THEN ' AND ct.transaction_type = ANY (' || c_cashout || ')'
         WHEN 'transfer' THEN ' AND ct.transaction_type = ANY (' || c_transfer || ')'
         WHEN 'game' THEN ' AND NOT (ct.transaction_type = ANY (' || c_cashout || ') OR ct.transaction_type = ANY (' || c_transfer || '))'
         ELSE '' END
    || CASE WHEN p_from IS NOT NULL THEN ' AND ct.created_at >= $4' ELSE '' END
    || CASE WHEN p_to IS NOT NULL THEN ' AND ct.created_at < $5' ELSE '' END;

  IF v_book = 'club' THEN
    v_pick := 'SELECT ct.id FROM public.chip_transactions ct WHERE ct.club_id = $1' || v_filter
      || ' ORDER BY ct.created_at DESC, ct.id DESC LIMIT $6 OFFSET $7';
  ELSE
    -- One person or a downline: each person's newest rows come straight off
    -- the (club_id, from_user_id, created_at) and (club_id, to_user_id,
    -- created_at) indexes, then merge. Measured 2026-10-24: an OR across the
    -- whole club walked 980k rows for an agent with 33 (13.9 s).
    IF v_book = 'mine' THEN v_people := ARRAY[v_viewer]; END IF;
    v_pick := 'SELECT DISTINCT ON (x.created_at, x.id) x.id FROM unnest($3) AS p(uid) CROSS JOIN LATERAL ('
      || '(SELECT ct.id, ct.created_at FROM public.chip_transactions ct WHERE ct.club_id = $1 AND ct.from_user_id = p.uid' || v_filter
      || ' ORDER BY ct.created_at DESC, ct.id DESC LIMIT $6 + $7)'
      || ' UNION ALL '
      || '(SELECT ct.id, ct.created_at FROM public.chip_transactions ct WHERE ct.club_id = $1 AND ct.to_user_id = p.uid' || v_filter
      || ' ORDER BY ct.created_at DESC, ct.id DESC LIMIT $6 + $7)'
      || ') x ORDER BY x.created_at DESC, x.id DESC LIMIT $6 OFFSET $7';
  END IF;

  v_sql := 'WITH picked AS MATERIALIZED (' || v_pick || ')' || $q$
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND $2 IS DISTINCT FROM ct.from_user_id AND $2 IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND $2 IS DISTINCT FROM ct.from_user_id AND $2 IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM picked
      JOIN public.chip_transactions ct ON ct.id = picked.id
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     ORDER BY ct.created_at DESC, ct.id DESC$q$;

  RETURN QUERY EXECUTE v_sql USING p_club_id, v_viewer, v_people, p_from, p_to, v_limit, v_offset;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_history_page(uuid, text, text, timestamp with time zone, timestamp with time zone, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_history_page(uuid, text, text, timestamp with time zone, timestamp with time zone, integer, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_cashier_history_totals(
  p_club_id uuid,
  p_kind text DEFAULT 'all',
  p_from timestamp with time zone DEFAULT NULL,
  p_to timestamp with time zone DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_kind text := lower(btrim(coalesce(p_kind, 'all')));
  c_cashout constant text := $k$'{cashout_request_escrow,cashout_approved,cashout_denied,cashout_cancelled,cashout_expired_refund}'::text[]$k$;
  c_transfer constant text := $k$'{agent_wallet_send,agent_wallet_claim_back,agent_wallet_self_stake,club_bank_send,horse_treasury_funding,club_bank_claim,club_bank_reversal,admin_removal,mint,treasury_mint,treasury_burn,treasury_debit,treasury_credit,peer_transfer,promo_wallet_send,club_promo_send,promo_disbursement,club_opening_grant,rakeback,commission_claim,overlay_funding,overlay_rebank,union_transfer,union_transfer_reversal,union_promo_send,union_promo_to_club,union_promo_clawback,union_clawback,leave_club_chip_return,default_mint_correction,promo_closed_on_union_join,tournament_ticket_issue,tournament_ticket_redeem,tournament_ticket_cancel,transfer}'::text[]$k$;
  v_sql text;
  v_in numeric;
  v_out numeric;
  v_n bigint;
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN NULL; END IF;
  IF v_kind NOT IN ('all', 'cashout', 'transfer', 'game') THEN
    RAISE EXCEPTION 'transaction_history_kind_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'transaction_history_range_invalid' USING ERRCODE = '22023';
  END IF;
  IF public.fn_club_bank_role(p_club_id, v_viewer) IS NULL THEN RETURN NULL; END IF;

  -- The Full Statement's direction rule, applied to the viewer's own rows.
  v_sql := $q$
    WITH own AS (
      SELECT ct.amount,
             CASE
               WHEN ct.transaction_type = 'cashout_request_escrow'
                 THEN CASE WHEN ct.from_user_id = $2 THEN 'out' ELSE 'managed' END
               WHEN ct.transaction_type IN ('cashout_approved', 'cashout_denied', 'cashout_cancelled', 'cashout_expired_refund')
                 THEN CASE WHEN ct.to_user_id = $2 THEN 'in' ELSE 'managed' END
               WHEN ct.transaction_type IN ('union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn') THEN 'managed'
               WHEN ct.to_user_id = $2 AND ct.from_user_id IS DISTINCT FROM $2 THEN 'in'
               WHEN ct.from_user_id = $2 AND ct.to_user_id IS DISTINCT FROM $2 THEN 'out'
               ELSE 'managed'
             END AS direction
        FROM public.chip_transactions ct
       WHERE ct.club_id = $1
         AND (ct.from_user_id = $2 OR ct.to_user_id = $2)$q$
    || CASE v_kind
         WHEN 'cashout' THEN ' AND ct.transaction_type = ANY (' || c_cashout || ')'
         WHEN 'transfer' THEN ' AND ct.transaction_type = ANY (' || c_transfer || ')'
         WHEN 'game' THEN ' AND NOT (ct.transaction_type = ANY (' || c_cashout || ') OR ct.transaction_type = ANY (' || c_transfer || '))'
         ELSE '' END
    || CASE WHEN p_from IS NOT NULL THEN ' AND ct.created_at >= $3' ELSE '' END
    || CASE WHEN p_to IS NOT NULL THEN ' AND ct.created_at < $4' ELSE '' END
    || $q$
    )
    SELECT coalesce(sum(abs(amount)) FILTER (WHERE direction = 'in'), 0),
           coalesce(sum(abs(amount)) FILTER (WHERE direction = 'out'), 0),
           count(*)
      FROM own$q$;

  EXECUTE v_sql INTO v_in, v_out, v_n USING p_club_id, v_viewer, p_from, p_to;
  RETURN jsonb_build_object(
    'incoming', round(v_in, 2)::text,
    'outgoing', round(v_out, 2)::text,
    'net', round(v_in - v_out, 2)::text,
    'entries', v_n
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_history_totals(uuid, text, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_history_totals(uuid, text, timestamp with time zone, timestamp with time zone) TO authenticated, service_role;

-- Read back the posture of both doors before COMMIT.
DO $post$
DECLARE v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.fn_cashier_history_page(uuid,text,text,timestamptz,timestamptz,integer,integer)'::regprocedure,
    'public.fn_cashier_history_totals(uuid,text,timestamptz,timestamptz)'::regprocedure
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=public, pg_temp', 'lock_timeout=5s']::text[]
    ) THEN
      RAISE EXCEPTION 'POST-APPLY: % posture is not definer + pinned settings', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-APPLY: % grants are wrong', v_fn;
    END IF;
  END LOOP;
END $post$;

COMMIT;
