-- 20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The Cashier could show one OFFSET page of operation receipts
-- (fn_club_trade_ledger) and nothing else: no date range, no filter, no
-- reference lookup, no statement across the wallets a viewer is allowed to
-- see, and no export. Table, tournament, promo, ticket and bonus-game
-- movements live only in chip_ledger, so they were invisible to the Cashier
-- entirely. This file adds one cross-wallet statement, read by one keyset,
-- and an export built on the Club Data export pattern (short-lived immutable
-- job, re-authorized on every page, whole file refused after a scope change).
--
-- THE STATEMENT MODEL
--
--   Receipts (public.chip_transactions, every transaction_type) are the
--   authority for every Cashier operation, exactly as the on-screen Trade
--   Record. Movements (public.chip_ledger, status 'posted') are added ONLY
--   for the categories that have no receipt writer.
--
--   An ENTRY is one of
--     receipt   a public.chip_transactions row in the club (every
--               transaction_type), or
--     movement  a public.chip_ledger row in the club, status 'posted', whose
--               category is in CASHIER_MOVEMENT_CATEGORIES and that no
--               receipt of the same club names by key (a safety net; the
--               category list is what prevents double counting):
--                 * receipt metadata->>'idempotency_key' = the movement's
--                   idempotency_key, receipt written inside [p_from - 1 day,
--                   p_to + 1 day): probes the partial unique index
--                   ux_chip_transactions_idempotency_key (the query carries
--                   its predicate, metadata ? 'idempotency_key'), or
--                 * a refund movement to a player_wallet whose
--                   seat_credit_restored receipt (same club, to_user_id =
--                   to_entity_id, within one minute) carries
--                   metadata->>'restore_key' = the movement's
--                   idempotency_key. Production: all 319 restore pairs are
--                   exactly this shape, sub-second gap.
--               * Restore mirrors are matched on the player wallet index
--                 within one minute: the probe runs only for refunds to a
--                 player_wallet (a SubPlan on the (club_id, to_user_id,
--                 created_at) index), never a scan of the club's receipts
--                 (the unbounded form was a Parallel Seq Scan costing ~430
--                 ms of a 472 ms page on the largest club; this shape
--                 measured 4.186 ms).
--
--   EVIDENCE (production, read-only probes, 2026-09-23)
--     receipt metadata.chip_ledger_id -> chip_ledger.id: 0 rows resolve, all
--       time. Not an anti-join (it is still printed as reference.ledger_id).
--     idempotency_key pairs: 83, gap 0s (tournament_ticket_entry receipt
--       <-> ticket_redeem movement).
--     restore_key pairs: 319, gap 0s (seat_credit_restored receipt <->
--       refund movement).
--     tournament_ticket_issue receipt <-> ticket_issue movement: 726 pairs,
--       gap 0s, linked only by metadata->>'ticket_id'.
--     Mirrored 100% by receipts (same club, amount, player, +-2s; 2 days):
--       tournament_buyin 32,650/32,650; table_cashout 2,046/2,046 (receipt
--       cashout); wheel/crossing/mines/crash/plinko_prize (same-named
--       receipts). Receipt families also exist for mint, rakeback,
--       commission (commission_claim), ticket_issue, ticket_redeem/entry and
--       ticket_cancel.
--     No receipt at all: buyin, addon, rebuy, tournament_prize (5
--       coincidental matches of 12,058), bounty, refund (the restore_key
--       ones excepted), spin_entry, spin_prize, promo, overlay, and the 21
--       prize_liability -> prize_liability tournament_buyin satellite moves.
--
--   CASHIER_MOVEMENT_CATEGORIES (included; no receipt writer):
--     buyin, addon, rebuy, tournament_prize, bounty, refund, spin_entry,
--     spin_prize, promo, promo_send, treasury_transfer, transfer,
--     player_funding, agent_funding, overlay, reversal, correction,
--     adjustment, leaderboard_payout
--
--   EXCLUDED because a receipt family mirrors them (would double count):
--     tournament_buyin, table_cashout, cashout, mint, rakeback, commission,
--     ticket_issue, ticket_redeem, ticket_cancel, wheel_prize, plinko_prize,
--     mines_prize, crash_prize, crossing_prize
--
--   EXCLUDED as per-hand and system flows with their own statements:
--     rake, bbj_contribution, bbj_payout, burn, horse_funding, settlement,
--     legacy_seed_reconcile. Every category not named in the included list
--     is also left out, so a new category is invisible until it is
--     deliberately added here.
--
--   No running balance is computed across the two sources. A receipt's
--   balance_after is the WRITER's balance (the agent's float on a send, the
--   treasury on a mint), so every receipt prints balance_after = null. A
--   movement prints post_to_balance / post_from_balance only for the side
--   that is the viewer's own entity; otherwise null.
--
--   amount    a positive 2dp string, to_char(round(x, 2),
--             'FM999999999999999990.00') (never '#'); totals the same.
--   wallet    player | agent | promo | bank | union | table | ticket |
--             cashout | other, one CASE over transaction_type (receipts) or
--             from_type / to_type / category (movements).
--   direction relative to the viewer: in (viewer receives), out (viewer
--             pays), managed (neither side is the viewer alone: staff and
--             agent views of other people's money, and a viewer moving chips
--             between two of their own wallets).
--   state     clawed_back (clawed_back), reversed (is_reversed), pending (a
--             cashout_request_escrow whose related_cashout_id is set and
--             that has no approved / denied / cancelled / expired-refund
--             receipt for the same cashout between the escrow and p_to + 1
--             day; the lookup runs for escrow rows only, and an escrow with
--             no related_cashout_id is posted, never pending forever),
--             reversible (reversible_until > now()), posted (default). Only
--             columns decide it.
--   from/to   a receipt side is {type 'user', id, profile label} (type null
--             when the side is null); a movement side is {from_type/to_type,
--             entity id, profile label or ledger label}.
--
--   A horse is never named. A receipt type containing "horse" prints as
--   treasury_funding (the label PlayerWalletModal already uses), and any
--   note, ledger label or reference value that contains the word is printed
--   as null. Filters match the printed values, so no filter can be used as
--   an oracle for the hidden ones. is_horse is never read.
--
-- THE SCOPE RULE (identical to fn_club_trade_ledger, which is the authority
-- for what the on-screen Cashier shows; an export is bound to the same rule)
--
--   An active or approved club_members row is required.
--     owner, co_owner, admin, super_agent -> 'all'      (the whole club)
--     agent, sub_agent                    -> 'downline' (the recursive
--        club_members.agent_id downline of active/approved members, viewer
--        included)
--     any other role                      -> 'self'     (rows where the
--        viewer is a side)
--   No membership, a suspended membership or a null role -> 'none'.
--   fn_club_cashier_scope maps super_agent to 'downline'; the statement does
--   not use it, because the export must match what is on screen.
--
-- OBJECTS
--   table    public.ca_cashier_statement_exports       (RLS on, no policy)
--   table    public.ca_cashier_statement_export_rows   (RLS on, no policy)
--   browser  public.fn_cashier_statement_scope(uuid)
--            public.fn_cashier_statement_page(uuid,timestamptz,timestamptz,jsonb,jsonb,integer)
--            public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)
--            public.fn_cashier_statement_export_start(uuid,timestamptz,timestamptz,jsonb,uuid)
--            public.fn_cashier_statement_export_page(uuid,integer,integer)
--            public.fn_cashier_statement_export_cancel(uuid)
--   private  (no EXECUTE for PUBLIC, anon, authenticated or service_role;
--            reached only from inside the SECURITY DEFINER doors above)
--            public.fn_cashier_statement_rows(...)   the ONE row-producing
--              query: the on-screen page, the totals door and the export are
--              all read through it, so a file can never differ from the
--              screen
--            public.fn_cashier_statement_downline(uuid,uuid)
--            public.fn_cashier_statement_filters(timestamptz,timestamptz,jsonb)
--            public.fn_cashier_statement_prune_expired()
--
-- BOUNDED READS AND THE TIME BUDGET
--   Measured on production before this shape (largest club, 323k receipts
--   in 30 days, scope all, 92 days, first page): 3,499 ms and 453k buffers,
--   because a UNION ALL + joins + top-N sort read every receipt and ledger
--   row of the range. So:
--   * The PAGE is O(limit). fn_cashier_statement_rows reads each source
--     separately with ORDER BY created_at DESC, id DESC LIMIT p_limit inside
--     the source subquery (every predicate, the cursor bound, the category
--     list, the anti-joins and the filters inside it), so each index scan
--     stops at the limit: chip_transactions (club_id, created_at DESC) and
--     chip_ledger (club_id, created_at DESC) for scope all; the (club_id,
--     from_user_id / to_user_id, created_at DESC) and (club_id,
--     from_entity_id / to_entity_id, created_at) indexes, one branch per
--     side, for self and downline. Only then are the <= 2 x p_limit (4 x for
--     self/downline) candidates merged, joined to profiles for labels and cut
--     to p_limit. A counterparty text search needs labels to filter, so it
--     joins profiles inside the branches (by primary key; the scan still
--     stops at the limit). A cursor page bounds each branch above by the
--     cursor instant, so the index starts at the cursor instead of at p_to.
--   * TOTALS are O(range) and live in their own door,
--     fn_cashier_statement_totals: plain SUM/COUNT by direction over the same
--     predicates, no ORDER BY, no LIMIT, no profiles join unless the
--     counterparty text filter needs labels. The page returns "totals":
--     null. The client shows Totals Unavailable when the totals call times
--     out (57014) and keeps the rows.
--   * EXPORT start reads through the same bounded path with p_limit 20,001,
--     so the 20,001-row refusal never sorts the whole range.
--
--   No function here sets statement_timeout. A function-level SET never
--   takes effect: the timer is armed when the OUTER statement starts (see
--   20260829212453_v30_revert_useless_fn_timeout.sql). The real budget is
--   the calling role's statement_timeout (authenticated: 8s) per call. The
--   post-apply check refuses a function-level statement_timeout on any of
--   these functions.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT count(*) = 10 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'fn\_cashier\_statement\_%')
-- @live-proof: (SELECT count(*) = 2 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('ca_cashier_statement_exports', 'ca_cashier_statement_export_rows') AND c.relrowsecurity)

BEGIN;

-- New objects only; nothing here waits behind a hot table for long.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The export job store. Private: RLS on with no policy, no browser grant.
--    No foreign key to a hot table (CLAUDE.md DDL policy).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_cashier_statement_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  scope_fingerprint text NOT NULL,
  date_from timestamptz NOT NULL,
  date_to timestamptz NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ready',
  total_rows integer NOT NULL DEFAULT 0,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL,
  metadata_fingerprint text NOT NULL,
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  CONSTRAINT ca_cashier_statement_exports_status_check
    CHECK (status IN ('ready')),
  CONSTRAINT ca_cashier_statement_exports_range_check
    CHECK (date_from < date_to),
  CONSTRAINT ca_cashier_statement_exports_total_rows_check
    CHECK (total_rows >= 0),
  CONSTRAINT ca_cashier_statement_exports_metadata_fingerprint_check
    CHECK (metadata_fingerprint = md5(metadata::text))
);

CREATE TABLE IF NOT EXISTS public.ca_cashier_statement_export_rows (
  export_id uuid NOT NULL
    REFERENCES public.ca_cashier_statement_exports(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  payload jsonb NOT NULL,
  CONSTRAINT ca_cashier_statement_export_rows_pkey PRIMARY KEY (export_id, ordinal),
  CONSTRAINT ca_cashier_statement_export_rows_ordinal_check CHECK (ordinal > 0)
);

-- One physical job per user; a request id replays only that user's job.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_cashier_statement_exports_one_per_user
  ON public.ca_cashier_statement_exports (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_cashier_statement_exports_request
  ON public.ca_cashier_statement_exports (user_id, request_id);
CREATE INDEX IF NOT EXISTS idx_ca_cashier_statement_exports_expires
  ON public.ca_cashier_statement_exports (expires_at);

ALTER TABLE public.ca_cashier_statement_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_cashier_statement_export_rows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ca_cashier_statement_exports
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ca_cashier_statement_export_rows
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.ca_cashier_statement_exports IS
  'Cashier statement export jobs: one per user, immutable, 15-minute expiry, re-authorized against fn_cashier_statement_scope on every page. Written and read only by the fn_cashier_statement_export_* doors.';
COMMENT ON TABLE public.ca_cashier_statement_export_rows IS
  'Materialized Cashier statement entries (the ENTRY json of fn_cashier_statement_rows) for one export job, in statement order.';

-- ---------------------------------------------------------------------------
-- 2. Private helpers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cashier_statement_downline(p_club_id uuid, p_viewer uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The fn_club_trade_ledger downline: the viewer plus every active or
  -- approved member reached through club_members.agent_id, recursively.
  -- UNION (not UNION ALL) terminates on a cyclic assignment.
  WITH RECURSIVE downline AS (
    SELECT p_viewer AS user_id
    UNION
    SELECT cm.user_id
      FROM public.club_members cm
      JOIN downline d ON cm.agent_id = d.user_id
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status::text, 'active') IN ('active', 'approved')
  )
  SELECT array_agg(d.user_id ORDER BY d.user_id)
    FROM downline d
   WHERE d.user_id IS NOT NULL
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashier_statement_filters(p_from timestamp with time zone, p_to timestamp with time zone, p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_key text;
  v_wallet text;
  v_direction text;
  v_state text;
  v_operation text;
  v_counterparty text;
  v_reference text;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) THEN
    RAISE EXCEPTION 'statement range needs a finite from and to' USING ERRCODE = '22023';
  END IF;
  IF p_from >= p_to THEN
    RAISE EXCEPTION 'statement range must start before it ends' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > interval '92 days' THEN
    RAISE EXCEPTION 'statement range is limited to 92 days' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_filters) <> 'object' THEN
    RAISE EXCEPTION 'statement filters must be an object' USING ERRCODE = '22023';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(v_filters) LOOP
    IF v_key NOT IN ('wallet', 'direction', 'operation', 'counterparty', 'state', 'reference') THEN
      RAISE EXCEPTION 'unknown statement filter: %', left(v_key, 32) USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_filters -> v_key) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'statement filter % must be text', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_wallet := lower(nullif(btrim(v_filters ->> 'wallet'), ''));
  v_direction := lower(nullif(btrim(v_filters ->> 'direction'), ''));
  v_state := lower(nullif(btrim(v_filters ->> 'state'), ''));
  v_operation := nullif(btrim(v_filters ->> 'operation'), '');
  v_counterparty := nullif(btrim(v_filters ->> 'counterparty'), '');
  v_reference := nullif(btrim(v_filters ->> 'reference'), '');

  IF coalesce(v_wallet, 'any') NOT IN ('any', 'player', 'agent', 'promo', 'bank', 'union', 'table', 'ticket', 'cashout', 'other') THEN
    RAISE EXCEPTION 'unknown wallet filter' USING ERRCODE = '22023';
  END IF;
  IF coalesce(v_direction, 'any') NOT IN ('any', 'in', 'out', 'managed') THEN
    RAISE EXCEPTION 'unknown direction filter' USING ERRCODE = '22023';
  END IF;
  IF coalesce(v_state, 'any') NOT IN ('any', 'reversible', 'reversed', 'clawed_back', 'pending', 'posted') THEN
    RAISE EXCEPTION 'unknown state filter' USING ERRCODE = '22023';
  END IF;
  IF v_operation IS NOT NULL AND (length(v_operation) > 64 OR v_operation ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'operation filter must be at most 64 printable characters' USING ERRCODE = '22023';
  END IF;
  IF v_counterparty IS NOT NULL THEN
    IF v_counterparty ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_counterparty := lower(v_counterparty);
    ELSIF length(v_counterparty) < 2 OR length(v_counterparty) > 64 OR v_counterparty ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'counterparty filter must be an id or 2 to 64 printable characters' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_reference IS NOT NULL THEN
    IF length(v_reference) > 128 OR v_reference ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'reference filter must be at most 128 printable characters' USING ERRCODE = '22023';
    END IF;
    IF v_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_reference := lower(v_reference);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'wallet', coalesce(v_wallet, 'any'),
    'direction', coalesce(v_direction, 'any'),
    'state', coalesce(v_state, 'any'),
    'operation', v_operation,
    'counterparty', v_counterparty,
    'reference', v_reference
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashier_statement_prune_expired()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer := 0;
BEGIN
  -- Overlapping callers skip instead of queueing. Transaction-scoped.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('ca-cashier-statement-export-expiry', 0)) THEN
    RETURN 0;
  END IF;

  -- At most 500 expired jobs per call, and no more child rows than one
  -- full export (20,000) beyond the first job. Locked rows are skipped.
  WITH candidate AS MATERIALIZED (
    SELECT export_job.id, export_job.expires_at, export_job.total_rows
      FROM public.ca_cashier_statement_exports export_job
     WHERE export_job.expires_at <= now()
     ORDER BY export_job.expires_at, export_job.id
     LIMIT 500
     FOR UPDATE SKIP LOCKED
  ), budget AS (
    SELECT candidate.id,
           row_number() OVER (ORDER BY candidate.expires_at, candidate.id) AS position,
           sum(candidate.total_rows) OVER (ORDER BY candidate.expires_at, candidate.id) AS running_rows
      FROM candidate
  )
  DELETE FROM public.ca_cashier_statement_exports expired_job
   USING budget
   WHERE expired_job.id = budget.id
     AND (budget.position = 1 OR budget.running_rows <= 20000);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The authorization door: exactly fn_club_trade_ledger's rule.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cashier_statement_scope(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  v_scope text := 'none';
  v_ids uuid[];
  v_reason text;
BEGIN
  IF v_viewer IS NULL THEN
    v_reason := 'sign_in_required';
  ELSIF p_club_id IS NULL THEN
    v_reason := 'club_required';
  ELSE
    SELECT cm.role::text
      INTO v_role
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.user_id = v_viewer
       AND coalesce(cm.status::text, 'active') IN ('active', 'approved')
     LIMIT 1;

    IF v_role IS NULL THEN
      v_reason := 'not_an_active_member';
    ELSIF v_role IN ('owner', 'co_owner', 'admin', 'super_agent') THEN
      v_scope := 'all';
    ELSIF v_role IN ('agent', 'sub_agent') THEN
      v_scope := 'downline';
      v_ids := public.fn_cashier_statement_downline(p_club_id, v_viewer);
    ELSE
      v_scope := 'self';
    END IF;
  END IF;

  -- Any change of viewer, club, scope or downline membership changes the
  -- fingerprint, which is what voids a prepared export.
  RETURN jsonb_build_object(
    'authorized', v_scope <> 'none',
    'reason', v_reason,
    'role', CASE WHEN v_scope <> 'none' THEN v_role END,
    'scope', v_scope,
    'viewer', v_viewer,
    'fingerprint', md5(concat_ws('|', v_viewer::text, p_club_id::text, v_scope, array_to_string(v_ids, ',')))
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The one row-producing query. Private (no browser EXECUTE): the callers
--    pass the viewer and scope they obtained from fn_cashier_statement_scope
--    and filters normalized by fn_cashier_statement_filters.
--      p_limit > 0    at most p_limit entries after the cursor. Each source
--                     branch reads its own top p_limit rows in index order
--                     (every predicate, the cursor bound and the anti-joins
--                     inside it, so the index scan stops early); only those
--                     small sets are merged, labelled and cut to p_limit.
--      p_limit NULL   every entry in the range, in statement order.
--      p_limit = 0    totals: one row per direction, entry_amount = the sum,
--                     entry = {"count": n}; no ORDER BY, no LIMIT, and no
--                     profiles join unless the counterparty text filter
--                     needs labels.
--    Branches: scope 'all' reads each ledger by (club_id, created_at);
--    'self' and 'downline' read the from-side and the to-side separately
--    (the to-side branch skips rows the from-side branch already holds), so
--    every branch can use a (club_id, user/entity, created_at) index.
-- ---------------------------------------------------------------------------
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
          p_filters ->> 'reference';                  -- $18
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The on-screen page (O(limit)) and its totals (O(range), own door).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cashier_statement_page(p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_filters jsonb DEFAULT '{}'::jsonb, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_scope jsonb;
  v_filters jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_fp text;
  v_after_at timestamptz;
  v_after_source text;
  v_after_id uuid;
  v_rows jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_last_at timestamptz;
  v_last_source text;
  v_last_id uuid;
  v_has_more boolean := false;
  v_row record;
BEGIN
  v_scope := public.fn_cashier_statement_scope(p_club_id);
  IF NOT coalesce((v_scope ->> 'authorized')::boolean, false)
     OR v_viewer IS NULL
     OR (v_scope ->> 'viewer')::uuid IS DISTINCT FROM v_viewer THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'reason', coalesce(v_scope ->> 'reason', 'not_authorized')
    );
  END IF;

  v_filters := public.fn_cashier_statement_filters(p_from, p_to, p_filters);
  v_fp := md5(concat_ws('|',
    v_viewer::text,
    p_club_id::text,
    to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    v_filters::text));

  IF p_cursor IS NOT NULL AND jsonb_typeof(p_cursor) <> 'null' THEN
    IF jsonb_typeof(p_cursor) <> 'object' THEN
      RAISE EXCEPTION 'statement cursor must be an object' USING ERRCODE = '22023';
    END IF;
    IF (p_cursor ->> 'fp') IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'cursor does not belong to this statement' USING ERRCODE = '55000';
    END IF;
    BEGIN
      v_after_at := (p_cursor ->> 'at')::timestamptz;
      v_after_source := p_cursor ->> 'source';
      v_after_id := (p_cursor ->> 'id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'statement cursor is malformed' USING ERRCODE = '22023';
    END;
    IF v_after_at IS NULL OR v_after_id IS NULL
       OR v_after_source IS NULL OR v_after_source NOT IN ('movement', 'receipt') THEN
      RAISE EXCEPTION 'statement cursor is malformed' USING ERRCODE = '22023';
    END IF;
  END IF;

  FOR v_row IN
    SELECT r.entry_at, r.entry_source, r.entry_id, r.entry
      FROM public.fn_cashier_statement_rows(
             p_club_id, v_viewer, v_scope ->> 'scope', p_from, p_to, v_filters,
             v_after_at, v_after_source, v_after_id, v_limit + 1) r
     ORDER BY r.entry_at DESC, r.entry_source COLLATE "C" ASC, r.entry_id DESC
  LOOP
    v_count := v_count + 1;
    IF v_count > v_limit THEN
      v_has_more := true;
      EXIT;
    END IF;
    v_rows := v_rows || jsonb_build_array(v_row.entry);
    v_last_at := v_row.entry_at;
    v_last_source := v_row.entry_source;
    v_last_id := v_row.entry_id;
  END LOOP;

  -- The page is O(limit). Totals are O(range) and have their own door,
  -- fn_cashier_statement_totals, so "totals" here is always null.
  RETURN jsonb_build_object(
    'authorized', true,
    'scope', v_scope ->> 'scope',
    'viewer', v_viewer,
    'range', jsonb_build_object(
      'from', to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'to', to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'filters', v_filters,
    'rows', v_rows,
    'next_cursor', CASE WHEN v_has_more THEN jsonb_build_object(
      'at', to_char(v_last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'source', v_last_source,
      'id', v_last_id,
      'fp', v_fp) END,
    'totals', NULL::jsonb,
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashier_statement_totals(p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_scope jsonb;
  v_filters jsonb;
  v_totals jsonb;
BEGIN
  v_scope := public.fn_cashier_statement_scope(p_club_id);
  IF NOT coalesce((v_scope ->> 'authorized')::boolean, false)
     OR v_viewer IS NULL
     OR (v_scope ->> 'viewer')::uuid IS DISTINCT FROM v_viewer THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'reason', coalesce(v_scope ->> 'reason', 'not_authorized')
    );
  END IF;

  v_filters := public.fn_cashier_statement_filters(p_from, p_to, p_filters);

  -- Plain SUM / COUNT over the page's own predicates (the totals mode of
  -- the one row query): no ORDER BY, no LIMIT, no labels unless the
  -- counterparty text filter needs them. O(range), in its own call, so a
  -- timeout here (57014) never costs the page its rows.
  SELECT jsonb_build_object(
           'in', to_char(round(coalesce(sum(t.entry_amount) FILTER (WHERE t.entry_direction = 'in'), 0), 2), 'FM999999999999999990.00'),
           'out', to_char(round(coalesce(sum(t.entry_amount) FILTER (WHERE t.entry_direction = 'out'), 0), 2), 'FM999999999999999990.00'),
           'managed', to_char(round(coalesce(sum(t.entry_amount) FILTER (WHERE t.entry_direction = 'managed'), 0), 2), 'FM999999999999999990.00'),
           'count', coalesce(sum((t.entry ->> 'count')::bigint), 0))
    INTO v_totals
    FROM public.fn_cashier_statement_rows(
           p_club_id, v_viewer, v_scope ->> 'scope', p_from, p_to, v_filters,
           NULL, NULL, NULL, 0) t;

  RETURN jsonb_build_object(
    'authorized', true,
    'scope', v_scope ->> 'scope',
    'range', jsonb_build_object(
      'from', to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'to', to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'filters', v_filters,
    'totals', v_totals,
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The export doors.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cashier_statement_export_start(p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_filters jsonb DEFAULT '{}'::jsonb, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_scope jsonb;
  v_filters jsonb;
  v_job public.ca_cashier_statement_exports%ROWTYPE;
  v_payloads jsonb[];
  v_count integer;
  v_in numeric;
  v_out numeric;
  v_managed numeric;
  v_totals jsonb;
  v_metadata jsonb;
  v_id uuid := gen_random_uuid();
  v_now timestamptz := now();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sign in to prepare an export' USING ERRCODE = '42501';
  END IF;

  v_scope := public.fn_cashier_statement_scope(p_club_id);
  IF NOT coalesce((v_scope ->> 'authorized')::boolean, false)
     OR (v_scope ->> 'viewer')::uuid IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'not authorized to export this statement' USING ERRCODE = '42501';
  END IF;

  v_filters := public.fn_cashier_statement_filters(p_from, p_to, p_filters);

  -- One start per user at a time; a second concurrent start is refused
  -- instead of queueing another statement build.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('ca-cashier-statement-export:' || v_user::text, 0)) THEN
    RAISE EXCEPTION 'an export is already being prepared' USING ERRCODE = '55000';
  END IF;

  IF p_request_id IS NOT NULL THEN
    SELECT export_job.*
      INTO v_job
      FROM public.ca_cashier_statement_exports export_job
     WHERE export_job.user_id = v_user
       AND export_job.request_id = p_request_id
       AND export_job.expires_at > v_now;
    IF FOUND AND v_job.scope_fingerprint = v_scope ->> 'fingerprint' THEN
      IF v_job.club_id IS DISTINCT FROM p_club_id
         OR v_job.date_from IS DISTINCT FROM p_from
         OR v_job.date_to IS DISTINCT FROM p_to
         OR v_job.filters IS DISTINCT FROM v_filters THEN
        RAISE EXCEPTION 'statement export request id was already used for different inputs' USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object(
        'export_id', v_job.id,
        'total_rows', v_job.total_rows,
        'expires_at', v_job.expires_at,
        'totals', v_job.totals,
        'metadata_fingerprint', v_job.metadata_fingerprint
      );
    END IF;
  END IF;

  -- One physical job per user: the caller's previous job (at most one, by
  -- the unique index) goes first, then anyone's expired jobs, bounded.
  DELETE FROM public.ca_cashier_statement_exports own_job
   WHERE own_job.user_id = v_user;
  PERFORM public.fn_cashier_statement_prune_expired();

  -- The bounded path: each source branch stops at 20,001 rows, so the
  -- refusal below never sorts the whole range.
  SELECT coalesce(array_agg(r.entry ORDER BY r.entry_at DESC, r.entry_source COLLATE "C" ASC, r.entry_id DESC), ARRAY[]::jsonb[]),
         count(*),
         coalesce(sum(r.entry_amount) FILTER (WHERE r.entry_direction = 'in'), 0),
         coalesce(sum(r.entry_amount) FILTER (WHERE r.entry_direction = 'out'), 0),
         coalesce(sum(r.entry_amount) FILTER (WHERE r.entry_direction = 'managed'), 0)
    INTO v_payloads, v_count, v_in, v_out, v_managed
    FROM public.fn_cashier_statement_rows(
           p_club_id, v_user, v_scope ->> 'scope', p_from, p_to, v_filters,
           NULL, NULL, NULL, 20001) r;

  IF v_count > 20000 THEN
    RAISE EXCEPTION 'narrow the range; the export is limited to 20,000 entries' USING ERRCODE = '55000';
  END IF;

  v_totals := jsonb_build_object(
    'in', to_char(round(v_in, 2), 'FM999999999999999990.00'),
    'out', to_char(round(v_out, 2), 'FM999999999999999990.00'),
    'managed', to_char(round(v_managed, 2), 'FM999999999999999990.00'),
    'count', v_count);
  v_metadata := jsonb_build_object(
    'kind', 'cashier_statement',
    'club_id', p_club_id,
    'scope', v_scope ->> 'scope',
    'from', to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'to', to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'filters', v_filters,
    'generated_at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'total_rows', v_count);

  INSERT INTO public.ca_cashier_statement_exports (
    id, user_id, club_id, scope_fingerprint, date_from, date_to, filters,
    status, total_rows, totals, metadata, metadata_fingerprint, request_id,
    created_at, expires_at
  ) VALUES (
    v_id, v_user, p_club_id, v_scope ->> 'fingerprint', p_from, p_to, v_filters,
    'ready', v_count, v_totals, v_metadata, md5(v_metadata::text), p_request_id,
    v_now, v_now + interval '15 minutes'
  )
  RETURNING * INTO v_job;

  INSERT INTO public.ca_cashier_statement_export_rows (export_id, ordinal, payload)
  SELECT v_id, prepared.ordinal::integer, prepared.payload
    FROM unnest(v_payloads) WITH ORDINALITY AS prepared(payload, ordinal);

  RETURN jsonb_build_object(
    'export_id', v_job.id,
    'total_rows', v_job.total_rows,
    'expires_at', v_job.expires_at,
    'totals', v_job.totals,
    'metadata_fingerprint', v_job.metadata_fingerprint
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashier_statement_export_page(p_export_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_job public.ca_cashier_statement_exports%ROWTYPE;
  v_scope jsonb;
  v_offset bigint;
  v_limit bigint := least(greatest(coalesce(p_limit, 1000), 1), 2000);
  v_rows jsonb;
  v_returned bigint;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sign in to read an export' USING ERRCODE = '42501';
  END IF;

  SELECT export_job.*
    INTO v_job
    FROM public.ca_cashier_statement_exports export_job
   WHERE export_job.id = p_export_id
     AND export_job.user_id = v_user;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'export is unavailable' USING ERRCODE = '55000';
  END IF;
  IF v_job.expires_at <= now() THEN
    RAISE EXCEPTION 'export expired; prepare a new export' USING ERRCODE = '55000';
  END IF;

  -- Re-derive the scope NOW. Any change since preparation refuses the whole
  -- file, page one included, so no client can combine pages prepared under
  -- two different scopes. (This door is read-only: the refused job is
  -- retired by the caller's next start or cancel, or by the expiry prune.)
  v_scope := public.fn_cashier_statement_scope(v_job.club_id);
  IF NOT coalesce((v_scope ->> 'authorized')::boolean, false)
     OR (v_scope ->> 'viewer')::uuid IS DISTINCT FROM v_user
     OR (v_scope ->> 'fingerprint') IS DISTINCT FROM v_job.scope_fingerprint THEN
    RAISE EXCEPTION 'export is no longer authorized' USING ERRCODE = '42501';
  END IF;

  IF v_job.metadata_fingerprint IS DISTINCT FROM md5(v_job.metadata::text) THEN
    RAISE EXCEPTION 'export metadata is invalid' USING ERRCODE = '55000';
  END IF;

  -- Offsets are clamped to 0..total_rows and computed in bigint, so no
  -- offset (2147483647 included) can overflow or step past the file.
  v_offset := least(greatest(coalesce(p_offset, 0)::bigint, 0), v_job.total_rows::bigint);

  SELECT coalesce(jsonb_agg(export_row.payload ORDER BY export_row.ordinal), '[]'::jsonb)
    INTO v_rows
    FROM public.ca_cashier_statement_export_rows export_row
   WHERE export_row.export_id = v_job.id
     AND export_row.ordinal > v_offset
     AND export_row.ordinal <= v_offset + v_limit;
  v_returned := jsonb_array_length(v_rows);

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total_rows', v_job.total_rows,
    'next_offset', least(v_offset + v_returned, v_job.total_rows::bigint),
    'has_more', v_offset + v_returned < v_job.total_rows,
    'expires_at', v_job.expires_at,
    'metadata', v_job.metadata,
    'metadata_fingerprint', v_job.metadata_fingerprint
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashier_statement_export_cancel(p_export_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_deleted integer := 0;
BEGIN
  IF v_user IS NULL OR p_export_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.ca_cashier_statement_exports cancelled_job
   USING (
     SELECT owned_job.id
       FROM public.ca_cashier_statement_exports owned_job
      WHERE owned_job.id = p_export_id
        AND owned_job.user_id = v_user
      FOR UPDATE SKIP LOCKED
   ) owned
   WHERE cancelled_job.id = owned.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM public.fn_cashier_statement_prune_expired();

  RETURN v_deleted = 1;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Privileges. Browser doors: authenticated + service_role. Private
--    helpers: owner only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_cashier_statement_scope(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_page(uuid, timestamp with time zone, timestamp with time zone, jsonb, jsonb, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_totals(uuid, timestamp with time zone, timestamp with time zone, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_export_start(uuid, timestamp with time zone, timestamp with time zone, jsonb, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_export_page(uuid, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_export_cancel(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_cashier_statement_scope(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashier_statement_page(uuid, timestamp with time zone, timestamp with time zone, jsonb, jsonb, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashier_statement_totals(uuid, timestamp with time zone, timestamp with time zone, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashier_statement_export_start(uuid, timestamp with time zone, timestamp with time zone, jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashier_statement_export_page(uuid, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashier_statement_export_cancel(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_cashier_statement_rows(uuid, uuid, text, timestamp with time zone, timestamp with time zone, jsonb, timestamp with time zone, text, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_downline(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_filters(timestamp with time zone, timestamp with time zone, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cashier_statement_prune_expired() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_cashier_statement_scope(uuid) IS
  'Cashier statement authorization, identical to fn_club_trade_ledger: owner/co_owner/admin/super_agent all, agent/sub_agent recursive downline, other active members self, otherwise none. The fingerprint changes with viewer, club, scope or downline.';
COMMENT ON FUNCTION public.fn_cashier_statement_page(uuid, timestamp with time zone, timestamp with time zone, jsonb, jsonb, integer) IS
  'One keyset page of the cross-wallet Cashier statement (every receipt plus chip_ledger movements of the categories no receipt writer mirrors), ordered at DESC, source ASC, id DESC, read per source with the limit pushed into each index scan. totals is always null (see fn_cashier_statement_totals). Lost authorization returns {authorized:false}.';
COMMENT ON FUNCTION public.fn_cashier_statement_totals(uuid, timestamp with time zone, timestamp with time zone, jsonb) IS
  'Totals (in, out, managed as 2dp strings, and count) of the Cashier statement over the whole filtered range, by the same predicates as fn_cashier_statement_page. Separate from the page so an O(range) read never costs the page its rows. Lost authorization returns {authorized:false}.';
COMMENT ON FUNCTION public.fn_cashier_statement_export_start(uuid, timestamp with time zone, timestamp with time zone, jsonb, uuid) IS
  'Materializes the same statement rows as fn_cashier_statement_page into one 15-minute export job for the caller (at most 20,000 entries).';
COMMENT ON FUNCTION public.fn_cashier_statement_export_page(uuid, integer, integer) IS
  'Pages a prepared Cashier statement export, re-deriving the caller scope on every page; a changed scope refuses the whole file (42501).';
COMMENT ON FUNCTION public.fn_cashier_statement_export_cancel(uuid) IS
  'Deletes the caller''s own Cashier statement export job and retires expired jobs, bounded.';
COMMENT ON FUNCTION public.fn_cashier_statement_rows(uuid, uuid, text, timestamp with time zone, timestamp with time zone, jsonb, timestamp with time zone, text, uuid, integer) IS
  'Private. The one row-producing query behind the Cashier statement page, its totals and its export. Owner-only EXECUTE.';

-- ---------------------------------------------------------------------------
-- 8. Post-apply self-checks.
-- ---------------------------------------------------------------------------
DO $post_apply$
DECLARE
  v_browser text[] := ARRAY[
    'public.fn_cashier_statement_scope(uuid)',
    'public.fn_cashier_statement_page(uuid,timestamptz,timestamptz,jsonb,jsonb,integer)',
    'public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)',
    'public.fn_cashier_statement_export_start(uuid,timestamptz,timestamptz,jsonb,uuid)',
    'public.fn_cashier_statement_export_page(uuid,integer,integer)',
    'public.fn_cashier_statement_export_cancel(uuid)'
  ];
  v_private text[] := ARRAY[
    'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)',
    'public.fn_cashier_statement_downline(uuid,uuid)',
    'public.fn_cashier_statement_filters(timestamptz,timestamptz,jsonb)',
    'public.fn_cashier_statement_prune_expired()'
  ];
  v_signature text;
  v_oid oid;
  v_table text;
BEGIN
  FOREACH v_signature IN ARRAY v_browser || v_private LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POST-APPLY: % is missing', v_signature;
    END IF;
    IF NOT coalesce((SELECT p.proconfig @> ARRAY['search_path=public, pg_temp']::text[] FROM pg_proc p WHERE p.oid = v_oid), false) THEN
      RAISE EXCEPTION 'POST-APPLY: % search_path is not public, pg_temp', v_signature;
    END IF;
    -- A function-level statement_timeout never takes effect (the outer
    -- statement arms the timer); the role's timeout is the budget.
    IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL unnest(p.proconfig) cfg WHERE p.oid = v_oid AND cfg LIKE 'statement\_timeout=%') THEN
      RAISE EXCEPTION 'POST-APPLY: % sets a function-level statement_timeout, which never takes effect', v_signature;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-APPLY: anon can execute %', v_signature;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.oid = v_oid
         AND acl.privilege_type = 'EXECUTE'
         AND acl.grantee = 0
    ) THEN
      RAISE EXCEPTION 'POST-APPLY: PUBLIC can execute %', v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY v_browser LOOP
    v_oid := to_regprocedure(v_signature);
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid) THEN
      RAISE EXCEPTION 'POST-APPLY: % is not SECURITY DEFINER', v_signature;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-APPLY: % is not executable by authenticated and service_role', v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY v_private LOOP
    v_oid := to_regprocedure(v_signature);
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-APPLY: private helper % is executable by a client role', v_signature;
    END IF;
  END LOOP;

  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_private[1])) THEN
    RAISE EXCEPTION 'POST-APPLY: fn_cashier_statement_rows is not SECURITY DEFINER';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['public.ca_cashier_statement_exports', 'public.ca_cashier_statement_export_rows'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = v_table::regclass) THEN
      RAISE EXCEPTION 'POST-APPLY: RLS is off on %', v_table;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = v_table::regclass) THEN
      RAISE EXCEPTION 'POST-APPLY: % must have no policy', v_table;
    END IF;
    IF has_table_privilege('anon', v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'POST-APPLY: a browser role holds a privilege on %', v_table;
    END IF;
  END LOOP;
END;
$post_apply$;

COMMIT;
