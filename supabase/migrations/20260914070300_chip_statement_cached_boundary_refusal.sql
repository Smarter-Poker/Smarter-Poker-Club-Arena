-- Pages opened before the cursor upgrade must also refuse ambiguous continuations.
DO $guard$
BEGIN
  IF to_regprocedure('public.fn_ca_chip_statement(text,uuid,timestamptz,integer)') IS NULL
     OR md5(pg_get_functiondef('public.fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure))
        NOT IN ('0fc821ab5a709168c1c348aa15f32792','48dd7c1b2b828579f04a45b84a6a6eee') THEN
    RAISE EXCEPTION 'legacy statement reader changed; requalify its current definition';
  END IF;
  IF to_regprocedure('public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)') IS NULL
     OR md5(pg_get_functiondef('public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure))
        <> 'c706109ed8dab335912f046aaa6ee215' THEN
    RAISE EXCEPTION 'paged statement reader changed; requalify before changing compatibility';
  END IF;
END $guard$;

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
             'category', p.category, 'description', p.description,
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
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_chip_statement(text,uuid,timestamptz,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_chip_statement(text,uuid,timestamptz,integer) TO authenticated,service_role;

