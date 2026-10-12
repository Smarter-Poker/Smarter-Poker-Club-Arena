-- 20261012040542_a_treasury_funded_seat_reads_as_a_club_bank_send.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (cashier launch, lead decision 2, 2026-10-09):
--
-- Dan, binding: "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY" and "HORSES
-- ARE NEVER EVER EXCLUDED BY DESIGN". When the club treasury pays a horse's
-- seat, the receipt is chip_transactions.horse_treasury_funding (65,659 rows
-- in 4 clubs, the newest 2026-10-02) with a note that says horse, no sender
-- and no metadata. Three cashier reads hand it to the browser as it is:
--
--   fn_club_trade_ledger, the Trade record: the kind (printed "Horse Treasury
--     Funding"), the horse note, and a shape no human send has (no sender),
--     to the owner, co-owners, admins, super agents and an agent's downline.
--   fn_club_bank_ledger, the Club Bank ledger: the same rows, and the kind as a
--     filter chip, so one tap listed every horse in the club.
--   fn_ca_chip_statement_page and fn_ca_chip_statement, the treasury
--     statement: the treasury leg's category horse_funding and a description
--     that ends in the horse's user id (1,767 legs on 2026-10-01 and 02 alone).
--
-- A Club Bank send now reads ONE way in the Trade record and the Club Bank
-- ledger, whether a person sent it or the treasury funded a seat:
--   kind 'club_bank_send'; from the Club Bank (from_user_id and from_name
--   null: the operator who pressed Send is not a side of the move, as in the
--   chip statement since 20261012030847), except to the two people in it: the
--   operator still reads their own send as theirs and the member paid still
--   reads who paid them (lead decision 2: those two views are unchanged, so
--   the Trade record's In and Out totals do not move); a funded seat names no
--   sender to anyone; the recipient's id and arena name;
--   notes = the sender's own typed reason, never the stock 'Club Bank Send'
--   and never a note that mentions a horse; metadata = only
--   {"destination": ...} (a funded seat reads 'player_wallet').
-- The Club Bank ledger's type list, type filter and count use that kind. The
-- treasury statement prints the funded seat's leg as 'table_funding' with no
-- description. Every row is kept: the same rows, order, pages and totals.
--
-- Not changed: who sees which rows; the Club Bank ledger's into/out/net
-- figures (they never counted a funded seat; that is an accounting question
-- for the owner, not this read); a funded seat is still not reversible;
-- SECURITY DEFINER, search_path, lock_timeout and grants (authenticated and
-- service_role EXECUTE, never anon). The chip statement (20261012030847)
-- already prints a funded seat as this same Club Bank send.
--
-- fn_club_trade_ledger is written against its 20261010005048 text (arena
-- names): install that file first; this one refuses until it is in.
-- Proved on PostgreSQL 17 against production's live bodies, reproduced byte
-- for byte (scripts/ci/test-horse-reads-db-postgres.py,
-- tests/fixtures/horse-reads-db/scenario.sql: it fails before and passes
-- after). The release contract
-- (scripts/verification-harness/cashier-release-contract.sql) accepts the
-- installed bodies and, until they are installed, the live ones.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) = '1b1312459ecc90069375d8bcdb3127ca')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)) = 'f17eb94522c177856683617945d9f371')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure)) = 'd513f6f312b29835cc5e74aa8ff00ce0')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure)) = '2fc3da7cf5496ad4eb1c0f71150169e6')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) IS DISTINCT FROM 'd489a8b997a25320b0b4ec8b14a43587' THEN
    RAISE EXCEPTION 'fn_club_trade_ledger is not the live text this migration was written against (install 20261010005048_a_cashier_list_names_a_member_by_the_arena_name first) (md5 %)',
      md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)) IS DISTINCT FROM '39ff91f5cc60c6300942f51e4ab2c3bb' THEN
    RAISE EXCEPTION 'fn_club_bank_ledger is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure)) IS DISTINCT FROM 'c706109ed8dab335912f046aaa6ee215' THEN
    RAISE EXCEPTION 'fn_ca_chip_statement_page is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure)) IS DISTINCT FROM '48dd7c1b2b828579f04a45b84a6a6eee' THEN
    RAISE EXCEPTION 'fn_ca_chip_statement is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_club_trade_ledger(p_club_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid, notes text, metadata jsonb, from_name text, to_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  -- Cashier exposes 250 rows and requests one sentinel row to decide whether
  -- another page exists. Preserve the established bounded RPC contract.
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 251);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN; END IF;
  v_role := public.fn_club_bank_role(p_club_id, v_viewer);
  IF v_role IS NULL THEN RETURN; END IF;

  IF v_role IN ('owner', 'co_owner', 'admin', 'super_agent') THEN
    RETURN QUERY
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  ELSIF v_role IN ('agent', 'sub_agent') THEN
    RETURN QUERY
    WITH RECURSIVE dl AS (
      SELECT v_viewer AS user_id
      UNION
      SELECT edge.child
        FROM public.fn_club_active_cashier_edges(p_club_id) edge
        JOIN dl ON edge.parent = dl.user_id
    )
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id IN (SELECT user_id FROM dl)
         OR ct.to_user_id IN (SELECT user_id FROM dl))
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  ELSE
    RETURN QUERY
    SELECT ct.id, ct.created_at,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END,
           ct.amount,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id) THEN NULL ELSE ct.from_user_id END,
           ct.to_user_id,
           CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse'
                  OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL
                ELSE ct.notes END,
           CASE WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet'))
                ELSE ct.metadata END,
           CASE WHEN pf.id IS NOT NULL AND NOT (ct.transaction_type = 'horse_treasury_funding' OR (ct.transaction_type = 'club_bank_send' AND v_viewer IS DISTINCT FROM ct.from_user_id AND v_viewer IS DISTINCT FROM ct.to_user_id))
                THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer)
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_bank_ledger(p_club_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_types text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
  v_types jsonb;
  v_in numeric;
  v_out numeric;
begin
  if not public.fn_can_use_club_bank(p_club_id) then
    return jsonb_build_object('authorized', false,
      'error', 'The Club Bank Ledger Is Restricted To Owners, Co Owners, Admins And Super Agents');
  end if;

  select count(*) into v_total
    from chip_transactions t
   where t.club_id = p_club_id
     and (p_types is null or (CASE WHEN t.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE t.transaction_type END) = any (p_types));

  -- Every type this club has ever recorded, so the filter offers real options
  -- rather than a hard-coded list that goes stale.
  select coalesce(jsonb_agg(x.transaction_type order by x.transaction_type), '[]'::jsonb)
    into v_types
    from (select distinct CASE WHEN transaction_type = 'horse_treasury_funding' THEN 'club_bank_send'
                               ELSE transaction_type END AS transaction_type
            from chip_transactions where club_id = p_club_id) x;

  -- What went INTO the bank and what came OUT of it. Scoped to the movements
  -- the bank itself makes; a peer transfer between two members never touches
  -- clubs.chip_treasury and would make this figure a lie.
  select
    coalesce(sum(t.amount) filter (
      where t.transaction_type in ('mint', 'club_bank_reversal', 'treasury_credit', 'club_bank_claim')), 0),
    coalesce(sum(t.amount) filter (
      where t.transaction_type in ('club_bank_send', 'treasury_debit')
        and coalesce(t.is_reversed, false) = false), 0)
    into v_in, v_out
    from chip_transactions t
   where t.club_id = p_club_id;

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'id', t.id,
             'created_at', t.created_at,
             'amount', round(coalesce(t.amount, 0), 2),
             'transaction_type', CASE WHEN t.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE t.transaction_type END,
             'notes', CASE WHEN t.transaction_type = 'horse_treasury_funding' OR t.notes ~* 'horse'
                             OR (t.transaction_type = 'club_bank_send' AND t.notes = 'Club Bank Send') THEN NULL
                           ELSE t.notes END,
             'balance_after', t.balance_after,
             'metadata', CASE WHEN t.transaction_type IN ('club_bank_send', 'horse_treasury_funding')
                              THEN jsonb_build_object('destination', coalesce(t.metadata ->> 'destination', 'player_wallet'))
                              ELSE coalesce(t.metadata, '{}'::jsonb) END,
             'is_reversed', coalesce(t.is_reversed, false),
             'reversible',
               t.transaction_type = 'club_bank_send'
               and coalesce(t.is_reversed, false) = false
               and (t.reversible_until is null or now() <= t.reversible_until),
             'from_user_id', CASE WHEN t.transaction_type = 'horse_treasury_funding' OR (t.transaction_type = 'club_bank_send' AND auth.uid() IS DISTINCT FROM t.from_user_id AND auth.uid() IS DISTINCT FROM t.to_user_id)
                                  THEN NULL ELSE t.from_user_id END,
             'to_user_id', t.to_user_id,
             'from_name', CASE WHEN t.transaction_type = 'horse_treasury_funding' OR (t.transaction_type = 'club_bank_send' AND auth.uid() IS DISTINCT FROM t.from_user_id AND auth.uid() IS DISTINCT FROM t.to_user_id) THEN NULL
                               ELSE coalesce(public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name), pf.username) END,
             'to_name', coalesce(public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name), pt.username)
           ) as r
      from chip_transactions t
      left join profiles pf on pf.id = t.from_user_id
      left join profiles pt on pt.id = t.to_user_id
     where t.club_id = p_club_id
       and (p_types is null or (CASE WHEN t.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE t.transaction_type END) = any (p_types))
     order by t.created_at desc
     limit v_limit offset v_offset
  ) s;

  return jsonb_build_object(
    'authorized', true,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'types', v_types,
    'totals', jsonb_build_object('into_bank', round(v_in, 2), 'out_of_bank', round(v_out, 2),
                                 'net', round(v_in - v_out, 2)),
    'rows', v_rows);
end
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_chip_statement_page(p_scope text DEFAULT 'player'::text, p_club_id uuid DEFAULT NULL::uuid, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller     uuid := auth.uid();
  v_entity     uuid;
  v_type       text;
  v_col        text;
  v_key        text;
  v_limit      int := GREATEST(LEAST(COALESCE(p_limit, 50), 200), 1);
  v_balance    numeric;
  v_clubs      jsonb := '[]'::jsonb;
  v_legs       jsonb;
  v_has_more   boolean;
  v_next       timestamptz;
  v_next_cursor jsonb;
  v_before timestamptz;
  v_before_id uuid;
  v_before_direction text;
  v_snap_bal   numeric;
  v_snap_at    timestamptz;
  v_snap_cum   numeric;
  v_snap_base  boolean;
  v_in         numeric;
  v_out        numeric;
  v_since_legs bigint;
  v_expected   numeric;
  v_audit      jsonb;
  v_t0         timestamptz := clock_timestamp();
BEGIN
  IF v_caller IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_scope = 'player' THEN
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'a player statement is the caller''s own; there is no other player to ask for' USING ERRCODE = '42501';
    END IF;
    v_entity := v_caller;              -- never a parameter: the statement is always your own
    v_type   := 'player_wallet';
    v_col    := 'club_members.chip_balance';
  ELSIF p_scope = 'club_treasury' THEN
    IF p_club_id IS NULL THEN
      RAISE EXCEPTION 'club_treasury needs p_club_id';
    END IF;
    IF public.ca_can_view_club_finances(p_club_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
    END IF;
    v_entity := p_club_id;
    v_type   := 'club_treasury';
    v_col    := 'clubs.chip_treasury';
  ELSE
    RAISE EXCEPTION 'scope must be player or club_treasury';
  END IF;
  v_key := v_type || ':' || v_entity::text || ':' || v_col;

  -- The cursor covers every ordering field and is bound to this account/filter.
  -- Timestamp-only pagination skipped siblings created by one transaction.
  IF p_cursor IS NOT NULL THEN
    IF jsonb_typeof(p_cursor) IS DISTINCT FROM 'object'
       OR NOT (p_cursor ?& ARRAY['at','id','direction','account','club_filter'])
       OR jsonb_typeof(p_cursor->'at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string'
       OR p_cursor->>'direction' NOT IN ('in','out')
       OR p_cursor->>'direction' IS NULL
       OR p_cursor->>'account' IS DISTINCT FROM v_key
       OR p_cursor->>'club_filter' IS DISTINCT FROM p_club_id::text THEN
      RAISE EXCEPTION 'statement cursor does not match this account and filter'
        USING ERRCODE='22023';
    END IF;
    v_before := (p_cursor->>'at')::timestamptz;
    v_before_id := (p_cursor->>'id')::uuid;
    v_before_direction := p_cursor->>'direction';
    IF NOT isfinite(v_before) THEN
      RAISE EXCEPTION 'statement cursor timestamp must be finite' USING ERRCODE='22023';
    END IF;
  END IF;


  /* THE BALANCE NOW, through the same reader the nightly replay uses. */
  v_balance := public.fn_ca_account_balance(v_type, v_entity, NULL, v_col);

  IF p_scope = 'player' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'club_id', m.club_id, 'club_name', c.name, 'balance', round(COALESCE(m.chip_balance, 0), 2))
             ORDER BY c.name), '[]'::jsonb)
      INTO v_clubs
      FROM public.club_members m
      JOIN public.clubs c ON c.id = m.club_id
     WHERE m.user_id = v_entity;
  END IF;

  /* THE PAGE. Both sides, newest first, from this account's point of view. */
  WITH mine AS (
    /* One index range per side - (to_entity_id, created_at DESC) and
       (from_entity_id, created_at DESC) both exist - each already limited,
       then merged. An OR across the two sides would be a bitmap of every leg
       the account ever had, which for a horse is tens of thousands. */
    (SELECT l.id, l.created_at, l.amount, l.category, l.description, l.club_id,
            l.table_id, l.tournament_id, l.hand_id, l.settlement_id,
            'in'::text AS direction, l.from_type AS counterparty_type,
            l.from_label AS counterparty_label, l.from_entity_id AS counterparty_id
       FROM public.chip_ledger l
      WHERE l.to_entity_id = v_entity AND l.to_type = v_type
        AND (p_club_id IS NULL OR l.club_id = p_club_id)
        AND (v_before IS NULL OR l.created_at < v_before
          OR (l.created_at = v_before AND l.id < v_before_id)
          OR (l.created_at = v_before AND l.id = v_before_id
              AND 'in' > v_before_direction))
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT v_limit + 1)
    UNION ALL
    (SELECT l.id, l.created_at, l.amount, l.category, l.description, l.club_id,
            l.table_id, l.tournament_id, l.hand_id, l.settlement_id,
            'out'::text, l.to_type, l.to_label, l.to_entity_id
       FROM public.chip_ledger l
      WHERE l.from_entity_id = v_entity AND l.from_type = v_type
        AND (p_club_id IS NULL OR l.club_id = p_club_id)
        AND (v_before IS NULL OR l.created_at < v_before
          OR (l.created_at = v_before AND l.id < v_before_id)
          OR (l.created_at = v_before AND l.id = v_before_id
              AND 'out' > v_before_direction))
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT v_limit + 1)
  ), page AS (
    SELECT * FROM mine ORDER BY created_at DESC, id DESC, direction ASC LIMIT v_limit
  )
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id', p.id, 'at', p.created_at, 'direction', p.direction, 'amount', round(p.amount, 2),
             'category', CASE WHEN p.category = 'horse_funding' THEN 'table_funding' ELSE p.category END,
             'description', CASE WHEN p.category = 'horse_funding' OR p.description ~* 'horse' THEN NULL
                                 ELSE p.description END,
             'counterparty_type', p.counterparty_type, 'counterparty_label', p.counterparty_label,
             'counterparty_id', p.counterparty_id,
             'club_id', p.club_id, 'table_id', p.table_id, 'tournament_id', p.tournament_id,
             'hand_id', p.hand_id, 'settlement_id', p.settlement_id)
             ORDER BY p.created_at DESC, p.id DESC, p.direction ASC) FROM page p), '[]'::jsonb),
         (SELECT count(*) FROM mine) > v_limit,   -- more than a page on either side, or both together
         (SELECT min(p.created_at) FROM page p),
         (SELECT jsonb_build_object('at',p.created_at,'id',p.id,'direction',p.direction,
                   'account',v_key,'club_filter',p_club_id)
            FROM page p ORDER BY p.created_at ASC,p.id ASC,p.direction DESC LIMIT 1)
    INTO v_legs, v_has_more, v_next, v_next_cursor;

  /* THE AUDIT. The last nightly reading of this account, and the journal
     since it. Balance-at-reading plus net-since equals balance-now, or it
     does not, and either way the player sees the same three numbers the
     platform's own control sees. */
  SELECT s.balance, s.taken_at, s.cum_unexplained, s.is_baseline
    INTO v_snap_bal, v_snap_at, v_snap_cum, v_snap_base
    FROM public.ca_account_snapshots s
   WHERE s.account_key = v_key
   ORDER BY s.taken_at DESC
   LIMIT 1;

  IF v_snap_at IS NULL THEN
    v_audit := jsonb_build_object(
      'status', 'no_reading_yet',
      'detail', 'this account has not yet been read by the nightly ledger replay (fn_ca_ledger_replay reads every account that moved in the last 26 hours, at 06:40 UTC). The legs above are complete; there is no reading to compare the balance against yet.',
      'balance_now', round(COALESCE(v_balance, 0), 2));
  ELSE
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_entity_id = v_entity AND l.to_type = v_type), 0),
           COALESCE(sum(l.amount) FILTER (WHERE l.from_entity_id = v_entity AND l.from_type = v_type), 0),
           count(*)
      INTO v_in, v_out, v_since_legs
      FROM public.chip_ledger l
     WHERE ((l.to_entity_id = v_entity AND l.to_type = v_type) OR (l.from_entity_id = v_entity AND l.from_type = v_type))
       AND l.created_at > v_snap_at;
    v_expected := round(v_snap_bal + v_in - v_out, 2);
    v_audit := jsonb_build_object(
      'status', CASE WHEN v_balance IS NULL THEN 'no_balance'
                     WHEN abs(round(v_balance, 2) - v_expected) < 0.005 THEN 'reconciles'
                     ELSE 'does_not_reconcile' END,
      'read_at', v_snap_at,
      'balance_at_reading', round(v_snap_bal, 2),
      'reading_is_baseline', COALESCE(v_snap_base, false),
      'cumulative_unexplained_at_reading', round(COALESCE(v_snap_cum, 0), 2),
      'in_since', round(v_in, 2),
      'out_since', round(v_out, 2),
      'legs_since', v_since_legs,
      'expected_now', v_expected,
      'balance_now', round(COALESCE(v_balance, 0), 2),
      'unexplained', CASE WHEN v_balance IS NULL THEN NULL ELSE round(round(v_balance, 2) - v_expected, 2) END,
      'detail', 'balance_at_reading + in_since - out_since = expected_now. The nightly replay (fn_ca_ledger_replay) makes this same comparison for every account and files an incident when it fails; a difference here that persists past the next 06:40 UTC reading is one the platform has also seen.');
  END IF;

  RETURN jsonb_build_object(
    'scope', p_scope,
    'entity_id', v_entity,
    'account', v_key,
    'club_filter', p_club_id,
    'balance_now', round(COALESCE(v_balance, 0), 2),
    'balance_exists', v_balance IS NOT NULL,
    'clubs', v_clubs,
    'legs', v_legs,
    'has_more', v_has_more,
    'next_before', v_next,
    'next_cursor', CASE WHEN v_has_more THEN v_next_cursor ELSE NULL END,
    'audit', v_audit,
    'generated_at', now(),
    'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000));
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_chip_statement(p_scope text DEFAULT 'player'::text, p_club_id uuid DEFAULT NULL::uuid, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller     uuid := auth.uid();
  v_entity     uuid;
  v_type       text;
  v_col        text;
  v_key        text;
  v_limit      int := GREATEST(LEAST(COALESCE(p_limit, 50), 200), 1);
  v_balance    numeric;
  v_clubs      jsonb := '[]'::jsonb;
  v_legs       jsonb;
  v_has_more   boolean;
  v_next       timestamptz;
  v_boundary_has_more boolean;
  v_snap_bal   numeric;
  v_snap_at    timestamptz;
  v_snap_cum   numeric;
  v_snap_base  boolean;
  v_in         numeric;
  v_out        numeric;
  v_since_legs bigint;
  v_expected   numeric;
  v_audit      jsonb;
  v_t0         timestamptz := clock_timestamp();
BEGIN
  IF v_caller IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_scope = 'player' THEN
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'a player statement is the caller''s own; there is no other player to ask for' USING ERRCODE = '42501';
    END IF;
    v_entity := v_caller;              -- never a parameter: the statement is always your own
    v_type   := 'player_wallet';
    v_col    := 'club_members.chip_balance';
  ELSIF p_scope = 'club_treasury' THEN
    IF p_club_id IS NULL THEN
      RAISE EXCEPTION 'club_treasury needs p_club_id';
    END IF;
    IF public.ca_can_view_club_finances(p_club_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
    END IF;
    v_entity := p_club_id;
    v_type   := 'club_treasury';
    v_col    := 'clubs.chip_treasury';
  ELSE
    RAISE EXCEPTION 'scope must be player or club_treasury';
  END IF;
  v_key := v_type || ':' || v_entity::text || ':' || v_col;

  -- A page opened before this upgrade may submit an already ambiguous cursor.
  -- A timestamp alone cannot show which same-timestamp legs that page displayed.
  IF p_before IS NOT NULL THEN
    SELECT count(*) > 1 INTO v_boundary_has_more FROM (
      (SELECT 1 FROM public.chip_ledger l
        WHERE l.to_entity_id=v_entity AND l.to_type=v_type
          AND l.created_at=p_before AND (p_club_id IS NULL OR l.club_id=p_club_id)
        LIMIT 2)
      UNION ALL
      (SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=v_entity AND l.from_type=v_type
          AND l.created_at=p_before AND (p_club_id IS NULL OR l.club_id=p_club_id)
        LIMIT 2)
      LIMIT 2
    ) boundary_legs;
    IF v_boundary_has_more THEN
      RAISE EXCEPTION 'Statement pagination has been upgraded; refresh the page to continue.'
        USING ERRCODE='PST01';
    END IF;
  END IF;

  /* THE BALANCE NOW, through the same reader the nightly replay uses. */
  v_balance := public.fn_ca_account_balance(v_type, v_entity, NULL, v_col);

  IF p_scope = 'player' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'club_id', m.club_id, 'club_name', c.name, 'balance', round(COALESCE(m.chip_balance, 0), 2))
             ORDER BY c.name), '[]'::jsonb)
      INTO v_clubs
      FROM public.club_members m
      JOIN public.clubs c ON c.id = m.club_id
     WHERE m.user_id = v_entity;
  END IF;

  /* THE PAGE. Both sides, newest first, from this account's point of view. */
  WITH mine AS (
    /* One index range per side - (to_entity_id, created_at DESC) and
       (from_entity_id, created_at DESC) both exist - each already limited,
       then merged. An OR across the two sides would be a bitmap of every leg
       the account ever had, which for a horse is tens of thousands. */
    (SELECT l.id, l.created_at, l.amount, l.category, l.description, l.club_id,
            l.table_id, l.tournament_id, l.hand_id, l.settlement_id,
            'in'::text AS direction, l.from_type AS counterparty_type,
            l.from_label AS counterparty_label, l.from_entity_id AS counterparty_id
       FROM public.chip_ledger l
      WHERE l.to_entity_id = v_entity AND l.to_type = v_type
        AND (p_club_id IS NULL OR l.club_id = p_club_id)
        AND (p_before IS NULL OR l.created_at < p_before)
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT v_limit + 1)
    UNION ALL
    (SELECT l.id, l.created_at, l.amount, l.category, l.description, l.club_id,
            l.table_id, l.tournament_id, l.hand_id, l.settlement_id,
            'out'::text, l.to_type, l.to_label, l.to_entity_id
       FROM public.chip_ledger l
      WHERE l.from_entity_id = v_entity AND l.from_type = v_type
        AND (p_club_id IS NULL OR l.club_id = p_club_id)
        AND (p_before IS NULL OR l.created_at < p_before)
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT v_limit + 1)
  ), page AS (
    SELECT * FROM mine ORDER BY created_at DESC, id DESC LIMIT v_limit
  )
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id', p.id, 'at', p.created_at, 'direction', p.direction, 'amount', round(p.amount, 2),
             'category', CASE WHEN p.category = 'horse_funding' THEN 'table_funding' ELSE p.category END,
             'description', CASE WHEN p.category = 'horse_funding' OR p.description ~* 'horse' THEN NULL
                                 ELSE p.description END,
             'counterparty_type', p.counterparty_type, 'counterparty_label', p.counterparty_label,
             'counterparty_id', p.counterparty_id,
             'club_id', p.club_id, 'table_id', p.table_id, 'tournament_id', p.tournament_id,
             'hand_id', p.hand_id, 'settlement_id', p.settlement_id)
             ORDER BY p.created_at DESC, p.id DESC) FROM page p), '[]'::jsonb),
         (SELECT count(*) FROM mine) > v_limit,   -- more than a page on either side, or both together
         (SELECT min(p.created_at) FROM page p),
         (SELECT count(*) FROM mine m WHERE m.created_at=(SELECT min(created_at) FROM page))
           > (SELECT count(*) FROM page p WHERE p.created_at=(SELECT min(created_at) FROM page))
    INTO v_legs, v_has_more, v_next, v_boundary_has_more;

  -- A cached client can only send a timestamp. Refuse an ambiguous boundary
  -- rather than acknowledging a page whose continuation skips ledger legs.
  IF v_boundary_has_more THEN
    RAISE EXCEPTION 'Statement pagination has been upgraded; refresh the page to continue.'
      USING ERRCODE='PST01';
  END IF;

  /* THE AUDIT. The last nightly reading of this account, and the journal
     since it. Balance-at-reading plus net-since equals balance-now, or it
     does not, and either way the player sees the same three numbers the
     platform's own control sees. */
  SELECT s.balance, s.taken_at, s.cum_unexplained, s.is_baseline
    INTO v_snap_bal, v_snap_at, v_snap_cum, v_snap_base
    FROM public.ca_account_snapshots s
   WHERE s.account_key = v_key
   ORDER BY s.taken_at DESC
   LIMIT 1;

  IF v_snap_at IS NULL THEN
    v_audit := jsonb_build_object(
      'status', 'no_reading_yet',
      'detail', 'this account has not yet been read by the nightly ledger replay (fn_ca_ledger_replay reads every account that moved in the last 26 hours, at 06:40 UTC). The legs above are complete; there is no reading to compare the balance against yet.',
      'balance_now', round(COALESCE(v_balance, 0), 2));
  ELSE
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_entity_id = v_entity AND l.to_type = v_type), 0),
           COALESCE(sum(l.amount) FILTER (WHERE l.from_entity_id = v_entity AND l.from_type = v_type), 0),
           count(*)
      INTO v_in, v_out, v_since_legs
      FROM public.chip_ledger l
     WHERE ((l.to_entity_id = v_entity AND l.to_type = v_type) OR (l.from_entity_id = v_entity AND l.from_type = v_type))
       AND l.created_at > v_snap_at;
    v_expected := round(v_snap_bal + v_in - v_out, 2);
    v_audit := jsonb_build_object(
      'status', CASE WHEN v_balance IS NULL THEN 'no_balance'
                     WHEN abs(round(v_balance, 2) - v_expected) < 0.005 THEN 'reconciles'
                     ELSE 'does_not_reconcile' END,
      'read_at', v_snap_at,
      'balance_at_reading', round(v_snap_bal, 2),
      'reading_is_baseline', COALESCE(v_snap_base, false),
      'cumulative_unexplained_at_reading', round(COALESCE(v_snap_cum, 0), 2),
      'in_since', round(v_in, 2),
      'out_since', round(v_out, 2),
      'legs_since', v_since_legs,
      'expected_now', v_expected,
      'balance_now', round(COALESCE(v_balance, 0), 2),
      'unexplained', CASE WHEN v_balance IS NULL THEN NULL ELSE round(round(v_balance, 2) - v_expected, 2) END,
      'detail', 'balance_at_reading + in_since - out_since = expected_now. The nightly replay (fn_ca_ledger_replay) makes this same comparison for every account and files an incident when it fails; a difference here that persists past the next 06:40 UTC reading is one the platform has also seen.');
  END IF;

  RETURN jsonb_build_object(
    'scope', p_scope,
    'entity_id', v_entity,
    'account', v_key,
    'club_filter', p_club_id,
    'balance_now', round(COALESCE(v_balance, 0), 2),
    'balance_exists', v_balance IS NOT NULL,
    'clubs', v_clubs,
    'legs', v_legs,
    'has_more', v_has_more,
    'next_before', v_next,
    'audit', v_audit,
    'generated_at', now(),
    'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000));
END $function$;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) IS DISTINCT FROM '1b1312459ecc90069375d8bcdb3127ca' THEN
    RAISE EXCEPTION 'fn_club_trade_ledger is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp', 'lock_timeout=5s']
  ) OR has_function_privilege('anon', 'public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_club_trade_ledger lost its definer posture or its grants' USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)) IS DISTINCT FROM 'f17eb94522c177856683617945d9f371' THEN
    RAISE EXCEPTION 'fn_club_bank_ledger is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) OR has_function_privilege('anon', 'public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_club_bank_ledger lost its definer posture or its grants' USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure)) IS DISTINCT FROM 'd513f6f312b29835cc5e74aa8ff00ce0' THEN
    RAISE EXCEPTION 'fn_ca_chip_statement_page is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public']
  ) OR has_function_privilege('anon', 'public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_chip_statement_page lost its definer posture or its grants' USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure)) IS DISTINCT FROM '2fc3da7cf5496ad4eb1c0f71150169e6' THEN
    RAISE EXCEPTION 'fn_ca_chip_statement is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public']
  ) OR has_function_privilege('anon', 'public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_chip_statement lost its definer posture or its grants' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
