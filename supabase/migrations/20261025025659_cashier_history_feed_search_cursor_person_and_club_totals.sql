-- 20261025025659_cashier_history_feed_search_cursor_person_and_club_totals.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS ADDS, AND WHY:
--
-- Dan, 2026-10-24: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE" on
-- the second round of Transaction History improvements:
--   1. club-wide totals for owners, co-owners and admins;
--   2. search the whole history on the server (a name, or an invoice number);
--   3. "Load More" that stays fast on the heaviest accounts (a cursor, not an
--      offset);
--   4. a row opens its full receipt (the cash-out invoice number is returned);
--   5. an agent picks one player inside My Downline, with that player's totals;
--   6. a cash-out still waiting shows as waiting (the request status is
--      returned with every cash-out leg).
--
-- Two new doors; the installed fn_cashier_history_page / _totals stay as they
-- are for the client already published, so nothing breaks between releases.
--
--   fn_cashier_history_feed(club, scope, kind, from, to, person, search,
--                           before_at, before_id, limit)
--     The book is decided here and can only narrow: the club book for owner,
--     co-owner and admin; the downline book for super agent, agent and sub
--     agent (Dan's Club Data ruling); otherwise the viewer's own rows. A
--     person narrows any book to one member of it. A search is either an
--     invoice number (CA-YYYY-NNNNNNNN, exact) or part of a member's arena
--     name. Paging is by (created_at, id) cursor: every page is an index
--     range, measured the same on page 1 and page 40.
--
--   fn_cashier_history_summary(club, scope, kind, from, to, person)
--     mode 'wallet': In / Out / Net of one wallet (the viewer, or the picked
--       person) by the Full Statement's direction rule;
--     mode 'group': In / Out / Net of the agent's downline as one group (a
--       move between two members of the downline is neither);
--     mode 'club': Entries, Chips Moved and Cash-Outs Paid for the whole club.
--
-- WHY THE CLUB TOTALS USE A DAY CACHE: measured 2026-10-25 on KINGS CLUB, 30
-- days is 613,012 ledger rows and summing them took 12.6 s without the type
-- and 26.2 s with it. The ledger is append-only (trg_ca_append_only), so a
-- closed UTC day never changes: its per-type sums are computed once, the
-- first time somebody asks, and kept in cashier_club_day_totals. Only the
-- open edges of a range (today, and a part day at the start) are read live.
-- Nothing is scheduled and no trigger is added to the ledger: a day is
-- filled by the request that needs it, within a 2.5 s budget, and the answer
-- says complete=false until every closed day in the range is in the cache.
--
-- No hot table is locked: one new table (no foreign keys), one internal
-- helper and two doors, in one transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.cashier_club_day_totals (
  club_id uuid NOT NULL,
  day date NOT NULL,
  -- '*' is the day marker: entries is the day's row count, and its presence
  -- is what says the day has been counted (a day with no rows still gets it).
  transaction_type text NOT NULL,
  entries bigint NOT NULL,
  volume numeric NOT NULL,
  net_amount numeric NOT NULL,
  filled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, day, transaction_type)
);
ALTER TABLE public.cashier_club_day_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cashier_club_day_totals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cashier_club_day_totals TO service_role;
COMMENT ON TABLE public.cashier_club_day_totals IS
  'Per club, per closed UTC day, per transaction type: entries, volume (sum of |amount|) and net (sum of amount) of chip_transactions. The ledger is append-only, so a closed day never changes. Filled on demand by fn_cashier_history_summary; ''*'' marks a counted day.';

-- The book a viewer may read, decided once for both doors. Internal: only the
-- two definer doors below call it.
CREATE OR REPLACE FUNCTION public.fn_cashier_history_book(
  p_club_id uuid,
  p_viewer uuid,
  p_scope text,
  p_person uuid,
  OUT book text,
  OUT people uuid[],
  OUT subject uuid
)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_role text;
  v_scope text := lower(btrim(coalesce(p_scope, 'mine')));
BEGIN
  IF v_scope NOT IN ('club', 'mine', 'downline') THEN
    RAISE EXCEPTION 'transaction_history_scope_invalid' USING ERRCODE = '22023';
  END IF;
  v_role := public.fn_club_bank_role(p_club_id, p_viewer);
  IF v_role IS NULL THEN book := NULL; RETURN; END IF;

  book := CASE
    WHEN v_scope = 'club' AND v_role IN ('owner', 'co_owner', 'admin') THEN 'club'
    WHEN v_scope = 'downline' AND v_role IN ('super_agent', 'agent', 'sub_agent') THEN 'downline'
    ELSE 'mine' END;

  IF book = 'downline' THEN
    WITH RECURSIVE dl AS (
      SELECT p_viewer AS user_id
      UNION
      SELECT edge.child
        FROM public.fn_club_active_cashier_edges(p_club_id) edge
        JOIN dl ON edge.parent = dl.user_id
    )
    SELECT array_agg(dl.user_id) INTO people FROM dl;
  ELSIF book = 'mine' THEN
    people := ARRAY[p_viewer];
  END IF;

  subject := p_viewer;
  IF p_person IS NOT NULL AND p_person IS DISTINCT FROM p_viewer THEN
    -- A person narrows the book to one of its members, never outside it.
    IF (book = 'club' AND EXISTS (
          SELECT 1 FROM public.club_members cm
           WHERE cm.club_id = p_club_id AND cm.user_id = p_person))
       OR (book = 'downline' AND p_person = ANY (people)) THEN
      subject := p_person;
      people := ARRAY[p_person];
      book := 'person';
    ELSE
      book := NULL;
      RETURN;
    END IF;
  ELSIF p_person IS NOT NULL THEN
    people := ARRAY[p_viewer];
    book := 'person';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_history_book(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_cashier_history_feed(
  p_club_id uuid,
  p_scope text DEFAULT 'mine',
  p_kind text DEFAULT 'all',
  p_from timestamp with time zone DEFAULT NULL,
  p_to timestamp with time zone DEFAULT NULL,
  p_person uuid DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_before_at timestamp with time zone DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
)
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
  c_transfer constant text := $k$'{agent_wallet_send,agent_wallet_claim_back,agent_wallet_self_stake,club_bank_send,horse_treasury_funding,club_bank_claim,club_bank_reversal,admin_removal,mint,treasury_mint,treasury_burn,treasury_debit,treasury_credit,peer_transfer,promo_wallet_send,club_promo_send,promo_disbursement,club_opening_grant,rakeback,commission_claim,overlay_funding,overlay_rebank,union_transfer,union_transfer_reversal,union_promo_send,union_promo_to_club,union_promo_clawback,union_clawback,leave_club_chip_return,default_mint_correction,promo_closed_on_union_join,tournament_ticket_issue,tournament_ticket_redeem,tournament_ticket_cancel,transfer}'::text[]$k$;
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
         WHEN 'game' THEN ' AND NOT (ct.transaction_type = ANY (' || c_cashout || ') OR ct.transaction_type = ANY (' || c_transfer || '))'
         ELSE '' END
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
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_history_feed(uuid, text, text, timestamp with time zone, timestamp with time zone, uuid, text, timestamp with time zone, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_history_feed(uuid, text, text, timestamp with time zone, timestamp with time zone, uuid, text, timestamp with time zone, uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_cashier_history_summary(
  p_club_id uuid,
  p_scope text DEFAULT 'mine',
  p_kind text DEFAULT 'all',
  p_from timestamp with time zone DEFAULT NULL,
  p_to timestamp with time zone DEFAULT NULL,
  p_person uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
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
  c_transfer constant text := $k$'{agent_wallet_send,agent_wallet_claim_back,agent_wallet_self_stake,club_bank_send,horse_treasury_funding,club_bank_claim,club_bank_reversal,admin_removal,mint,treasury_mint,treasury_burn,treasury_debit,treasury_credit,peer_transfer,promo_wallet_send,club_promo_send,promo_disbursement,club_opening_grant,rakeback,commission_claim,overlay_funding,overlay_rebank,union_transfer,union_transfer_reversal,union_promo_send,union_promo_to_club,union_promo_clawback,union_clawback,leave_club_chip_return,default_mint_correction,promo_closed_on_union_join,tournament_ticket_issue,tournament_ticket_redeem,tournament_ticket_cancel,transfer}'::text[]$k$;
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
         WHEN 'game' THEN ' AND NOT (ct.transaction_type = ANY (' || c_cashout || ') OR ct.transaction_type = ANY (' || c_transfer || '))'
         ELSE '' END;

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
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_history_summary(uuid, text, text, timestamp with time zone, timestamp with time zone, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_history_summary(uuid, text, text, timestamp with time zone, timestamp with time zone, uuid) TO authenticated, service_role;

DO $post$
DECLARE v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.fn_cashier_history_feed(uuid,text,text,timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)'::regprocedure,
    'public.fn_cashier_history_summary(uuid,text,text,timestamptz,timestamptz,uuid)'::regprocedure
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
  IF has_function_privilege('authenticated', 'public.fn_cashier_history_book(uuid,uuid,text,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-APPLY: the book helper is reachable by authenticated';
  END IF;
  IF has_table_privilege('authenticated', 'public.cashier_club_day_totals', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'POST-APPLY: the day cache is reachable by authenticated';
  END IF;
END $post$;

COMMIT;
