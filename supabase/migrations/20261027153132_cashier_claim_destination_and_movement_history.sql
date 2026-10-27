-- Owner 2026-10-27: selected reclaim destination, promo stays promo, chip movement history.
-- Function-only change; no hot-table DDL, records rewritten or engine dependency.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_cashier_history_feed(uuid,text,text,timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)'::regprocedure)) <> '89660440772e3eb071c43d20cdd3f61f' THEN RAISE EXCEPTION 'History Source Changed: fn_cashier_history_feed'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_cashier_history_feed(p_club_id uuid, p_scope text DEFAULT 'mine'::text, p_kind text DEFAULT 'all'::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_person uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid, notes text, metadata jsonb, from_name text, to_name text, request_status text, request_created_at timestamp with time zone, invoice_number text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_kind text := lower(btrim(coalesce(p_kind, 'all')));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  -- 250 rows on screen plus one sentinel row, as fn_club_trade_ledger.
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 251);
  v_book text;
  v_people uuid[];
  v_subject uuid;
  v_ids uuid[];
  v_match uuid[];
  v_filter text;
  v_pick text;
  c_cashout constant text := $k$'{cashout_request_escrow,cashout_approved,cashout_denied,cashout_cancelled,cashout_expired_refund}'::text[]$k$;
  c_transfer constant text := $k$'{agent_wallet_send,agent_wallet_claim_back,agent_wallet_self_stake,club_bank_send,horse_treasury_funding,club_bank_claim,club_bank_reversal,admin_removal,mint,treasury_mint,treasury_burn,treasury_debit,treasury_credit,peer_transfer,promo_wallet_send,club_promo_send,promo_disbursement,club_opening_grant,rakeback,commission_claim,overlay_funding,overlay_rebank,union_transfer,union_transfer_reversal,union_promo_send,union_promo_to_club,union_promo_clawback,union_clawback,leave_club_chip_return,default_mint_correction,promo_closed_on_union_join,tournament_ticket_issue,tournament_ticket_cancel,transfer}'::text[]$k$;
  v_sql text;
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN; END IF;
  IF v_kind NOT IN ('all', 'cashout', 'transfer', 'game') THEN
    RAISE EXCEPTION 'transaction_history_kind_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'transaction_history_range_invalid' USING ERRCODE = '22023';
  END IF;
  IF (p_before_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'transaction_history_cursor_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT b.book, b.people, b.subject INTO v_book, v_people, v_subject
    FROM public.fn_cashier_history_book(p_club_id, v_viewer, p_scope, p_person) b;
  IF v_book IS NULL THEN RETURN; END IF;

  v_filter := CASE v_kind
         WHEN 'cashout' THEN ' AND ct.transaction_type = ANY (' || c_cashout || ')'
         WHEN 'transfer' THEN ' AND ct.transaction_type = ANY (' || c_transfer || ')'
         WHEN 'game' THEN ' AND false'
         ELSE ' AND (ct.transaction_type = ANY (' || c_cashout || ') OR ct.transaction_type = ANY (' || c_transfer || '))' END
    || CASE WHEN p_from IS NOT NULL THEN ' AND ct.created_at >= $4' ELSE '' END
    || CASE WHEN p_to IS NOT NULL THEN ' AND ct.created_at < $5' ELSE '' END
    || CASE WHEN p_before_at IS NOT NULL THEN ' AND (ct.created_at, ct.id) < ($6, $7)' ELSE '' END;

  IF v_search IS NOT NULL THEN
    IF length(v_search) < 2 THEN RETURN; END IF;
    IF v_search ~* '^CA-[0-9]{4}-[0-9]+$' THEN
      -- An invoice number names the ledger legs it documents, in this club.
      SELECT array_agg(e.source_transaction_id) INTO v_ids
        FROM public.settlement_invoices i
        JOIN public.accounting_cashier_events e ON e.invoice_id = i.id
       WHERE i.invoice_number = upper(v_search) AND i.club_id = p_club_id
         AND e.source_transaction_id IS NOT NULL;
      IF v_ids IS NULL THEN RETURN; END IF;
      v_filter := v_filter || ' AND ct.id = ANY ($9)';
    ELSE
      -- Part of an arena name: the members of this club it matches.
      SELECT array_agg(m.user_id) INTO v_match
        FROM (
          SELECT DISTINCT cm.user_id
            FROM public.club_members cm
            JOIN public.profiles pr ON pr.id = cm.user_id
           WHERE cm.club_id = p_club_id
             AND public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name)
                 ILIKE '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           LIMIT 200
        ) m;
      IF v_match IS NULL THEN RETURN; END IF;
      IF v_book = 'club' THEN
        -- The club book reads each matched member's rows directly.
        v_people := v_match;
        v_book := 'people';
      ELSE
        v_filter := v_filter || ' AND (ct.from_user_id = ANY ($10) OR ct.to_user_id = ANY ($10))';
      END IF;
    END IF;
  END IF;

  IF v_book = 'club' THEN
    v_pick := 'SELECT ct.id FROM public.chip_transactions ct WHERE ct.club_id = $1' || v_filter
      || ' ORDER BY ct.created_at DESC, ct.id DESC LIMIT $8';
  ELSE
    -- One person, a downline or the matched members: each person's newest
    -- rows come straight off the (club_id, from_user_id, created_at) and
    -- (club_id, to_user_id, created_at) indexes, then merge.
    v_pick := 'SELECT DISTINCT ON (x.created_at, x.id) x.id FROM unnest($3) AS p(uid) CROSS JOIN LATERAL ('
      || '(SELECT ct.id, ct.created_at FROM public.chip_transactions ct WHERE ct.club_id = $1 AND ct.from_user_id = p.uid' || v_filter
      || ' ORDER BY ct.created_at DESC, ct.id DESC LIMIT $8)'
      || ' UNION ALL '
      || '(SELECT ct.id, ct.created_at FROM public.chip_transactions ct WHERE ct.club_id = $1 AND ct.to_user_id = p.uid' || v_filter
      || ' ORDER BY ct.created_at DESC, ct.id DESC LIMIT $8)'
      || ') x ORDER BY x.created_at DESC, x.id DESC LIMIT $8';
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
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END,
           cr.status,
           cr.created_at,
           si.invoice_number
      FROM picked
      JOIN public.chip_transactions ct ON ct.id = picked.id
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
      LEFT JOIN public.cashout_requests cr
        ON cr.id = ct.related_cashout_id
       AND ct.transaction_type IN ('cashout_request_escrow', 'cashout_approved', 'cashout_denied', 'cashout_cancelled', 'cashout_expired_refund')
      LEFT JOIN public.accounting_cashier_events ae ON ae.source_transaction_id = ct.id
      LEFT JOIN public.settlement_invoices si ON si.id = ae.invoice_id
     ORDER BY ct.created_at DESC, ct.id DESC$q$;

  RETURN QUERY EXECUTE v_sql
    USING p_club_id, v_viewer, v_people, p_from, p_to, p_before_at, p_before_id, v_limit, v_ids, v_match;
END
$function$

;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_cashier_history_summary(uuid,text,text,timestamptz,timestamptz,uuid)'::regprocedure)) <> '043453f8319d0e8904f29e90c03eecd9' THEN RAISE EXCEPTION 'History Source Changed: fn_cashier_history_summary'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_cashier_history_summary(p_club_id uuid, p_scope text DEFAULT 'mine'::text, p_kind text DEFAULT 'all'::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_person uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_kind text := lower(btrim(coalesce(p_kind, 'all')));
  v_book text;
  v_people uuid[];
  v_subject uuid;
  v_group uuid[];
  c_cashout constant text := $k$'{cashout_request_escrow,cashout_approved,cashout_denied,cashout_cancelled,cashout_expired_refund}'::text[]$k$;
  c_transfer constant text := $k$'{agent_wallet_send,agent_wallet_claim_back,agent_wallet_self_stake,club_bank_send,horse_treasury_funding,club_bank_claim,club_bank_reversal,admin_removal,mint,treasury_mint,treasury_burn,treasury_debit,treasury_credit,peer_transfer,promo_wallet_send,club_promo_send,promo_disbursement,club_opening_grant,rakeback,commission_claim,overlay_funding,overlay_rebank,union_transfer,union_transfer_reversal,union_promo_send,union_promo_to_club,union_promo_clawback,union_clawback,leave_club_chip_return,default_mint_correction,promo_closed_on_union_join,tournament_ticket_issue,tournament_ticket_cancel,transfer}'::text[]$k$;
  v_kind_filter text;
  v_sql text;
  v_in numeric;
  v_out numeric;
  v_n bigint;
  -- club mode
  v_now timestamptz := now();
  v_to timestamptz;
  v_first_full date;
  v_end_full date;
  v_day date;
  v_started timestamptz := clock_timestamp();
  v_complete boolean := true;
  v_entries bigint := 0;
  v_volume numeric := 0;
  v_paid numeric := 0;
  v_e bigint;
  v_v numeric;
  v_p numeric;
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN NULL; END IF;
  IF v_kind NOT IN ('all', 'cashout', 'transfer', 'game') THEN
    RAISE EXCEPTION 'transaction_history_kind_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'transaction_history_range_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT b.book, b.people, b.subject INTO v_book, v_people, v_subject
    FROM public.fn_cashier_history_book(p_club_id, v_viewer, p_scope, p_person) b;
  IF v_book IS NULL THEN RETURN NULL; END IF;

  v_kind_filter := CASE v_kind
         WHEN 'cashout' THEN ' AND ct.transaction_type = ANY (' || c_cashout || ')'
         WHEN 'transfer' THEN ' AND ct.transaction_type = ANY (' || c_transfer || ')'
         WHEN 'game' THEN ' AND false'
         ELSE ' AND (ct.transaction_type = ANY (' || c_cashout || ') OR ct.transaction_type = ANY (' || c_transfer || '))' END;

  IF v_book = 'club' THEN
    v_to := least(coalesce(p_to, v_now), v_now);
    IF p_from IS NULL THEN
      SELECT min(ct.created_at)::date INTO v_first_full
        FROM public.chip_transactions ct WHERE ct.club_id = p_club_id;
      IF v_first_full IS NULL THEN
        RETURN jsonb_build_object('mode', 'club', 'entries', 0, 'volume', '0.00', 'cashouts_paid', '0.00', 'complete', true);
      END IF;
    ELSE
      v_first_full := CASE WHEN p_from = date_trunc('day', p_from, 'UTC')
                           THEN (p_from AT TIME ZONE 'UTC')::date
                           ELSE (p_from AT TIME ZONE 'UTC')::date + 1 END;
    END IF;
    -- Only closed days are cached; today and later are always read live.
    v_end_full := least((v_to AT TIME ZONE 'UTC')::date, (v_now AT TIME ZONE 'UTC')::date);
    IF v_end_full < v_first_full THEN v_end_full := v_first_full; END IF;

    -- Count each closed day in range the cache does not have yet, oldest
    -- first, inside a 2.5 s budget. A closed day never changes (the ledger is
    -- append-only), so a counted day is never counted again.
    FOR v_day IN
      SELECT d::date FROM generate_series(v_first_full, v_end_full - 1, interval '1 day') d
       WHERE NOT EXISTS (
         SELECT 1 FROM public.cashier_club_day_totals t
          WHERE t.club_id = p_club_id AND t.day = d::date AND t.transaction_type = '*')
       ORDER BY 1
    LOOP
      IF clock_timestamp() - v_started > interval '2.5 seconds' THEN
        v_complete := false;
        EXIT;
      END IF;
      INSERT INTO public.cashier_club_day_totals (club_id, day, transaction_type, entries, volume, net_amount)
      SELECT p_club_id, v_day, s.transaction_type, s.entries, s.volume, s.net_amount
        FROM (
          SELECT ct.transaction_type, count(*) AS entries, coalesce(sum(abs(ct.amount)), 0) AS volume, coalesce(sum(ct.amount), 0) AS net_amount
            FROM public.chip_transactions ct
           WHERE ct.club_id = p_club_id
             AND ct.created_at >= (v_day::timestamp AT TIME ZONE 'UTC')
             AND ct.created_at < ((v_day + 1)::timestamp AT TIME ZONE 'UTC')
           GROUP BY ct.transaction_type
          UNION ALL
          SELECT '*', count(*), coalesce(sum(abs(ct.amount)), 0), coalesce(sum(ct.amount), 0)
            FROM public.chip_transactions ct
           WHERE ct.club_id = p_club_id
             AND ct.created_at >= (v_day::timestamp AT TIME ZONE 'UTC')
             AND ct.created_at < ((v_day + 1)::timestamp AT TIME ZONE 'UTC')
        ) s
      ON CONFLICT (club_id, day, transaction_type) DO NOTHING;
    END LOOP;

    -- Cached closed days.
    EXECUTE 'SELECT coalesce(sum(t.entries), 0), coalesce(sum(t.volume), 0),'
      || ' coalesce(sum(t.volume) FILTER (WHERE t.transaction_type = ''cashout_approved''), 0)'
      || ' FROM public.cashier_club_day_totals t'
      || ' WHERE t.club_id = $1 AND t.day >= $2 AND t.day < $3 AND t.transaction_type <> ''*'''
      || replace(v_kind_filter, 'ct.transaction_type', 't.transaction_type')
      INTO v_e, v_v, v_p USING p_club_id, v_first_full, v_end_full;
    v_entries := v_entries + v_e; v_volume := v_volume + v_v; v_paid := v_paid + v_p;

    -- The open edges, read live: before the first whole day, and from the end
    -- of the last cached day to the end of the range.
    v_sql := 'SELECT count(*), coalesce(sum(abs(ct.amount)), 0),'
      || ' coalesce(sum(abs(ct.amount)) FILTER (WHERE ct.transaction_type = ''cashout_approved''), 0)'
      || ' FROM public.chip_transactions ct WHERE ct.club_id = $1 AND ct.created_at >= $2 AND ct.created_at < $3'
      || v_kind_filter;
    IF p_from IS NOT NULL AND p_from < (v_first_full::timestamp AT TIME ZONE 'UTC') THEN
      EXECUTE v_sql INTO v_e, v_v, v_p
        USING p_club_id, p_from, least(v_to, v_first_full::timestamp AT TIME ZONE 'UTC');
      v_entries := v_entries + v_e; v_volume := v_volume + v_v; v_paid := v_paid + v_p;
    END IF;
    IF v_to > greatest(v_end_full::timestamp AT TIME ZONE 'UTC', coalesce(p_from, '-infinity')) THEN
      EXECUTE v_sql INTO v_e, v_v, v_p
        USING p_club_id, greatest(v_end_full::timestamp AT TIME ZONE 'UTC', coalesce(p_from, '-infinity')), v_to;
      v_entries := v_entries + v_e; v_volume := v_volume + v_v; v_paid := v_paid + v_p;
    END IF;

    RETURN jsonb_build_object(
      'mode', 'club',
      'entries', v_entries,
      'volume', round(v_volume, 2)::text,
      'cashouts_paid', round(v_paid, 2)::text,
      'complete', v_complete
    );
  END IF;

  -- One wallet (the viewer or the picked person), or the downline as a group.
  -- The Full Statement's direction rule, with "the viewer" read as "a member
  -- of the group": a move between two members of the group is neither In nor
  -- Out.
  v_group := CASE WHEN v_book = 'downline' THEN v_people ELSE ARRAY[v_subject] END;
  v_sql := $q$
    WITH rows AS (
      SELECT DISTINCT ON (x.id) x.amount, x.transaction_type, x.from_user_id, x.to_user_id
        FROM unnest($2) AS p(uid) CROSS JOIN LATERAL (
          (SELECT ct.id, ct.amount, ct.transaction_type, ct.from_user_id, ct.to_user_id
             FROM public.chip_transactions ct
            WHERE ct.club_id = $1 AND ct.from_user_id = p.uid$q$ || '%FILTER%' || $q$)
          UNION ALL
          (SELECT ct.id, ct.amount, ct.transaction_type, ct.from_user_id, ct.to_user_id
             FROM public.chip_transactions ct
            WHERE ct.club_id = $1 AND ct.to_user_id = p.uid$q$ || '%FILTER%' || $q$)
        ) x
    ), classified AS (
      SELECT amount,
             CASE
               WHEN transaction_type = 'cashout_request_escrow'
                 THEN CASE WHEN from_user_id = ANY ($2) AND NOT (to_user_id = ANY ($2) AND $5) THEN 'out' ELSE 'managed' END
               WHEN transaction_type IN ('cashout_approved', 'cashout_denied', 'cashout_cancelled', 'cashout_expired_refund')
                 THEN CASE WHEN to_user_id = ANY ($2) AND NOT (from_user_id = ANY ($2) AND $5) THEN 'in' ELSE 'managed' END
               WHEN transaction_type IN ('union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn') THEN 'managed'
               WHEN to_user_id = ANY ($2) AND NOT coalesce(from_user_id = ANY ($2), false) THEN 'in'
               WHEN from_user_id = ANY ($2) AND NOT coalesce(to_user_id = ANY ($2), false) THEN 'out'
               ELSE 'managed'
             END AS direction
        FROM rows
    )
    SELECT coalesce(sum(abs(amount)) FILTER (WHERE direction = 'in'), 0),
           coalesce(sum(abs(amount)) FILTER (WHERE direction = 'out'), 0),
           count(*)
      FROM classified$q$;
  v_sql := replace(v_sql, '%FILTER%', v_kind_filter
    || CASE WHEN p_from IS NOT NULL THEN ' AND ct.created_at >= $3' ELSE '' END
    || CASE WHEN p_to IS NOT NULL THEN ' AND ct.created_at < $4' ELSE '' END);

  -- $5: inside a downline a cash-out between two members stays in the group.
  -- For one wallet it keeps the Statement's exact rule (a request is Out for
  -- the player even though its leg names the agent).
  EXECUTE v_sql INTO v_in, v_out, v_n USING p_club_id, v_group, p_from, p_to, (v_book = 'downline');
  RETURN jsonb_build_object(
    'mode', CASE WHEN v_book = 'downline' THEN 'group' ELSE 'wallet' END,
    'subject', v_subject,
    'incoming', round(v_in, 2)::text,
    'outgoing', round(v_out, 2)::text,
    'net', round(v_in - v_out, 2)::text,
    'entries', v_n
  );
END
$function$

;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
VALUES ('fn_club_wallet_claim_back','approved','Owner-selected reclaim destination; exact-intent atomic direct move and one journal leg, promo restricted to promo destinations.') ON CONFLICT(proname) DO NOTHING;
DO $patch$ DECLARE d text; BEGIN
 SELECT pg_get_functiondef('public.fn_cashier_browser_recovery_valid(uuid,uuid,text,text,jsonb)'::regprocedure) INTO d;
 IF position('''fn_club_bank_claim_back'',''fn_agent_wallet_send''' IN d)=0 THEN RAISE EXCEPTION 'Recovery Action List Changed'; END IF;
 EXECUTE replace(d,'''fn_club_bank_claim_back'',''fn_agent_wallet_send''','''fn_club_bank_claim_back'',''fn_club_wallet_claim_back'',''fn_agent_wallet_send''');
END $patch$;
CREATE OR REPLACE FUNCTION public.fn_club_wallet_claim_back(
 p_club_id uuid,p_from_user_id uuid,p_amount numeric,p_source text,
 p_destination text,p_reason text,p_op_id uuid,p_transaction_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp' SET lock_timeout TO '5s'
AS $function$
DECLARE
 actor uuid:=auth.uid(); actor_role text; holder_role text; gate jsonb; result jsonb;
 held numeric; holder_after numeric; destination_after numeric; source_agent uuid; target_agent uuid;
 original public.chip_transactions%ROWTYPE; v_amount numeric:=p_amount; claimed numeric; remaining numeric; repay numeric:=0; drawn numeric; repaid numeric; used numeric; movement_type text:=CASE WHEN p_transaction_id IS NULL THEN 'club_bank_claim' ELSE 'agent_wallet_claim_back' END;
 tx uuid; context jsonb; setting text; destination_pool text; destination_entity uuid;
BEGIN
 IF p_op_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','A Retry Key Is Required'); END IF;
 gate:=public.fn_cashier_exact_intent_begin(CASE WHEN p_transaction_id IS NULL THEN 'club_bank_claim' ELSE 'agent_wallet_claim_back' END,p_club_id,p_op_id,
  jsonb_build_object('actor',actor,'club',p_club_id,'action','club_wallet_claim','source_user',p_from_user_id,
   'amount',p_amount,'source',p_source,'destination',p_destination,'reason',p_reason,'original_transaction_id',p_transaction_id));
 IF gate->>'state'='return' THEN RETURN gate->'response'; END IF;
 IF actor IS NULL OR p_club_id IS NULL OR p_from_user_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','Choose An Active Club Member'); END IF;
 IF (p_amount IS NULL AND p_transaction_id IS NULL) OR p_amount<=0 OR p_amount>1e9 OR p_amount<>round(p_amount,2) THEN RETURN jsonb_build_object('success',false,'error','Enter A Valid Claim Amount'); END IF;
 IF p_source IS NULL OR p_source NOT IN ('player_wallet','agent_wallet','promo_wallet') OR p_destination IS NULL OR p_destination NOT IN ('club_bank','club_promo_wallet','player_wallet','agent_wallet','promo_wallet') THEN RETURN jsonb_build_object('success',false,'error','Unknown Wallet'); END IF;
 IF p_source='promo_wallet' AND p_destination NOT IN ('promo_wallet','club_promo_wallet') THEN RETURN jsonb_build_object('success',false,'error','Promo Chips Must Return To A Promo Wallet'); END IF;
 IF actor=p_from_user_id AND p_source=p_destination THEN RETURN jsonb_build_object('success',false,'error','Choose A Different Return Wallet'); END IF;
 -- Shared authority locks precede balance locks, matching existing cashier writers.
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));
 PERFORM 1 FROM public.clubs WHERE id=p_club_id FOR UPDATE;
 PERFORM 1 FROM public.club_members WHERE club_id=p_club_id AND user_id IN (actor,p_from_user_id) ORDER BY user_id FOR UPDATE;
 actor_role:=public.fn_club_bank_role(p_club_id);
 IF actor_role IS NULL OR actor_role NOT IN ('owner','co_owner','admin','super_agent','agent','sub_agent') THEN RETURN jsonb_build_object('success',false,'error','Your Claim Authority Is Not Active'); END IF;
 IF p_transaction_id IS NULL AND actor_role NOT IN ('owner','co_owner','admin') THEN RETURN jsonb_build_object('success',false,'error','Choose One Of Your Recent Sends'); END IF;
 IF p_destination IN ('club_bank','club_promo_wallet') AND actor_role NOT IN ('owner','co_owner','admin') THEN RETURN jsonb_build_object('success',false,'error','Only Club Staff May Claim Into A Club Wallet'); END IF;
 IF p_transaction_id IS NOT NULL THEN
  SELECT * INTO original FROM public.chip_transactions WHERE id=p_transaction_id AND club_id=p_club_id FOR UPDATE;
  IF original.id IS NULL OR original.transaction_type<>'agent_wallet_send' OR original.from_user_id IS DISTINCT FROM actor OR original.to_user_id IS DISTINCT FROM p_from_user_id OR coalesce(original.metadata->>'destination','player_wallet') IS DISTINCT FROM p_source THEN RETURN jsonb_build_object('success',false,'error','You Can Only Claim Your Own Recent Send From Its Original Wallet'); END IF;
  IF coalesce(original.is_reversed,false) OR original.reversible_until IS NULL OR now()>original.reversible_until THEN RETURN jsonb_build_object('success',false,'error','The Ten Minute Claim Window Has Closed'); END IF;
  claimed:=coalesce((original.metadata->>'claimed_back')::numeric,0);
  repaid:=coalesce((original.metadata->>'credit_repaid')::numeric,0);
  remaining:=trunc(greatest(original.amount-claimed,0),2);
  v_amount:=coalesce(p_amount,remaining);
  IF remaining<0.01 OR v_amount>remaining THEN RETURN jsonb_build_object('success',false,'error','That Amount Is No Longer Claimable'); END IF;
 END IF;
 IF actor<>p_from_user_id AND NOT public.fn_club_cashier_can_transact(p_club_id,actor,p_from_user_id) THEN RETURN jsonb_build_object('success',false,'error','That Member Is Not In Your Downline'); END IF;
 SELECT role INTO holder_role FROM public.club_members WHERE club_id=p_club_id AND user_id=p_from_user_id AND coalesce(status,'active') IN ('active','approved');
 IF holder_role IS NULL THEN RETURN jsonb_build_object('success',false,'error','That Person Is Not An Active Member'); END IF;
 IF p_destination='player_wallet' AND actor_role='admin' THEN RETURN jsonb_build_object('success',false,'error','Admins Do Not Hold A Player Wallet'); END IF;
 IF p_source='player_wallet' THEN
  SELECT coalesce(chip_balance,0) INTO held FROM public.club_members WHERE club_id=p_club_id AND user_id=p_from_user_id;
 ELSE
  IF holder_role NOT IN ('owner','co_owner','admin','super_agent','agent','sub_agent') THEN RETURN jsonb_build_object('success',false,'error','That Member Does Not Hold That Wallet'); END IF;
  SELECT id,CASE WHEN p_source='promo_wallet' THEN coalesce(promo_wallet_balance,0) ELSE coalesce(agent_wallet_balance,0) END INTO source_agent,held FROM public.agents WHERE club_id=p_club_id AND user_id=p_from_user_id FOR UPDATE;
 END IF;
 IF held IS NULL OR held<v_amount THEN RETURN jsonb_build_object('success',false,'error','Insufficient Chips In The Selected Wallet'); END IF;
 IF p_transaction_id IS NOT NULL AND p_source<>'promo_wallet' THEN
  drawn:=coalesce((original.metadata->>'credit_drawn')::numeric,0); repaid:=coalesce((original.metadata->>'credit_repaid')::numeric,0);
  SELECT coalesce(credit_used,0) INTO used FROM public.agents WHERE club_id=p_club_id AND user_id=actor FOR UPDATE;
  repay:=least(coalesce(used,0),greatest(drawn-repaid,0),CASE WHEN original.amount-claimed-v_amount<0.01 THEN greatest(drawn-repaid,0) ELSE trunc(drawn*v_amount/original.amount,2) END);
 END IF;
 IF p_destination IN ('agent_wallet','promo_wallet') THEN target_agent:=public.fn_ensure_agent_row(p_club_id,actor,actor_role); END IF;
 destination_pool:=CASE p_destination WHEN 'club_bank' THEN 'club_treasury' WHEN 'club_promo_wallet' THEN 'promo_wallet' ELSE p_destination END;
 destination_entity:=CASE WHEN p_destination IN ('club_bank','club_promo_wallet') THEN p_club_id ELSE actor END;
 SELECT jsonb_object_agg(k,coalesce(current_setting(k,true),'')) INTO context FROM unnest(ARRAY['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_counterparty_label','app.ledger_correlation','app.ledger_idempotency_key','app.ledger_autoskip_agents','app.ledger_autoskip_club_members','app.ledger_autoskip_clubs','app.ledger_tournament','app.ledger_settlement']) settings(k);
 PERFORM set_config('app.ledger_tournament','',true); PERFORM set_config('app.ledger_settlement','',true);
 PERFORM public.fn_ca_declare_ledger('club_bank_claim',destination_pool,destination_entity,NULL,'club_wallet_claim:'||p_op_id::text,ARRAY['club_members','agents','clubs']);
 PERFORM set_config('app.ledger_correlation',p_op_id::text,true);
 IF p_source='player_wallet' THEN UPDATE public.club_members SET chip_balance=coalesce(chip_balance,0)-v_amount,updated_at=now() WHERE club_id=p_club_id AND user_id=p_from_user_id RETURNING chip_balance INTO holder_after;
 ELSIF p_source='agent_wallet' THEN UPDATE public.agents SET agent_wallet_balance=coalesce(agent_wallet_balance,0)-v_amount,updated_at=now() WHERE id=source_agent RETURNING agent_wallet_balance INTO holder_after;
 ELSE UPDATE public.agents SET promo_wallet_balance=coalesce(promo_wallet_balance,0)-v_amount,updated_at=now() WHERE id=source_agent RETURNING promo_wallet_balance INTO holder_after; END IF;
 CASE p_destination
 WHEN 'club_bank' THEN UPDATE public.clubs SET chip_treasury=coalesce(chip_treasury,0)+(v_amount-repay),updated_at=now() WHERE id=p_club_id RETURNING chip_treasury INTO destination_after;
 WHEN 'club_promo_wallet' THEN UPDATE public.clubs SET promo_balance=coalesce(promo_balance,0)+(v_amount-repay),updated_at=now() WHERE id=p_club_id RETURNING promo_balance INTO destination_after;
 WHEN 'player_wallet' THEN UPDATE public.club_members SET chip_balance=coalesce(chip_balance,0)+(v_amount-repay),updated_at=now() WHERE club_id=p_club_id AND user_id=actor RETURNING chip_balance INTO destination_after;
 WHEN 'agent_wallet' THEN UPDATE public.agents SET agent_wallet_balance=coalesce(agent_wallet_balance,0)+(v_amount-repay),updated_at=now() WHERE id=target_agent RETURNING agent_wallet_balance INTO destination_after;
 WHEN 'promo_wallet' THEN UPDATE public.agents SET promo_wallet_balance=coalesce(promo_wallet_balance,0)+(v_amount-repay),updated_at=now() WHERE id=target_agent RETURNING promo_wallet_balance INTO destination_after;
 END CASE;
 IF repay>0 THEN UPDATE public.agents SET credit_used=credit_used-repay,updated_at=now() WHERE club_id=p_club_id AND user_id=actor; END IF;
 IF holder_after IS NULL OR destination_after IS NULL THEN RAISE EXCEPTION 'The Claim Credit Landed Nowhere'; END IF;
 PERFORM set_config('app.ledger_idempotency_key','',true);
 IF v_amount>repay AND NOT public.fn_ca_post_leg('club_bank_claim',p_source,p_from_user_id,destination_pool,destination_entity,v_amount-repay,p_club_id,'club_wallet_claim:'||p_op_id::text,'Cashier Claim Back') THEN RAISE EXCEPTION 'The Claim Journal Was Not Written'; END IF;
 IF repay>0 AND NOT public.fn_ca_post_leg('credit_repayment',p_source,p_from_user_id,'credit_facility',actor,repay,p_club_id,'club_wallet_claim:credit:'||p_op_id::text,'Claim Repays The Original Credit Draw') THEN RAISE EXCEPTION 'The Credit Repayment Journal Was Not Written'; END IF;
 IF p_transaction_id IS NOT NULL THEN
  UPDATE public.chip_transactions SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('claimed_back',claimed+v_amount,'credit_repaid',coalesce(repaid,0)+repay),is_reversed=(original.amount-claimed-v_amount<0.01),clawed_back=(original.amount-claimed-v_amount<0.01) WHERE id=p_transaction_id;
 END IF;
 FOR setting IN SELECT jsonb_object_keys(context) LOOP PERFORM set_config(setting,context->>setting,true); END LOOP;
 INSERT INTO public.chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,notes,metadata,balance_after)
 VALUES(p_club_id,p_from_user_id,actor,v_amount,movement_type,coalesce(p_reason,'Cashier Claim Back'),jsonb_build_object('op_id',p_op_id,'source',p_source,'destination',p_destination,'original_transaction_id',p_transaction_id,'credit_repaid',repay,'returned_amount',v_amount-repay,'actor_role',actor_role,'holder_balance_after',holder_after,'destination_balance_after',destination_after),destination_after) RETURNING id INTO tx;
 result:=jsonb_build_object('success',true,'replayed',false,'transaction_id',tx,'op_id',p_op_id,'amount',v_amount,'source',p_source,'destination',p_destination,'credit_repaid',repay,'returned_amount',v_amount-repay,'holder_balance_after',holder_after,'destination_balance_after',destination_after);
 RETURN public.fn_cashier_exact_intent_finish(p_op_id,result);
END $function$;
REVOKE ALL ON FUNCTION public.fn_club_wallet_claim_back(uuid,uuid,numeric,text,text,text,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_wallet_claim_back(uuid,uuid,numeric,text,text,text,uuid,uuid) TO authenticated,service_role;

-- Older open clients retain their entry points. New promo claims through those
-- doors return to promo as well; successful historical retries keep their receipt.
DO $patch$ DECLARE d text; BEGIN
 SELECT pg_get_functiondef('public.fn_club_bank_claim_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure) INTO d;
 IF md5(d)<>'547eeb7c06ed21d1e6a7ad8bf686da12' THEN RAISE EXCEPTION 'Legacy Club Claim Source Changed'; END IF;
 d:=replace(d,'''club_bank_claim'', ''club_treasury'', p_club_id','''club_bank_claim'', CASE WHEN v_source=''promo_wallet'' THEN ''promo_wallet'' ELSE ''club_treasury'' END, p_club_id');
 d:=replace(d,'set chip_treasury = coalesce(chip_treasury, 0) + p_amount,','set chip_treasury = coalesce(chip_treasury, 0) + CASE WHEN v_source=''promo_wallet'' THEN 0 ELSE p_amount END, promo_balance = coalesce(promo_balance,0) + CASE WHEN v_source=''promo_wallet'' THEN p_amount ELSE 0 END,');
 d:=replace(d,'returning chip_treasury into v_bank_after;','returning CASE WHEN v_source=''promo_wallet'' THEN promo_balance ELSE chip_treasury END into v_bank_after;');
 d:=replace(d,'''source'', v_source,','''source'', v_source, ''destination'', CASE WHEN v_source=''promo_wallet'' THEN ''club_promo_wallet'' ELSE ''club_bank'' END,');
 EXECUTE d;
 SELECT pg_get_functiondef('public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)'::regprocedure) INTO d;
 IF md5(d)<>'5de5e8e5528036ef643e43150e5f37cf' THEN RAISE EXCEPTION 'Legacy Agent Claim Source Changed'; END IF;
 d:=replace(d,'''agent_claim'', ''agent_wallet'', v_actor','''agent_claim'', CASE WHEN v_dest=''promo_wallet'' THEN ''promo_wallet'' ELSE ''agent_wallet'' END, v_actor');
 d:=replace(d,'v_dest, v_src.to_user_id, ''agent_wallet'', v_actor','v_dest, v_src.to_user_id, CASE WHEN v_dest=''promo_wallet'' THEN ''promo_wallet'' ELSE ''agent_wallet'' END, v_actor');
 d:=replace(d,'if v_drawn > 0 then','if v_drawn > 0 and v_dest <> ''promo_wallet'' then');
 d:=replace(d,'set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + (v_take - v_repay),','set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + CASE WHEN v_dest=''promo_wallet'' THEN 0 ELSE (v_take-v_repay) END, promo_wallet_balance = coalesce(promo_wallet_balance,0) + CASE WHEN v_dest=''promo_wallet'' THEN v_take ELSE 0 END,');
 d:=replace(d,'''source'', v_dest,','''source'', v_dest, ''destination'', CASE WHEN v_dest=''promo_wallet'' THEN ''promo_wallet'' ELSE ''agent_wallet'' END,');
 EXECUTE d;
END $patch$;
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)'::regprocedure)) = 'c5ae86bc20569cb05ec93c87e31e0435')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cashier_history_feed(uuid,text,text,timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)'::regprocedure)) = 'dad4d92ef739f520d0c512c9950d5c62')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cashier_history_summary(uuid,text,text,timestamptz,timestamptz,uuid)'::regprocedure)) = 'cf02a67ac0d71d5e0db7c84a5b224f23')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_club_bank_claim_core_20261004(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = 'cd3ad7a833947bea54cd2b9c7087ce85')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_club_wallet_claim_back(uuid,uuid,numeric,text,text,text,uuid,uuid)'::regprocedure)) = '85b41fe75ee3a9d5c5617dc671c120f6')
COMMIT;
