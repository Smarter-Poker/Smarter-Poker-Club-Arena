-- 20260907222128_a_player_can_audit_their_own_chips.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- PHASE 7 OF THE CHIP-ACCOUNTING PROGRAMME, roadmap 9.5:
-- "A PLAYER CAN ALREADY AUDIT THEIR OWN CHIPS, AND HAS NOWHERE TO DO IT.
--  chip_ledger carries RLS - a player may read any leg where they are
--  performed_by, from_entity_id or to_entity_id - and no surface anywhere
--  shows it. A standard nobody outside the team can check is half a standard,
--  and this is also the cheapest support tool on the platform: 'where did my
--  chips go' answers itself. Same for a club operator and their treasury."
--
-- WHAT WAS THERE, READ ON 2026-09-07. A surface did exist:
-- TransactionLedgerView, on the wallet page's Ledger tab, reading chip_ledger
-- with `performed_by.eq.<me>,to_entity_id.eq.<me>`. Two things about it:
--
--   1. It never asked for from_entity_id. Every chip that LEFT the player -
--      buy-ins, tournament entries, add-ons, rebuys - was invisible; only
--      credits showed. "Where did my chips go" was the one question the
--      surface could not answer.
--   2. It was a feed, not a statement. Twenty rows, newest first, no
--      balance, nothing to check the balance against. An audit is a
--      comparison; a list with nothing to compare to is a photograph.
--
-- And the comparison the standard already makes nightly had no reader
-- outside the team: fn_ca_ledger_replay reads every player wallet against
-- the journal every night and writes the reading to ca_account_snapshots
-- (balance, taken_at, cum_unexplained). That reading is exactly what a
-- player would want to see: "at 06:40 your wallet was read at X and agreed
-- with the journal; since then the journal shows Y in and Z out; that puts
-- you at X+Y-Z; your wallet says W" - and whether W equals X+Y-Z is the
-- audit, in one line, computed from the same rows the platform's own
-- controls use.
--
-- WHAT THIS BUILDS: fn_ca_chip_statement(scope, club, before, limit).
--
--   scope 'player'         the caller's own wallet. The entity is auth.uid()
--                          and nothing else - a player cannot ask for another
--                          player's statement, and the same function serves
--                          a horse and a human identically (CLAUDE.md 10.5:
--                          a horse's chip history is a player's chip history).
--   scope 'club_treasury'  the club's treasury, for whoever
--                          ca_can_view_club_finances says may see it - the
--                          same gate the club ledger already uses.
--
-- Every answer carries: the balance now (per club and in total, for a
-- player), a page of legs with the direction from the account's point of
-- view and the counterparty named, and the AUDIT block above, read from
-- ca_account_snapshots. When there is no reading yet - a wallet that has
-- never moved 26 hours before a nightly run - the audit block says
-- `no_reading_yet` rather than pretending. The coverage travels with the
-- answer (CLAUDE.md 10.86).
--
-- Cost: one index range per side over (to_entity_id, created_at DESC) and
-- (from_entity_id, created_at DESC), which already exist, for the page; the
-- audit's net is the legs since the last reading, under a day. Measured
-- below in the DO block on the busiest account of the day.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_chip_statement(
  p_scope   text        DEFAULT 'player',
  p_club_id uuid        DEFAULT NULL,
  p_before  timestamptz DEFAULT NULL,
  p_limit   integer     DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
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
    IF NOT public.ca_can_view_club_finances(p_club_id) THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
    END IF;
    v_entity := p_club_id;
    v_type   := 'club_treasury';
    v_col    := 'clubs.chip_treasury';
  ELSE
    RAISE EXCEPTION 'scope must be player or club_treasury';
  END IF;
  v_key := v_type || ':' || v_entity::text || ':' || v_col;

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
             'category', p.category, 'description', p.description,
             'counterparty_type', p.counterparty_type, 'counterparty_label', p.counterparty_label,
             'counterparty_id', p.counterparty_id,
             'club_id', p.club_id, 'table_id', p.table_id, 'tournament_id', p.tournament_id,
             'hand_id', p.hand_id, 'settlement_id', p.settlement_id)
             ORDER BY p.created_at DESC, p.id DESC) FROM page p), '[]'::jsonb),
         (SELECT count(*) FROM mine) > v_limit,   -- more than a page on either side, or both together
         (SELECT min(p.created_at) FROM page p)
    INTO v_legs, v_has_more, v_next;

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
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_chip_statement(text, uuid, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_chip_statement(text, uuid, timestamptz, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_chip_statement(text, uuid, timestamptz, integer) IS
  'Phase 7 (roadmap 9.5). A chip statement a player - horse or human, identically - or a club operator can audit: balance now, a page of legs with direction and counterparty, and the comparison against the last nightly reading in ca_account_snapshots (balance_at_reading + in_since - out_since vs balance_now). scope=player is always the caller''s own wallet; scope=club_treasury is gated by ca_can_view_club_finances.';

-- ---------------------------------------------------------------------------
-- PROVE IT, in this transaction, or abort it.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_uid   uuid;
  v_res   jsonb;
  v_club  uuid;
  v_ms    numeric;
  v_n     int;
BEGIN
  -- nobody can ask for another player's statement: the entity is auth.uid()
  IF pg_get_functiondef('public.fn_ca_chip_statement(text, uuid, timestamptz, integer)'::regprocedure) !~ 'v_entity := v_caller;' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the player statement does not bind the entity to auth.uid()';
  END IF;
  -- and there is no horse filter anywhere in it (CLAUDE.md 10.5)
  IF pg_get_functiondef('public.fn_ca_chip_statement(text, uuid, timestamptz, integer)'::regprocedure) ~* 'is_horse' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the statement treats horses differently';
  END IF;

  -- grants: authenticated may call it (it is the player's own), anon may not
  IF has_function_privilege('anon', 'public.fn_ca_chip_statement(text, uuid, timestamptz, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: anon can call the statement';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_ca_chip_statement(text, uuid, timestamptz, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: authenticated cannot call the statement';
  END IF;

  -- unauthenticated: refused, never an empty statement
  BEGIN
    PERFORM set_config('request.jwt.claims', '{}', true);
    PERFORM public.fn_ca_chip_statement('player');
    RAISE EXCEPTION 'VERIFY FAILED: an unauthenticated call got a statement';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  -- as the busiest player of the day (a horse, almost certainly - and that is
  -- the point): the statement answers, both directions appear, and the audit
  -- block is one of the three stated shapes
  SELECT e INTO v_uid FROM (
    SELECT to_entity_id AS e FROM public.chip_ledger WHERE to_type = 'player_wallet' AND created_at > now() - interval '6 hours'
    UNION ALL
    SELECT from_entity_id FROM public.chip_ledger WHERE from_type = 'player_wallet' AND created_at > now() - interval '6 hours') x
   GROUP BY e ORDER BY count(*) DESC LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'VERIFY FAILED: no player moved chips in the last six hours (?)'; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  v_res := public.fn_ca_chip_statement('player', NULL, NULL, 50);
  IF (v_res->>'entity_id')::uuid <> v_uid THEN
    RAISE EXCEPTION 'VERIFY FAILED: the statement is for % not the caller %', v_res->>'entity_id', v_uid;
  END IF;
  IF jsonb_array_length(v_res->'legs') = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the busiest wallet of the day has an empty statement';
  END IF;
  SELECT count(DISTINCT l->>'direction') INTO v_n FROM jsonb_array_elements(v_res->'legs') l;
  IF v_n < 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED: only one direction in the page - the defect this migration exists for: %', v_res->'legs'->0;
  END IF;
  IF v_res->'audit'->>'status' NOT IN ('reconciles', 'does_not_reconcile', 'no_reading_yet', 'no_balance') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the audit block has no stated shape: %', v_res->'audit';
  END IF;
  IF v_res->'audit'->>'status' = 'reconciles' AND abs((v_res->'audit'->>'unexplained')::numeric) >= 0.005 THEN
    RAISE EXCEPTION 'VERIFY FAILED: reconciles with a non-zero difference: %', v_res->'audit';
  END IF;
  v_ms := (v_res->>'ms')::numeric;
  IF v_ms > 2000 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the statement took % ms for one page; it must stay an index range', v_ms;
  END IF;

  -- club treasury: the gate is the club-finance gate, read from the
  -- catalogue. It cannot be probed negatively from here - the gate answers
  -- true to session_user postgres, which is what applies this migration -
  -- so the assertion is that the treasury branch reaches it and nothing else.
  IF pg_get_functiondef('public.fn_ca_chip_statement(text, uuid, timestamptz, integer)'::regprocedure)
       !~ 'IF NOT public\.ca_can_view_club_finances\(p_club_id\) THEN' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the club treasury statement is not behind ca_can_view_club_finances';
  END IF;
  -- and it answers for a club the caller may see (postgres may see every club)
  SELECT c.id INTO v_club FROM public.clubs c WHERE c.chip_treasury IS NOT NULL ORDER BY c.chip_treasury DESC LIMIT 1;
  v_res := public.fn_ca_chip_statement('club_treasury', v_club, NULL, 20);
  IF v_res->>'scope' <> 'club_treasury' OR (v_res->>'entity_id')::uuid <> v_club THEN
    RAISE EXCEPTION 'VERIFY FAILED: the treasury statement is not for the club asked: %', v_res - 'legs';
  END IF;

  RAISE NOTICE 'a player can audit their own chips: % legs, audit %, % ms', jsonb_array_length(v_res->'legs'), v_res->'audit'->>'status', v_ms;
END $verify$;

COMMIT;
