-- 20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql
--
-- Reserved after the 20260909005925 busted-player and 20260909011642
-- same-chair-generation repairs on main. This order is load-bearing: the
-- wrapper below captures those repaired implementations as owner-only cores,
-- so a clean rebuild and a live incremental rollout end on identical code.
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- The historical minute reconciler used this exact session advisory lock.
-- Acquire it before any relation lock so a running job can finish before the
-- cutover and no new job can enter behind our table write barrier. Keep the
-- cron catalog write-frozen until the function and its schedule are gone.
SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'));
LOCK TABLE cron.job IN SHARE ROW EXCLUSIVE MODE;

-- Seat exits are part of tournament settlement. They are not a generic table
-- cleanup operation and they are not a wallet cash-out. Drain concurrent seat
-- writers while the trigger and every existing atomic owner are cut over.
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournament_players IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.table_seats IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.tournament_seat_exit_authority_cutover (
  authority text PRIMARY KEY
    CHECK (authority='tournament_seat_exit_authority:v1'),
  migration_version text NOT NULL CHECK (migration_version='20260909014545'),
  installed_at timestamptz NOT NULL,
  repaired_seat_count integer NOT NULL CHECK (repaired_seat_count>=0),
  repaired_seat_ids uuid[] NOT NULL,
  repaired_table_count integer NOT NULL CHECK (repaired_table_count>=0),
  repaired_table_ids uuid[] NOT NULL,
  repaired_roster_count integer NOT NULL CHECK (repaired_roster_count>=0),
  repaired_roster_ids uuid[] NOT NULL,
  repaired_chip_count integer NOT NULL CHECK (repaired_chip_count>=0),
  repaired_chip_roster_ids uuid[] NOT NULL,
  repaired_stakes_count integer NOT NULL CHECK (repaired_stakes_count>=0),
  repaired_stakes_table_ids uuid[] NOT NULL,
  closed_duplicate_table_count integer NOT NULL
    CHECK (closed_duplicate_table_count>=0),
  closed_duplicate_table_ids uuid[] NOT NULL,
  repaired_player_count_count integer NOT NULL
    CHECK (repaired_player_count_count>=0),
  repaired_player_count_tournament_ids uuid[] NOT NULL,
  CHECK (repaired_seat_count=cardinality(repaired_seat_ids)),
  CHECK (repaired_table_count=cardinality(repaired_table_ids)),
  CHECK (repaired_roster_count=cardinality(repaired_roster_ids)),
  CHECK (repaired_chip_count=cardinality(repaired_chip_roster_ids)),
  CHECK (repaired_stakes_count=cardinality(repaired_stakes_table_ids)),
  CHECK (closed_duplicate_table_count=
         cardinality(closed_duplicate_table_ids)),
  CHECK (repaired_player_count_count=
         cardinality(repaired_player_count_tournament_ids)),
  CHECK (array_position(repaired_seat_ids,NULL) IS NULL),
  CHECK (array_position(repaired_table_ids,NULL) IS NULL),
  CHECK (array_position(repaired_roster_ids,NULL) IS NULL),
  CHECK (array_position(repaired_chip_roster_ids,NULL) IS NULL),
  CHECK (array_position(repaired_stakes_table_ids,NULL) IS NULL),
  CHECK (array_position(closed_duplicate_table_ids,NULL) IS NULL),
  CHECK (array_position(repaired_player_count_tournament_ids,NULL) IS NULL)
);

ALTER TABLE public.tournament_seat_exit_authority_cutover
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_seat_exit_authority_cutover
  FROM PUBLIC,anon,authenticated,service_role;

-- The old process-start sweep wrote seat and table rows in separate requests.
-- Close its exact historical backlog once while every writer is drained, then
-- record the complete affected identity set before installing the permanent
-- source guard. A receipted terminal event is already immutable proof and may
-- never be repaired here: disagreement with that proof aborts the migration.
DO $terminal_orphan_cutover$
DECLARE
  v_seat_ids uuid[]:=ARRAY[]::uuid[];
  v_table_ids uuid[]:=ARRAY[]::uuid[];
  v_seats_updated integer:=0;
  v_tables_updated integer:=0;
  v_roster_ids uuid[]:=ARRAY[]::uuid[];
  v_chip_roster_ids uuid[]:=ARRAY[]::uuid[];
  v_stakes_table_ids uuid[]:=ARRAY[]::uuid[];
  v_duplicate_table_ids uuid[]:=ARRAY[]::uuid[];
  v_player_count_tournament_ids uuid[]:=ARRAY[]::uuid[];
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      LEFT JOIN public.tables tb ON tb.tournament_id=t.id
      LEFT JOIN public.table_seats s
        ON s.table_id=tb.id AND s.left_at IS NULL
     WHERE upper(COALESCE(t.status::text,'')) IN
             ('COMPLETED','CANCELLED','CANCELED')
       AND public.fn_ca_has_committed_tournament_receipt(t.id)
       AND (s.id IS NOT NULL
         OR (tb.id IS NOT NULL AND (
           lower(COALESCE(tb.status,''))<>'closed'
           OR tb.current_players IS DISTINCT FROM 0)))
  ) THEN
    RAISE EXCEPTION
      'a committed terminal receipt disagrees with durable table or seat state'
      USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_seat_ids
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
    JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE s.left_at IS NULL
     AND upper(COALESCE(t.status::text,'')) IN
           ('COMPLETED','CANCELLED','CANCELED')
     AND NOT public.fn_ca_has_committed_tournament_receipt(t.id);

  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_table_ids
    FROM public.tables tb
    JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE upper(COALESCE(t.status::text,'')) IN
           ('COMPLETED','CANCELLED','CANCELED')
     AND NOT public.fn_ca_has_committed_tournament_receipt(t.id)
     AND (lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0);

  UPDATE public.table_seats s
     SET left_at=COALESCE(t.ended_at,transaction_timestamp()),
         status='left',leave_pending=false,is_sitting_out=false,is_away=false,
         sit_out_at=NULL,scheduled_leave_hands=NULL
    FROM public.tables tb,public.tournaments t
   WHERE s.id=ANY(v_seat_ids)
     AND tb.id=s.table_id AND t.id=tb.tournament_id
     AND s.left_at IS NULL;
  GET DIAGNOSTICS v_seats_updated=ROW_COUNT;

  UPDATE public.tables tb
     SET current_players=0,updated_at=now()
   WHERE tb.id=ANY(v_table_ids);
  GET DIAGNOSTICS v_tables_updated=ROW_COUNT;

  IF v_seats_updated<>cardinality(v_seat_ids)
     OR v_tables_updated<>cardinality(v_table_ids) THEN
    RAISE EXCEPTION
      'terminal backlog changed while the cutover owned its write barrier'
      USING ERRCODE='40001';
  END IF;

  -- Retire the minute reconciler only after closing its exact historical
  -- backlog under this write barrier. Every future writer is re-emitted below
  -- with its denormalised fields in the same transaction.
  --
  -- The hand path also used a separate two-statement chip reconciler. Drain
  -- and repair its exact backlog once here, while both source and mirror are
  -- write-frozen. A positive playing row without one live seat, or two live
  -- seats claiming one player, has no non-arbitrary chip source and therefore
  -- aborts the cutover instead of being guessed. A seatless zero remains a
  -- legitimate rebuy/elimination candidate.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      LEFT JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
      LEFT JOIN public.table_seats s
        ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
     WHERE tp.status='playing'
       AND upper(COALESCE(t.status::text,''))='RUNNING'
       AND EXISTS (
         SELECT 1 FROM public.tables any_table
          WHERE any_table.tournament_id=tp.tournament_id)
     GROUP BY tp.id,tp.chips
    HAVING count(s.id)>1 OR (COALESCE(tp.chips,0)>0 AND count(s.id)<>1)
  ) THEN
    RAISE EXCEPTION
      'live tournament chip cutover found an ambiguous or missing positive seat'
      USING ERRCODE='P0404';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
      JOIN public.table_seats s
        ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
     WHERE tp.status='playing'
       AND upper(COALESCE(t.status::text,''))='RUNNING'
       AND (s.stack IS NULL OR s.stack<0 OR s.stack<>trunc(s.stack))
  ) THEN
    RAISE EXCEPTION
      'live tournament chip cutover found a negative or fractional seat stack'
      USING ERRCODE='P0404';
  END IF;

  WITH exact_live AS (
    SELECT tp.id AS roster_id,s.stack::integer AS chips
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
      JOIN public.table_seats s
        ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
     WHERE tp.status='playing'
       AND upper(COALESCE(t.status::text,''))='RUNNING'
  ), repaired AS (
    UPDATE public.tournament_players tp
       SET chips=live.chips
      FROM exact_live live
     WHERE tp.id=live.roster_id
       AND tp.chips IS DISTINCT FROM live.chips
    RETURNING tp.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_chip_roster_ids FROM repaired;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
      JOIN public.table_seats s
        ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
     WHERE tp.status='playing'
       AND upper(COALESCE(t.status::text,''))='RUNNING'
       AND tp.chips IS DISTINCT FROM s.stack::integer
  ) THEN
    RAISE EXCEPTION 'live tournament chip cutover did not converge exactly'
      USING ERRCODE='P0404';
  END IF;

  WITH live_seat AS (
    SELECT s.user_id,tb.tournament_id,s.table_id,s.seat_number,
           row_number() OVER (
             PARTITION BY tb.tournament_id,s.user_id
             ORDER BY s.joined_at DESC NULLS LAST,s.id) AS rn
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL
  ), repaired AS (
    UPDATE public.tournament_players tp
       SET table_id=ls.table_id,seat_number=ls.seat_number
      FROM live_seat ls
     WHERE ls.rn=1
       AND tp.tournament_id=ls.tournament_id
       AND tp.user_id=ls.user_id
       AND tp.status IN ('registered','playing')
       AND (tp.table_id IS DISTINCT FROM ls.table_id
         OR tp.seat_number IS DISTINCT FROM ls.seat_number)
    RETURNING tp.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_roster_ids FROM repaired;

  WITH repaired AS (
    UPDATE public.tables tb
       SET stakes=trim_scale(tb.small_blind)::text||'/'||
                  trim_scale(tb.big_blind)::text,
           updated_at=now()
      FROM public.tournaments t
     WHERE t.id=tb.tournament_id
       AND upper(COALESCE(t.status::text,'')) IN
             ('RUNNING','REGISTERING','ANNOUNCED')
       AND tb.small_blind IS NOT NULL AND tb.big_blind IS NOT NULL
       AND tb.stakes IS DISTINCT FROM
           trim_scale(tb.small_blind)::text||'/'||
           trim_scale(tb.big_blind)::text
    RETURNING tb.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_stakes_table_ids FROM repaired;

  WITH seat_first AS (
    SELECT t.id
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status::text,'')) IN
             ('RUNNING','REGISTERING','ANNOUNCED')
       AND (lower(COALESCE(t.variant,'')) IN ('spin','sng')
         OR COALESCE(t.max_players,0)<=2)
  ), ranked AS (
    SELECT tb.id,
           (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id=tb.id AND s.left_at IS NULL) AS seats,
           public.fn_tournament_primary_table(tb.tournament_id) AS keep_id
      FROM public.tables tb
      JOIN seat_first sf ON sf.id=tb.tournament_id
     WHERE lower(COALESCE(tb.status,''))<>'closed'
  ), repaired AS (
    UPDATE public.tables tb
       SET status='closed',current_players=0,updated_at=now()
      FROM ranked r
     WHERE tb.id=r.id AND r.seats=0
       AND r.keep_id IS NOT NULL AND r.keep_id<>r.id
    RETURNING tb.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_duplicate_table_ids FROM repaired;

  WITH truth AS (
    SELECT t.id,
           (lower(COALESCE(t.variant,'')) IN ('spin','sng')
             OR COALESCE(t.max_players,0)<=2) AS is_seat_first,
           public.fn_tournament_primary_table(t.id) AS primary_table,
           CASE
             WHEN lower(COALESCE(t.variant,'')) IN ('spin','sng')
                  OR COALESCE(t.max_players,0)<=2 THEN (
               SELECT count(*) FROM public.table_seats s
                WHERE s.table_id=public.fn_tournament_primary_table(t.id)
                  AND s.left_at IS NULL)
             ELSE (
               SELECT count(*) FROM public.tournament_players tp
                WHERE tp.tournament_id=t.id
                  AND tp.status IN ('registered','playing'))
           END AS real_count
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status::text,'')) IN
             ('RUNNING','REGISTERING','ANNOUNCED')
  ), repaired AS (
    UPDATE public.tournaments t
       SET current_players=truth.real_count,updated_at=now()
      FROM truth
     WHERE t.id=truth.id
       AND NOT (truth.is_seat_first AND truth.primary_table IS NULL)
       AND COALESCE(t.current_players,-1) IS DISTINCT FROM truth.real_count
    RETURNING t.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_player_count_tournament_ids FROM repaired;

  IF EXISTS (
    SELECT 1 FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
    JOIN public.tournaments t ON t.id=tb.tournament_id
    WHERE s.left_at IS NULL
      AND upper(COALESCE(t.status::text,'')) IN
            ('COMPLETED','CANCELLED','CANCELED'))
     OR EXISTS (
    SELECT 1 FROM public.tables tb
    JOIN public.tournaments t ON t.id=tb.tournament_id
    WHERE upper(COALESCE(t.status::text,'')) IN
            ('COMPLETED','CANCELLED','CANCELED')
      AND (lower(COALESCE(tb.status,''))<>'closed'
        OR tb.current_players IS DISTINCT FROM 0)) THEN
    RAISE EXCEPTION 'terminal table and seat backlog did not close exactly'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_seat_exit_authority_cutover(
    authority,migration_version,installed_at,
    repaired_seat_count,repaired_seat_ids,
    repaired_table_count,repaired_table_ids,
    repaired_roster_count,repaired_roster_ids,
    repaired_chip_count,repaired_chip_roster_ids,
    repaired_stakes_count,repaired_stakes_table_ids,
    closed_duplicate_table_count,closed_duplicate_table_ids,
    repaired_player_count_count,repaired_player_count_tournament_ids)
  VALUES(
    'tournament_seat_exit_authority:v1','20260909014545',
    transaction_timestamp(),cardinality(v_seat_ids),v_seat_ids,
    cardinality(v_table_ids),v_table_ids,
    cardinality(v_roster_ids),v_roster_ids,
    cardinality(v_chip_roster_ids),v_chip_roster_ids,
    cardinality(v_stakes_table_ids),v_stakes_table_ids,
    cardinality(v_duplicate_table_ids),v_duplicate_table_ids,
    cardinality(v_player_count_tournament_ids),
    v_player_count_tournament_ids);
END;
$terminal_orphan_cutover$;

CREATE TABLE public.tournament_seat_exit_authorizations (
  token uuid NOT NULL,
  seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN (
    'unregister','cancel','satellite_finish','terminal_finish','move',
    'elimination','hand_settlement')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (token,seat_id),
  UNIQUE (token,tournament_id,user_id,seat_id,operation)
);

ALTER TABLE public.tournament_seat_exit_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_seat_exit_authorizations
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.tournament_seat_move_receipts (
  request_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  source_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  destination_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  source_seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  destination_seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  source_seat_number integer NOT NULL CHECK (source_seat_number BETWEEN 1 AND 10),
  destination_seat_number integer NOT NULL CHECK (destination_seat_number BETWEEN 1 AND 10),
  stack numeric NOT NULL CHECK (
    stack::text NOT IN ('NaN','Infinity','-Infinity') AND stack > 0),
  moved_at timestamptz NOT NULL,
  CHECK (source_table_id <> destination_table_id),
  CHECK (source_seat_id <> destination_seat_id),
  UNIQUE (tournament_id,user_id,request_id)
);

ALTER TABLE public.tournament_seat_move_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_seat_move_receipts
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_seat_move_receipts_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $move_receipt_immutable$
BEGIN
  RAISE EXCEPTION 'tournament seat move receipts are append-only'
    USING ERRCODE='55000';
END;
$move_receipt_immutable$;

REVOKE ALL ON FUNCTION public.fn_tournament_seat_move_receipts_append_only()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER tournament_seat_move_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_seat_move_receipts
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_seat_move_receipts_append_only();

-- Open one unforgeable, transaction-local capability. The relation is owner
-- only and the trigger requires both its row and the matching GUC, so neither
-- a browser nor a service query can manufacture seat-exit authority.
CREATE OR REPLACE FUNCTION public.fn_ca_open_tournament_seat_exit_authority(
  p_tournament_id uuid,
  p_operation text,
  p_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $open_seat_exit_authority$
DECLARE
  v_token uuid:=gen_random_uuid();
BEGIN
  IF p_tournament_id IS NULL
     OR p_operation NOT IN (
       'unregister','cancel','satellite_finish','terminal_finish','move',
       'elimination') THEN
    RAISE EXCEPTION 'invalid tournament seat-exit authority scope'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;

  -- Deterministic seat order matches hand settlement and terminal close.
  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id
   FOR UPDATE OF s;

  INSERT INTO public.tournament_seat_exit_authorizations(
    token,seat_id,tournament_id,user_id,operation)
  SELECT v_token,s.id,p_tournament_id,s.user_id,p_operation
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND s.user_id IS NOT NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id;

  PERFORM set_config('app.tournament_seat_exit_token',v_token::text,true);
  PERFORM set_config('app.tournament_seat_exit_operation',p_operation,true);
  RETURN v_token;
END;
$open_seat_exit_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_open_tournament_seat_exit_authority(
  uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Hand settlement already owns its exact lease, parent, table, roster and
-- seat lock order before the stack core writes anything. Its capability
-- opener must therefore neither reacquire the global terminal advisory lock
-- nor upgrade the parent row out of order. It authorizes only the exact
-- zero-candidate users at this table; any missing or duplicate live seat
-- refuses the hand before the core can mutate a stack.
CREATE OR REPLACE FUNCTION
  public.fn_ca_open_tournament_hand_seat_exit_authority(
    p_tournament_id uuid,
    p_table_id uuid,
    p_user_ids uuid[]
  )
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $open_hand_seat_exit_authority$
DECLARE
  v_token uuid:=gen_random_uuid();
  v_expected integer;
  v_inserted integer;
BEGIN
  v_expected:=COALESCE(cardinality(p_user_ids),0);
  IF p_tournament_id IS NULL OR p_table_id IS NULL OR v_expected=0
     OR array_position(p_user_ids,NULL) IS NOT NULL
     OR (SELECT count(DISTINCT u) FROM unnest(p_user_ids) u)<>v_expected
     OR NOT EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id) THEN
    RAISE EXCEPTION 'invalid accepted-hand seat-exit authority scope'
      USING ERRCODE='22023';
  END IF;

  INSERT INTO public.tournament_seat_exit_authorizations(
    token,seat_id,tournament_id,user_id,operation)
  SELECT v_token,s.id,p_tournament_id,s.user_id,'hand_settlement'
    FROM public.table_seats s
   WHERE s.table_id=p_table_id
     AND s.left_at IS NULL
     AND s.user_id=ANY(p_user_ids)
   ORDER BY s.id;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted<>v_expected THEN
    RAISE EXCEPTION
      'accepted-hand seat-exit authority expected % live seat(s), found %',
      v_expected,v_inserted USING ERRCODE='P0404';
  END IF;

  PERFORM set_config('app.tournament_seat_exit_token',v_token::text,true);
  PERFORM set_config('app.tournament_seat_exit_operation','hand_settlement',true);
  RETURN v_token;
END;
$open_hand_seat_exit_authority$;

REVOKE ALL ON FUNCTION
  public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])
  FROM PUBLIC,anon,authenticated,service_role;

-- A zero-stack hand is durable work for the tournament manager. Extend the
-- existing level-triggered outbox before the accepted-hand wrapper can emit
-- the new reason. The wake row is written by the same database transaction as
-- the hand, stack mirror, and seat exit: a later failure rolls all of them
-- back, while a replay cannot advance the wake generation a second time.
ALTER TABLE public.tournament_manager_wakes
  DROP CONSTRAINT tournament_manager_wakes_reason_check;
ALTER TABLE public.tournament_manager_wakes
  ADD CONSTRAINT tournament_manager_wakes_reason_check
  CHECK (reason IN (
    'rebuy','reentry','addon','late_registration','deal_vote',
    'bounty_settled','accepted_hand_bust'));

CREATE OR REPLACE FUNCTION public.fn_emit_tournament_manager_wake(
  p_tournament_id uuid,
  p_reason text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $manager_wake_with_accepted_hand_bust$
DECLARE
  v_id bigint;
  v_status text;
BEGIN
  IF p_reason NOT IN (
    'rebuy','reentry','addon','late_registration','deal_vote',
    'bounty_settled','accepted_hand_bust'
  ) THEN
    RAISE EXCEPTION 'invalid tournament manager wake reason';
  END IF;

  SELECT upper(COALESCE(t.status,''))
    INTO v_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.tournament_manager_wakes AS pending(
    tournament_id,reason,generation)
  VALUES (p_tournament_id,p_reason,1)
  ON CONFLICT (tournament_id,reason) WHERE consumed_at IS NULL
  DO UPDATE SET
    generation=pending.generation+1,
    created_at=clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$manager_wake_with_accepted_hand_bust$;

REVOKE ALL ON FUNCTION public.fn_emit_tournament_manager_wake(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_emit_tournament_manager_wake(uuid,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  p_token uuid,
  p_require_consumed boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $close_seat_exit_authority$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  DELETE FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  PERFORM set_config('app.tournament_seat_exit_token','',true);
  PERFORM set_config('app.tournament_seat_exit_operation','',true);
  IF COALESCE(p_require_consumed,true) AND v_remaining<>0 THEN
    RAISE EXCEPTION
      'tournament seat-exit authority left % live seat(s) unconsumed',v_remaining
      USING ERRCODE='P0404';
  END IF;
  RETURN v_remaining;
END;
$close_seat_exit_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_live_seat_exit_requires_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $seat_exit_guard$
DECLARE
  v_tournament_id uuid;
  v_token uuid;
  v_operation text:=COALESCE(
    current_setting('app.tournament_seat_exit_operation',true),'');
  v_authorized integer;
  v_exit boolean:=false;
BEGIN
  IF OLD.left_at IS NOT NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='DELETE' THEN
    v_exit:=true;
  ELSE
    v_exit:=NEW.left_at IS NOT NULL
      OR lower(COALESCE(NEW.status,''))='left'
      OR NEW.table_id IS DISTINCT FROM OLD.table_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.seat_number IS DISTINCT FROM OLD.seat_number;
  END IF;
  IF NOT v_exit THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id
    INTO v_tournament_id
    FROM public.tables tb
   WHERE tb.id=OLD.table_id;
  IF v_tournament_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  BEGIN
    v_token:=NULLIF(
      current_setting('app.tournament_seat_exit_token',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_token:=NULL;
  END;
  IF v_token IS NULL OR v_operation='' THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;

  DELETE FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=v_token
     AND a.seat_id=OLD.id
     AND a.tournament_id=v_tournament_id
     AND a.user_id=OLD.user_id
     AND a.operation=v_operation;
  GET DIAGNOSTICS v_authorized=ROW_COUNT;
  IF v_authorized<>1 THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$seat_exit_guard$;

REVOKE ALL ON FUNCTION public.fn_tournament_live_seat_exit_requires_authority()
  FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS zy_tournament_live_seat_exit_requires_authority
  ON public.table_seats;
CREATE TRIGGER zy_tournament_live_seat_exit_requires_authority
  BEFORE DELETE OR UPDATE OF table_id,user_id,seat_number,left_at,status
  ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_live_seat_exit_requires_authority();

-- Preserve the complete accepted-stack implementation behind an owner-only
-- name. The recreated canonical helper is also owner-only; it exists solely
-- so the already lease-fenced 12-argument hand transaction can mint and
-- consume an exact one-use seat capability around zero-stack vacates.
DO $rename_hand_stack_core$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)')
       IS NULL THEN
    IF to_regprocedure(
         'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)')
         IS NULL THEN
      RAISE EXCEPTION 'accepted-hand stack implementation is missing';
    END IF;
    ALTER FUNCTION public.fn_ca_settle_hand_stacks_absolute(
      uuid,bigint,jsonb,numeric,numeric,text,numeric)
      RENAME TO fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority;
  END IF;
END;
$rename_hand_stack_core$;

REVOKE ALL ON FUNCTION
  public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(
    uuid,bigint,jsonb,numeric,numeric,text,numeric)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb DEFAULT '[]'::jsonb,
  p_rake numeric DEFAULT NULL::numeric,
  p_bbj numeric DEFAULT NULL::numeric,
  p_ref text DEFAULT NULL::text,
  p_inflow numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $accepted_hand_stack_with_seat_authority$
DECLARE
  v_tournament_id uuid;
  v_zero_user_ids uuid[]:=ARRAY[]::uuid[];
  v_token uuid;
  v_opened integer:=0;
  v_remaining integer:=0;
  v_consumed integer:=0;
  v_result jsonb;
  v_expected_vacated integer;
  v_hand uuid;
  v_succeeded_receipt boolean:=false;
BEGIN
  -- Parse only an entirely well-shaped roster. Malformed input is passed to
  -- the preserved core unchanged so its canonical refusal remains the one
  -- semantic result and no capability is opened for a partial interpretation.
  IF jsonb_typeof(p_stacks)='array'
     AND jsonb_array_length(p_stacks)>0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) x
        WHERE jsonb_typeof(x)<>'object'
           OR jsonb_typeof(x->'user_id')<>'string'
           OR COALESCE(x->>'user_id','') !~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(x->'stack')<>'number')
     AND (SELECT count(DISTINCT x->>'user_id')
            FROM jsonb_array_elements(p_stacks) x)
           = jsonb_array_length(p_stacks) THEN
    SELECT tb.tournament_id INTO v_tournament_id
      FROM public.tables tb WHERE tb.id=p_table_id;
    IF v_tournament_id IS NOT NULL THEN
      SELECT COALESCE(
               array_agg(DISTINCT (x->>'user_id')::uuid
                         ORDER BY (x->>'user_id')::uuid),
               ARRAY[]::uuid[])
        INTO v_zero_user_ids
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x->>'stack')::numeric=0;
    END IF;
  END IF;

  IF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
    v_hand:=md5(
      'ca-hand:'||p_table_id::text||':'||p_hand_number::text||
      CASE WHEN p_ref IS NULL OR p_ref='' THEN '' ELSE ':'||p_ref END
    )::uuid;
    SELECT EXISTS (
      SELECT 1 FROM public.settlement_idempotency_keys k
       WHERE k.table_id=p_table_id AND k.hand_id=v_hand
         AND k.status='succeeded')
      INTO v_succeeded_receipt;
  END IF;

  -- A successful replay has already consumed and closed every zero seat. Do
  -- not weaken the fresh path to accommodate it: skip opening, then let the
  -- preserved core validate the complete request identity and return replay.
  IF cardinality(v_zero_user_ids)>0 AND NOT v_succeeded_receipt THEN
    v_token:=public.fn_ca_open_tournament_hand_seat_exit_authority(
      v_tournament_id,p_table_id,v_zero_user_ids);
    SELECT count(*) INTO v_opened
      FROM public.tournament_seat_exit_authorizations a
     WHERE a.token=v_token AND a.operation='hand_settlement';
  END IF;

  BEGIN
    v_result:=public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(
      p_table_id,p_hand_number,p_stacks,p_rake,p_bbj,p_ref,p_inflow);

    IF v_token IS NOT NULL THEN
      v_remaining:=public.fn_ca_close_tournament_seat_exit_authority(
        v_token,false);
      v_consumed:=v_opened-v_remaining;
      IF COALESCE((v_result->>'success')::boolean,false)
         AND NOT COALESCE((v_result->>'replay')::boolean,false) THEN
        BEGIN
          v_expected_vacated:=
            (v_result->>'tournament_zero_stack_seat_count')::integer;
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION
            'accepted-hand stack result omitted its seat-exit receipt'
            USING ERRCODE='P0404';
        END;
        IF v_expected_vacated IS NULL
           OR v_expected_vacated<>v_consumed THEN
          RAISE EXCEPTION
            'accepted-hand consumed % seat capability row(s), receipt named %',
            v_consumed,v_expected_vacated USING ERRCODE='P0404';
        END IF;
        IF v_expected_vacated>0 THEN
          PERFORM public.fn_emit_tournament_manager_wake(
            v_tournament_id,'accepted_hand_bust');
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    IF v_token IS NOT NULL THEN
      PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    END IF;
    RAISE;
  END;

  RETURN v_result;
END;
$accepted_hand_stack_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric)
  FROM PUBLIC,anon,authenticated,service_role;

-- The accepted-hand, rebuy, registration and move transactions now write both
-- seat and roster together. Retire the two-statement snapshot reconciler after
-- its exact one-time repair above; leaving either half callable would permit a
-- stale snapshot to overwrite a newer accepted-hand mirror.
DO $legacy_chip_sync_preflight$
DECLARE
  v_live oid:=to_regprocedure(
    'public.fn_sync_tournament_live_seat_chips(uuid)');
  v_lower oid:=to_regprocedure(
    'public.fn_sync_tournament_chips(uuid,jsonb)');
BEGIN
  IF v_live IS NULL OR v_lower IS NULL THEN
    RAISE EXCEPTION 'legacy tournament chip reconciler shape changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.oid<>v_live
       AND p.prosrc LIKE '%fn_sync_tournament_chips%') THEN
    RAISE EXCEPTION
      'an unexpected persistent function still calls the legacy chip writer';
  END IF;
END;
$legacy_chip_sync_preflight$;

DROP FUNCTION public.fn_sync_tournament_live_seat_chips(uuid) RESTRICT;
DROP FUNCTION public.fn_sync_tournament_chips(uuid,jsonb) RESTRICT;

-- Preserve the large, already-probed entitlement refund core byte-for-byte.
-- The new wrapper owns only the seat-exit capability around that transaction.
DO $rename_unregister_core$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)')
       IS NULL THEN
    IF to_regprocedure(
       'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)')
       IS NULL THEN
      RAISE EXCEPTION 'exact tournament unregistration authority is missing';
    END IF;
    ALTER FUNCTION public.fn_ca_unregister_tournament_player_exact(
      uuid,uuid,uuid,text,uuid)
      RENAME TO fn_ca_unregister_tournament_player_exact_pre_seat_guard;
  END IF;
END;
$rename_unregister_core$;

REVOKE ALL ON FUNCTION
  public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(
    uuid,uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_table_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $unregister_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_live_seats integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT count(*) INTO v_live_seats
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_seats>1 THEN
    RAISE EXCEPTION
      'tournament player % has % live seats; exact unregistration refuses ambiguous chips',
      p_user_id,v_live_seats USING ERRCODE='P0404';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'unregister',p_user_id);
  BEGIN
    v_result:=public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(
      p_tournament_id,p_user_id,p_expected_table_id,p_description,p_request_id);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$unregister_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_unregister_tournament_player_exact(
  uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Terminal owners get the same capability wrapper. Money, ranking, tickets,
-- roster status, felt closure and the immutable receipt still live in each
-- existing core and therefore still commit or roll back together.
DO $rename_terminal_cores$
BEGIN
  IF to_regprocedure(
       'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.atomic_cancel_tournament(uuid,uuid)
      RENAME TO atomic_cancel_tournament_pre_seat_guard;
  END IF;
  IF to_regprocedure(
       'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
      RENAME TO fn_settle_satellite_tournament_pre_seat_guard;
  END IF;
  IF to_regprocedure(
       'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)') IS NULL THEN
    ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
      RENAME TO fn_complete_tournament_terminal_pre_seat_guard;
  END IF;
END;
$rename_terminal_cores$;

REVOKE ALL ON FUNCTION public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(
  p_tournament_id uuid,p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions','pg_temp'
SET statement_timeout TO '120s'
AS $cancel_with_seat_authority$
DECLARE
  v_uid uuid:=auth.uid();
  v_managed_close_owned boolean:=false;
  v_token uuid;
  v_result jsonb;
BEGIN
  -- The authenticated managed-game gateway inserts this exact processing
  -- receipt in the same transaction before its private close function reaches
  -- us. An uncommitted receipt from another backend is invisible, so this is
  -- a transaction-bound capability rather than a caller-controlled flag.
  v_managed_close_owned:=
    COALESCE(current_setting('app.managed_game_lifecycle',true),'')='on'
    AND v_uid IS NOT NULL
    AND p_admin_id IS NOT DISTINCT FROM v_uid
    AND EXISTS (
      SELECT 1 FROM public.managed_game_command_receipts r
       WHERE r.actor_id=v_uid
         AND r.game_kind='tournament'
         AND r.game_id=p_tournament_id
         AND r.command_action='close'
         AND r.status='processing');
  IF NOT public.fn_caller_is_engine()
     AND NOT v_managed_close_owned THEN
    RAISE EXCEPTION 'atomic_cancel_tournament requires service authority'
      USING ERRCODE='28000';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'cancel',NULL);
  BEGIN
    v_result:=public.atomic_cancel_tournament_pre_seat_guard(
      p_tournament_id,p_admin_id);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'success')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$cancel_with_seat_authority$;

REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(
  p_tournament_id uuid,p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $satellite_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'satellite settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'satellite_finish',NULL);
  BEGIN
    v_result:=public.fn_settle_satellite_tournament_pre_seat_guard(
      p_tournament_id,p_observed_winner_id);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$satellite_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(
  p_tournament_id uuid,p_observed_winner_id uuid,p_settlement_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '45s'
AS $terminal_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'terminal settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'terminal_finish',NULL);
  BEGIN
    v_result:=public.fn_complete_tournament_terminal_pre_seat_guard(
      p_tournament_id,p_observed_winner_id,p_settlement_mode);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$terminal_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  TO service_role;

-- Elimination is a terminal transition for one seat, not a free-standing
-- cleanup. The rolling-window implementations first CAS the roster row to
-- eliminated and then release the exact zero-stack seat. That valid sequence
-- cannot use the RUNNING/playing state proof above after its roster CAS, so
-- preserve each audited implementation byte-for-byte behind an owner-only
-- name and put the same scoped capability around both public engine roots.
DO $rename_elimination_cores$
BEGIN
  IF to_regprocedure(
       'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)')
       IS NULL THEN
    ALTER FUNCTION public.fn_eliminate_tournament_player_atomic(
      uuid,uuid,integer,numeric,numeric)
      RENAME TO fn_eliminate_tournament_player_atomic_pre_seat_guard;
  END IF;
  IF to_regprocedure(
       'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)')
       IS NULL THEN
    ALTER FUNCTION public.fn_claim_tournament_bounty_elimination(
      uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
      RENAME TO fn_claim_tournament_bounty_elimination_pre_seat_guard;
  END IF;
END;
$rename_elimination_cores$;

REVOKE ALL ON FUNCTION
  public.fn_eliminate_tournament_player_atomic_pre_seat_guard(
    uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_claim_tournament_bounty_elimination_pre_seat_guard(
    uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_bubble_refund numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $elimination_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_live_seats integer;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'tournament elimination requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.fn_eliminate_tournament_player_atomic_pre_seat_guard(
      p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.fn_eliminate_tournament_player_atomic_pre_seat_guard(
      p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  END IF;
  SELECT count(*) INTO v_live_seats
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_seats>1 THEN
    RAISE EXCEPTION
      'tournament elimination refuses % live seats for one player',v_live_seats
      USING ERRCODE='P0404';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'elimination',p_user_id);
  BEGIN
    v_result:=public.fn_eliminate_tournament_player_atomic_pre_seat_guard(
      p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$elimination_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid,uuid,integer,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid,uuid,integer,numeric,numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_claim_tournament_bounty_elimination(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_table_id uuid,
  p_hand_id uuid,
  p_hand_number bigint,
  p_seat_joined_at timestamptz,
  p_knocker_user_id uuid,
  p_claimants jsonb,
  p_bubble_refund numeric DEFAULT 0,
  p_allow_existing_eliminated boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $bounty_elimination_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_live_seats integer;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'tournament bounty elimination requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.fn_claim_tournament_bounty_elimination_pre_seat_guard(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.fn_claim_tournament_bounty_elimination_pre_seat_guard(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;
  SELECT count(*) INTO v_live_seats
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL;
  IF v_live_seats>1 THEN
    RAISE EXCEPTION
      'tournament bounty elimination refuses % live seats for one player',
      v_live_seats USING ERRCODE='P0404';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'elimination',p_eliminated_user_id);
  BEGIN
    v_result:=public.fn_claim_tournament_bounty_elimination_pre_seat_guard(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$bounty_elimination_with_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_tournament_bounty_elimination(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  TO service_role;

-- A table-stack cashout can never be a tournament seat-exit API. Preserve the
-- latest cash implementation behind a wrapper and refuse tournament parents
-- before any credit, idempotency row, session close or seat mutation.
DO $rename_cashout_core$
BEGIN
  IF to_regprocedure(
       'public.atomic_seat_cashout_locked_pre_tournament_guard(uuid,uuid,integer,text)')
       IS NULL THEN
    ALTER FUNCTION public.atomic_seat_cashout_locked(uuid,uuid,integer,text)
      RENAME TO atomic_seat_cashout_locked_pre_tournament_guard;
  END IF;
END;
$rename_cashout_core$;

REVOKE ALL ON FUNCTION
  public.atomic_seat_cashout_locked_pre_tournament_guard(
    uuid,uuid,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(
  p_user_id uuid,p_table_id uuid,p_seat_number integer DEFAULT NULL,
  p_leave_mode text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $cashout_not_tournament$
DECLARE
  v_tournament_id uuid;
BEGIN
  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE='22023';
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  RETURN public.atomic_seat_cashout_locked_pre_tournament_guard(
    p_user_id,p_table_id,p_seat_number,p_leave_mode);
END;
$cashout_not_tournament$;

REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(
  uuid,uuid,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(
  uuid,uuid,integer,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_admin_kick_player(
  p_table_id uuid,p_user_id uuid,p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $cash_admin_kick$
DECLARE
  v_uid uuid:=auth.uid();
  v_club uuid;
  v_tournament_id uuid;
  v_seat_number integer;
  v_seat_id uuid;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_admin_kick_player requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  SELECT tb.club_id,tb.tournament_id INTO v_club,v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','table_not_found');
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  IF NOT public.fn_can_create_games(v_club,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  SELECT s.id,s.seat_number INTO v_seat_id,v_seat_number
    FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_user_id
     AND s.left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_seated');
  END IF;
  PERFORM set_config('app.cash_exit_authority','club_admin',true);
  PERFORM public.fn_ca_declare_ledger('table_cashout','table_stack',p_table_id);
  BEGIN
    v_result:=public.atomic_seat_cashout_locked(
      p_user_id,p_table_id,v_seat_number,'forced');
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_exit_authority','',true);
    RAISE;
  END;
  PERFORM set_config('app.cash_exit_authority','',true);
  IF COALESCE(v_result->>'reason','')='no_active_seat' THEN
    RETURN jsonb_build_object('ok',false,'reason','not_seated');
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'refunded',COALESCE((v_result->>'stack')::numeric,0),
    'seat_id',v_seat_id,'reason_text',p_reason);
END;
$cash_admin_kick$;

REVOKE ALL ON FUNCTION public.fn_admin_kick_player(uuid,uuid,text)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_admin_kick_player(uuid,uuid,text)
  TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_clear_table_seats(
  p_table_id uuid,p_reopen boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cash_clear_seats$
DECLARE
  v_tournament_id uuid;
  v_cleared integer:=0;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_clear_table_seats requires service authority'
      USING ERRCODE='28000';
  END IF;
  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  PERFORM public.fn_cashout_seats_for_closing_table(p_table_id,'seats cleared');
  UPDATE public.table_seats
     SET left_at=now(),is_sitting_out=false
   WHERE table_id=p_table_id AND left_at IS NULL;
  GET DIAGNOSTICS v_cleared=ROW_COUNT;
  UPDATE public.tables
     SET current_players=0,
         status=CASE WHEN p_reopen AND status<>'closed' THEN 'waiting' ELSE status END
   WHERE id=p_table_id;
  RETURN v_cleared;
END;
$cash_clear_seats$;

REVOKE ALL ON FUNCTION public.fn_clear_table_seats(uuid,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_clear_table_seats(uuid,boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.force_close_table_and_refund(
  p_table_id uuid,p_actor_id uuid DEFAULT NULL,p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cash_force_close$
DECLARE
  v_result jsonb;
  v_total numeric:=0;
  v_count integer:=0;
  v_actor uuid;
  v_tournament_id uuid;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'force_close_table_and_refund requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','p_table_id required');
  END IF;
  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'error','table_not_found');
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  v_actor:=COALESCE(
    p_actor_id,auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_result:=public.fn_cashout_seats_for_closing_table(
    p_table_id,'force-closed by admin'||COALESCE(' - '||p_reason,''));
  IF COALESCE(v_result->>'ok','false')<>'true' THEN
    RETURN jsonb_build_object('success',false,'error',v_result->>'reason');
  END IF;
  v_count:=COALESCE((v_result->>'players_paid')::integer,0);
  v_total:=COALESCE((v_result->>'chips_returned')::numeric,0);
  UPDATE public.table_seats SET left_at=now()
   WHERE table_id=p_table_id AND left_at IS NULL;
  UPDATE public.tables SET status='closed',current_players=0
   WHERE id=p_table_id;
  INSERT INTO public.audit_trail(
    actor_id,actor_role,action,target_type,target_id,amount,reason)
  VALUES(v_actor,'platform_admin','force_close_table','table',
    p_table_id,v_total,p_reason);
  RETURN jsonb_build_object(
    'success',true,'players_refunded',v_count,'total_refunded',v_total);
END;
$cash_force_close$;

REVOKE ALL ON FUNCTION public.force_close_table_and_refund(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.force_close_table_and_refund(uuid,uuid,text)
  TO service_role;

DO $rename_player_leave_core$
BEGIN
  IF to_regprocedure(
       'public.player_leave_table_pre_tournament_guard(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.player_leave_table(uuid,uuid)
      RENAME TO player_leave_table_pre_tournament_guard;
  END IF;
END;
$rename_player_leave_core$;

REVOKE ALL ON FUNCTION public.player_leave_table_pre_tournament_guard(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.player_leave_table(
  p_table_id uuid,p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $cash_player_leave$
DECLARE
  v_tournament_id uuid;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'player_leave_table requires service authority'
      USING ERRCODE='28000';
  END IF;
  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id=p_table_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY'
      USING ERRCODE='55000';
  END IF;
  PERFORM public.player_leave_table_pre_tournament_guard(p_table_id,p_user_id);
END;
$cash_player_leave$;

REVOKE ALL ON FUNCTION public.player_leave_table(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.player_leave_table(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_seat_move_receipt(
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $move_receipt$
  SELECT jsonb_build_object(
    'ok',true,
    'request_id',r.request_id,
    'tournament_id',r.tournament_id,
    'user_id',r.user_id,
    'source_table_id',r.source_table_id,
    'destination_table_id',r.destination_table_id,
    'source_seat_id',r.source_seat_id,
    'destination_seat_id',r.destination_seat_id,
    'source_seat_number',r.source_seat_number,
    'destination_seat_number',r.destination_seat_number,
    'stack',r.stack,
    'moved_at',r.moved_at)
  FROM public.tournament_seat_move_receipts r
  WHERE r.request_id=p_request_id;
$move_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_seat_move_receipt(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- The balancer now submits one operation identity to one transaction. Source
-- release, destination occupancy, roster coordinates, table counts and the
-- replay receipt are inseparable.
CREATE OR REPLACE FUNCTION public.fn_move_tournament_player(
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_destination_table_id uuid,
  p_destination_seat_number integer,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $atomic_tournament_move$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_tp public.tournament_players%ROWTYPE;
  v_source public.table_seats%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_destination_id uuid;
  v_token uuid;
  v_moved_at timestamptz;
  v_rows integer;
  v_live_count integer;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_move_tournament_player requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_request_id IS NULL OR p_source_table_id=p_destination_table_id
     OR p_destination_seat_number NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid tournament move identity' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('table_cap:'||p_user_id::text,0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NOT NULL THEN
    IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
       OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
       OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
       OR (v_result->>'destination_table_id')::uuid
            IS DISTINCT FROM p_destination_table_id
       OR (v_result->>'destination_seat_number')::integer
            IS DISTINCT FROM p_destination_seat_number THEN
      RAISE EXCEPTION 'tournament move request id belongs to another operation'
        USING ERRCODE='23505';
    END IF;
    RETURN v_result||jsonb_build_object('replayed',true);
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;
  IF upper(COALESCE(v_t.status,''))<>'RUNNING' THEN
    RAISE EXCEPTION 'tournament % is not RUNNING',p_tournament_id
      USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_tp FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_tp.status<>'playing'
     OR v_tp.table_id IS DISTINCT FROM p_source_table_id THEN
    RAISE EXCEPTION 'tournament move source roster is not exact'
      USING ERRCODE='P0404';
  END IF;

  PERFORM tb.id FROM public.tables tb
   WHERE tb.id IN (p_source_table_id,p_destination_table_id)
   ORDER BY tb.id FOR UPDATE;
  IF (SELECT count(*) FROM public.tables tb
       WHERE tb.id IN (p_source_table_id,p_destination_table_id)
         AND tb.tournament_id=p_tournament_id)<>2 THEN
    RAISE EXCEPTION 'tournament move tables do not share the event'
      USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_destination_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed'
         OR p_destination_seat_number>COALESCE(tb.max_players,9))) THEN
    RAISE EXCEPTION 'tournament move destination is not open'
      USING ERRCODE='55000';
  END IF;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL;
  IF v_live_count<>1 THEN
    RAISE EXCEPTION 'tournament move requires exactly one live source seat'
      USING ERRCODE='P0404';
  END IF;

  SELECT s.* INTO v_source FROM public.table_seats s
   WHERE s.table_id=p_source_table_id AND s.user_id=p_user_id
     AND s.left_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_source.seat_number IS DISTINCT FROM v_tp.seat_number
     OR v_source.stack IS NULL
     OR v_source.stack::text IN ('NaN','Infinity','-Infinity')
     OR v_source.stack<=0
     OR abs(v_source.stack-v_tp.chips::numeric)>0.5 THEN
    RAISE EXCEPTION 'tournament move source chips or coordinates are not exact'
      USING ERRCODE='P0404';
  END IF;

  SELECT s.* INTO v_destination FROM public.table_seats s
   WHERE s.table_id=p_destination_table_id
     AND s.seat_number=p_destination_seat_number FOR UPDATE;
  IF FOUND AND v_destination.left_at IS NULL THEN
    RAISE EXCEPTION 'tournament move destination seat is occupied'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.user_id<>p_user_id
       AND tp.status IN ('registered','playing')
       AND tp.table_id=p_destination_table_id
       AND tp.seat_number=p_destination_seat_number) THEN
    RAISE EXCEPTION 'tournament move destination roster is occupied'
      USING ERRCODE='23505';
  END IF;

  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'move',p_user_id);
  v_moved_at:=clock_timestamp();
  BEGIN
    UPDATE public.table_seats s
       SET stack=0,left_at=v_moved_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
     WHERE s.id=v_source.id AND s.left_at IS NULL
       AND s.stack=v_source.stack;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'tournament move lost its locked source seat'
        USING ERRCODE='40001';
    END IF;

    IF v_destination.id IS NULL THEN
      INSERT INTO public.table_seats(
        table_id,seat_number,user_id,player_id,member_id,stack,
        is_sitting_out,is_away,joined_at,horse_id,scheduled_leave_hands,
        left_at,status,leave_pending,auto_rebuy,time_bank_remaining,
        time_bank_uses_remaining,sit_out_at,entry_hold,entry_post_agreed)
      VALUES(
        p_destination_table_id,p_destination_seat_number,p_user_id,
        v_source.player_id,v_source.member_id,v_source.stack,
        false,false,v_moved_at,v_source.horse_id,NULL,NULL,'active',false,
        v_source.auto_rebuy,v_source.time_bank_remaining,
        v_source.time_bank_uses_remaining,NULL,NULL,
        v_source.entry_post_agreed)
      RETURNING id INTO v_destination_id;
    ELSE
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=v_source.player_id,
             member_id=v_source.member_id,stack=v_source.stack,
             is_sitting_out=false,is_away=false,joined_at=v_moved_at,
             horse_id=v_source.horse_id,scheduled_leave_hands=NULL,
             left_at=NULL,status='active',leave_pending=false,
             auto_rebuy=v_source.auto_rebuy,
             time_bank_remaining=v_source.time_bank_remaining,
             time_bank_uses_remaining=v_source.time_bank_uses_remaining,
             sit_out_at=NULL,entry_hold=NULL,
             entry_post_agreed=v_source.entry_post_agreed
       WHERE s.id=v_destination.id AND s.left_at IS NOT NULL
       RETURNING id INTO v_destination_id;
      IF v_destination_id IS NULL THEN
        RAISE EXCEPTION 'tournament move could not reuse destination seat'
          USING ERRCODE='40001';
      END IF;
    END IF;

    UPDATE public.tournament_players tp
       SET table_id=p_destination_table_id,
           seat_number=p_destination_seat_number
     WHERE tp.id=v_tp.id AND tp.status='playing'
       AND tp.table_id=p_source_table_id
       AND tp.seat_number=v_source.seat_number;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'tournament move lost its locked roster row'
        USING ERRCODE='40001';
    END IF;

    UPDATE public.tables tb
       SET current_players=(
         SELECT count(*) FROM public.table_seats s
          WHERE s.table_id=tb.id AND s.left_at IS NULL),
           updated_at=now()
     WHERE tb.id IN (p_source_table_id,p_destination_table_id);

    IF (SELECT count(*) FROM public.table_seats s
        JOIN public.tables tb ON tb.id=s.table_id
       WHERE tb.tournament_id=p_tournament_id
         AND s.user_id=p_user_id AND s.left_at IS NULL)<>1
       OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_destination_id
            AND s.table_id=p_destination_table_id
            AND s.seat_number=p_destination_seat_number
            AND s.user_id=p_user_id AND s.left_at IS NULL
            AND s.stack=v_source.stack)
       OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_source.id AND s.left_at=v_moved_at AND s.stack=0)
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.id=v_tp.id AND tp.status='playing'
            AND tp.table_id=p_destination_table_id
            AND tp.seat_number=p_destination_seat_number) THEN
      RAISE EXCEPTION 'tournament move final proof is not exact'
        USING ERRCODE='P0404';
    END IF;

    INSERT INTO public.tournament_seat_move_receipts(
      request_id,tournament_id,user_id,source_table_id,destination_table_id,
      source_seat_id,destination_seat_id,source_seat_number,
      destination_seat_number,stack,moved_at)
    VALUES(
      p_request_id,p_tournament_id,p_user_id,p_source_table_id,
      p_destination_table_id,v_source.id,v_destination_id,
      v_source.seat_number,p_destination_seat_number,v_source.stack,v_moved_at);

    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'tournament move receipt did not persist'
      USING ERRCODE='P0404';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',false);
END;
$atomic_tournament_move$;

REVOKE ALL ON FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid) TO service_role;

-- Unfilled Spins still expire, but cancellation itself owns every refund and
-- count. There is no post-cancel counter reconciler and no estimate presented
-- as money returned.
CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $expire_unfilled_without_reconciler$
DECLARE
  v_minutes integer;
  g record;
  v_result jsonb;
  v_expired integer:=0;
  v_failed integer:=0;
  v_refunded numeric:=0;
  v_ids jsonb:='[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_spin_expire_unfilled requires service authority'
      USING ERRCODE='28000';
  END IF;
  SELECT unfilled_timeout_minutes INTO v_minutes
    FROM public.spin_fill_policy LIMIT 1;
  v_minutes:=COALESCE(v_minutes,30);
  IF v_minutes<=0 THEN
    RETURN jsonb_build_object('ok',true,'disabled',true,'expired',0);
  END IF;
  FOR g IN
    SELECT t.id
      FROM public.tournaments t
     WHERE t.variant='spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND t.started_at IS NULL
       AND EXISTS (
         SELECT 1 FROM public.table_seats s
         JOIN public.tables tb ON tb.id=s.table_id
          WHERE tb.tournament_id=t.id AND s.left_at IS NULL
            AND s.joined_at<now()-make_interval(mins=>v_minutes))
       AND (SELECT count(*) FROM public.table_seats s
             JOIN public.tables tb ON tb.id=s.table_id
            WHERE tb.tournament_id=t.id AND s.left_at IS NULL)
           <COALESCE(t.max_players,3)
     ORDER BY t.created_at
     LIMIT GREATEST(COALESCE(p_limit,50),1)
  LOOP
    BEGIN
      v_result:=public.atomic_cancel_tournament(g.id,NULL);
      IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'atomic cancellation returned no success receipt';
      END IF;
      v_expired:=v_expired+1;
      v_refunded:=v_refunded+
        COALESCE((v_result->>'total_refunded')::numeric,0);
      v_ids:=v_ids||to_jsonb(g.id::text);
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      RAISE WARNING 'fn_spin_expire_unfilled: could not cancel %: %',g.id,SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object(
    'ok',v_failed=0,'expired',v_expired,'failed',v_failed,
    'chips_refunded',round(v_refunded,2),'timeout_minutes',v_minutes,
    'tournament_ids',v_ids);
END;
$expire_unfilled_without_reconciler$;

REVOKE ALL ON FUNCTION public.fn_spin_expire_unfilled(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_expire_unfilled(integer)
  TO service_role;

-- The minute denormal reconciler used to repair a newly opened late-
-- registration table's missing stakes. Write the display contract in the
-- same INSERT that creates the table instead. This is the complete installed
-- implementation, not a dynamic source rewrite; all existing behavior and
-- the private nested-call ACL remain explicit.
CREATE OR REPLACE FUNCTION
  public.fn_seat_late_registrant_before_maintenance_gate(
    p_tournament_id uuid,p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $late_seat_without_reconciler$
DECLARE
  v_status text;
  v_start_chips integer;
  v_club uuid;
  v_bonus integer;
  v_chips integer;
  v_table uuid;
  v_cap integer;
  v_seat integer;
  v_taken integer;
  v_opened boolean:=false;
  v_sb numeric;
  v_bb numeric;
  v_bs varchar;
  v_tclub uuid;
  v_tno integer;
BEGIN
  PERFORM set_config('app.money_path','fn_seat_late_registrant',true);
  SELECT status,COALESCE(starting_chips,0),club_id
    INTO v_status,v_start_chips,v_club
    FROM public.tournaments WHERE id=p_tournament_id;

  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','not_running');
  END IF;

  SELECT COALESCE(chips,0) INTO v_bonus
    FROM public.tournament_players
   WHERE tournament_id=p_tournament_id
     AND user_id=p_user_id
     AND table_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND s.user_id=p_user_id AND s.left_at IS NULL)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','already_seated_or_missing');
  END IF;

  v_chips:=v_start_chips+GREATEST(v_bonus,0);

  SELECT tb.id,COALESCE(tb.max_players,9)
    INTO v_table,v_cap
    FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id
     AND lower(COALESCE(tb.status,'')) IN ('waiting','running','active')
     AND (SELECT count(*) FROM public.table_seats s
           WHERE s.table_id=tb.id AND s.left_at IS NULL)
         <COALESCE(tb.max_players,9)
   ORDER BY (SELECT count(*) FROM public.table_seats s
              WHERE s.table_id=tb.id AND s.left_at IS NULL) DESC,
            tb.created_at ASC
   LIMIT 1
   FOR UPDATE OF tb;

  IF v_table IS NULL THEN
    SELECT COALESCE(tb.max_players,9),tb.small_blind,tb.big_blind,
           tb.blind_structure,COALESCE(tb.club_id,v_club)
      INTO v_cap,v_sb,v_bb,v_bs,v_tclub
      FROM public.tables tb
     WHERE tb.tournament_id=p_tournament_id
     ORDER BY tb.created_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
      SELECT COALESCE(t.table_size,9) INTO v_cap
        FROM public.tournaments t WHERE t.id=p_tournament_id;
      v_sb:=1;
      v_bb:=2;
      v_bs:='standard';
      v_tclub:=v_club;
    END IF;

    IF v_sb IS NULL OR v_bb IS NULL OR v_sb<=0 OR v_bb<v_sb THEN
      RAISE EXCEPTION 'late-registration table has invalid blind authority'
        USING ERRCODE='P0404';
    END IF;

    SELECT count(*)+1 INTO v_tno
      FROM public.tables WHERE tournament_id=p_tournament_id;

    INSERT INTO public.tables(
      name,tournament_id,club_id,max_players,small_blind,big_blind,
      stakes,blind_structure,status,current_players)
    VALUES(
      'Table '||v_tno,p_tournament_id,v_tclub,v_cap,v_sb,v_bb,
      trim_scale(v_sb)::text||'/'||trim_scale(v_bb)::text,
      COALESCE(v_bs,'standard'),'waiting',0)
    RETURNING id INTO v_table;
    v_opened:=true;
  END IF;

  SELECT g.n INTO v_seat
    FROM generate_series(1,v_cap) AS g(n)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats s
      WHERE s.table_id=v_table AND s.seat_number=g.n
        AND s.left_at IS NULL)
   ORDER BY g.n LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','no_open_seat');
  END IF;

  UPDATE public.table_seats
     SET user_id=p_user_id,stack=v_chips,left_at=NULL,joined_at=now(),
         is_sitting_out=false,is_away=false,
         club_id=COALESCE(club_id,v_club)
   WHERE table_id=v_table AND seat_number=v_seat AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats(
        table_id,user_id,seat_number,stack,club_id)
      VALUES(v_table,p_user_id,v_seat,v_chips,v_club);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok',false,'reason','seat_race');
    END;
  END IF;

  UPDATE public.tournament_players
     SET status='playing',chips=v_chips,table_id=v_table,
         seat_number=v_seat
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id;

  SELECT count(*) INTO v_taken
    FROM public.table_seats
   WHERE table_id=v_table AND left_at IS NULL;
  UPDATE public.tables SET current_players=v_taken WHERE id=v_table;

  RETURN jsonb_build_object(
    'ok',true,'table_id',v_table,'seat_number',v_seat,'chips',v_chips,
    'opened_table',v_opened);
END;
$late_seat_without_reconciler$;

REVOKE ALL ON FUNCTION
  public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- Table Management can also change blinds. Keep its complete current
-- implementation, but write stakes beside those blinds in the same UPDATE
-- and restore the intended private gateway ACL explicitly.
CREATE OR REPLACE FUNCTION public.fn_update_managed_game(
  p_kind text,p_game_id uuid,p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $managed_update_without_reconciler$
DECLARE
  v_uid uuid:=auth.uid();
  v_club uuid;
  v_players integer;
  v_status text;
  v_name text;
  v_sb numeric;
  v_bb numeric;
  v_min numeric;
  v_max numeric;
  v_seats integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;

  IF p_kind='table' THEN
    SELECT club_id,current_players,status
      INTO v_club,v_players,v_status
      FROM public.tables WHERE id=p_game_id FOR UPDATE;
  ELSIF p_kind='tournament' THEN
    SELECT club_id,current_players,status
      INTO v_club,v_players,v_status
      FROM public.tournaments WHERE id=p_game_id FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('ok',false,'reason','invalid_game_kind');
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;

  v_name:=left(regexp_replace(COALESCE(p_patch->>'name',''),'\s+',' ','g'),80);
  IF length(trim(v_name))=0 THEN
    RETURN jsonb_build_object('ok',false,'reason','name_required');
  END IF;

  IF p_kind='table' THEN
    IF v_players>0 OR lower(v_status) IN ('running','active') THEN
      UPDATE public.tables SET name=v_name,updated_at=now()
       WHERE id=p_game_id;
    ELSE
      SELECT COALESCE((p_patch->>'small_blind')::numeric,t.small_blind),
             COALESCE((p_patch->>'big_blind')::numeric,t.big_blind),
             COALESCE((p_patch->>'min_buy_in')::numeric,t.min_buy_in),
             COALESCE((p_patch->>'max_buy_in')::numeric,t.max_buy_in),
             COALESCE((p_patch->>'max_players')::integer,t.max_players)
        INTO v_sb,v_bb,v_min,v_max,v_seats
        FROM public.tables t WHERE t.id=p_game_id;

      IF v_sb IS NULL OR v_bb IS NULL OR v_min IS NULL OR v_max IS NULL
         OR v_seats IS NULL OR v_sb<=0 OR v_bb<v_sb OR v_min<=0
         OR v_max<v_min THEN
        RETURN jsonb_build_object('ok',false,'reason','invalid_table_limits');
      END IF;

      UPDATE public.tables
         SET name=v_name,small_blind=v_sb,big_blind=v_bb,
             stakes=trim_scale(v_sb)::text||'/'||trim_scale(v_bb)::text,
             min_buy_in=v_min,max_buy_in=v_max,
             max_players=LEAST(10,GREATEST(2,v_seats)),updated_at=now()
       WHERE id=p_game_id;
    END IF;
  ELSE
    PERFORM 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_game_id FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','players_registered');
    END IF;
    IF upper(v_status) NOT IN ('ANNOUNCED','REGISTERING','SCHEDULED') THEN
      RETURN jsonb_build_object('ok',false,'reason','already_started');
    END IF;

    UPDATE public.tournaments
       SET name=v_name,
           max_players=GREATEST(
             2,COALESCE((p_patch->>'max_players')::integer,max_players)),
           start_time=COALESCE(
             (p_patch->>'start_time')::timestamptz,start_time),
           updated_at=now()
     WHERE id=p_game_id;
  END IF;

  RETURN jsonb_build_object('ok',true);
END;
$managed_update_without_reconciler$;

REVOKE ALL ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb)
  TO service_role;

-- Fail closed unless the catalog still has exactly the audited watcher shape
-- and no executable dependency. The minute job is then unscheduled while its
-- catalog and advisory lock remain held, and both legacy mutators are dropped
-- with RESTRICT rather than hidden behind a revoke.
DO $legacy_reconciler_preflight$
DECLARE
  v_reconciler oid:=to_regprocedure(
    'public.fn_reconcile_tournament_denormals()');
  v_release oid:=to_regprocedure(
    'public.fn_release_seats_on_tournament_finish()');
  v_release_trigger oid;
  j record;
BEGIN
  SELECT tg.oid INTO v_release_trigger
    FROM pg_trigger tg
   WHERE tg.tgrelid='public.tournaments'::regclass
     AND tg.tgname='trg_release_seats_on_tournament_finish'
     AND NOT tg.tgisinternal
     AND tg.tgfoid=v_release
     AND tg.tgtype=17
     AND tg.tgenabled='O';
  IF v_reconciler IS NULL OR v_release IS NULL
     OR v_release_trigger IS NULL THEN
    RAISE EXCEPTION 'legacy tournament reconciler/watch trigger shape changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_depend d
     WHERE d.refclassid='pg_proc'::regclass
       AND d.refobjid=v_reconciler)
     OR EXISTS (
    SELECT 1 FROM pg_depend d
     WHERE d.refclassid='pg_proc'::regclass
       AND d.refobjid=v_release
       AND NOT (d.classid='pg_trigger'::regclass
            AND d.objid=v_release_trigger AND d.deptype='n')) THEN
    RAISE EXCEPTION 'unexpected catalog dependency on a retired reconciler';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.oid NOT IN (v_reconciler,v_release)
       AND (p.prosrc LIKE '%fn_reconcile_tournament_denormals(%'
         OR p.prosrc LIKE '%fn_release_seats_on_tournament_finish(%')) THEN
    RAISE EXCEPTION 'an executable function still calls a retired reconciler';
  END IF;

  FOR j IN
    SELECT jobid FROM cron.job
     WHERE jobname='reconcile-tournament-denormals'
        OR command LIKE '%fn_reconcile_tournament_denormals(%'
     ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname='reconcile-tournament-denormals'
        OR command LIKE '%fn_reconcile_tournament_denormals(%') THEN
    RAISE EXCEPTION 'tournament denormal reconciler cron survived unschedule';
  END IF;

  IF EXISTS (
    WITH live_seat AS (
      SELECT s.user_id,tb.tournament_id,s.table_id,s.seat_number,
             row_number() OVER (
               PARTITION BY tb.tournament_id,s.user_id
               ORDER BY s.joined_at DESC NULLS LAST,s.id) AS rn
        FROM public.table_seats s
        JOIN public.tables tb ON tb.id=s.table_id
       WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL)
    SELECT 1 FROM public.tournament_players tp
    JOIN live_seat ls ON ls.rn=1
      AND tp.tournament_id=ls.tournament_id AND tp.user_id=ls.user_id
     WHERE tp.status IN ('registered','playing')
       AND (tp.table_id IS DISTINCT FROM ls.table_id
         OR tp.seat_number IS DISTINCT FROM ls.seat_number))
     OR EXISTS (
    SELECT 1 FROM public.tables tb
    JOIN public.tournaments t ON t.id=tb.tournament_id
     WHERE upper(COALESCE(t.status::text,'')) IN
             ('RUNNING','REGISTERING','ANNOUNCED')
       AND tb.small_blind IS NOT NULL AND tb.big_blind IS NOT NULL
       AND tb.stakes IS DISTINCT FROM
           trim_scale(tb.small_blind)::text||'/'||
           trim_scale(tb.big_blind)::text) THEN
    RAISE EXCEPTION 'tournament denormal cutover left roster or stakes drift';
  END IF;

  IF EXISTS (
    WITH seat_first AS (
      SELECT t.id
        FROM public.tournaments t
       WHERE upper(COALESCE(t.status::text,'')) IN
               ('RUNNING','REGISTERING','ANNOUNCED')
         AND (lower(COALESCE(t.variant,'')) IN ('spin','sng')
           OR COALESCE(t.max_players,0)<=2)), ranked AS (
      SELECT tb.id,
             (SELECT count(*) FROM public.table_seats s
               WHERE s.table_id=tb.id AND s.left_at IS NULL) AS seats,
             public.fn_tournament_primary_table(tb.tournament_id) AS keep_id
        FROM public.tables tb
        JOIN seat_first sf ON sf.id=tb.tournament_id
       WHERE lower(COALESCE(tb.status,''))<>'closed')
    SELECT 1 FROM ranked
     WHERE seats=0 AND keep_id IS NOT NULL AND keep_id<>id)
     OR EXISTS (
    WITH truth AS (
      SELECT t.id,
             (lower(COALESCE(t.variant,'')) IN ('spin','sng')
               OR COALESCE(t.max_players,0)<=2) AS is_seat_first,
             public.fn_tournament_primary_table(t.id) AS primary_table,
             CASE
               WHEN lower(COALESCE(t.variant,'')) IN ('spin','sng')
                    OR COALESCE(t.max_players,0)<=2 THEN (
                 SELECT count(*) FROM public.table_seats s
                  WHERE s.table_id=public.fn_tournament_primary_table(t.id)
                    AND s.left_at IS NULL)
               ELSE (
                 SELECT count(*) FROM public.tournament_players tp
                  WHERE tp.tournament_id=t.id
                    AND tp.status IN ('registered','playing'))
             END AS real_count
        FROM public.tournaments t
       WHERE upper(COALESCE(t.status::text,'')) IN
               ('RUNNING','REGISTERING','ANNOUNCED'))
    SELECT 1 FROM public.tournaments t
    JOIN truth ON truth.id=t.id
     WHERE NOT (truth.is_seat_first AND truth.primary_table IS NULL)
       AND COALESCE(t.current_players,-1)
           IS DISTINCT FROM truth.real_count) THEN
    RAISE EXCEPTION
      'tournament denormal cutover left duplicate or player-count drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid=
       'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure
       AND p.prosrc LIKE '%stakes%trim_scale(v_sb)%trim_scale(v_bb)%'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public'])
     OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid='public.fn_update_managed_game(text,uuid,jsonb)'::regprocedure
       AND p.prosrc LIKE '%stakes=trim_scale(v_sb)%trim_scale(v_bb)%'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public'])
     OR has_function_privilege(
       'authenticated','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'a hard-coded reconciler replacement is incomplete';
  END IF;
END;
$legacy_reconciler_preflight$;

DROP TRIGGER trg_release_seats_on_tournament_finish ON public.tournaments;
DROP FUNCTION public.fn_release_seats_on_tournament_finish() RESTRICT;
DROP FUNCTION public.fn_reconcile_tournament_denormals() RESTRICT;

-- The remaining delayed cleanup owners are likewise obsolete. Terminal and
-- cancellation receipts close their own felt, and production dependency/
-- cron/call probes are empty.
DROP TRIGGER IF EXISTS trg_clear_seats_on_game_end ON public.tournaments;
DROP FUNCTION IF EXISTS public.fn_clear_seats_on_game_end();
DROP FUNCTION IF EXISTS public.fn_spin_reap_stale_boards(
  integer,boolean,boolean,integer);

-- The amount-trusting unregister RPC and its counter wrapper predate immutable
-- entry entitlements. Neither can identify the wallet rail that paid for an
-- entry, and the amount-taking RPC can therefore manufacture the wrong refund.
-- The exact entitlement authority above is the only supported unregister
-- owner. Prove the two obsolete signatures have no executable caller before
-- dropping them without CASCADE; keep historical audit/registry rows intact.
DO $legacy_unregister_preflight$
DECLARE
  v_atomic oid:=to_regprocedure(
    'public.atomic_tournament_unregister(uuid,uuid,numeric)');
  v_counter oid:=to_regprocedure(
    'public.fn_tournament_unregister_counter(uuid,numeric)');
  v_carriers text[];
BEGIN
  IF v_atomic IS NULL OR v_counter IS NULL THEN
    RAISE EXCEPTION
      'legacy tournament unregister signatures changed before exact retirement';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_depend d
     WHERE d.refclassid='pg_proc'::regclass
       AND d.refobjid IN (v_atomic,v_counter)
  ) THEN
    RAISE EXCEPTION
      'a catalog object still depends on a legacy tournament unregister signature';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.oid NOT IN (v_atomic,v_counter)
       AND (
         p.prosrc ~ 'atomic_tournament_unregister[[:space:]]*\('
         OR p.prosrc ~ 'fn_tournament_unregister_counter[[:space:]]*\('
       )
  ) THEN
    RAISE EXCEPTION
      'an executable function body still calls a legacy tournament unregister signature';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname=ANY(ARRAY[
         'atomic_seat_horse',
         'atomic_table_withdraw',
         'distribute_tournament_prizes'
       ])
  ) THEN
    RAISE EXCEPTION 'a retired wallet writer has been recreated';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.oid<>'public.guard_wallet_balance_write()'::regprocedure
       AND (
         p.prosrc LIKE '%atomic_seat_horse%'
         OR p.prosrc LIKE '%atomic_table_withdraw%'
         OR p.prosrc LIKE '%distribute_tournament_prizes%'
       )
  ) THEN
    RAISE EXCEPTION 'a function body still names a retired wallet writer';
  END IF;

  SELECT COALESCE(array_agg(p.proname::text ORDER BY p.proname),ARRAY[]::text[])
    INTO v_carriers
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.oid<>v_atomic
     AND p.prosrc LIKE '%atomic_tournament_unregister%';
  IF v_carriers IS DISTINCT FROM ARRAY[
       'fn_club_arena_global_wallet_check',
       'fn_union_money_path_check',
       'fn_union_overload_check',
       'guard_wallet_balance_write'
     ]::text[] THEN
    RAISE EXCEPTION
      'unexpected legacy unregister source carriers: %',v_carriers;
  END IF;
END;
$legacy_unregister_preflight$;

DROP FUNCTION public.atomic_tournament_unregister(uuid,uuid,numeric);
DROP FUNCTION public.fn_tournament_unregister_counter(uuid,numeric);

-- Re-emit every current diagnostic/guard body in full. This is deliberately
-- static SQL: no pg_get_functiondef rewrite can silently splice a future body.
CREATE OR REPLACE FUNCTION public.fn_club_arena_global_wallet_check()
RETURNS TABLE(fn text,detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $global_wallet_check_without_legacy_unregister$
  SELECT p.proname::text,
         'Club Arena money path references the global wallets table - every club '
         || 'must be its own standalone wallet, never joined or pooled'
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','process_tournament_rebuy',
       'atomic_cancel_tournament','fn_pay_player_chips',
       'atomic_pay_player_rakeback','credit_player_rakeback')
       -- atomic_pay_agent_settlement was here until phase 7 dropped it.
     AND p.prosrc ~* '(update|insert into|from)\s+(public\.)?wallets\M';
$global_wallet_check_without_legacy_unregister$;

CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
RETURNS TABLE(fn text,detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $union_money_path_without_legacy_unregister$
  SELECT x.fn,
         'money path no longer reaches club scope (directly or through any '
         || 'function it calls, to 4 levels) - club wallets would be commingled'
    FROM (VALUES
            ('atomic_table_buyin'),('atomic_table_cashout'),
            ('atomic_table_rebuy'),('atomic_table_addon'),
            ('atomic_tournament_register'),
            ('process_tournament_rebuy'),
            ('credit_player_wallet'),('atomic_cancel_tournament'),
            ('fn_pay_player_chips'),
            ('atomic_pay_player_rakeback'),('credit_player_rakeback')
            -- transfer_chips_agent_to_player was here. It is dropped: it
            -- debited the agent's PLAYER wallet, its only caller was an unused
            -- World Hub route, and fn_agent_wallet_send is the path.
            --
            -- atomic_pay_agent_settlement was here until phase 7, and is
            -- dropped for the same shape of reason: staff paying an agent out
            -- of a column nothing maintained, against Dan's ruling that agents
            -- claim their own. What replaces it, fn_agent_claim_commission, is
            -- club-scoped by construction - it takes p_club_id, locks that
            -- club's row and debits that club's treasury - so there is nothing
            -- here for this check to discover about it.
         ) AS x(fn)
   -- A function that has been deleted outright is still a breach; one that
   -- exists but cannot reach club scope is the breach this was written for.
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname=x.fn)
      OR NOT public.fn_money_path_reaches_club_scope(x.fn,4);
$union_money_path_without_legacy_unregister$;

CREATE OR REPLACE FUNCTION public.fn_union_overload_check()
RETURNS TABLE(fn text,signatures bigint,detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $union_overload_without_legacy_unregister$
  SELECT p.proname::text,count(*),
         'money-path function has multiple signatures - callers may silently hit '
         || 'the stale one (this has already happened three times: buy-in, '
         || 'cascading commission, tournament register)'
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','process_tournament_rebuy',
       'calculate_cascading_commission','credit_agent_commission_from_rake',
       'atomic_distribute_rake','record_tournament_buyin_rake',
       'fn_pay_player_chips'
       -- atomic_pay_agent_settlement was here until phase 7 dropped it.
     )
   GROUP BY p.proname
  HAVING count(*)>1;
$union_overload_without_legacy_unregister$;

CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $wallet_guard_without_legacy_unregister$
DECLARE
  v_stack text;
  v_bypass text;
  v_allowed text[]:=ARRAY[
    'atomic_credit_wallet_and_log','atomic_deduct_wallet_and_log','atomic_wallet_transfer',
    'atomic_chip_transfer','fn_idempotent_credit_wallet','fn_idempotent_deduct_wallet',
    'fn_idempotent_wallet_transfer','atomic_table_buyin','atomic_table_cashout',
    'atomic_table_rebuy','atomic_table_addon','player_leave_table','atomic_tournament_register',
    'atomic_cancel_tournament',
    'process_tournament_rebuy',
    'atomic_pay_player_rakeback','credit_agent_commission',
    'credit_player_rakeback','fn_cancel_cashout','fn_reject_cashout',
    'fn_clawback_chips_atomic','distribute_chips','mint_club_chips','add_chips','add_to_promo_wallet',
    'credit_player_wallet','deduct_player_wallet','wallet_internal_transfer','wallet_user_transfer',
    'create_user_wallets','reconcile_ledger_nightly',
    -- added 2026-08-15 with the chip-removal authority policy
    'fn_admin_remove_player_chips','fn_approve_cashout_atomic','fn_cancel_cashout_atomic',
    -- added 2026-08-21 with the diamond-backed Chip Mint (Dan's directive)
    'fn_mint_chips_from_diamonds',
    -- added 2026-08-23 with the Club Bank Cashier (Dan directive)
    'fn_club_bank_send',
    'fn_club_bank_claim_back','fn_promo_wallet_send',
    'fn_club_bank_reverse'
    -- removed 2026-08-31 (phase 6): execute_commission_payout, which credited a
    -- wallet, debited nothing and never marked the commission settled.
    -- removed 2026-09-01 (phase 7): atomic_pay_agent_settlement, a staff payout
    -- that decremented a column nothing incremented.
  ];
  v_fn text;
BEGIN
  v_bypass:=current_setting('app.bypass_wallet_guard',true);
  IF v_bypass='on' THEN RETURN NEW; END IF;
  GET DIAGNOSTICS v_stack=PG_CONTEXT;
  FOREACH v_fn IN ARRAY v_allowed LOOP
    IF v_stack ~ ('function (public\.)?'||v_fn||'\(') THEN
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION
    'Direct balance mutation on %.% is forbidden by Phase 4.1.6a guard. '
    'All balance changes must flow through the whitelisted SECURITY DEFINER '
    'RPCs (atomic_*, fn_idempotent_*, distribute_chips, mint_club_chips, etc.) '
    'that log to chip_ledger. Admin override: '
    'SELECT set_config(''app.bypass_wallet_guard'', ''on'', true);',
    TG_TABLE_SCHEMA,TG_TABLE_NAME
    USING ERRCODE='insufficient_privilege';
END;
$wallet_guard_without_legacy_unregister$;

REVOKE ALL ON FUNCTION public.guard_wallet_balance_write()
  FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the service-only diagnostic contract explicitly after replacement.
REVOKE ALL ON FUNCTION public.fn_club_arena_global_wallet_check()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_arena_global_wallet_check()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_money_path_check()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_money_path_check()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_overload_check()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_overload_check()
  TO service_role;

-- Every supported roster exit now enters through an owner-executed authority.
-- service_role must not retain a raw DELETE fallback around those receipts.
REVOKE DELETE ON TABLE public.tournament_players FROM service_role;

DO $legacy_unregister_cutover_proof$
DECLARE
  v_signature text;
  v_source text;
  v_delete_owners integer;
BEGIN
  IF to_regprocedure(
       'public.atomic_tournament_unregister(uuid,uuid,numeric)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_tournament_unregister_counter(uuid,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy tournament unregister signatures still exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname=ANY(ARRAY[
         'atomic_seat_horse',
         'atomic_table_withdraw',
         'distribute_tournament_prizes'
       ])
  ) THEN
    RAISE EXCEPTION 'a retired wallet writer still exists';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND (p.prosrc LIKE '%atomic_tournament_unregister%'
         OR p.prosrc LIKE '%fn_tournament_unregister_counter%'
         OR p.prosrc LIKE '%atomic_seat_horse%'
         OR p.prosrc LIKE '%atomic_table_withdraw%'
         OR p.prosrc LIKE '%distribute_tournament_prizes%')
  ) THEN
    RAISE EXCEPTION 'a persistent function body still names a retired wallet writer';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_club_arena_global_wallet_check()',
    'public.fn_union_money_path_check()',
    'public.fn_union_overload_check()'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE')
       OR has_function_privilege('anon',v_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_signature,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure(v_signature)
            AND p.prosecdef
            AND p.proconfig @> ARRAY['search_path=public']
       ) THEN
      RAISE EXCEPTION 'diagnostic ACL or definer contract changed: %',v_signature;
    END IF;
  END LOOP;

  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid='public.guard_wallet_balance_write()'::regprocedure
     AND NOT p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public']
     AND NOT has_function_privilege(
       'anon','public.guard_wallet_balance_write()','EXECUTE')
     AND NOT has_function_privilege(
       'authenticated','public.guard_wallet_balance_write()','EXECUTE')
     AND NOT has_function_privilege(
       'service_role','public.guard_wallet_balance_write()','EXECUTE');
  IF v_source IS NULL
     OR v_source LIKE '%atomic_tournament_unregister%' THEN
    RAISE EXCEPTION 'wallet write guard did not retain its invoker contract';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_unregister_from_tournament(uuid)',
    'public.fn_unregister_from_tournament(uuid,uuid)',
    'public.fn_leave_seat_and_refund(uuid)',
    'public.fn_leave_seat_and_refund(uuid,uuid)',
    'public.fn_admin_remove_tournament_player(uuid,uuid)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure(v_signature) AND p.prosecdef
       ) THEN
      RAISE EXCEPTION 'supported tournament exit RPC changed: %',v_signature;
    END IF;
  END LOOP;

  IF has_function_privilege(
       'service_role',
       'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_players','DELETE') THEN
    RAISE EXCEPTION 'tournament roster exit ACL has a bypass';
  END IF;

  SELECT count(*)
    INTO v_delete_owners
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+(public\.)?tournament_players';
  IF v_delete_owners<>1 OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid=
       'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)'::regprocedure
       AND p.prosrc ~*
         'delete[[:space:]]+from[[:space:]]+(public\.)?tournament_players'
  ) THEN
    RAISE EXCEPTION
      'unexpected direct tournament roster delete owner count: %',v_delete_owners;
  END IF;
END;
$legacy_unregister_cutover_proof$;

DO $seat_exit_cutover_proof$
DECLARE
  v_source text;
BEGIN
  IF (SELECT count(*)
        FROM public.tournament_seat_exit_authority_cutover c
       WHERE c.authority='tournament_seat_exit_authority:v1'
         AND c.migration_version='20260909014545'
         AND c.installed_at IS NOT NULL
         AND c.installed_at<=clock_timestamp()
         AND c.repaired_seat_count=cardinality(c.repaired_seat_ids)
         AND c.repaired_table_count=cardinality(c.repaired_table_ids)
         AND c.repaired_roster_count=cardinality(c.repaired_roster_ids)
         AND c.repaired_chip_count=
             cardinality(c.repaired_chip_roster_ids)
         AND c.repaired_stakes_count=
             cardinality(c.repaired_stakes_table_ids)
         AND c.closed_duplicate_table_count=
             cardinality(c.closed_duplicate_table_ids)
         AND c.repaired_player_count_count=
             cardinality(c.repaired_player_count_tournament_ids)
         AND array_position(c.repaired_seat_ids,NULL) IS NULL
         AND array_position(c.repaired_table_ids,NULL) IS NULL
         AND array_position(c.repaired_roster_ids,NULL) IS NULL
         AND array_position(c.repaired_chip_roster_ids,NULL) IS NULL
         AND array_position(c.repaired_stakes_table_ids,NULL) IS NULL
         AND array_position(c.closed_duplicate_table_ids,NULL) IS NULL
         AND array_position(
               c.repaired_player_count_tournament_ids,NULL) IS NULL)<>1 THEN
    RAISE EXCEPTION 'tournament seat-exit cutover marker is missing or invalid';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.repaired_seat_ids) repaired(id)
      LEFT JOIN public.table_seats s ON s.id=repaired.id
     WHERE s.id IS NULL OR s.left_at IS NULL)
     OR EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.repaired_table_ids) repaired(id)
      LEFT JOIN public.tables tb ON tb.id=repaired.id
     WHERE tb.id IS NULL OR lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0)
     OR EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.closed_duplicate_table_ids) repaired(id)
      LEFT JOIN public.tables tb ON tb.id=repaired.id
     WHERE tb.id IS NULL OR lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'terminal seat-exit cutover receipt lost its exact repair state';
  END IF;
  IF has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','DELETE') THEN
    RAISE EXCEPTION 'seat-exit cutover marker is reachable by service role';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid='public.table_seats'::regclass
         AND tgname='zy_tournament_live_seat_exit_requires_authority'
         AND NOT tgisinternal)<>1 THEN
    RAISE EXCEPTION 'tournament seat-exit guard is not armed exactly once';
  END IF;
  IF to_regprocedure('public.fn_clear_seats_on_game_end()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_spin_reap_stale_boards(integer,boolean,boolean,integer)')
       IS NOT NULL
     OR to_regprocedure(
       'public.fn_reconcile_tournament_denormals()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_live_seat_chips(uuid)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_chips(uuid,jsonb)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_release_seats_on_tournament_finish()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid='public.tournaments'::regclass
          AND tg.tgname='trg_release_seats_on_tournament_finish'
          AND NOT tg.tgisinternal)
     OR EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname='reconcile-tournament-denormals'
           OR command LIKE '%fn_reconcile_tournament_denormals(%') THEN
    RAISE EXCEPTION 'retired tournament seat reconcilers still exist';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure
          AND p.prosrc LIKE '%stakes%trim_scale(v_sb)%trim_scale(v_bb)%'
          AND p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public'])
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid='public.fn_update_managed_game(text,uuid,jsonb)'::regprocedure
          AND p.prosrc LIKE '%stakes=trim_scale(v_sb)%trim_scale(v_bb)%'
          AND p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public'])
     OR has_function_privilege(
       'authenticated','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'denormal write ownership is not hard-coded at source';
  END IF;
  IF has_function_privilege(
       'anon','public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'tournament move authority ACL is not service-only';
  END IF;
  IF has_table_privilege(
       'service_role','public.tournament_seat_exit_authorizations','SELECT')
     OR has_table_privilege(
       'authenticated','public.tournament_seat_exit_authorizations','INSERT')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'seat-exit capability table is externally reachable';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
    'public.fn_tournament_live_seat_exit_requires_authority()'::regprocedure;
  IF v_source IS NULL
     OR v_source LIKE '%tournament_players%'
     OR replace(v_source,' ','') LIKE '%OLD.stack=0%RETURNNEW%' THEN
    RAISE EXCEPTION 'seat-exit trigger retained a tokenless state bypass';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
  IF v_source IS NULL
     OR v_source NOT LIKE '%fn_ca_open_tournament_hand_seat_exit_authority%'
     OR v_source NOT LIKE '%fn_ca_close_tournament_seat_exit_authority%'
     OR v_source NOT LIKE
          '%fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority%'
     OR v_source NOT LIKE '%fn_emit_tournament_manager_wake%'
     OR v_source NOT LIKE '%accepted_hand_bust%'
     OR replace(v_source,' ','') NOT LIKE '%v_expected_vacated<>v_consumed%' THEN
    RAISE EXCEPTION 'accepted-hand seat capability wrapper changed';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_emit_tournament_manager_wake(uuid,text)'::regprocedure;
  IF v_source IS NULL OR v_source NOT LIKE '%accepted_hand_bust%'
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_manager_wakes'::regclass
          AND c.conname='tournament_manager_wakes_reason_check'
          AND pg_get_constraintdef(c.oid) LIKE '%accepted_hand_bust%') THEN
    RAISE EXCEPTION 'accepted-hand bust wake authority changed';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'tournament elimination seat authority ACL changed';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_open_tournament_seat_exit_authority%'
     OR v_source NOT LIKE '%fn_ca_close_tournament_seat_exit_authority%'
     OR v_source NOT LIKE
          '%fn_eliminate_tournament_player_atomic_pre_seat_guard%'
     OR v_source LIKE '%UPDATE public.table_seats%' THEN
    RAISE EXCEPTION 'ordinary elimination bypasses its private seat owner';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_open_tournament_seat_exit_authority%'
     OR v_source NOT LIKE '%fn_ca_close_tournament_seat_exit_authority%'
     OR v_source NOT LIKE
          '%fn_claim_tournament_bounty_elimination_pre_seat_guard%'
     OR v_source LIKE '%UPDATE public.table_seats%' THEN
    RAISE EXCEPTION 'bounty elimination bypasses its private seat owner';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)'::regprocedure
          AND p.prosrc LIKE '%fn_eliminate_player_legacy_candidate_20260907%'
          AND p.prosrc NOT LIKE '%UPDATE public.table_seats%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure
          AND p.prosrc LIKE '%fn_claim_bounty_legacy_candidate_20260907%'
          AND p.prosrc NOT LIKE '%UPDATE public.table_seats%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure
          AND p.prosrc LIKE '%UPDATE public.table_seats%'
          AND p.prosrc LIKE '%left_at%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure
          AND p.prosrc LIKE '%UPDATE public.table_seats%'
          AND p.prosrc LIKE '%left_at%') THEN
    RAISE EXCEPTION 'private elimination seat owners changed shape';
  END IF;
  SELECT pg_get_functiondef(
    'public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure)
    INTO v_source;
  IF position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' IN v_source)=0
     OR position('atomic_seat_cashout_locked_pre_tournament_guard' IN v_source)=0 THEN
    RAISE EXCEPTION 'cashout wrapper is not hard-refusing tournaments';
  END IF;
  SELECT pg_get_functiondef(
    'public.fn_admin_kick_player(uuid,uuid,text)'::regprocedure) INTO v_source;
  IF position('fn_can_create_games' IN v_source)=0
     OR position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' IN v_source)=0 THEN
    RAISE EXCEPTION 'admin kick is not a cash-only game-authority path';
  END IF;
END;
$seat_exit_cutover_proof$;

COMMIT;
