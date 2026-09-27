BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=public,extensions,pg_temp;
DO $isolation$ BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user NOT IN('fixture_bootstrap','postgres')
 OR current_database() NOT LIKE 'qual_spin_expiry_%'
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_ISOLATION_REQUIRED'; END IF;
END $isolation$;


SET LOCAL check_function_bodies=off;

DO $remove_old$ DECLARE r record; BEGIN FOR r IN SELECT tgname FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND NOT tgisinternal LOOP EXECUTE format('DROP TRIGGER %I ON public.table_seats',r.tgname); END LOOP; END $remove_old$;

DO $remove_old$ DECLARE r record; BEGIN FOR r IN SELECT tgname FROM pg_trigger WHERE tgrelid='public.tables'::regclass AND NOT tgisinternal LOOP EXECUTE format('DROP TRIGGER %I ON public.tables',r.tgname); END LOOP; END $remove_old$;

DO $remove_old$ DECLARE r record; BEGIN FOR r IN SELECT tgname FROM pg_trigger WHERE tgrelid='public.tournament_players'::regclass AND NOT tgisinternal LOOP EXECUTE format('DROP TRIGGER %I ON public.tournament_players',r.tgname); END LOOP; END $remove_old$;

CREATE OR REPLACE FUNCTION public.fn_block_deleted_table_revival()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(OLD.is_deleted, false)
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('running','waiting','active','open') THEN
    NEW.status := OLD.status;      -- refuse the revival, keep it closed
    NEW.is_deleted := true;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_block_deleted_table_revival() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_block_deleted_table_revival() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_block_deleted_table_revival() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_block_deleted_table_revival() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_block_deleted_table_revival()'::regprocedure)) IS DISTINCT FROM 'b0ab67c371603e45eede5885055ce242' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_block_deleted_table_revival()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_ca_arena_seat_is_same_asset()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_club_asset text; v_arena uuid;
BEGIN
  BEGIN
    SELECT s.club_id INTO v_arena FROM public.ca_arena_settings s WHERE s.id = 1;
    IF v_arena IS NULL THEN RETURN NULL; END IF;   -- no arena yet: nothing to be inconsistent with
    SELECT c.asset INTO v_club_asset
      FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = NEW.table_id;
    IF v_club_asset IS NULL THEN RETURN NULL; END IF;
    -- The only asymmetry that can exist today: a seat at an arena (diamond) table funded from a
    -- chip club wallet, or the reverse. Both are a reporting error before they are a money one.
    IF (v_club_asset = 'diamonds') <> ((SELECT t.club_id FROM public.tables t WHERE t.id = NEW.table_id) = v_arena) THEN
      -- Flipping DR15 escalates what this files; it never refuses the seat, because a guard
      -- that can refuse a seat can strand a player mid-hand. The mode is READ here so the rule
      -- has a consumer and a flip means something (CLAUDE.md 10.86).
      PERFORM public.fn_ca_diamond_incident('DR15:cross_asset_seat',
        CASE WHEN public.fn_ca_diamond_rule_mode('DR15:cross_asset_seat') = 'refuse'
             THEN 'critical' ELSE 'warning' END, NEW.user_id, NEW.stack,
        'fn_ca_arena_seat_is_same_asset',
        jsonb_build_object('table_id', NEW.table_id, 'club_asset', v_club_asset, 'arena_club', v_arena));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- a seat is never refused by a reporting guard
  END;
  RETURN NULL;
END $function$;

ALTER FUNCTION public.fn_ca_arena_seat_is_same_asset() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_ca_arena_seat_is_same_asset() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_ca_arena_seat_is_same_asset() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_ca_arena_seat_is_same_asset() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_arena_seat_is_same_asset()'::regprocedure)) IS DISTINCT FROM '1abc2e0357e6cbd626319d4f454a913c' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_ca_arena_seat_is_same_asset()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
  v_tournament_id uuid;
  v_variant text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id, t.variant, t.max_players, t.starting_chips
    INTO v_tournament_id, v_variant, v_max_players, v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack <= 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack
        USING ERRCODE = 'check_violation',
              HINT = 'Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF public.fn_ca_tournament_recorded_seat_first(v_tournament_id, false) THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips <= 0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id, v_starting_chips
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.stack IS DISTINCT FROM v_starting_chips THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack, v_starting_chips
          USING ERRCODE = 'check_violation',
                HINT = 'The paid seat transaction is the only starting-stack authority; no later top-up exists.';
      END IF;
    END IF;
  END IF;

  -- Cash seats with no funded stack preserve their existing reservation path.
  IF COALESCE(NEW.stack,0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_assign_tournament_player_seat_atomic',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$function$;

ALTER FUNCTION public.fn_ca_guard_seat_creation() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_ca_guard_seat_creation() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_ca_guard_seat_creation() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_guard_seat_creation()'::regprocedure)) IS DISTINCT FROM 'b3e14f411d43b01e84fd614c87f8bf6a' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_ca_guard_seat_creation()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_ca_refuse_restricted_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_scope    text := coalesce(tg_argv[0], 'account');
  v_user     uuid;
  v_enforced boolean := false;
  v_tourney  uuid;
  v_row      public.ca_player_restrictions;
begin
  begin
    v_user := new.user_id;
    if v_user is null then
      return new;
    end if;

    -- THE HOT PATH, and the only thing that runs for a player nobody has
    -- restricted: one probe of the partial index
    -- ca_player_restrictions_active_by_user, which on a platform with no
    -- restrictions is a handful of pages. Everything below it - the
    -- table lookup, the policy read, the observation write - happens
    -- only for a player who genuinely carries a live restriction.
    if not exists (
      select 1 from public.ca_player_restrictions r
       where r.user_id = v_user
         and r.status = 'active'
         and (r.expires_at is null or r.expires_at > now())
    ) then
      return new;
    end if;

    -- THE SCOPE THIS WRITE ACTUALLY BELONGS TO. table_seats carries both
    -- cash and tournament seats and 97.8% of its rows are tournament
    -- ones, so the trigger argument is a DEFAULT, not an answer.
    if tg_table_name = 'table_seats' then
      select t.tournament_id into v_tourney
        from public.tables t where t.id = new.table_id;
      v_scope := case when v_tourney is not null then 'tournaments' else 'cash' end;
    end if;

    if not public.fn_ca_player_restricted(v_user, v_scope) then
      return new;
    end if;

    select restrictions_enforced into v_enforced
      from public.ca_operator_policy limit 1;
    v_enforced := coalesce(v_enforced, false);

    v_row := public.fn_ca_player_restriction_for(v_user, v_scope);

    if not v_enforced then
      insert into public.ca_restriction_observations
        (user_id, scope, restriction_id, table_name, op, would_refuse, detail)
      values (
        v_user, v_scope, v_row.id, tg_table_name, tg_op, true,
        jsonb_build_object(
          'reason_code', v_row.reason_code,
          'restriction_scope', v_row.scope,
          'applied_at', v_row.applied_at,
          'expires_at', v_row.expires_at,
          -- Which of the two ways in this was, so the evidence says
          -- whether the revive path is being used at all.
          'seating_op', tg_op,
          'tournament_id', v_tourney));
      return new;
    end if;

    raise exception
      'PLAYER_RESTRICTED: this account is restricted (%) and cannot % on %.',
      v_row.reason_code, tg_op, tg_table_name
      using errcode = '42501',
            hint = 'An operator applied this restriction. It can be lifted from the Players tab in the operator console.';

  exception
    when insufficient_privilege then
      raise;
    when others then
      return new;
  end;
end;
$function$;

ALTER FUNCTION public.fn_ca_refuse_restricted_entry() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_ca_refuse_restricted_entry() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_ca_refuse_restricted_entry() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_ca_refuse_restricted_entry() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_refuse_restricted_entry()'::regprocedure)) IS DISTINCT FROM '7b1f259496d3b5ad18a1218d35b9b34e' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_ca_refuse_restricted_entry()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_ca_reject_automated_user_club_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_user_id uuid;
  v_automated boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'club_members' THEN
    v_club_id := NEW.club_id;
    v_user_id := NEW.user_id;
    v_automated := COALESCE(NEW.is_bot, false);
  ELSIF TG_TABLE_NAME = 'agents' THEN
    v_club_id := NEW.club_id;
    v_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'table_seats' THEN
    -- A historical/departed seat remains immutable evidence. Only a live seat
    -- can put an automated player back onto a user-created club table.
    IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
    SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    SELECT t.club_id INTO v_club_id
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    v_user_id := NEW.user_id;
  ELSE
    RAISE EXCEPTION 'Unsupported Automated-Club Guard Table: %', TG_TABLE_NAME;
  END IF;

  v_automated := v_automated OR COALESCE(
    (SELECT p.is_horse FROM public.profiles p WHERE p.id = v_user_id), false
  );

  IF v_automated AND NOT public.fn_ca_house_board_allows_automation(v_club_id) THEN
    RAISE EXCEPTION 'AUTOMATED_PLAYER_HOUSE_BOARD_ONLY: Automated Players Cannot Enter A User-Created Club'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_ca_reject_automated_user_club_row() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_ca_reject_automated_user_club_row() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_ca_reject_automated_user_club_row() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_ca_reject_automated_user_club_row() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_reject_automated_user_club_row()'::regprocedure)) IS DISTINCT FROM '7c73094df30c90f94a78cbbd5d24f504' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_ca_reject_automated_user_club_row()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_entry_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tclub uuid;
BEGIN
  -- Maintenance escape for deliberate service operations.
  IF current_setting('app.ca_entry_gate_skip', true) = '1' THEN
    RETURN NEW;
  END IF;
  SELECT t.club_id INTO v_tclub FROM public.tournaments t WHERE t.id = NEW.tournament_id;
  IF v_tclub IS NULL THEN
    RETURN NEW; -- clubless tournament: nothing to scope against
  END IF;
  IF NOT public.fn_ca_entry_scope_ok(NEW.user_id, v_tclub) THEN
    RAISE EXCEPTION 'tournament entry refused: player % has no club membership in the scope of tournament % (club/union %). Join a club in this union first.',
      NEW.user_id, NEW.tournament_id, v_tclub
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_ca_tournament_entry_gate() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_ca_tournament_entry_gate() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_entry_gate() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_entry_gate() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_tournament_entry_gate()'::regprocedure)) IS DISTINCT FROM '63799ff529efacd917879e944ce2e165' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_ca_tournament_entry_gate()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_was numeric;
  v_now numeric;
  v_delta numeric;
  v_felt numeric;
  v_supply numeric;
BEGIN
  -- What this row contributes to the felt. A vacated seat contributes nothing,
  -- whatever its stack still says - that stale figure is the whole defect.
  v_now := CASE WHEN NEW.left_at IS NULL THEN COALESCE(NEW.stack,0) ELSE 0 END;
  v_was := CASE WHEN TG_OP = 'INSERT' THEN 0
                WHEN OLD.left_at IS NULL THEN COALESCE(OLD.stack,0)
                ELSE 0 END;
  v_delta := v_now - v_was;

  -- Only growth is judged. A seat exit, a losing bet and a no-op never refuse:
  -- a guard that can refuse a seat exit strands a player mid-hand.
  IF v_delta <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id = NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NULL;                      -- a cash seat; supply is not the meter
  END IF;

  -- DEFERRED, so this is the committed end state of the whole transaction:
  -- every seat of a settled hand, or the vacate and the re-seat of a move.
  v_felt   := public.fn_ca_tournament_felt_total(v_tournament_id);
  v_supply := public.fn_ca_tournament_chip_supply(v_tournament_id);

  -- Tolerate history, refuse growth: only the write that CARRIES the felt over
  -- the line is refused. An event already over stays playable.
  IF v_felt > v_supply AND (v_felt - v_delta) <= v_supply
     AND NOT EXISTS (
       SELECT 1 FROM public.union_pnl_inventory_events own
       WHERE own.transaction_id=pg_current_xact_id() AND own.source_name='table_seats'
         AND own.row_id=NEW.id AND own.operation=TG_OP
         AND own.after_row=public.fn_union_pnl_inventory_project('table_seats',to_jsonb(NEW))
         AND own.before_row=CASE WHEN TG_OP='UPDATE'
           THEN public.fn_union_pnl_inventory_project('table_seats',to_jsonb(OLD)) ELSE NULL END
         AND (SELECT count(*)>=2 AND bool_and((
                  e.operation='UPDATE'
                  AND e.before_row->>'table_id'=NEW.table_id::text
                  AND e.after_row->>'table_id'=NEW.table_id::text
                  AND e.before_row->>'user_id'=e.after_row->>'user_id'
                  AND e.before_row->>'occupancy_id'=e.after_row->>'occupancy_id'
                  AND e.before_row->>'joined_at'=e.after_row->>'joined_at') IS TRUE)
                AND sum(CASE WHEN e.after_row->>'left_at' IS NULL
                             THEN COALESCE((e.after_row->>'stack')::numeric,0) ELSE 0 END
                      - CASE WHEN e.before_row->>'left_at' IS NULL
                             THEN COALESCE((e.before_row->>'stack')::numeric,0) ELSE 0 END)=0
              FROM public.union_pnl_inventory_events e
              WHERE e.transaction_id=pg_current_xact_id() AND e.source_name='table_seats'
                AND (e.before_row->>'table_id'=NEW.table_id::text
                  OR e.after_row->>'table_id'=NEW.table_id::text)) IS TRUE
         AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_events scope
           WHERE scope.transaction_id=pg_current_xact_id() AND scope.source_name='tables'
             AND scope.row_id=NEW.table_id
             AND scope.before_row->'tournament_id' IS DISTINCT FROM scope.after_row->'tournament_id')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
       JOIN public.table_seats s ON s.id=NEW.id
       WHERE r.transaction_id=pg_current_xact_id() AND r.state='seated'
         AND r.tournament_id=v_tournament_id AND r.user_id=NEW.user_id
         AND r.destination_table_id=NEW.table_id AND r.destination_seat_number=NEW.seat_number
         AND r.assignment->>'seat_id'=NEW.id::text
         AND r.assignment->>'occupancy_id'=NEW.occupancy_id::text
         AND s.user_id=NEW.user_id AND s.table_id=NEW.table_id AND s.seat_number=NEW.seat_number
         AND s.occupancy_id=NEW.occupancy_id AND s.left_at IS NULL AND s.stack=r.grant_chips
         AND v_was=0 AND v_now=r.grant_chips AND v_delta=r.grant_chips
         AND r.live_chips_before+r.grant_chips=v_felt
         AND (r.expected->>'acknowledged_supply')::numeric=v_supply
         AND r.expected->'supply_acknowledgement' IS NOT DISTINCT FROM
           (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=v_tournament_id)
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY: seat % (table %, seat %) adds % chips, '
      'leaving % on the felt of tournament % against % ever bought in',
      NEW.id, NEW.table_id, NEW.seat_number, v_delta, v_felt,
      v_tournament_id, v_supply
      USING ERRCODE = '55000',
            HINT = 'A vacated seat''s stack is a stale snapshot, not chips. '
                   'Fund a seat from the felt the player is leaving, or record '
                   'the creation in tournament_felt_supply_acknowledgements.';
  END IF;

  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure)) IS DISTINCT FROM '81fda5e596905c96a07bebfcff7f32b3' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_ca_tournament_felt_may_not_exceed_supply()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_cancel_cash_seat_moves_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
     OR (NEW.seat_admission_key = 'closed' AND OLD.seat_admission_key IS DISTINCT FROM 'closed') THEN
    -- the moves that name this table, and the swap partners of those moves
    UPDATE public.cash_seat_moves m
       SET state = 'cancelled', note = 'table_closed'
     WHERE m.state = 'pending'
       AND (m.from_table_id = NEW.id OR m.to_table_id = NEW.id
            OR EXISTS (SELECT 1 FROM public.cash_seat_moves p
                        WHERE p.id = m.swap_move_id AND p.state = 'pending'
                          AND (p.from_table_id = NEW.id OR p.to_table_id = NEW.id)));
  END IF;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_cancel_cash_seat_moves_on_table_close() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_cancel_cash_seat_moves_on_table_close() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cancel_cash_seat_moves_on_table_close() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_cancel_cash_seat_moves_on_table_close() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_cancel_cash_seat_moves_on_table_close()'::regprocedure)) IS DISTINCT FROM '15c4186eb80013ea8907e73f80f4a096' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_cancel_cash_seat_moves_on_table_close()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    v_old_tournament_id:=NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP<>'DELETE' THEN
    v_new_tournament_id:=NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
      USING ERRCODE='55000';
  END IF;
  v_tournament_id:=COALESCE(v_new_tournament_id,v_old_tournament_id);
  IF v_tournament_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='chip_ledger' AND TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=v_tournament_id) THEN
    RAISE EXCEPTION 'cancelled tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

ALTER FUNCTION public.fn_cancelled_tournament_evidence_is_immutable() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_cancelled_tournament_evidence_is_immutable() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cancelled_tournament_evidence_is_immutable() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_cancelled_tournament_evidence_is_immutable()'::regprocedure)) IS DISTINCT FROM '55061034adb7416d401622572397c7d2' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_cancelled_tournament_evidence_is_immutable()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_seat_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id=OLD.table_id;
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id=NEW.table_id;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' AND v_new_tournament_id IS NOT NULL THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_new_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=COALESCE(v_new_tournament_id,v_old_tournament_id)) THEN
    RAISE EXCEPTION 'cancelled tournament seat evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

ALTER FUNCTION public.fn_cancelled_tournament_seat_is_immutable() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_cancelled_tournament_seat_is_immutable() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cancelled_tournament_seat_is_immutable() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_cancelled_tournament_seat_is_immutable()'::regprocedure)) IS DISTINCT FROM '97fd52cab28c046053764ece6e6a808a' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_cancelled_tournament_seat_is_immutable()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_capture_managed_game_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_kind text := CASE TG_TABLE_NAME WHEN 'tables' THEN 'table' ELSE 'tournament' END;
  v_contract jsonb;
  v_hash text;
  v_last_hash text;
  v_version integer;
  v_sqlstate text;
  v_message text;
  v_dedupe text;
BEGIN
  IF v_kind = 'table' AND to_jsonb(NEW) -> 'tournament_id' <> 'null'::jsonb THEN
    RETURN NEW;
  END IF;

  v_contract := public.fn_managed_game_contract_document(v_kind, to_jsonb(NEW));

  -- ── NOTHING IN THE CONTRACT MOVED (2026-09-06) ───────────────────────────
  -- The engine and the cluster controller write `current_players`, `status`,
  -- `lifecycle`, `last_activity_at` and the lease columns thousands of times
  -- an hour, and every one of those is in the document's denylist. Comparing
  -- the documents is the same test the hash comparison below performs, minus
  -- the advisory lock and the indexed read - and it is derived from the
  -- document rather than from a second copy of the denylist, so it cannot
  -- drift the day a contract column is added.
  IF TG_OP = 'UPDATE'
     AND v_contract IS NOT DISTINCT FROM
         public.fn_managed_game_contract_document(v_kind, to_jsonb(OLD)) THEN
    RETURN NEW;
  END IF;

  -- ── THE CAPTURE CANNOT REFUSE THE WRITE IT DESCRIBES ─────────────────────
  BEGIN
    v_hash := public.fn_managed_game_contract_hash(v_contract);

    -- Updates of one physical row normally serialize already. This lock also
    -- protects repair/import paths that can publish the same logical game from
    -- separate statements before either has allocated its next version.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_kind || ':' || NEW.id::text, 0));

    SELECT contract_hash, version
      INTO v_last_hash, v_version
      FROM public.managed_game_contract_versions
     WHERE game_kind = v_kind AND game_id = NEW.id
     ORDER BY version DESC
     LIMIT 1;

    IF v_last_hash IS NOT DISTINCT FROM v_hash THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.managed_game_contract_versions (
      game_kind, game_id, club_id, union_id, version, contract,
      contract_hash, published_by, change_reason
    ) VALUES (
      v_kind, NEW.id, NEW.club_id, NEW.union_id, COALESCE(v_version, 0) + 1,
      v_contract, v_hash, auth.uid(),
      CASE
        WHEN TG_OP = 'INSERT' THEN 'created'
        WHEN auth.uid() IS NULL THEN 'system_revision'
        ELSE 'operator_revision'
      END
    );

    RETURN NEW;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_dedupe := 'contract_capture:' || v_kind || ':' || coalesce(v_sqlstate, 'unknown');

    -- The handler must not be able to fail either. A detector that raises is
    -- the defect it was written to catch, one level up.
    BEGIN
      UPDATE public.ca_drift_incidents
         SET occurrences  = occurrences + 1,
             last_seen_at = now(),
             metadata     = metadata
                            || jsonb_build_object('last_game_id', NEW.id,
                                                  'message', v_message)
       WHERE source = 'managed_game_contract_capture'
         AND dedupe_key = v_dedupe
         AND status IN ('open', 'acknowledged', 'reconciling');
      IF NOT FOUND THEN
        -- `classification` and `layer` are CHECK-constrained enums, read off
        -- the live catalogue rather than guessed: 'contract_capture_failed'
        -- and 'schema' are in neither list, and writing them would have made
        -- this handler raise - the exact defect one level up.
        INSERT INTO public.ca_drift_incidents (
          source, dedupe_key, classification, severity, layer,
          club_id, union_id, entity_type, entity_id, suspected_cause, metadata
        ) VALUES (
          'managed_game_contract_capture', v_dedupe, 'unknown',
          'critical', 'projection',
          NEW.club_id, NEW.union_id, v_kind, NEW.id,
          'fn_capture_managed_game_contract raised ' || coalesce(v_sqlstate, '?') ||
            '. The game write SUCCEEDED; the contract version row is missing.',
          jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message,
                             'game_kind', v_kind, 'first_game_id', NEW.id,
                             'tg_op', TG_OP)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- the incident could not be filed; the WARNING below still speaks
    END;

    RAISE WARNING
      'managed game contract capture failed for % % (%): % - the % write was NOT refused; incident filed under source managed_game_contract_capture',
      v_kind, NEW.id, v_sqlstate, v_message, TG_TABLE_NAME;

    RETURN NEW;
  END;
END;
$function$;

ALTER FUNCTION public.fn_capture_managed_game_contract() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_capture_managed_game_contract() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_capture_managed_game_contract() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_capture_managed_game_contract() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_capture_managed_game_contract()'::regprocedure)) IS DISTINCT FROM '28e259c9fd0c76f39c5ca5b5f0328777' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_capture_managed_game_contract()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_cash_game_roster_track()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_game uuid;
  v_move uuid;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT cluster_id INTO v_game FROM public.tables WHERE id = NEW.table_id;
  IF v_game IS NULL THEN RETURN NEW; END IF;

  BEGIN
    IF NEW.left_at IS NULL THEN
      -- A live chair in the game. On the roster once, at the time of the
      -- first chair; a second chair (a move, mid-transaction) changes nothing.
      INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
      VALUES (v_game, NEW.user_id, coalesce(NEW.joined_at, now()))
      ON CONFLICT (game_id, user_id) WHERE left_at IS NULL DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL THEN
      -- The chair emptied. A move declares itself (app.cash_seat_move) and is
      -- not a leave; a player with another live chair in the game is still in
      -- the game. ANYTHING ELSE IS A LEAVE, whatever was planned for them.
      --
      -- A LEAVE CANCELS THE MOVE (2026-09-09). This used to wait while a move
      -- was pending, so the destination chair stayed reserved for a player who
      -- had gone, a swap partner was held for a side that would never come,
      -- and a rejoin inside that window kept the old roster row - the old list
      -- position and the old seat change. Dan: a player who leaves and joins
      -- the same game again goes to the BOTTOM of the list.
      IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
         AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                           JOIN public.tables t ON t.id = ts.table_id
                          WHERE ts.user_id = NEW.user_id AND ts.left_at IS NULL AND ts.id <> NEW.id
                            AND t.cluster_id = v_game AND t.lifecycle <> 'closed') THEN
        -- One pending move per player (cash_seat_moves_one_pending_per_player),
        -- so a scalar RETURNING is the whole set.
        v_move := NULL;
        UPDATE public.cash_seat_moves m
           SET state = 'cancelled', note = 'player_left_game'
         WHERE m.player_id = NEW.user_id AND m.game_id = v_game AND m.state = 'pending'
        RETURNING m.id INTO v_move;
        -- A swap partner is released at once: the held side is dealt back in
        -- at its next boundary and the tick puts its request back on the list.
        IF v_move IS NOT NULL THEN
          UPDATE public.cash_seat_moves p
             SET state = 'cancelled', note = 'swap_partner_gone'
           WHERE p.swap_move_id = v_move AND p.state = 'pending';
        END IF;
        UPDATE public.cash_game_roster SET left_at = now()
         WHERE game_id = v_game AND user_id = NEW.user_id AND left_at IS NULL;
        UPDATE public.cash_seat_change_requests
           SET status = 'cancelled', resolved_at = now(), note = 'left_game'
         WHERE game_id = v_game AND user_id = NEW.user_id AND status = 'requested';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_cash_game_roster_track: % (seat %, user %)', SQLERRM, NEW.id, NEW.user_id;
  END;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_cash_game_roster_track() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_cash_game_roster_track() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cash_game_roster_track() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_cash_game_roster_track() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_cash_game_roster_track()'::regprocedure)) IS DISTINCT FROM '1ce40780d8a8b510b88549de225a9b25' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_cash_game_roster_track()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- A different occupant never inherits the prior player's away state.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR (NEW.left_at IS NOT NULL AND OLD.left_at IS NULL) THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_clear_sitout_on_turnover() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_clear_sitout_on_turnover() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_clear_sitout_on_turnover() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_clear_sitout_on_turnover() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_clear_sitout_on_turnover()'::regprocedure)) IS DISTINCT FROM '0047b57eef2386cece21471486e8579c' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_clear_sitout_on_turnover()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_closed_cluster_main_releases_index()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cluster_id IS NOT NULL
     AND NEW.main_index IS NOT NULL
     AND (NEW.lifecycle = 'closed' OR coalesce(NEW.is_deleted, false) = true)
  THEN
    NEW.main_index := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_closed_cluster_main_releases_index() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_closed_cluster_main_releases_index() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_closed_cluster_main_releases_index() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_closed_cluster_main_releases_index() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_closed_cluster_main_releases_index() TO "anon";

GRANT EXECUTE ON FUNCTION public.fn_closed_cluster_main_releases_index() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.fn_closed_cluster_main_releases_index() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_closed_cluster_main_releases_index()'::regprocedure)) IS DISTINCT FROM '24110b324b6d406e070b3bbfb8b1e178' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_closed_cluster_main_releases_index()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_cluster_table_ceiling()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live integer;
  v_ceiling integer;
BEGIN
  IF NEW.cluster_id IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(g.cap_mains, 8) + 1 + CASE WHEN g.allow_second_feeder THEN 1 ELSE 0 END + 2
    INTO v_ceiling
    FROM public.cash_games g WHERE g.id = NEW.cluster_id;
  IF v_ceiling IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_live FROM public.tables t
   WHERE t.cluster_id = NEW.cluster_id
     AND coalesce(t.is_deleted, false) = false
     AND t.lifecycle <> 'closed';

  IF v_live >= v_ceiling THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (NEW.cluster_id, 'table_refused_at_ceiling',
            jsonb_build_object('live', v_live, 'ceiling', v_ceiling,
                               'role', NEW.role, 'main_index', NEW.main_index));
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_cluster_table_ceiling() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_cluster_table_ceiling() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cluster_table_ceiling() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_cluster_table_ceiling() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_cluster_table_ceiling() TO "anon";

GRANT EXECUTE ON FUNCTION public.fn_cluster_table_ceiling() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.fn_cluster_table_ceiling() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_cluster_table_ceiling()'::regprocedure)) IS DISTINCT FROM '0ad0641a5ee0891d6a720f95594a3392' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_cluster_table_ceiling()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_daily_missions_tournament_registered_inserted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_event record;
  v_occurred_at timestamptz := transaction_timestamp();
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT DISTINCT inserted.user_id
    FROM inserted_rows inserted
    WHERE inserted.status::text IN ('playing', 'eliminated', 'finished', 'winner')
    ORDER BY inserted.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('daily-missions-user:' || v_user_id::text, 0)
    );
  END LOOP;

  FOR v_event IN
    SELECT inserted.id, inserted.user_id, inserted.tournament_id
    FROM inserted_rows inserted
    WHERE inserted.status::text IN ('playing', 'eliminated', 'finished', 'winner')
    ORDER BY inserted.user_id, inserted.tournament_id, inserted.id
  LOOP
    BEGIN
      PERFORM public.enqueue_daily_challenge_event(
        v_event.user_id,
        'tournament:' || v_event.tournament_id::text,
        '{"tournaments_played":1}'::jsonb,
        '{}'::jsonb,
        v_occurred_at
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions tournament event % for player % could not be queued: %',
        v_event.tournament_id,
        v_event.user_id,
        SQLERRM;
    END;
  END LOOP;

  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_daily_missions_tournament_registered_inserted() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_daily_missions_tournament_registered_inserted() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_daily_missions_tournament_registered_inserted() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_daily_missions_tournament_registered_inserted()'::regprocedure)) IS DISTINCT FROM '83e6b7b48dd8edba41500d30130ca538' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_daily_missions_tournament_registered_inserted()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_daily_missions_tournament_registered_updated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_event record;
  v_occurred_at timestamptz := transaction_timestamp();
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT DISTINCT updated.user_id
    FROM updated_rows updated
    JOIN previous_rows previous ON previous.id = updated.id
    WHERE updated.status::text IN ('playing', 'eliminated', 'finished', 'winner')
      AND (
        previous.status IS NULL
        OR previous.status::text NOT IN ('playing', 'eliminated', 'finished', 'winner')
      )
    ORDER BY updated.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('daily-missions-user:' || v_user_id::text, 0)
    );
  END LOOP;

  FOR v_event IN
    SELECT updated.id, updated.user_id, updated.tournament_id
    FROM updated_rows updated
    JOIN previous_rows previous ON previous.id = updated.id
    WHERE updated.status::text IN ('playing', 'eliminated', 'finished', 'winner')
      AND (
        previous.status IS NULL
        OR previous.status::text NOT IN ('playing', 'eliminated', 'finished', 'winner')
      )
    ORDER BY updated.user_id, updated.tournament_id, updated.id
  LOOP
    BEGIN
      PERFORM public.enqueue_daily_challenge_event(
        v_event.user_id,
        'tournament:' || v_event.tournament_id::text,
        '{"tournaments_played":1}'::jsonb,
        '{}'::jsonb,
        v_occurred_at
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions tournament event % for player % could not be queued: %',
        v_event.tournament_id,
        v_event.user_id,
        SQLERRM;
    END;
  END LOOP;

  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_daily_missions_tournament_registered_updated() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_daily_missions_tournament_registered_updated() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_daily_missions_tournament_registered_updated() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_daily_missions_tournament_registered_updated()'::regprocedure)) IS DISTINCT FROM 'b4a2985c8672e0c4cadf7f53a6a26e1b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_daily_missions_tournament_registered_updated()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_emit_managed_game_row_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_document jsonb := to_jsonb(NEW);
  v_old_document jsonb := to_jsonb(OLD);
  v_club  uuid := COALESCE(v_new_document ->> 'club_id', v_old_document ->> 'club_id')::uuid;
  v_id    uuid := COALESCE(v_new_document ->> 'id',      v_old_document ->> 'id')::uuid;
  v_watch text[];
BEGIN
  -- Tournament backing tables are represented by the tournament event itself.
  IF TG_TABLE_NAME = 'tables' THEN
    IF COALESCE(v_new_document ->> 'tournament_id',
                v_old_document ->> 'tournament_id') IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Exactly the columns fn_list_managed_games projects for this kind. Keep
    -- these two lists in step with that function: a column the board reads and
    -- this does not watch is a row that silently stops refreshing.
    v_watch := CASE TG_TABLE_NAME
      WHEN 'tables' THEN ARRAY[
        'club_id', 'union_id', 'tournament_id', 'is_deleted', 'name', 'status',
        'game_variant', 'current_players', 'max_players', 'small_blind',
        'big_blind', 'min_buy_in', 'max_buy_in', 'created_at']
      ELSE ARRAY[
        'club_id', 'union_id', 'name', 'status', 'game_type', 'variant',
        'current_players', 'max_players', 'start_time', 'created_at',
        'buy_in_amount', 'guaranteed_prize', 'prize_pool']
    END;

    IF (SELECT jsonb_object_agg(k, COALESCE(v_old_document -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
       IS NOT DISTINCT FROM
       (SELECT jsonb_object_agg(k, COALESCE(v_new_document -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
    THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public.fn_emit_game_management_event(
    'game_changed', v_club, NULL, NULL,
    CASE WHEN TG_TABLE_NAME = 'tables' THEN 'table' ELSE 'tournament' END,
    v_id, NULL, jsonb_build_object('operation', lower(TG_OP)));
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_emit_managed_game_row_event() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_emit_managed_game_row_event() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_emit_managed_game_row_event() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_emit_managed_game_row_event() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_emit_managed_game_row_event()'::regprocedure)) IS DISTINCT FROM '9706ead97b5e6f495957bfd02a6eb282' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_emit_managed_game_row_event()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_enforce_booking_game_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_load    int;
  v_tstatus text;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NULL OR NEW.status NOT IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  -- registered -> playing at late registration is not a NEW claim.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  SELECT tr.status INTO v_tstatus
    FROM public.tournaments tr
   WHERE tr.id = NEW.tournament_id;

  -- Once under way, entrants are counted by their SEATS and the seat trigger
  -- owns the rule. An unreadable tournament row is checked, not waved through.
  IF v_tstatus IS NOT NULL AND v_tstatus NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_load := public.fn_concurrent_game_load(NEW.user_id, NULL, NULL, NEW.tournament_id);

  IF v_load >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not enter another',
      NEW.user_id, v_load
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before entering another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_enforce_booking_game_cap() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_enforce_booking_game_cap() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_enforce_booking_game_cap() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_enforce_booking_game_cap() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_enforce_booking_game_cap()'::regprocedure)) IS DISTINCT FROM '0770bebd2ce6924626f2c3c947d23038' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_enforce_booking_game_cap()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live       int;
  v_is_closed  boolean;
  v_tournament uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A MOVE WITHIN ONE GAME IS NOT A FIFTH GAME (2026-09-05). Only the cluster
  -- executor sets this, for the one transaction in which a player changes
  -- chairs inside a game they are already in. It replaces the 041000 rule
  -- ("holds another live seat in this cluster"), which also let a player buy
  -- a second seat into a game they were already sitting in.
  IF current_setting('app.cash_seat_move', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed'), t.tournament_id
    INTO v_is_closed, v_tournament
    FROM public.tables t
   WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
    RETURN NEW;
  END IF;

  /* THE ENTRY WAS ALREADY APPROVED AT THE DOOR (2026-09-09). An active
     entrant taking a chair in their own event is that entry being honoured,
     whether it is their first chair or their fifth move. The cap on entering
     lives in fn_enforce_booking_game_cap, which is the gate that can still
     say no while saying no is free. */
  IF v_tournament IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_live := public.fn_concurrent_game_load(NEW.user_id, NEW.id, NEW.table_id, v_tournament);

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before joining another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike. A chair in an event you are already entered in is the entry being honoured and is never refused here.';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_enforce_four_table_limit() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_enforce_four_table_limit() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_enforce_four_table_limit() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_enforce_four_table_limit() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_enforce_four_table_limit()'::regprocedure)) IS DISTINCT FROM '817fb0550497afd5347b936a3cbb5bb9' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_enforce_four_table_limit()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_enforce_table_union_ownership_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL AND NEW.union_id IS DISTINCT FROM v_union THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_enforce_table_union_ownership_update() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_enforce_table_union_ownership_update() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_enforce_table_union_ownership_update() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_enforce_table_union_ownership_update() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_enforce_table_union_ownership_update()'::regprocedure)) IS DISTINCT FROM '210f773b42237b874226747b29e672b3' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_enforce_table_union_ownership_update()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_enforce_tournament_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_max int;
  v_have int;
  v_name text;
  v_status text;
  v_variant text;
  v_seat_first boolean;
BEGIN
  PERFORM public.fn_ca_tournament_is_unlimited(NEW.tournament_id);
  /* UNDER THE ROW LOCK (2026-09-06). This read the tournament without one, so
     two entries arriving together could both see room and both be admitted.
     Parent before child - the order every registration door already uses. */
  SELECT max_players, name, status, COALESCE(variant, '')
    INTO v_max, v_name, v_status, v_variant
    FROM public.tournaments WHERE id = NEW.tournament_id
    FOR NO KEY UPDATE;

  -- No declared capacity means no capacity to exceed (open MTTs).
  IF public.fn_ca_tournament_is_unlimited(NEW.tournament_id)
     OR v_max IS NULL OR v_max <= 0 THEN
    RETURN NEW;
  END IF;

  /* 'sng' JOINS 'spin' (2026-09-06). fn_sync_seat_first_player_count has
     always counted ('spin','sng') OR max <= 2 as seat-first; this said
     'spin' OR max <= 2. All 35 overfilled events were sng, and they qualified
     only on the <= 2 half - a six-max sng was outside the rule entirely. */
  v_seat_first := (v_variant IN ('spin', 'sng') OR v_max <= 2);

  -- A seat-first board sells its seats once. After it stops being joinable it
  -- admits nobody, however many of its entrants have since busted.
  IF v_seat_first
     AND upper(COALESCE(v_status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RAISE EXCEPTION
      'tournament_full: % is % and takes no further entrants',
      COALESCE(v_name, NEW.tournament_id::text), lower(v_status)
      USING ERRCODE = '23514';
  END IF;

  IF v_seat_first THEN
    /* AN ENTRY, NOT A SURVIVOR (2026-09-06). This branch used to exclude
       eliminated, winner, left, withdrawn, cancelled, refunded and busted -
       the right rule for a seat and the wrong one for an entry. On a
       two-handed board it meant a bust-out put a sold seat back on sale, and
       35 events took between 3 and 32 paid entries because of it. The board
       sold its seats; what became of the players who bought them is not a
       vacancy. */
    SELECT count(*) INTO v_have
      FROM public.tournament_players
     WHERE tournament_id = NEW.tournament_id;
  ELSE
    -- Multi-table events are unchanged: a busted entrant does not hold a seat
    -- against the next one on a board that is still filling.
    SELECT count(*) INTO v_have
      FROM public.tournament_players
     WHERE tournament_id = NEW.tournament_id
       AND COALESCE(status, 'registered') NOT IN
           ('eliminated', 'winner', 'left', 'withdrawn', 'cancelled', 'refunded', 'busted');
  END IF;

  IF v_have >= v_max THEN
    RAISE EXCEPTION
      'tournament_full: % already has % of % entrants', COALESCE(v_name, NEW.tournament_id::text), v_have, v_max
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_enforce_tournament_capacity() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_enforce_tournament_capacity() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_enforce_tournament_capacity() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_enforce_tournament_capacity() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_enforce_tournament_capacity()'::regprocedure)) IS DISTINCT FROM 'c89a358115c8cd06ff93cfffc2aab84f' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_enforce_tournament_capacity()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF EXISTS (
      SELECT 1 FROM public.table_seats ts
       WHERE ts.table_id = OLD.id AND ts.left_at IS NULL
    ) THEN
      RAISE EXCEPTION 'This table cannot be deleted while players are seated'
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_is_engine THEN
      RAISE EXCEPTION 'Tables are closed through fn_close_managed_game, never deleted'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This tournament cannot be deleted after a player has registered'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_is_engine THEN
    RAISE EXCEPTION 'Tournaments are cancelled through fn_close_managed_game, never deleted'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$function$;

ALTER FUNCTION public.fn_guard_managed_game_delete() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_guard_managed_game_delete() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_delete() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_delete() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_guard_managed_game_delete()'::regprocedure)) IS DISTINCT FROM 'bef4392e9fa3124cecaaf74a739e465b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_guard_managed_game_delete()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
  v_managed_command boolean :=
    COALESCE(current_setting('app.managed_game_lifecycle', true), '') = 'on';
  v_protected_tournament_keys text[] := ARRAY[
    'name', 'start_time', 'max_players', 'buy_in_amount', 'buy_in_fee',
    'guaranteed_prize', 'late_reg_mins', 'starting_chips', 'blind_structure',
    'payout_structure', 'game_type', 'variant', 'tournament_type', 'is_rebuy',
    'rebuy_cost', 'rebuy_chips', 'rebuy_levels', 'add_on_available',
    'addon_cost', 'addon_chips', 'is_bounty', 'bounty_amount', 'is_pko',
    'is_mystery_bounty', 'mystery_bounty_min', 'mystery_bounty_max',
    'description', 'short_description', 'min_players', 'late_reg_levels',
    'is_reentry', 'max_rebuys', 'max_reentries', 'addon_levels',
    'addon_break_minutes', 'is_private', 'is_vip_only', 'ban_chat',
    'all_in_or_fold', 'label_as_new', 'hide_club_name', 'is_pinned',
    'action_time_seconds', 'table_size', 'accelerated_mtt', 'big_blind_ante',
    'authorized_to_register', 'early_bird_enabled', 'early_bird_chips',
    'bubble_protection', 'final_table_deal_enabled', 'restart_every_minutes',
    'synchronized_breaks', 'is_multi_day', 'total_days', 'is_xmtt',
    'union_id', 'satellite_target_id', 'satellite_seats', 'spin_type',
    'mystery_bounty_profile', 'mystery_bounty_activation',
    'mystery_bounty_activation_value', 'mystery_bounty_pool_percent',
    'mystery_bounty_top_percent', 'settings'
  ];
  v_key text;
  v_new_document jsonb;
  v_old_document jsonb;
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF lower(COALESCE(NEW.status, '')) IN ('closed', 'deleted')
       AND lower(COALESCE(OLD.status, '')) NOT IN ('closed', 'deleted')
       AND EXISTS (
         SELECT 1
         FROM public.table_seats ts
         WHERE ts.table_id = NEW.id
           AND ts.left_at IS NULL
       ) THEN
      RAISE EXCEPTION 'This table cannot be closed while players are seated'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine
       AND NOT v_managed_command
       AND (
         lower(COALESCE(NEW.status, '')) = 'deleted'
         AND lower(COALESCE(OLD.status, '')) <> 'deleted'
         OR COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false)
       ) THEN
      RAISE EXCEPTION 'Table lifecycle changes must use fn_close_managed_game'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments'
     AND EXISTS (
       SELECT 1
       FROM public.tournament_players tp
       WHERE tp.tournament_id = NEW.id
     ) THEN
    IF NOT v_is_engine
       AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine THEN
      v_new_document := to_jsonb(NEW);
      v_old_document := to_jsonb(OLD);
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN
          RAISE EXCEPTION 'This tournament cannot be modified after a player has registered'
            USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_is_engine
     AND NOT v_managed_command
     AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
     AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
    RAISE EXCEPTION 'Tournament lifecycle changes must use fn_close_managed_game'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_guard_managed_game_lifecycle() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_guard_managed_game_lifecycle() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_lifecycle() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_lifecycle() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure)) IS DISTINCT FROM 'e4e6dbe534f8ed1fc7fa03fcad968114' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_guard_managed_game_lifecycle()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_guard_one_live_tournament_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_other_table   uuid;
  v_other_seat    integer;
BEGIN
  IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
  FROM public.tables t
  WHERE t.id = NEW.table_id;

  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ts.table_id, ts.seat_number
    INTO v_other_table, v_other_seat
  FROM public.table_seats ts
  JOIN public.tables t2 ON t2.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND ts.user_id = NEW.user_id
    AND t2.tournament_id = v_tournament_id
    AND ts.id IS DISTINCT FROM NEW.id
  LIMIT 1;

  IF v_other_table IS NOT NULL THEN
    RAISE EXCEPTION
      'player % already holds a live seat in tournament % (table %, seat %) - one live seat per tournament',
      NEW.user_id, v_tournament_id, v_other_table, v_other_seat
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_guard_one_live_tournament_seat() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_guard_one_live_tournament_seat() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_one_live_tournament_seat() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_guard_one_live_tournament_seat() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_guard_one_live_tournament_seat()'::regprocedure)) IS DISTINCT FROM 'f55ac7c4e07131b85e42bd8e0b39cacc' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_guard_one_live_tournament_seat()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_guard_retired_club_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_old_club_id uuid;
  v_maintenance boolean :=
    auth.uid() IS NULL
    AND coalesce(current_setting('app.club_retirement_maintenance', true), '') = 'on';
BEGIN
  IF v_maintenance THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := OLD.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = OLD.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = OLD.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = OLD.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
    ELSE
      v_club_id := OLD.club_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = NEW.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = NEW.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = NEW.agent_id;
    ELSE
      v_club_id := NEW.club_id;
    END IF;

    -- On UPDATE, check the source scope too. Moving a retained row to an active
    -- club must not become an escape hatch from a retired club's write freeze.
    IF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'unions' THEN
        v_old_club_id := OLD.id;
      ELSIF TG_TABLE_NAME = 'table_seats' THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.table_id;
      ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tournaments t
         WHERE t.id = OLD.tournament_id;
      ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
        SELECT cr.club_id INTO v_old_club_id FROM public.cashout_requests cr
         WHERE cr.id = OLD.cashout_request_id;
      ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
        SELECT a.club_id INTO v_old_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
      ELSE
        v_old_club_id := OLD.club_id;
      END IF;
    END IF;
  END IF;

  -- A union row can use a club UUID without an FK back to clubs. Serialize
  -- that conversion with the retirement RPC so it cannot create a union
  -- identity from a club that became retired in the same instant.
  IF TG_TABLE_NAME = 'unions' AND v_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('cashier-hierarchy:' || v_club_id::text, 0)
    );
  END IF;

  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id IN (v_club_id, v_old_club_id) AND c.lifecycle_status = 'retired'
  ) THEN
    RAISE EXCEPTION 'CLUB_RETIRED: gameplay and cashier records are read-only'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.fn_guard_retired_club_mutation() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_guard_retired_club_mutation() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_retired_club_mutation() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_guard_retired_club_mutation() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_guard_retired_club_mutation()'::regprocedure)) IS DISTINCT FROM 'b82be212e7ccf2a15637c231861ff993' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_guard_retired_club_mutation()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_log_seat_stack_exit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stack numeric;
  v_kind  text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=OLD.table_id AND c.asset='diamonds') THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- A departed seat being tidied up is not an exit: its stack left when
    -- left_at was stamped, and that is already recorded below.
    IF OLD.left_at IS NOT NULL THEN RETURN OLD; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'deleted';
  ELSE
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN RETURN NEW; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'left';
  END IF;

  IF v_stack <= 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- CASH ONLY. A tournament stack is play money inside the event -- it credits
  -- no wallet when the seat ends, so it cannot be lost in the sense this table
  -- exists to detect. Filtering HERE rather than in the report keeps ~2,000
  -- meaningless rows an hour out of the audit trail entirely.
  IF EXISTS (SELECT 1 FROM public.tables t
              WHERE t.id = OLD.table_id AND t.tournament_id IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.ca_seat_stack_exits
    (seat_id, table_id, user_id, club_id, seat_number, stack, exit_kind, db_role, app_name)
  VALUES (OLD.id, OLD.table_id, OLD.user_id, OLD.club_id, OLD.seat_number,
          v_stack, v_kind, current_user,
          NULLIF(current_setting('application_name', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

ALTER FUNCTION public.fn_log_seat_stack_exit() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_log_seat_stack_exit() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_log_seat_stack_exit() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_log_seat_stack_exit() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_log_seat_stack_exit()'::regprocedure)) IS DISTINCT FROM '9ef7dad056ad5b5e745200ca83170c04' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_log_seat_stack_exit()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_new_seat_clear_sitout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.is_sitting_out := false;
  NEW.sit_out_at := NULL;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_new_seat_clear_sitout() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_new_seat_clear_sitout() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_new_seat_clear_sitout() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_new_seat_clear_sitout() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_new_seat_clear_sitout()'::regprocedure)) IS DISTINCT FROM 'c801ec89e83f06d5051bb4efdc38db22' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_new_seat_clear_sitout()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_no_live_seat_on_finished_game()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.status INTO v_status
    FROM public.tables tb
    JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_status IN ('COMPLETED', 'CANCELLED') THEN
    NEW.left_at := now();
    NEW.is_sitting_out := false;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_no_live_seat_on_finished_game() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_no_live_seat_on_finished_game() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_no_live_seat_on_finished_game() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_no_live_seat_on_finished_game() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_no_live_seat_on_finished_game()'::regprocedure)) IS DISTINCT FROM 'c8d1ca2128fc5f5405a194a46e298d47' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_no_live_seat_on_finished_game()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_notify_blinding_off()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_name text;
  v_stack text := '';
BEGIN
  BEGIN
    -- Only the moment they GO away, never the moment they come back, and never
    -- a repeat while they stay away.
    IF NOT (COALESCE(NEW.is_sitting_out, false) OR COALESCE(NEW.is_away, false)) THEN
      RETURN NEW;
    END IF;
    IF (COALESCE(OLD.is_sitting_out, false) OR COALESCE(OLD.is_away, false)) THEN
      RETURN NEW;
    END IF;
    -- A seat they have already left is not blinding off.
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;

    -- Tournaments only. A cash seat that sits out simply stops being dealt in;
    -- it is not paying blinds to be absent, so there is nothing urgent to say.
    SELECT t.tournament_id INTO v_tournament_id FROM public.tables t WHERE t.id = NEW.table_id;
    IF v_tournament_id IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT COALESCE(NULLIF(btrim(tn.name), ''), 'Your Tournament')
      INTO v_name FROM public.tournaments tn WHERE tn.id = v_tournament_id;
    v_name := COALESCE(v_name, 'Your Tournament');

    IF COALESCE(NEW.stack, 0) > 0 THEN
      v_stack := ' You have ' || to_char(round(NEW.stack), 'FM999,999,999,990') || ' chips left.';
    END IF;

    -- Copy carried over verbatim from notifyBlindingOff() so the intent that
    -- was already written and reviewed is preserved exactly.
    PERFORM public.fn_raise_notification(
      NEW.user_id,
      'tournament_blinding_off',
      'You Are Being Blinded Off',
      'Your seat in ' || v_name || ' is posting blinds without you.' || v_stack || ' Tap to take your seat.',
      '/table/' || NEW.table_id::text,
      jsonb_build_object('tableId', NEW.table_id, 'tournamentId', v_tournament_id, 'action', 'blinding_off')
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never let a notification interfere with the engine writing a seat.
    RAISE WARNING 'fn_notify_blinding_off failed for seat %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END; $function$;

ALTER FUNCTION public.fn_notify_blinding_off() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_notify_blinding_off() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_notify_blinding_off() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_notify_blinding_off() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_notify_blinding_off()'::regprocedure)) IS DISTINCT FROM '68022d5d999830f2fc014f191fa616e8' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_notify_blinding_off()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_on_table_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_terminal_now  boolean;
    v_terminal_before boolean;
    v_tournament_live boolean := false;
    v_seats int;
BEGIN
    v_terminal_now := lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished');
    v_terminal_before := lower(coalesce(OLD.status,'')) IN ('closed','completed','cancelled','finished');

    IF NEW.tournament_id IS NOT NULL THEN
        SELECT upper(coalesce(t.status,'')) NOT IN ('COMPLETED','CANCELLED')
          INTO v_tournament_live
          FROM public.tournaments t
         WHERE t.id = NEW.tournament_id;
        v_tournament_live := coalesce(v_tournament_live, false);
    END IF;

    -- A close releases the table's seats, UNLESS its tournament is still live,
    -- in which case the close is somebody else's mistake and the field plays on.
    IF v_terminal_now AND NOT v_terminal_before AND NOT v_tournament_live THEN
        /* PAY BEFORE RELEASING (2026-08-30). This released the seats and kept
           the chips: 1,036 exits worth 432,100.90 chips in a single day, every
           one a cash table. The refund has to happen first - after left_at is
           set the seat is no longer active and the stack cannot be reached.
           No-ops for tournament tables. */
        PERFORM public.fn_cashout_seats_for_closing_table(
                  NEW.id, 'table ' || coalesce(NEW.status,'closed'));

        UPDATE public.table_seats
           SET left_at = coalesce(NEW.updated_at, now())
         WHERE table_id = NEW.id
           AND left_at IS NULL;
    END IF;

    -- LOUD, and now NAMED. Only when the close strands players who are still
    -- seated; ordinary consolidation of an empty table is not an incident.
    IF v_terminal_now AND NOT v_terminal_before AND v_tournament_live THEN
        SELECT count(*)::int INTO v_seats
          FROM public.table_seats s
         WHERE s.table_id = NEW.id AND s.left_at IS NULL;

        IF v_seats > 0 THEN
            BEGIN
                INSERT INTO public.engine_recovery_events (table_id, event, detail, hand_count)
                VALUES (
                    NEW.id,
                    'table_closed_under_live_tournament',
                    jsonb_build_object(
                        'tournament_id',    NEW.tournament_id,
                        'old_status',       OLD.status,
                        'new_status',       NEW.status,
                        'seats_protected',  v_seats,
                        'application_name', coalesce(nullif(current_setting('application_name', true), ''), '(unset)'),
                        'db_role',          current_user,
                        'session_role',     session_user,
                        'client_addr',      coalesce(host(inet_client_addr()), '(local)'),
                        'txid',             txid_current()::text
                    )::text,
                    v_seats
                );
            EXCEPTION WHEN OTHERS THEN
                -- The log is a courtesy. It must never block a write.
                NULL;
            END;
        END IF;
    END IF;

    IF v_terminal_now <> v_terminal_before AND NEW.club_id IS NOT NULL THEN
        PERFORM public.fn_refresh_club_activity_counts(NEW.club_id);
    END IF;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_on_table_status_change() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_on_table_status_change() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_on_table_status_change() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_on_table_status_change() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_on_table_status_change()'::regprocedure)) IS DISTINCT FROM '1558760e483a714cc77e8645fe0a51fe' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_on_table_status_change()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_player_needs_a_started_game()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz;
  v_status  text;
  v_found   boolean := false;
BEGIN
  -- The WHEN clause already asks this; asked again so the refusal survives a
  -- trigger that is ever re-armed without one.
  IF NEW.status IS NULL OR NEW.status NOT IN ('eliminated', 'winner') THEN
    RETURN NULL;
  END IF;

  SELECT t.started_at, upper(COALESCE(t.status, '')), true
    INTO v_started, v_status, v_found
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;

  -- A parent removed later in the same transaction owes nothing.
  IF NOT COALESCE(v_found, false) THEN
    RETURN NULL;
  END IF;

  -- A terminal tournament records everyone out on purpose: cancellation
  -- refunds through exactly this write, and completion settles through it.
  IF v_status IN ('CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETING') THEN
    RETURN NULL;
  END IF;

  IF v_started IS NULL THEN
    RAISE EXCEPTION
      'tournament % never started: registration % cannot be recorded as %',
      NEW.tournament_id, NEW.id, NEW.status
      USING ERRCODE = 'P0404',
            HINT = 'A game that has not started cannot put a player out. Finish the launch, or cancel the tournament, before recording a result.';
  END IF;

  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_player_needs_a_started_game() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_player_needs_a_started_game() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_player_needs_a_started_game() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_player_needs_a_started_game() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_player_needs_a_started_game()'::regprocedure)) IS DISTINCT FROM 'b007e153e4bd41fb664255668c408831' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_player_needs_a_started_game()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_poker_bind_diamond_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_count integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NULL; END IF;
 /* A TOURNAMENT ENTRY BINDS ITS CUSTODY TO THE ENTRY, NEVER TO A SEAT. That
    is what lets one entry survive a table move, a balance and a re-seat: there
    is nothing seat-shaped on the row to re-point. Seating asserts the entry and
    touches no custody at all. */
 IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) IS NOT NULL THEN
   IF NOT EXISTS (
     SELECT 1 FROM public.tables t
       JOIN public.poker_diamond_custody c ON c.target_id=t.tournament_id
        AND c.user_id=NEW.user_id AND c.arena_id=t.club_id
        AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL
     WHERE t.id=NEW.table_id
   ) THEN
     RAISE EXCEPTION 'Diamond Tournament Seat Requires A Funded Entry' USING ERRCODE='P0810';
   END IF;
   RETURN NULL;
 END IF;
 UPDATE public.poker_diamond_custody
   SET seat_id=NEW.id,seat_joined_at=NEW.joined_at,occupancy_id=NEW.occupancy_id,state='active'
   WHERE user_id=NEW.user_id AND target_id=NEW.table_id AND purpose='cash_seat'
     AND entry_key='seat:'||NEW.id AND state='reserved' AND balance=NEW.stack AND seat_id IS NULL;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>1 THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $function$;

ALTER FUNCTION public.fn_poker_bind_diamond_seat() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_poker_bind_diamond_seat() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_poker_bind_diamond_seat() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_poker_bind_diamond_seat() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_poker_bind_diamond_seat()'::regprocedure)) IS DISTINCT FROM 'c14b4bbfaa71a58210f8de5726040a8c' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_poker_bind_diamond_seat()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_seat_keeps_custody()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ids uuid[];
BEGIN
 IF TG_OP='INSERT' THEN v_ids:=ARRAY[NEW.id];
 ELSIF TG_OP='DELETE' THEN v_ids:=ARRAY[OLD.id];
 ELSE v_ids:=ARRAY[OLD.id,NEW.id]; END IF;
 IF EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
   WHERE c.seat_id=ANY(v_ids) AND c.state='active' AND c.purpose='cash_seat'
     AND NOT EXISTS(SELECT 1 FROM public.table_seats s
       WHERE s.id=c.seat_id AND s.joined_at=c.seat_joined_at
         AND s.occupancy_id=c.occupancy_id AND s.user_id=c.user_id
         AND s.table_id=c.target_id AND s.club_id=c.arena_id
         AND s.left_at IS NULL AND s.stack=c.balance)
 ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.purpose='cash_seat' AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 /* A DIAMOND TOURNAMENT SEAT HOLDS AN ENTRY, NOT A BALANCE. The stack is a
    nonredeemable play unit and bears no relation to custody, so nothing in
    this arm compares it to anything. What must be true at every commit is that
    the seat is covered by a live funded entry for THIS event, held against the
    tournament and not against the seat. */
 IF EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.user_id=s.user_id AND c.target_id=t.tournament_id AND c.arena_id=s.club_id
         AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL)
 ) THEN
   RAISE EXCEPTION 'A Diamond Tournament Seat Must Hold Its Funded Entry' USING ERRCODE='P0812';
 END IF;
 RETURN NULL;
END $function$;

ALTER FUNCTION public.fn_poker_diamond_seat_keeps_custody() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_poker_diamond_seat_keeps_custody()'::regprocedure)) IS DISTINCT FROM 'd80aed613a97e567268cb2bf6fdfd094' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_poker_diamond_seat_keeps_custody()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_poker_guard_arena_structure()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_asset text;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    IF TG_OP='UPDATE' AND (NEW.asset,NEW.is_platform) IS DISTINCT FROM (OLD.asset,OLD.is_platform) THEN
      RAISE EXCEPTION 'Arena Asset Is Immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.asset='diamonds' AND auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Arena Requires Platform Operations' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT asset INTO v_asset FROM public.clubs WHERE id=NEW.club_id;
  IF TG_TABLE_NAME='club_members' AND TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
     AND EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Participation Cannot Become A Chip Membership' USING ERRCODE='23514';
  END IF;
  -- Branch before resolving fields: membership rows do not have union_id.
  IF TG_TABLE_NAME IN ('tables','tournaments') THEN
    IF TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
       AND (EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset IS DISTINCT FROM v_asset)
         OR (OLD.club_id IS NULL AND OLD.union_id IS NOT NULL AND v_asset='diamonds')) THEN
      RAISE EXCEPTION 'Game Asset Is Immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF v_asset='diamonds' THEN
    IF TG_TABLE_NAME='club_members' THEN
      IF TG_OP='INSERT' OR NEW.role IS DISTINCT FROM 'player' OR NEW.status IS DISTINCT FROM 'automatic'
         OR NEW.agent_id IS NOT NULL OR NEW.parent_agent_id IS NOT NULL
         OR coalesce(NEW.chip_balance,0)<>0 OR coalesce(NEW.credit_limit,0)<>0
         OR coalesce(NEW.credit_used,0)<>0 OR coalesce(NEW.promo_balance,0)<>0
         OR coalesce(NEW.held_chips,0)<>0 THEN
        RAISE EXCEPTION 'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='union_clubs' THEN
      RAISE EXCEPTION 'Diamond Arena Cannot Join A Union' USING ERRCODE='23514';
    ELSIF auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false)
       -- DIAMOND PHASE 8: a player's entry, add-on and withdrawal move the
       -- play-state counters through the estate's doors; the structure is
       -- still platform operations only.
       AND NOT (TG_OP='UPDATE' AND TG_TABLE_NAME IN ('tournaments','tables')
                AND (to_jsonb(NEW) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))
                  = (to_jsonb(OLD) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))) THEN
      RAISE EXCEPTION 'Diamond Games Require Platform Operations' USING ERRCODE='42501';
    ELSIF NEW.union_id IS NOT NULL THEN
      RAISE EXCEPTION 'Diamond Games Cannot Belong To A Union' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_poker_guard_arena_structure() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_poker_guard_arena_structure() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_poker_guard_arena_structure() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_poker_guard_arena_structure() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_poker_guard_arena_structure()'::regprocedure)) IS DISTINCT FROM 'f17675dd0b647abda7b0b9d8772c9c0e' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_poker_guard_arena_structure()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_poker_guard_chip_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NEW; END IF;
 IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) IS NULL THEN
   /* A CASH SEAT IS ITS CUSTODY. The stack a player sits down with IS the
      Diamonds held for that seat, which is why a cash-out can pay the stack.
      This block is the live rule, unchanged. */
   IF TG_OP<>'INSERT' OR NOT EXISTS (
     SELECT 1 FROM public.poker_diamond_custody c
       JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
     WHERE c.user_id=NEW.user_id AND c.target_id=NEW.table_id AND c.purpose='cash_seat'
       AND c.entry_key='seat:'||NEW.id AND c.state='reserved' AND c.balance=NEW.stack
       AND c.seat_id IS NULL AND a.cash_games_enabled
   ) THEN
     RAISE EXCEPTION 'Diamond Seat Requires Atomic Custody Funding' USING ERRCODE='23514';
   END IF;
 ELSE
   /* A TOURNAMENT SEAT IS NOT ITS CUSTODY. The stack is a nonredeemable play
      unit; the money is the ENTRY, held against the tournament. So the seat is
      admitted by a funded live entry and by NO equation with the stack. */
   IF NOT EXISTS (
     SELECT 1 FROM public.tables t
       JOIN public.poker_diamond_custody c ON c.target_id=t.tournament_id
        AND c.user_id=NEW.user_id AND c.arena_id=t.club_id
        AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL
       JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
     WHERE t.id=NEW.table_id AND a.tournaments_enabled
   ) THEN
     RAISE EXCEPTION 'Diamond Tournament Seat Requires A Funded Entry' USING ERRCODE='P0810';
   END IF;
   /* One entry buys one event. Balancing may move the seat from table to table
      inside that event, and nowhere else. */
   IF TG_OP='UPDATE' THEN
     IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=OLD.table_id)
        IS DISTINCT FROM (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) THEN
       RAISE EXCEPTION 'A Diamond Tournament Seat Moves Only Inside Its Own Tournament'
         USING ERRCODE='P0811';
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_poker_guard_chip_seat() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_poker_guard_chip_seat() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_poker_guard_chip_seat() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_poker_guard_chip_seat() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_poker_guard_chip_seat()'::regprocedure)) IS DISTINCT FROM '3326766760c7b9c9bfe12daca34ebd0f' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_poker_guard_chip_seat()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_refuse_new_entries_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_cash boolean;
BEGIN
  /* Classify non-admissions before asking for the boundary. Departures,
     ordinary seat updates, tournament table balancing, earned satellite
     seats, and non-RUNNING status changes can arrive inside transactions that
     already own their own rows. They are not new entry and must never acquire
     this lock late. */
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'UPDATE'
       AND NOT (
         (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL)
         OR OLD.user_id IS DISTINCT FROM NEW.user_id
       ) THEN
      RETURN NEW;
    END IF;

    SELECT (t.tournament_id IS NULL) INTO v_is_cash
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    /* Tournament seating is movement inside an already-admitted field. This
       includes INSERT and reuse of a vacated destination row (UPDATE that
       clears left_at or changes user_id). Freezing the latter after its source
       seat was vacated strands a player between tables. New tournament entry
       remains guarded at tournament_players and in its canonical outer RPC. */
    IF NOT COALESCE(v_is_cash, true) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'tournaments' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'RUNNING' THEN
      RETURN NEW;
    END IF;
    /* This is not a new launch: fn_begin_tournament_launch_atomic already
       admitted it before the maintenance boundary. Only the private completion
       RPC can set this exact transaction-local marker, and the immutable
       incomplete receipt proves which launch it is completing. */
    IF OLD.status = 'REGISTERING'
       AND EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_tournament_launch', true)
                = NEW.id::text || ':' || r.launch_id::text
       ) THEN
      RETURN NEW;
    END IF;
    /* A BAGGED EVENT RESUMES ONLY THROUGH ITS STAGE RESUME RECEIPT
       (multi-day, 20260924043224). The private resume completion RPC sets
       this exact transaction-local marker, the incomplete receipt proves
       which resume it completes, and its begin already took the
       maintenance barrier. Every other write into RUNNING still raises. */
    IF OLD.status = 'BAGGED'
       AND EXISTS (
         SELECT 1
           FROM public.tournament_stage_resume_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_stage_resume', true)
                = NEW.id::text || ':' || r.resume_id::text
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_LAUNCH_RECEIPT_REQUIRED: REGISTERING to RUNNING belongs to the atomic launch completion RPC'
      USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    /* Every roster insertion must serialize on its tournament parent before
       launch completion proves the field. Canonical registration functions
       already take this lock before their first child mutation, so this is
       re-entrant there; it closes the direct-owner/legacy path that could
       otherwise commit a new registered row between completion's roster read
       and its RUNNING write. */
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
        USING ERRCODE = '23503';
    END IF;

    IF COALESCE(NEW.is_satellite_qualifier, false)
       AND NEW.source_satellite_id IS NOT NULL
       AND current_setting('app.atomic_satellite_settlement', true)
           = NEW.source_satellite_id::text THEN
      RETURN NEW;
    END IF;
  END IF;

  /* Canonical RPCs own this already, so try-lock is re-entrant. A direct or
     previously unknown outer caller fails without waiting while it may hold
     other rows; this is the deadlock-safe backstop, not the normal path. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN NEW;
  END IF;

  IF NOT public.fn_entry_purchases_frozen() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'PLATFORM_FROZEN: scheduled maintenance has closed new entries. % on % was refused without moving chips.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55006',
          HINT = 'Retry after the maintenance break has ended.';
END;
$function$;

ALTER FUNCTION public.fn_refuse_new_entries_while_frozen() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_refuse_new_entries_while_frozen() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_refuse_new_entries_while_frozen() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_refuse_new_entries_while_frozen() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_refuse_new_entries_while_frozen()'::regprocedure)) IS DISTINCT FROM '7d7bd629403539eb069ac20afc62b547' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_refuse_new_entries_while_frozen()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_refuse_reentry_with_pending_bounty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status='eliminated' AND NEW.status='playing'
     AND EXISTS (SELECT 1 FROM public.tournament_bounty_obligations o
                  WHERE o.tournament_id=NEW.tournament_id
                    AND o.eliminated_user_id=NEW.user_id AND o.state='pending') THEN
    RAISE EXCEPTION 'prior bounty obligation is still pending for tournament %, player %',
      NEW.tournament_id, NEW.user_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_refuse_reentry_with_pending_bounty() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_refuse_reentry_with_pending_bounty() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_refuse_reentry_with_pending_bounty() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_refuse_reentry_with_pending_bounty()'::regprocedure)) IS DISTINCT FROM 'f08a8f5318184e14f8bc8e173d3d56f3' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_refuse_reentry_with_pending_bounty()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_refuse_seat_on_closed_cluster_table()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lifecycle text;
  v_cluster uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT cluster_id, lifecycle INTO v_cluster, v_lifecycle FROM public.tables WHERE id = NEW.table_id;
  IF v_cluster IS NULL THEN RETURN NEW; END IF;
  IF v_lifecycle IN ('breaking', 'closed') THEN
    RAISE EXCEPTION 'TABLE_CLOSING: this table is % and takes no new players - the game will seat you at its next open table', v_lifecycle
      USING ERRCODE = 'check_violation';
  END IF;
  -- ONE SEAT PER GAME (2026-09-05). A must-move game is one game however many
  -- tables it has; a player holds one chair in it. The executor, changing that
  -- chair, declares itself and is let through; everybody else is refused.
  IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
     AND NEW.user_id IS NOT NULL
     AND EXISTS (SELECT 1
                   FROM public.table_seats ts
                   JOIN public.tables t ON t.id = ts.table_id
                  WHERE ts.user_id = NEW.user_id
                    AND ts.left_at IS NULL
                    AND ts.id IS DISTINCT FROM NEW.id
                    AND t.cluster_id = v_cluster
                    AND t.id <> NEW.table_id
                    AND t.lifecycle <> 'closed') THEN
    RAISE EXCEPTION 'ALREADY_IN_GAME: you already have a seat in this game - the game moves you between its tables itself'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_refuse_seat_on_closed_cluster_table() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_refuse_seat_on_closed_cluster_table() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_refuse_seat_on_closed_cluster_table() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_refuse_seat_on_closed_cluster_table() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_refuse_seat_on_closed_cluster_table()'::regprocedure)) IS DISTINCT FROM '5ce84d41cb75c61791d1250e35deb5fe' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_refuse_seat_on_closed_cluster_table()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ONBOARDING NEVER FREEZES (to-do #2563 item 1). A membership row carrying
  -- no chips is identity, not money. This table, INSERT only, zero balance.
  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- CHIP STANDARD (2026-09-05): A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A
  -- WRITE. When a balance write was permitted (a money table outside this
  -- guard, or a permitted role), its chip_ledger leg is written by the
  -- autoledger inside that same statement, at trigger depth 2 or more.
  -- Refusing the leg while the write stands is the one outcome the standard
  -- cannot allow: 104 BBJ bank moves (9.69 chips) lost their legs this way at :55 and
  -- :00 up to 09-05 06:58 (ca_ledger_write_failures, sqlstate 55006), each one an unexplained movement on the BBJ meter. A direct
  -- INSERT on chip_ledger from a client (depth 1) is still refused.
  IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

ALTER FUNCTION public.fn_refuse_while_frozen() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_refuse_while_frozen() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_refuse_while_frozen() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_refuse_while_frozen() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_refuse_while_frozen()'::regprocedure)) IS DISTINCT FROM '3a866372172806a8a69cc3d37413f0cc' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_refuse_while_frozen()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_refuse_zero_chip_field_elimination()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live int;
  v_zero int;
  v_status text;
BEGIN
  -- Only a transition INTO elimination, from a live seat, at zero chips.
  IF NEW.status <> 'eliminated' OR OLD.status <> 'playing' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.chips, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE COALESCE(chips, 0) <= 0)
    INTO v_live, v_zero
    FROM public.tournament_players
   WHERE tournament_id = NEW.tournament_id
     AND status = 'playing';

  -- More than one player left and NONE of them has a chip: the table has not
  -- been credited. Bust nobody. (At exactly one remaining player this is the
  -- legitimate "everybody busted in the same hand" tail, which the engine
  -- resolves by naming the last one out the winner - leave that alone.)
  IF v_live > 1 AND v_zero = v_live THEN
    SELECT upper(COALESCE(t.status, '')) INTO v_status
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;

    -- ...unless the event is already over. Nothing is going to credit those
    -- stacks now, and holding the write means the place stays unowned and
    -- unpayable forever. Refusing to bust somebody in a finished tournament
    -- does not protect them; it withholds their money.
    IF v_status IN ('COMPLETED', 'CANCELLED', 'CANCELED') THEN
      RAISE WARNING
        'allowing elimination in % (%): all % live player(s) read 0 chips, but the event is terminal - recording the finish',
        NEW.tournament_id, v_status, v_live;
      RETURN NEW;
    END IF;

    RAISE WARNING
      'refused elimination in %: all % live player(s) read 0 chips - uncredited stacks, not a bust',
      NEW.tournament_id, v_live;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_refuse_zero_chip_field_elimination() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_refuse_zero_chip_field_elimination() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_refuse_zero_chip_field_elimination() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_refuse_zero_chip_field_elimination() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_refuse_zero_chip_field_elimination()'::regprocedure)) IS DISTINCT FROM '97d03afb414b95e0f3bd959df6075c2c' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_refuse_zero_chip_field_elimination()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_require_live_seat_parent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE parent_key text;
BEGIN
 IF NEW.left_at IS NOT NULL THEN
  NEW.active_parent_key := NULL;
  RETURN NEW;
 END IF;
 SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active seat requires an existing parent table' USING ERRCODE='23514'; END IF;
 IF parent_key IS NULL THEN
  -- Only a pre-migration empty parent needs this initialization. Ordinary
  -- admissions do not update/lock the parent ahead of the native FK check.
  UPDATE public.tables t SET seat_admission_key = CASE
    WHEN lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished')
      OR t.lifecycle='closed' OR coalesce(t.is_deleted,false) OR coalesce(t.is_template,false) THEN 'closed'
    WHEN t.tournament_id IS NOT NULL THEN 'tournament:'||t.tournament_id::text
    ELSE 'cash' END
  WHERE t.id=NEW.table_id AND t.seat_admission_key IS NULL;
  SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 END IF;
 IF parent_key IS NULL OR parent_key='closed' THEN
  RAISE EXCEPTION 'CLOSED_TABLE_REJECTS_ACTIVE_SEAT' USING ERRCODE='23514';
 END IF;

 IF TG_OP='INSERT' OR OLD.left_at IS NOT NULL
   OR OLD.table_id IS DISTINCT FROM NEW.table_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
  IF (current_setting('app.money_path',true) IN ('atomic_table_buyin','fn_horse_seat_from_treasury')
      OR current_setting('app.cash_seat_move',true)='on') AND parent_key<>'cash' THEN
   RAISE EXCEPTION 'CASH_PURCHASE_ONLY: cash admission cannot create tournament chips' USING ERRCODE='55000';
  END IF;
 END IF;
 NEW.active_parent_key := parent_key;
 RETURN NEW;
END
$function$;

ALTER FUNCTION public.fn_require_live_seat_parent() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_require_live_seat_parent() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_require_live_seat_parent() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_require_live_seat_parent()'::regprocedure)) IS DISTINCT FROM '799eb3f8788b5ee10e98da69cf52c12e' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_require_live_seat_parent()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_status text;
  v_acquisition_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_target_key bigint;
  v_owns_acquisition_root boolean:=false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.is_satellite_qualifier IS DISTINCT FROM OLD.is_satellite_qualifier
       OR NEW.source_satellite_id IS DISTINCT FROM OLD.source_satellite_id) THEN
    RAISE EXCEPTION 'tournament player ownership and entry provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,OLD.source_satellite_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,NEW.source_satellite_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = OLD.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = NEW.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  -- Ticket admission and an exact pre-start ticket return are the only
  -- lifecycle edges that may respectively add or remove provenance after the
  -- source satellite has closed. Both are authorities of the TARGET event,
  -- the row's own tournament, and hold its lane: T(target) exclusively for
  -- the rolling admission and unregistration doors, G exclusively for the
  -- terminal satellite delivery and ticket-return authorities. Either
  -- exclusive hold is the proof (2026-09-10); a shared hold of either key is
  -- not, and no canonical writer holds T(source) in place of T(target).
  -- Holding G shared, an admission still waits for the source satellite's
  -- terminal settlement, so the committed-receipt read below stays stable.
  -- The unregistration wrapper additionally exposes its exact operation while
  -- the owner-only core is active; a raw DELETE therefore cannot masquerade as
  -- a ticket return merely by reaching this trigger.
  IF TG_OP IN ('INSERT','DELETE') THEN
    v_target_key:=hashtextextended(
      'ca:tournament-terminal-settlement:v1:'||(CASE WHEN TG_OP='INSERT'
        THEN NEW.tournament_id ELSE OLD.tournament_id END)::text,0);
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid=pg_backend_pid()
         AND l.locktype='advisory'
         AND l.database=(
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname=current_database())
         AND ((l.classid=(((v_acquisition_key>>32)&4294967295)::oid)
               AND l.objid=((v_acquisition_key&4294967295)::oid))
           OR (l.classid=(((v_target_key>>32)&4294967295)::oid)
               AND l.objid=((v_target_key&4294967295)::oid)))
         AND l.objsubid=1
         AND l.mode='ExclusiveLock'
         AND l.granted)
      INTO v_owns_acquisition_root;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    -- The rolling satellite authority owns target before source. Take both
    -- roots in that same order so a direct provenance insert cannot invert
    -- the pair across its specialized and generic guards.
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite provenance'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOREACH v_source_id IN ARRAY v_source_ids LOOP
      IF v_source_id IS DISTINCT FROM NEW.tournament_id THEN
        SELECT upper(COALESCE(t.status::text,'')) INTO v_status
          FROM public.tournaments t
         WHERE t.id = v_source_id FOR SHARE;
        IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
           AND NOT COALESCE(v_owns_acquisition_root,false) THEN
          RAISE EXCEPTION 'completed satellite target provenance is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NOT (
       (TG_OP='INSERT' AND COALESCE(v_owns_acquisition_root,false))
       OR (TG_OP='DELETE'
           AND COALESCE(v_owns_acquisition_root,false)
           AND COALESCE(current_setting(
                 'app.tournament_seat_exit_operation',true),'')='unregister')
     )
     AND EXISTS (
    SELECT 1 FROM unnest(v_source_ids) source(id)
     WHERE public.fn_ca_has_committed_tournament_receipt(source.id)
  ) THEN
    RAISE EXCEPTION 'completed satellite target provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_satellite_target_player_provenance_is_immutable() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_satellite_target_player_provenance_is_immutable() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_satellite_target_player_provenance_is_immutable() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_satellite_target_player_provenance_is_immutable()'::regprocedure)) IS DISTINCT FROM '68f98d4ec2cb186aae11787f1666cffc' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_satellite_target_player_provenance_is_immutable()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_seat_change_syncs_seat_first_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_table_id uuid;
  v_tid uuid;
BEGIN
  v_table_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  IF v_table_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT tournament_id INTO v_tid
    FROM public.tables
   WHERE id = v_table_id;
  IF v_tid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.id = v_tid
       AND public.fn_ca_tournament_recorded_seat_first(t.id, true)
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM public.fn_sync_seat_first_player_count(v_tid);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

ALTER FUNCTION public.fn_seat_change_syncs_seat_first_count() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_seat_change_syncs_seat_first_count() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_seat_change_syncs_seat_first_count() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_seat_change_syncs_seat_first_count()'::regprocedure)) IS DISTINCT FROM '3d222458b40d5aec09f8f1e88bf60d53' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_seat_change_syncs_seat_first_count()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_seat_insert_cancel_waitlist()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.table_waitlist
     SET status = 'seated'
   WHERE table_id = NEW.table_id
     AND user_id  = NEW.user_id
     AND status IN ('waiting', 'notified');
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_seat_insert_cancel_waitlist() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_seat_insert_cancel_waitlist() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_seat_insert_cancel_waitlist() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_seat_insert_cancel_waitlist() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_seat_insert_cancel_waitlist()'::regprocedure)) IS DISTINCT FROM '9bf8481f945f641918a4b044c8138aa4' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_seat_insert_cancel_waitlist()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_serialize_entry_statement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* This is a backstop for a direct/unwrapped INSERT. A canonical RPC already
     owns the shared lock before touching any rows. An unexpected outer caller
     may already own unrelated rows, so waiting behind a queued maintenance
     writer here could form a soft deadlock. Fail the whole statement
     immediately and transactionally instead; the caller may retry from its
     outer boundary. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_serialize_entry_statement() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_serialize_entry_statement() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_serialize_entry_statement() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_serialize_entry_statement()'::regprocedure)) IS DISTINCT FROM '4ecec1cba7db73f67f44fe08f3791536' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_serialize_entry_statement()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_active_seat_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    NEW.active_game_scope := NULL;
  ELSE
    SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
    IF NOT FOUND OR NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'Active seat requires an existing table and player' USING ERRCODE='23514';
    END IF;
    IF NEW.active_game_scope IS NULL THEN
      -- A pre-migration empty table has no cached scope. Initialize only that
      -- parent, inside this admission transaction. Existing occupied tables
      -- never take this UPDATE path. Concurrent initialization is idempotent.
      UPDATE public.tables t SET seat_game_scope = CASE WHEN t.cluster_id IS NULL
        THEN 'table:'||t.id::text ELSE 'cluster:'||t.cluster_id::text END
      WHERE t.id=NEW.table_id AND t.seat_game_scope IS NULL;
      SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
      IF NEW.active_game_scope IS NULL THEN
        RAISE EXCEPTION 'Active seat parent scope initialization failed' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.fn_stamp_active_seat_game_scope() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_active_seat_game_scope() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_active_seat_game_scope() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_active_seat_game_scope()'::regprocedure)) IS DISTINCT FROM 'd271007d2e1b1f4daa83bfc295d47c1e' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_active_seat_game_scope()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_entry_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.club_id IS NULL AND NEW.user_id IS NOT NULL AND NEW.tournament_id IS NOT NULL THEN
    NEW.club_id := public.fn_tournament_club_for_user(NEW.user_id, NEW.tournament_id, NULL);
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_stamp_entry_club() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_entry_club() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_entry_club() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_stamp_entry_club() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_entry_club()'::regprocedure)) IS DISTINCT FROM '1f47891ae5cbb8a1e8dbb495a710bd20' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_entry_club()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- A SEAT KEEPS THE CLUB IT WAS SEATED UNDER (2026-09-10). Nothing that the
  -- stamp is derived from changed, and the seat already carries a club, so
  -- there is nothing to derive. This was 6.0 ms of club_members lookups on
  -- every stack write; see the migration header.
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
     AND NEW.club_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NOT NULL AND NEW.table_id IS NOT NULL THEN
    NEW.club_id := COALESCE(
      public.fn_seat_club_for_user(NEW.user_id, NEW.table_id, NEW.club_id),
      NEW.club_id
    );
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.fn_stamp_seat_club() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_seat_club() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_seat_club() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_stamp_seat_club() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_seat_club()'::regprocedure)) IS DISTINCT FROM '467104f7e791b76328ce5e20b42ba81b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_seat_club()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_horse_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.horse_id := NULL;
    RETURN NEW;
  END IF;

  SELECT CASE WHEN COALESCE(p.is_horse, false) THEN p.id ELSE NULL END
    INTO NEW.horse_id
    FROM public.profiles p
   WHERE p.id = NEW.user_id;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_stamp_seat_horse_id() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_seat_horse_id() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_seat_horse_id() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_stamp_seat_horse_id() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_seat_horse_id()'::regprocedure)) IS DISTINCT FROM '3c659ba826e3a3296cdfd74911164185' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_seat_horse_id()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_occupancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.table_id IS DISTINCT FROM NEW.table_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
     OR (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id THEN
    RAISE EXCEPTION 'SEAT_OCCUPANCY_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_stamp_seat_occupancy() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_seat_occupancy() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_seat_occupancy() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_seat_occupancy()'::regprocedure)) IS DISTINCT FROM '4d2645a24bd3b88d7ffc51097b37d640' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_seat_occupancy()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_sit_out_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.sit_out_at := CASE WHEN COALESCE(NEW.is_sitting_out, false)
                           THEN COALESCE(NEW.sit_out_at, now())
                           ELSE NULL END;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_sitting_out, false) AND NOT COALESCE(OLD.is_sitting_out, false) THEN
    -- Entering sit-out: start the clock.
    NEW.sit_out_at := now();
  ELSIF NOT COALESCE(NEW.is_sitting_out, false) THEN
    -- Not sitting out, by any route (sat back in, seat turned over, evicted).
    NEW.sit_out_at := NULL;
  ELSIF public.fn_freeze_bypass_active()
        AND NEW.sit_out_at IS NOT NULL
        AND NEW.sit_out_at IS DISTINCT FROM OLD.sit_out_at THEN
    -- Still sitting out, and the writer is the THAW (the only transaction
    -- that runs under app.freeze_bypass). It is giving this clock back the
    -- minutes the freeze took; honour the value it supplied.
    NULL;
  ELSE
    -- Still sitting out. HOLD THE ORIGINAL STAMP. An unrelated UPDATE to the
    -- row (a stack change, a time-bank decrement, a status write) must NOT
    -- restart the five minutes.
    NEW.sit_out_at := COALESCE(OLD.sit_out_at, NEW.sit_out_at, now());
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_stamp_sit_out_at() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_sit_out_at() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_sit_out_at() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_stamp_sit_out_at() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_sit_out_at()'::regprocedure)) IS DISTINCT FROM '6443901e814681a3518e6781068c8fea' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_sit_out_at()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_table_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.seat_game_scope := CASE WHEN NEW.cluster_id IS NULL
    THEN 'table:'||NEW.id::text ELSE 'cluster:'||NEW.cluster_id::text END;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.fn_stamp_table_game_scope() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_table_game_scope() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_table_game_scope() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_table_game_scope()'::regprocedure)) IS DISTINCT FROM '30cd14f9ff42850835c1f0bb624a0873' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_table_game_scope()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_table_seat_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 NEW.seat_admission_key := CASE
   WHEN lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished')
     OR NEW.lifecycle='closed' OR coalesce(NEW.is_deleted,false) OR coalesce(NEW.is_template,false) THEN 'closed'
   WHEN NEW.tournament_id IS NOT NULL THEN 'tournament:'||NEW.tournament_id::text
   ELSE 'cash' END;
 RETURN NEW;
END
$function$;

ALTER FUNCTION public.fn_stamp_table_seat_admission() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_table_seat_admission() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_table_seat_admission() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_table_seat_admission()'::regprocedure)) IS DISTINCT FROM '9c5d3aee9f48697db3ea08807df46527' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_table_seat_admission()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_table_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;               -- private games are never union-visible
    RETURN NEW;
  END IF;

  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      -- The union's OWN house club is not a union_clubs member; it carries the
      -- union on its clubs row. Without this, house-club games are unstamped
      -- and therefore invisible in every club lobby.
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
    IF v_union IS NOT NULL THEN NEW.union_id := v_union; END IF;
  END IF;

  -- A union game belongs to the UNION, not to whichever member club happened to
  -- create it. Point club_id at the union's own container row so every surface
  -- agrees on who runs the game.
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;

  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_stamp_table_union_ownership() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_table_union_ownership() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_table_union_ownership() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_stamp_table_union_ownership() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_table_union_ownership()'::regprocedure)) IS DISTINCT FROM 'adf012b27a178a70603ee15e92f87c0d' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_table_union_ownership()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_elimination_sequence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'eliminated' THEN
      NEW.elimination_sequence := nextval(
        'public.tournament_player_elimination_sequence'::regclass);
    ELSE
      NEW.elimination_sequence := NULL;
    END IF;
  ELSIF OLD.status::text IS DISTINCT FROM 'eliminated'
        AND NEW.status::text = 'eliminated' THEN
    NEW.elimination_sequence := nextval(
      'public.tournament_player_elimination_sequence'::regclass);
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text IS DISTINCT FROM 'eliminated' THEN
    NEW.elimination_sequence := NULL;
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text = 'eliminated'
        AND OLD.elimination_sequence IS NULL
        AND NEW.elimination_sequence IS NOT NULL THEN
    -- 2026-09-20. A row that was already 'eliminated' when this trigger was
    -- introduced can never transition INTO 'eliminated' again, so it could
    -- never acquire the stamp this trigger exists to give it, and every
    -- repair was refused below as database-owned. Permit exactly that one
    -- acquisition: NULL -> a value, on a row that is already eliminated.
    -- Changing a stamp that EXISTS is still refused, so a sequence is still
    -- write-once; tournament_players_one_elimination_sequence keeps it
    -- unique within the event and the CHECK keeps it positive.
    NULL;
  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
    RAISE EXCEPTION 'elimination_sequence is database-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_stamp_tournament_elimination_sequence() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_stamp_tournament_elimination_sequence() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_stamp_tournament_elimination_sequence() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_stamp_tournament_elimination_sequence()'::regprocedure)) IS DISTINCT FROM '1da72fa956566502be6d6c8d46ba6d2a' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_stamp_tournament_elimination_sequence()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_sync_club_table_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clubs uuid[];
  v_unions uuid[];
BEGIN
  -- Both sides, so a table MOVING between clubs or unions fixes the club it
  -- left as well as the one it joined.
  v_clubs := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.club_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.club_id END
  ], NULL);
  v_unions := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.union_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.union_id END
  ], NULL);

  IF cardinality(v_clubs) > 0 THEN
    UPDATE clubs SET table_count = fn_live_table_count(id) WHERE id = ANY(v_clubs);
  END IF;

  -- Every club that can see a touched union's tables (members + the union row).
  IF cardinality(v_unions) > 0 THEN
    UPDATE clubs SET table_count = fn_live_table_count(id)
     WHERE id = ANY(v_unions)
        OR id IN (SELECT club_id FROM union_clubs WHERE union_id = ANY(v_unions));
  END IF;

  RETURN NULL;
END $function$;

ALTER FUNCTION public.fn_sync_club_table_counts() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_sync_club_table_counts() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_sync_club_table_counts() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_sync_club_table_counts() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_sync_club_table_counts()'::regprocedure)) IS DISTINCT FROM '960a3c64c28448700907d886e49b941b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_sync_club_table_counts()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_sync_tournament_current_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tid uuid;
  v_count integer;
BEGIN
  v_tid := COALESCE(NEW.tournament_id, OLD.tournament_id);
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tournament_players
  WHERE tournament_id = v_tid
    AND status IN ('registered', 'playing');

  UPDATE public.tournaments
     SET current_players = v_count
   WHERE id = v_tid
     AND status IN ('ANNOUNCED', 'REGISTERING')
     AND current_players IS DISTINCT FROM v_count;

  /* A RUNNING FIELD IS COUNTED BY THE BUST THAT SHRINKS IT (2026-09-22).
     The statement above is pre-start only, on purpose, and nothing else
     counted a RUNNING field: a bust left the count one too high until a
     minutely job (reconcile-tournament-denormals) rewrote it, and the
     registration door refuses a late entrant while the count and the roster
     disagree. A player moving into or out of the field is recounted here, in
     the transaction that moves them.

     Only a MEMBERSHIP change on UPDATE. An admission (INSERT) or a removal
     (DELETE) into a RUNNING field is counted by the door that performs it:
     the registration, horse and satellite-seat doors publish the new count
     themselves and require this trigger to leave a RUNNING count alone.

     Seat-first formats are skipped with the predicate their own owner uses
     (fn_sync_seat_first_player_count, live seats on the primary table), so
     the two writers partition the column and never write the same event.

     The tournaments row is already locked FOR UPDATE by this transaction:
     every membership change takes it first, in
     aa_tournament_player_launch_proof_lock. */
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND (COALESCE(OLD.status, '') IN ('registered', 'playing'))
         IS DISTINCT FROM (COALESCE(NEW.status, '') IN ('registered', 'playing')) THEN
    UPDATE public.tournaments t
       SET current_players = v_count
     WHERE t.id = v_tid
       AND t.status = 'RUNNING'
       AND t.current_players IS DISTINCT FROM v_count
       AND NOT public.fn_ca_tournament_recorded_seat_first(t.id, true);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

ALTER FUNCTION public.fn_sync_tournament_current_players() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_sync_tournament_current_players() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_sync_tournament_current_players() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_sync_tournament_current_players() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_sync_tournament_current_players()'::regprocedure)) IS DISTINCT FROM '3fd8f2c2f0866754467266a6bc5b6d80' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_sync_tournament_current_players()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_table_seats_lightning_anchor_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ps     uuid;
  v_player uuid;
  v_cluster uuid;
  v_hand   uuid;
BEGIN
  -- A SEAT THAT ANCHORS AN OPEN POOL SESSION IS NOT DELETED (BEFORE DELETE,
  -- file D). There is no foreign key to hold the anchor, by design; this is
  -- what holds it. The buy-in's DELETE of a departed occupant's row is untouched:
  -- a departure exits the session at the commit that records it, so by the
  -- time anyone deletes that row it anchors nothing open.
  IF TG_OP = 'DELETE' THEN
    SELECT ps.id, ps.player_id, ps.cluster_id INTO v_ps, v_player, v_cluster
      FROM public.lightning_pool_session ps
     WHERE ps.anchor_seat_id = OLD.id AND ps.exited_at IS NULL;
    IF v_ps IS NULL THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'LIGHTNING_ANCHOR_SEAT_IS_IN_THE_POOL: seat % anchors open pool session % of player % in Cluster %; a seat can be deleted once the pool session it anchors has exited',
      OLD.id, v_ps, v_player, v_cluster USING ERRCODE = 'PLT01';
  END IF;

  SELECT ps.id, ps.player_id, ps.cluster_id INTO v_ps, v_player, v_cluster
    FROM public.lightning_pool_session ps
   WHERE ps.anchor_seat_id = OLD.id AND ps.exited_at IS NULL;
  IF v_ps IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.fn_lightning_player_in_hand(v_player, v_cluster) THEN
    RETURN NEW;
  END IF;

  SELECT i.hand_id INTO v_hand
    FROM public.lightning_reservation r
    JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
   WHERE r.cluster_id = v_cluster AND r.player_id = v_player AND r.state = 'committed'
     AND i.state IN ('forming', 'reserved', 'dealing', 'settling')
   ORDER BY i.created_at DESC, i.id
   LIMIT 1;

  -- THE ONE WRITER ALLOWED THROUGH is the settlement of THAT hand, which names
  -- it in ca.lightning_settlement_hand for its own transaction. Any other
  -- value, or none, is refused.
  IF v_hand IS NOT NULL
     AND nullif(current_setting('ca.lightning_settlement_hand', true), '') IS NOT DISTINCT FROM v_hand::text THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'LIGHTNING_HAND_IN_PROGRESS: seat % anchors pool session % of player % in Cluster %, who is in Lightning hand %; the anchor stack, departure and occupant change only by that hand''s settlement (stack % -> %, left_at % -> %)',
    OLD.id, v_ps, v_player, v_cluster, v_hand, OLD.stack, NEW.stack, OLD.left_at, NEW.left_at
    USING ERRCODE = 'PLT01';
END
$function$;

ALTER FUNCTION public.fn_table_seats_lightning_anchor_guard() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_table_seats_lightning_anchor_guard() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_table_seats_lightning_anchor_guard() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_table_seats_lightning_anchor_guard() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_table_seats_lightning_anchor_guard()'::regprocedure)) IS DISTINCT FROM 'fe1678bae7a7973b2a9bcaf6ade83156' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_table_seats_lightning_anchor_guard()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_table_seats_lightning_pool_follows_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  ps      record;
  v_other uuid;
  v_now   timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE'
     AND ((OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
          OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    FOR ps IN
      UPDATE public.lightning_pool_session s
         SET exited_at    = GREATEST(v_now, s.entered_at),
             exit_reason  = CASE WHEN NEW.user_id IS DISTINCT FROM OLD.user_id
                                 THEN 'anchor_seat_turned_over' ELSE 'anchor_seat_left' END,
             state        = 'closed',
             ending_stack = OLD.stack,
             updated_at   = v_now
       WHERE s.anchor_seat_id = OLD.id AND s.exited_at IS NULL
      RETURNING s.id, s.cluster_id, s.cluster_epoch, s.player_id, s.exit_reason, s.ending_stack
    LOOP
      UPDATE public.lightning_pool_slot sl
         SET closed_at = GREATEST(v_now, sl.opened_at),
             close_reason = 'pool_session_exited',
             updated_at = v_now
       WHERE sl.pool_session_id = ps.id AND sl.closed_at IS NULL;

      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
      VALUES (ps.cluster_id, OLD.table_id, 'pool_player_left', jsonb_build_object(
        'cluster_id', ps.cluster_id, 'cluster_epoch', ps.cluster_epoch, 'player_id', ps.player_id,
        'pool_session_id', ps.id, 'anchor_seat_id', OLD.id, 'reason', ps.exit_reason,
        'ending_stack', ps.ending_stack, 'at', v_now), ps.cluster_epoch);

      SELECT ts.id INTO v_other
        FROM public.table_seats ts
        JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = ps.cluster_id AND ts.user_id = ps.player_id AND ts.id <> OLD.id
         AND public.fn_lightning_anchor_is_live_eligible(ts.id, ps.cluster_id, ps.player_id)
       ORDER BY ts.joined_at, ts.id
       LIMIT 1;
      IF v_other IS NOT NULL THEN
        PERFORM public.fn_lightning_pool_enter(v_other, v_now);
      END IF;
    END LOOP;
  END IF;

  IF NEW.left_at IS NULL AND NEW.user_id IS NOT NULL
     AND coalesce(NEW.stack, 0) > 0
     AND coalesce(NEW.is_sitting_out, false) = false
     AND coalesce(NEW.leave_pending, false) = false
     AND EXISTS (SELECT 1 FROM public.tables tb
                   JOIN public.cash_games g ON g.id = tb.cluster_id
                  WHERE tb.id = NEW.table_id AND g.cluster_mode = 'lightning') THEN
    PERFORM public.fn_lightning_pool_enter(NEW.id, v_now);
  END IF;
  RETURN NULL;
END
$function$;

ALTER FUNCTION public.fn_table_seats_lightning_pool_follows_seat() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_table_seats_lightning_pool_follows_seat() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_table_seats_lightning_pool_follows_seat() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_table_seats_lightning_pool_follows_seat() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_table_seats_lightning_pool_follows_seat()'::regprocedure)) IS DISTINCT FROM 'd1e10013c5a044a6dd82e9a99755e4f4' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_table_seats_lightning_pool_follows_seat()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tables_autostart_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.tournament_id IS NULL
     AND NEW.auto_start_players IS NOT NULL
     AND NEW.max_players IS NOT NULL
     AND NEW.auto_start_players > NEW.max_players THEN
    RAISE EXCEPTION
      'auto_start_players (%) cannot exceed max_players (%) - the table would never deal',
      NEW.auto_start_players, NEW.max_players;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_tables_autostart_guard() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tables_autostart_guard() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tables_autostart_guard() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_tables_autostart_guard() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tables_autostart_guard()'::regprocedure)) IS DISTINCT FROM 'a5e5cb3e8ec400049b2e1dd2641b433b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tables_autostart_guard()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tables_creation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_variant text := lower(coalesce(NEW.game_variant, 'nlh'));
  v_cap integer;
  v_name text;
BEGIN
  -- ── name hygiene ──
  v_name := btrim(coalesce(NEW.name, ''));
  v_name := replace(replace(v_name, '<', ''), '>', '');
  IF length(v_name) = 0 THEN
    RAISE EXCEPTION 'table name is required';
  END IF;
  IF length(v_name) > 60 THEN
    v_name := left(v_name, 60);
  END IF;
  NEW.name := v_name;

  -- ── action time ──
  IF NEW.action_time_seconds IS NOT NULL
     AND (NEW.action_time_seconds < 10 OR NEW.action_time_seconds > 120) THEN
    RAISE EXCEPTION 'action_time_seconds must be between 10 and 120 (got %)', NEW.action_time_seconds;
  END IF;

  IF coalesce(NEW.game_type, '') = 'cash' THEN
    -- ── seat law ──
    v_cap := CASE v_variant
               WHEN 'plo6' THEN 6
               WHEN 'plo5' THEN 7
               WHEN 'plo4' THEN 8
               WHEN 'plo8' THEN 8
               WHEN 'flo8' THEN 8
               ELSE 9
             END;
    IF coalesce(NEW.max_players, 0) < 2 THEN
      RAISE EXCEPTION 'a cash table needs at least 2 seats (got %)', NEW.max_players;
    END IF;
    IF NEW.max_players > v_cap THEN
      RAISE EXCEPTION 'seat law: % allows at most % seats (got %) - the deck cannot fund three run-it boards above that',
        v_variant, v_cap, NEW.max_players;
    END IF;

    -- ── blinds ──
    IF coalesce(NEW.small_blind, 0) <= 0 OR coalesce(NEW.big_blind, 0) <= 0 THEN
      RAISE EXCEPTION 'blinds must be positive (sb=%, bb=%)', NEW.small_blind, NEW.big_blind;
    END IF;
    IF NEW.big_blind <= NEW.small_blind THEN
      RAISE EXCEPTION 'big blind must exceed small blind (sb=%, bb=%)', NEW.small_blind, NEW.big_blind;
    END IF;

    -- ── buy-in order ──
    IF NEW.min_buy_in IS NOT NULL AND NEW.max_buy_in IS NOT NULL
       AND NEW.min_buy_in > NEW.max_buy_in THEN
      RAISE EXCEPTION 'min_buy_in (%) cannot exceed max_buy_in (%)', NEW.min_buy_in, NEW.max_buy_in;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_tables_creation_guard() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tables_creation_guard() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tables_creation_guard() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_tables_creation_guard() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tables_creation_guard()'::regprocedure)) IS DISTINCT FROM 'e34e22d06e6ecd0d766de04c8a6aec2e' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tables_creation_guard()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tables_kill_pot_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_refusal text;
BEGIN
  -- The WHEN clause already skips 'off'; this keeps the function honest if it
  -- is ever attached without one. A mode outside the vocabulary is left to
  -- tables_kill_mode_check, which refuses it (23514) after this trigger.
  IF NEW.kill_mode IS NULL OR NEW.kill_mode NOT IN ('half','full') THEN
    RETURN NEW;
  END IF;

  -- Readiness gates SETTING the kill configuration, not every later write to
  -- a row that already carries one.
  IF (TG_OP = 'INSERT'
      OR NEW.kill_mode IS DISTINCT FROM OLD.kill_mode
      OR NEW.kill_threshold_bb IS DISTINCT FROM OLD.kill_threshold_bb)
     AND NOT public.fn_capability_available('cash.fixed_limit.kill_pots') THEN
    RAISE EXCEPTION 'Kill Pots Are Not Available Yet'
      USING ERRCODE = '22023',
            DETAIL = 'capability cash.fixed_limit.kill_pots is not deployed';
  END IF;

  v_refusal := public.fn_kill_pot_configuration_refusal(
    NEW.kill_mode, NEW.game_variant, NEW.game_type, NEW.tournament_id,
    NEW.bomb_pot_enabled, NEW.big_blind, NEW.club_id);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION '%', v_refusal
      USING ERRCODE = '22023',
            DETAIL = format('table %s kill_mode %s', NEW.id, NEW.kill_mode);
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.fn_tables_kill_pot_guard() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tables_kill_pot_guard() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tables_kill_pot_guard() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_tables_kill_pot_guard() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tables_kill_pot_guard()'::regprocedure)) IS DISTINCT FROM '837823de88843f8045bf37a120417585' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tables_kill_pot_guard()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tables_stakes_follows_its_own_blinds()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Cash tables label themselves through fn_cash_stakes_label and are not
  -- this trigger's business. Excluded here as well as in the WHEN clause so
  -- the body is safe if the trigger is ever recreated without one.
  IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL THEN
    NEW.stakes := trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_tables_stakes_follows_its_own_blinds() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tables_stakes_follows_its_own_blinds() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tables_stakes_follows_its_own_blinds() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_tables_stakes_follows_its_own_blinds() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_tables_stakes_follows_its_own_blinds() TO "anon";

GRANT EXECUTE ON FUNCTION public.fn_tables_stakes_follows_its_own_blinds() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.fn_tables_stakes_follows_its_own_blinds() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tables_stakes_follows_its_own_blinds()'::regprocedure)) IS DISTINCT FROM 'fb440f8eb09cdddfe941f5d3fbeef7f0' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tables_stakes_follows_its_own_blinds()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tables_sync_rit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  -- If only one was provided, mirror to the other. If both differ, prefer
  -- whichever was just changed: when run_it_twice changed, copy to enabled;
  -- otherwise copy enabled → run_it_twice.
  IF TG_OP = 'INSERT' THEN
    IF NEW.run_it_twice_enabled IS NULL AND NEW.run_it_twice IS NOT NULL THEN
      NEW.run_it_twice_enabled := NEW.run_it_twice;
    ELSIF NEW.run_it_twice IS NULL AND NEW.run_it_twice_enabled IS NOT NULL THEN
      NEW.run_it_twice := NEW.run_it_twice_enabled;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Detect which side changed and mirror to the other.
    IF NEW.run_it_twice IS DISTINCT FROM OLD.run_it_twice
       AND NEW.run_it_twice_enabled IS NOT DISTINCT FROM OLD.run_it_twice_enabled THEN
      NEW.run_it_twice_enabled := NEW.run_it_twice;
    ELSIF NEW.run_it_twice_enabled IS DISTINCT FROM OLD.run_it_twice_enabled
          AND NEW.run_it_twice IS NOT DISTINCT FROM OLD.run_it_twice THEN
      NEW.run_it_twice := NEW.run_it_twice_enabled;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_tables_sync_rit() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tables_sync_rit() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tables_sync_rit() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_tables_sync_rit() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tables_sync_rit()'::regprocedure)) IS DISTINCT FROM 'ccf4af5898c86afba1541cd57018173b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tables_sync_rit()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_status text;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    v_tournament_id := NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid IS DISTINCT FROM
       NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid THEN
      RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  ELSE
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;

  IF v_tournament_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND to_jsonb(OLD) ? 'terminal_closed_at' THEN
    v_old_marker := NULLIF(to_jsonb(OLD)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP <> 'DELETE' AND to_jsonb(NEW) ? 'terminal_closed_at' THEN
    v_new_marker := NULLIF(to_jsonb(NEW)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION '% rows cannot supply a terminal marker',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% terminal marker transition is not canonical',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  -- A journal row is durable testimony from the instant it names a
  -- tournament. Refuse its UPDATE/DELETE without taking a child-to-parent
  -- lock; a row trigger already owns the child tuple at this point. INSERT is
  -- the only operation that takes the root lock, which preserves the
  -- parent-to-child order used by both terminal authorities.
  IF TG_TABLE_NAME = 'chip_ledger' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = v_tournament_id)
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION
      'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_terminal_tournament_evidence_is_immutable() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_terminal_tournament_evidence_is_immutable() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_terminal_tournament_evidence_is_immutable() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure)) IS DISTINCT FROM '5eb12239ece45d08eb32dbaa9e3028dd' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_terminal_tournament_evidence_is_immutable()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_seat_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_status text;
  v_marker timestamptz;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id = NEW.table_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;

  -- A CASH SEAT WITH NO TERMINAL MARKER HAS NOTHING TO BE IMMUTABLE ABOUT
  -- (2026-09-10). With no tournament on either side and no marker on either
  -- side, every check below passes and the row is returned; return it here
  -- instead of after a status lookup and three receipt scans on a NULL id.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL
     AND v_old_marker IS NULL AND v_new_marker IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament seat % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'seat % terminal marker transition is not canonical',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id
     FOR SHARE;
    SELECT tb.terminal_closed_at INTO v_marker
      FROM public.tables tb
     WHERE tb.id = NEW.table_id
       AND tb.tournament_id = v_new_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')),tb.terminal_closed_at
      INTO v_status,v_marker
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_terminal_tournament_seat_is_immutable() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_terminal_tournament_seat_is_immutable() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_terminal_tournament_seat_is_immutable() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_terminal_tournament_seat_is_immutable()'::regprocedure)) IS DISTINCT FROM '10a5d9082f7770127359f9eca7068ed6' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_terminal_tournament_seat_is_immutable()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tournament_elimination_has_a_place()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
  v_position integer;
  v_tournament text;
BEGIN
  /* THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10). An eliminated
     row is a finishing place: fn_complete_tournament_entry_reprice reads a row
     without one as an unfinished reprice and refuses the event for ever, and
     the engine's elimination sweep will not run until that proof passes.

     A DEFERRED CHECK READS THE ROW AT COMMIT, NOT THE STATEMENT. NEW is the
     tuple the firing statement produced, so a settlement that writes the status
     first and the place second would be refused on a row that is about to be
     correct - which is what happened to five satellites between 07:24 and
     07:52. Re-read; if the row is gone, there is nothing to judge. */
  SELECT tp.status, tp.position INTO v_status, v_position
    FROM public.tournament_players tp
   WHERE tp.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_status = 'eliminated' AND v_position IS NULL THEN
    SELECT t.status INTO v_tournament FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_tournament IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
      RAISE EXCEPTION 'tournament % player % was recorded eliminated with no finishing place; a bust is recorded through the knockout door, which assigns the place',
        NEW.tournament_id, NEW.user_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_tournament_elimination_has_a_place() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tournament_elimination_has_a_place() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tournament_elimination_has_a_place() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_tournament_elimination_has_a_place() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tournament_elimination_has_a_place()'::regprocedure)) IS DISTINCT FROM '8995e4364a00e5bae077701c1185bf8b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tournament_elimination_has_a_place()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_tournament_status text;
  v_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_tournament_key bigint;
  v_owns_authority boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL
       OR (OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
         AND OLD.seat_number IS NOT DISTINCT FROM NEW.seat_number) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,''))
    INTO v_tournament_id,v_tournament_status
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Proof of authority (2026-09-10): this backend holds, exclusively, either
  -- T(the seat's tournament) - that tournament's rolling lane - or G - a
  -- terminal authority. A shared hold of either key proves nothing: hand
  -- settlements hold T shared and rolling authorities hold G shared.
  v_tournament_key:=hashtextextended(
    'ca:tournament-terminal-settlement:v1:'||v_tournament_id::text,0);
  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.pid=pg_backend_pid()
       AND l.locktype='advisory'
       AND l.database=(
         SELECT d.oid FROM pg_catalog.pg_database d
          WHERE d.datname=current_database())
       AND ((l.classid=(((v_key>>32)&4294967295)::oid)
             AND l.objid=((v_key&4294967295)::oid))
         OR (l.classid=(((v_tournament_key>>32)&4294967295)::oid)
             AND l.objid=((v_tournament_key&4294967295)::oid)))
       AND l.objsubid=1
       AND l.mode='ExclusiveLock'
       AND l.granted)
    INTO v_owns_authority;
  IF NOT COALESCE(v_owns_authority,false) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
      USING ERRCODE='55000',
            HINT='Use a canonical tournament seat purchase, registration, move, or assignment RPC.';
  END IF;
  -- A BAGGED event takes back its bagged players only inside its stage
  -- resume (multi-day, 20260924043224): exact marker, incomplete receipt.
  IF v_tournament_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING')
     AND NOT (v_tournament_status = 'BAGGED'
              AND EXISTS (
                SELECT 1
                  FROM public.tournament_stage_resume_receipts r
                 WHERE r.tournament_id = v_tournament_id
                   AND r.completed_at IS NULL
                   AND current_setting('app.atomic_stage_resume', true)
                       = v_tournament_id::text || ':' || r.resume_id::text)) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_CLOSED: tournament %, status %',
      v_tournament_id,v_tournament_status
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure)) IS DISTINCT FROM '2039e26a8513bba99c057a28b79f44e5' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tournament_live_seat_acquisition_requires_authority()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tournament_players_bagged_custody_fence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournaments uuid[];
  v_bagged uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.chips IS NOT DISTINCT FROM OLD.chips
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.current_bounty IS NOT DISTINCT FROM OLD.current_bounty
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id THEN
    RETURN NEW;
  END IF;
  v_tournaments := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id] END;
  SELECT t.id INTO v_bagged
    FROM public.tournaments t
   WHERE t.id = ANY (v_tournaments) AND t.status = 'BAGGED'
     AND current_setting('app.multi_day_stage_custody', true) IS DISTINCT FROM t.id::text
   LIMIT 1;
  IF v_bagged IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_BAGGED_CUSTODY: tournament % is bagged; its stacks belong to the bag until the stage resumes', v_bagged
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.fn_tournament_players_bagged_custody_fence() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tournament_players_bagged_custody_fence() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tournament_players_bagged_custody_fence() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tournament_players_bagged_custody_fence()'::regprocedure)) IS DISTINCT FROM '7f2c2b24929ac233f1fa250a6f1911df' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tournament_players_bagged_custody_fence()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tournament_table_inherits_committed_blinds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_level integer; v_state jsonb;
BEGIN
  IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;
  SELECT current_level,blind_level_state INTO v_level,v_state
    FROM public.tournaments WHERE id=NEW.tournament_id FOR SHARE;
  IF v_state IS NULL THEN
    -- No committed level to inherit. The display string is still a function of
    -- this row's own blinds, so derive it rather than trusting the caller:
    -- that is what let 'undefined/undefined' and stale levels be stored, and
    -- what left a minutely cron UPDATE as the only thing holding the invariant
    -- for the 167,997 tournaments with no blind_level_state.
    IF NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL THEN
      NEW.stakes := trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
    END IF;
    RETURN NEW;
  END IF;
  IF (v_state->>'index')::integer IS DISTINCT FROM v_level THEN
    RAISE EXCEPTION 'Tournament table cannot inherit an unconfirmed blind level';
  END IF;
  NEW.small_blind:=(v_state->>'small_blind')::numeric;
  NEW.big_blind:=(v_state->>'big_blind')::numeric;
  NEW.ante:=(v_state->>'ante')::numeric;
  NEW.stakes:=trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_tournament_table_inherits_committed_blinds() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tournament_table_inherits_committed_blinds() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tournament_table_inherits_committed_blinds() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_tournament_table_inherits_committed_blinds() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tournament_table_inherits_committed_blinds()'::regprocedure)) IS DISTINCT FROM '0386e9eb7f88d7e783c8cec1dbf5f5e8' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tournament_table_inherits_committed_blinds()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_status text;
  v_ended_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Tournament tables are durable event evidence. They close; they are never
    -- deleted. This unconditional rule needs no parent lock after PostgreSQL
    -- has already acquired the child row, so it cannot reverse terminal's
    -- tournament -> table order.
    IF OLD.tournament_id IS NOT NULL THEN
      RAISE EXCEPTION 'tournament table % is durable and cannot be deleted',OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.terminal_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'new table % cannot supply a terminal marker',NEW.id
        USING ERRCODE = '55000';
    END IF;
    IF NEW.tournament_id IS NOT NULL THEN
      -- INSERT has no child row to lock yet, so taking the parent first is
      -- deadlock-safe. If terminal owns it, this waits and then sees COMPLETED;
      -- if expansion owns it first, terminal waits and includes the new table.
      SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
        FROM public.tournaments t
       WHERE t.id = NEW.tournament_id
       FOR SHARE;
      IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'cannot add table % to terminal tournament %',
          NEW.id,NEW.tournament_id USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'table identity % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;

  -- Reassociation would be a child-row-first parent transition and would also
  -- change the immutable event table set. Tournament membership never moves.
  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     AND (NEW.tournament_id IS NOT NULL OR OLD.tournament_id IS NOT NULL) THEN
    RAISE EXCEPTION 'table % tournament association is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF OLD.terminal_closed_at IS NOT NULL THEN
    IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.terminal_closed_at IS DISTINCT FROM OLD.terminal_closed_at
       OR lower(COALESCE(NEW.status::text,'')) <> 'closed'
       OR lower(COALESCE(NEW.lifecycle,'')) <> 'closed'
       OR NEW.current_players IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'terminal tournament table % cannot reopen or move',OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')),t.ended_at
      INTO v_new_status,v_ended_at
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      IF NEW.current_players IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'table % cannot reopen terminal tournament %',
          NEW.id,NEW.tournament_id USING ERRCODE = '55000';
      END IF;
      -- The existing game-end hook first clears current_players while leaving
      -- status unchanged. Coerce that one-way zero-player write directly to
      -- the terminal shape; delayed waiting/running writes can never reopen it.
      NEW.status := 'closed';
      NEW.lifecycle := 'closed';
      NEW.terminal_closed_at := COALESCE(v_ended_at,transaction_timestamp());
    ELSIF NEW.terminal_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'live tournament table % cannot supply a terminal marker',NEW.id
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.terminal_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'unscoped table % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_tournament_table_terminal_close_is_irreversible() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_tournament_table_terminal_close_is_irreversible() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_tournament_table_terminal_close_is_irreversible() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_tournament_table_terminal_close_is_irreversible()'::regprocedure)) IS DISTINCT FROM '7e67d3e09e9eadfc27e230f9b81c16b2' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_tournament_table_terminal_close_is_irreversible()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_observe()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE prior jsonb; following jsonb; frame public.union_pnl_transaction_frames;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'pnl_inventory_source_truncate_refused' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN prior:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN following:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 IF prior IS NOT DISTINCT FROM following THEN RETURN NULL; END IF;
 frame:=public.fn_union_pnl_original_frame();
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
 VALUES(TG_TABLE_NAME,(COALESCE(following,prior)->>'id')::uuid,frame.observed_at,frame.transaction_id,TG_OP,prior,following);
 RETURN NULL;
END $function$;

ALTER FUNCTION public.fn_union_pnl_inventory_observe() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_observe() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_observe() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_observe()'::regprocedure)) IS DISTINCT FROM '11c7c788d943a11375a15819e78873ba' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.fn_union_pnl_inventory_observe()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;

ALTER FUNCTION smarter_private.f06_source_guard() OWNER TO "postgres";

REVOKE ALL ON FUNCTION smarter_private.f06_source_guard() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION smarter_private.f06_source_guard() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure)) IS DISTINCT FROM '17bf5b2ba1901ba4a3f55f7ff3426f6c' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: smarter_private.f06_source_guard()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION smarter_private.f06_table_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE blocked boolean; reopening boolean;
BEGIN
 IF TG_OP='INSERT' THEN NEW.f06_lifecycle:=nextval('smarter_private.f06_lifecycle_seq');RETURN NEW; END IF;
 PERFORM smarter_private.f06_try_lane(OLD.tournament_id);
 SELECT EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=OLD.id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) INTO blocked;
 IF TG_OP='DELETE' THEN
 IF blocked THEN RAISE EXCEPTION 'F06_PENDING_CUSTODY' USING ERRCODE='55000'; END IF; RETURN OLD; END IF;
 reopening:=(lower(COALESCE(OLD.status,'')) IN ('closed','completed','cancelled','finished') OR OLD.lifecycle='closed' OR COALESCE(OLD.is_deleted,false))
 AND NOT (lower(COALESCE(NEW.status,'')) IN ('closed','completed','cancelled','finished') OR NEW.lifecycle='closed' OR COALESCE(NEW.is_deleted,false));
 IF NEW.f06_lifecycle IS DISTINCT FROM OLD.f06_lifecycle THEN RAISE EXCEPTION 'F06_LIFECYCLE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF blocked AND (reopening OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id) THEN
 RAISE EXCEPTION 'F06_PENDING_CUSTODY' USING ERRCODE='55000'; END IF;
 IF reopening THEN NEW.f06_lifecycle:=nextval('smarter_private.f06_lifecycle_seq'); END IF;
 RETURN NEW;
END $function$;

ALTER FUNCTION smarter_private.f06_table_guard() OWNER TO "postgres";

REVOKE ALL ON FUNCTION smarter_private.f06_table_guard() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION smarter_private.f06_table_guard() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('smarter_private.f06_table_guard()'::regprocedure)) IS DISTINCT FROM 'd8775467cf3f807b1992be752638d308' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: smarter_private.f06_table_guard()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_assert_live_tournament_seat_has_roster()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_user_id uuid;
  v_parent_status text;
BEGIN
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'DELETE' OR NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    SELECT t.tournament_id INTO v_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSE
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;
    v_tournament_id := OLD.tournament_id;
    v_user_id := OLD.user_id;
  END IF;

  IF v_tournament_id IS NOT NULL THEN
    SELECT t.status::text INTO v_parent_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;

  /* Terminal cleanup may intentionally close the roster and seats in
     separate idempotent requests.  The invariant is strict while the event
     is joinable or playable; finished/cancelled tables are separately barred
     from acquiring new live seats and may drain without being wedged. */
  IF v_tournament_id IS NOT NULL
     AND upper(COALESCE(v_parent_status, '')) IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables t ON t.id = s.table_id
        WHERE t.tournament_id = v_tournament_id
          AND s.user_id = v_user_id
          AND s.left_at IS NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament_id
          AND p.user_id = v_user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament % at commit',
      v_user_id, v_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

ALTER FUNCTION public.trg_assert_live_tournament_seat_has_roster() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_assert_live_tournament_seat_has_roster() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_assert_live_tournament_seat_has_roster() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_assert_live_tournament_seat_has_roster()'::regprocedure)) IS DISTINCT FROM '7832e3544f1029a4d31f3db07a2659da' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_assert_live_tournament_seat_has_roster()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
  -- An occupied table cannot close. The engine owns its departures.
  -- Do not convert this refusal into a warning and commit a closed table.
  PERFORM public.fn_cashout_seats_for_closing_table(NEW.id,'table '||NEW.status);
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.trg_auto_cashout_on_table_close() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_auto_cashout_on_table_close() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_auto_cashout_on_table_close() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_auto_cashout_on_table_close() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_auto_cashout_on_table_close()'::regprocedure)) IS DISTINCT FROM 'a936bf2b604a14a6ae620e6b3db852f0' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_auto_cashout_on_table_close()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_fn_close_session_when_seat_vacated()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  BEGIN
    IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
              WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NULL; END IF;
    /* A VACATED SEAT CLOSES ITS SESSION AT COMMIT (2026-09-10). Deferred: any
       proper close in this transaction has already run. Only a session that
       NOBODY closed is still open here, and that is the one this closes. */
    IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = NEW.table_id AND t.tournament_id IS NULL) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'seat_vacated'
       WHERE player_id = NEW.user_id AND scope_type = 'table'
         AND scope_id = NEW.table_id AND closed_at IS NULL;
    END IF;
    RETURN NULL;
  END $function$;

ALTER FUNCTION public.trg_fn_close_session_when_seat_vacated() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_fn_close_session_when_seat_vacated() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_fn_close_session_when_seat_vacated() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.trg_fn_close_session_when_seat_vacated() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_fn_close_session_when_seat_vacated() TO "anon";

GRANT EXECUTE ON FUNCTION public.trg_fn_close_session_when_seat_vacated() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.trg_fn_close_session_when_seat_vacated() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_fn_close_session_when_seat_vacated()'::regprocedure)) IS DISTINCT FROM '7e27f560b34e0d3b3e5688195c1b9b3b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_fn_close_session_when_seat_vacated()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_fn_close_sessions_when_table_closes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  BEGIN
    /* A CLOSED TABLE CLOSES ITS SESSIONS (2026-09-10). See the migration of
       the same name. Fires on the transition INTO closed/deleted only, so a
       no-op status write on an already-closed table does nothing. */
    IF (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
       OR (COALESCE(NEW.is_deleted,false) AND NOT COALESCE(OLD.is_deleted,false)) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'table_closed'
       WHERE scope_type = 'table' AND scope_id = NEW.id AND closed_at IS NULL;
    END IF;
    RETURN NEW;
  END $function$;

ALTER FUNCTION public.trg_fn_close_sessions_when_table_closes() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_fn_close_sessions_when_table_closes() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_fn_close_sessions_when_table_closes() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.trg_fn_close_sessions_when_table_closes() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_fn_close_sessions_when_table_closes() TO "anon";

GRANT EXECUTE ON FUNCTION public.trg_fn_close_sessions_when_table_closes() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.trg_fn_close_sessions_when_table_closes() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_fn_close_sessions_when_table_closes()'::regprocedure)) IS DISTINCT FROM '5cff41ed8d0fc0c0aaa75661f6a28a2a' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_fn_close_sessions_when_table_closes()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_result()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = OLD.tournament_id
      UNION ALL
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = NEW.tournament_id
      UNION ALL
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;
  IF NOT v_old_batched AND NOT v_new_batched THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a result frozen by an atomic settlement batch cannot be %', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW.id, NEW.tournament_id, NEW.user_id, NEW.club_id, NEW.status,
         NEW.position, NEW.prize, NEW.eliminated_at, NEW.chips,
         NEW.registered_at, NEW.rebuys, NEW.add_on)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tournament_id, OLD.user_id, OLD.club_id, OLD.status,
         OLD.position, OLD.prize, OLD.eliminated_at, OLD.chips,
         OLD.registered_at, OLD.rebuys, OLD.add_on) THEN
    RAISE EXCEPTION
      'a result frozen by an atomic settlement batch cannot change identity, payout club, status, position, prize, bust time or deal input'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.trg_freeze_batched_tournament_result() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_freeze_batched_tournament_result() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_freeze_batched_tournament_result() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_freeze_batched_tournament_result() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_freeze_batched_tournament_result()'::regprocedure)) IS DISTINCT FROM '14222acda7118db82f77f831afd8d1a6' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_freeze_batched_tournament_result()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_lock_and_classify_tournament_table()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_parent_status text;
  v_launch_id uuid;
  v_launch_generation uuid;
  v_launch_completed_at timestamptz;
  v_proof_open boolean;
  v_needs_origin boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.current_players IS NOT DISTINCT FROM OLD.current_players
     AND NEW.max_players IS NOT DISTINCT FROM OLD.max_players
     AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted THEN
    RETURN NEW;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id]
  END;

  v_needs_origin := TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL;
  IF TG_OP = 'UPDATE'
     AND OLD.tournament_id IS NULL
     AND NEW.tournament_id IS NOT NULL THEN
    v_needs_origin := true;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.tournament_id IS NOT NULL
     AND NEW.tournament_id IS DISTINCT FROM OLD.tournament_id THEN
    PERFORM *
      FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_ORIGIN_IMMUTABLE: table % cannot change tournament', OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF NOT v_needs_origin THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  IF v_needs_origin THEN
    SELECT locked.parent_status,
           locked.launch_id,
           locked.launch_lease_generation,
           locked.launch_completed_at
      INTO v_parent_status,
           v_launch_id,
           v_launch_generation,
           v_launch_completed_at
      FROM public.fn_lock_tournament_launch_proof_parents(
        ARRAY[NEW.tournament_id]
      ) AS locked;

    IF upper(v_parent_status) = 'RUNNING' THEN
      IF v_launch_id IS NOT NULL AND v_launch_completed_at IS NULL THEN
        RAISE EXCEPTION
          'TOURNAMENT_TABLE_ORIGIN_STATE_MISMATCH: RUNNING parent has an incomplete launch receipt'
          USING ERRCODE = '55000';
      END IF;
      INSERT INTO public.tournament_table_origins (
        table_id, tournament_id, origin_kind
      ) VALUES (
        NEW.id, NEW.tournament_id, 'capacity'
      );
    ELSIF upper(v_parent_status) = 'REGISTERING' THEN
      IF v_launch_id IS NULL THEN
        INSERT INTO public.tournament_table_origins (
          table_id, tournament_id, origin_kind
        ) VALUES (
          NEW.id, NEW.tournament_id, 'prelaunch'
        );
      ELSIF v_launch_completed_at IS NULL THEN
        INSERT INTO public.tournament_table_origins (
          table_id,
          tournament_id,
          origin_kind,
          launch_id,
          launch_lease_generation
        ) VALUES (
          NEW.id,
          NEW.tournament_id,
          'launch',
          v_launch_id,
          v_launch_generation
        );
      ELSE
        RAISE EXCEPTION
          'TOURNAMENT_TABLE_ORIGIN_STATE_MISMATCH: REGISTERING parent has a completed launch receipt'
          USING ERRCODE = '55000';
      END IF;
    ELSIF v_launch_id IS NULL THEN
      INSERT INTO public.tournament_table_origins (
        table_id, tournament_id, origin_kind
      ) VALUES (
        NEW.id, NEW.tournament_id, 'prelaunch'
      );
    ELSE
      RAISE EXCEPTION
        'STALE_TOURNAMENT_LAUNCH_TABLE: completed or inconsistent launch cannot create table %',
        NEW.id
        USING ERRCODE = '55000';
    END IF;
  ELSE
    PERFORM *
      FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

ALTER FUNCTION public.trg_lock_and_classify_tournament_table() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_lock_and_classify_tournament_table() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_lock_and_classify_tournament_table() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_lock_and_classify_tournament_table()'::regprocedure)) IS DISTINCT FROM '7f03f5391ca9a47ea9a8b5b3c8a38fd5' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_lock_and_classify_tournament_table()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_ids uuid[];
  v_is_live_acquisition boolean := false;
  v_proof_open boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
     AND NEW.stack IS NOT DISTINCT FROM OLD.stack
     AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT t.tournament_id INTO v_old_tournament_id
      FROM public.tables t
     WHERE t.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT t.tournament_id INTO v_new_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
  END IF;

  -- A CASH SEAT HAS NO LAUNCH PROOF TO LOCK (2026-09-10). With both ids NULL
  -- the body below cannot lock, refuse or require anything: v_ids would be
  -- {NULL,NULL}, the proof-open test is false, the lock helper returns on an
  -- empty set, and the roster check needs a tournament. Measured 6.4 ms per
  -- seat write on a cash table for that no-op; see the migration header.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
    ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
  END;

  IF TG_OP = 'INSERT' THEN
    v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_is_live_acquisition := NEW.left_at IS NULL
      AND NEW.user_id IS NOT NULL
      AND (
        OLD.left_at IS NOT NULL
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.table_id IS DISTINCT FROM NEW.table_id
      );
  END IF;

  IF NOT v_is_live_acquisition THEN
    -- THE SAME ROWS AS `t.id = ANY(v_ids)`, WITHOUT A RE-PLAN PER CALL
    -- (2026-09-10). v_ids is {new} / {old} / {old,new} for INSERT / DELETE /
    -- UPDATE, and the side that is not assigned is NULL, which matches nothing
    -- in either form. With an array parameter PL/pgSQL keeps a custom plan and
    -- re-plans this statement on every seat write (0.83-0.99 ms measured);
    -- with two scalar parameters it adopts the generic plan (0.026 ms).
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE (t.id = v_old_tournament_id OR t.id = v_new_tournament_id)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);

  IF TG_OP <> 'DELETE'
     AND NEW.left_at IS NULL
     AND NEW.user_id IS NOT NULL
     AND v_new_tournament_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_new_tournament_id
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
      NEW.user_id, v_new_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

ALTER FUNCTION public.trg_lock_and_validate_tournament_live_seat() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_lock_and_validate_tournament_live_seat() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_lock_and_validate_tournament_live_seat() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_lock_and_validate_tournament_live_seat()'::regprocedure)) IS DISTINCT FROM 'ddcd580bb32b2b953a5b45df5d29068e' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_lock_and_validate_tournament_live_seat()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_lock_tournament_player_launch_proof()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_proof_open boolean;
  v_must_lock_live_seat_invariant boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.chips IS NOT DISTINCT FROM OLD.chips
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number THEN
    RETURN NEW;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id]
  END;

  /* A completed launch no longer needs every chip/link maintenance write to
     take its proof locks.  It DOES still need every mutation that can remove
     the active roster supporting a concurrent live-seat acquisition to share
     the same receipt -> tournament lock.  Without this distinction, a seat
     INSERT could prove an active roster while a concurrent DELETE or
     active-to-inactive UPDATE skipped the parent lock; each transaction could
     then commit the half of an impossible state it observed before the other.
     Identity changes and inactive/unknown status transitions stay on the
     conservative side.  Only same-active status/link/chip traffic may use the
     completed-launch fast path below. */
  v_must_lock_live_seat_invariant :=
    TG_OP = 'DELETE'
    OR (
      TG_OP = 'UPDATE'
      AND (
        NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NOT (
          OLD.status IN ('registered', 'playing')
          AND NEW.status IN ('registered', 'playing')
        )
      )
    );

  IF TG_OP <> 'INSERT' AND NOT v_must_lock_live_seat_invariant THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

ALTER FUNCTION public.trg_lock_tournament_player_launch_proof() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_lock_tournament_player_launch_proof() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_lock_tournament_player_launch_proof() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_lock_tournament_player_launch_proof()'::regprocedure)) IS DISTINCT FROM '74d26c6b61202e5f077c07379b58829e' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_lock_tournament_player_launch_proof()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_refuse_finalized_tournament_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_finalized boolean;
BEGIN
  SELECT COALESCE(t.prize_pool_finalized, false)
    INTO v_finalized
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_finalized THEN
    RAISE EXCEPTION 'registration is closed because tournament % prize pool is finalized',
      NEW.tournament_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.trg_refuse_finalized_tournament_entry() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_refuse_finalized_tournament_entry() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_refuse_finalized_tournament_entry() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_refuse_finalized_tournament_entry() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_refuse_finalized_tournament_entry()'::regprocedure)) IS DISTINCT FROM 'd86d79923949a7f5434c5d2a286fdb49' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_refuse_finalized_tournament_entry()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table_status text;
  v_is_deleted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.left_at IS NOT NULL
       OR NEW.user_id IS NULL
       OR (
         OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
       ) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT lower(t.status::text), COALESCE(t.is_deleted, false)
    INTO v_table_status, v_is_deleted
    FROM public.tables t
   WHERE t.id = NEW.table_id
     AND t.tournament_id IS NOT NULL
   FOR SHARE;

  IF FOUND AND (v_table_status = 'closed' OR v_is_deleted) THEN
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_CLOSED: table % cannot acquire a live seat', NEW.table_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_refuse_live_seat_on_closed_tournament_table()'::regprocedure)) IS DISTINCT FROM '77a66788308c83b1b27a047328be37ed' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_refuse_live_seat_on_closed_tournament_table()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_seat_parent_keys_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_scope text; v_key text; v_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
     AND OLD.active_game_scope IS NOT DISTINCT FROM NEW.active_game_scope
     AND OLD.active_parent_key IS NOT DISTINCT FROM NEW.active_parent_key THEN
    RETURN NEW; -- an FK re-checks only when a referencing column changes
  END IF;
  IF NEW.table_id IS NULL OR (NEW.active_game_scope IS NULL AND NEW.active_parent_key IS NULL) THEN
    RETURN NEW; -- MATCH SIMPLE
  END IF;
  SELECT t.seat_game_scope, t.seat_admission_key, true INTO v_scope, v_key, v_found
    FROM public.tables t WHERE t.id = NEW.table_id FOR KEY SHARE;
  IF NEW.active_game_scope IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_scope IS DISTINCT FROM NEW.active_game_scope) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "active_seat_game_scope_parent"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'active_seat_game_scope_parent',
            DETAIL = format('Key (table_id, active_game_scope)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_game_scope);
  END IF;
  IF NEW.active_parent_key IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_key IS DISTINCT FROM NEW.active_parent_key) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "live_seat_parent_cannot_close"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
            DETAIL = format('Key (table_id, active_parent_key)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_parent_key);
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.trg_seat_parent_keys_match() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_seat_parent_keys_match() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_seat_parent_keys_match() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.trg_seat_parent_keys_match() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_seat_parent_keys_match() TO "anon";

GRANT EXECUTE ON FUNCTION public.trg_seat_parent_keys_match() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.trg_seat_parent_keys_match() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_seat_parent_keys_match()'::regprocedure)) IS DISTINCT FROM '9060bc3173c812e142d40612ad973f1a' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_seat_parent_keys_match()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_seed_bounty_head()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_head numeric;
BEGIN
  -- Already seeded by fn_register_for_tournament / fn_register_horse_for_tournament.
  IF COALESCE(NEW.current_bounty, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT is_bounty, is_pko, is_mystery_bounty, bounty_amount
    INTO v_t FROM tournaments WHERE id = NEW.tournament_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN NEW;
  END IF;

  v_head := round(COALESCE(v_t.bounty_amount, 0), 2);
  IF v_head <= 0 THEN RETURN NEW; END IF;

  -- EVERY bounty format, mystery included, puts the FLAT bounty on the head.
  -- The mystery value is drawn from the funded chest inventory at the knockout
  -- (fn_mystery_bounty_reserve), not from a PRNG at the till. mystery_bounty_value
  -- is deliberately left alone here: it is set by the reveal, from the chest.
  UPDATE tournament_players
     SET current_bounty = v_head
   WHERE id = NEW.id;

  -- Fund the pool by this entrant's bounty contribution.
  UPDATE tournaments
     SET bounty_pool = round(COALESCE(bounty_pool, 0) + v_head, 2)
   WHERE id = NEW.tournament_id;

  /**
   * REACHING THIS LINE MEANS NOBODY PAID FOR THIS HEAD (2026-08-29).
   *
   * The early return above catches every entrant who arrived through a
   * register RPC, because those pre-set the head from the collected buy-in
   * split. So the pool was just increased by an entrant with no recorded
   * contribution -- a satellite seat award, a ticket redemption, a backfill,
   * or a path that does not exist yet.
   *
   * Not blocked: see the migration header. Made loud, once per tournament, so
   * the question can be answered from evidence instead of assumption.
   */
  INSERT INTO financial_alerts (severity, source, message, context)
  SELECT 'warning', 'trg_seed_bounty_head',
         'Bounty pool funded for an entrant with no collected buy-in split',
         jsonb_build_object(
           'tournament_id', NEW.tournament_id,
           'head', v_head,
           'detail', 'this entrant did not arrive through a register RPC, so no bounty '
                  || 'contribution was collected for the head just added to bounty_pool; '
                  || 'fn_finalize_bounty_pool pays any unclaimed remainder to the champion')
   WHERE NOT EXISTS (
     SELECT 1 FROM financial_alerts
      WHERE source = 'trg_seed_bounty_head'
        AND resolved IS NOT TRUE
        AND context->>'tournament_id' = NEW.tournament_id::text);

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.trg_seed_bounty_head() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_seed_bounty_head() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_seed_bounty_head() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_seed_bounty_head() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_seed_bounty_head()'::regprocedure)) IS DISTINCT FROM 'dcc816d3b32709a2ad55398b5d620351' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_seed_bounty_head()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_table_parent_keys_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.seat_admission_key IS NOT NULL AND NEW.seat_admission_key IS DISTINCT FROM OLD.seat_admission_key THEN
    IF EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.table_id = OLD.id AND s.active_parent_key = OLD.seat_admission_key) THEN
      RAISE EXCEPTION 'update or delete on table "tables" violates foreign key constraint "live_seat_parent_cannot_close" on table "table_seats"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
              DETAIL = format('Key (id, seat_admission_key)=(%s, %s) is still referenced from table "table_seats".', OLD.id, OLD.seat_admission_key);
    END IF;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.trg_table_parent_keys_guard() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_table_parent_keys_guard() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_table_parent_keys_guard() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.trg_table_parent_keys_guard() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_table_parent_keys_guard() TO "anon";

GRANT EXECUTE ON FUNCTION public.trg_table_parent_keys_guard() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.trg_table_parent_keys_guard() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_table_parent_keys_guard()'::regprocedure)) IS DISTINCT FROM '903859ebc0b396942e7507e72b796ef9' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_table_parent_keys_guard()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_table_scope_cascade()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.seat_game_scope IS NOT NULL AND NEW.seat_game_scope IS DISTINCT FROM OLD.seat_game_scope THEN
    UPDATE public.table_seats s SET active_game_scope = NEW.seat_game_scope
     WHERE s.table_id = NEW.id AND s.active_game_scope = OLD.seat_game_scope;
  END IF;
  RETURN NULL;
END $function$;

ALTER FUNCTION public.trg_table_scope_cascade() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_table_scope_cascade() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_table_scope_cascade() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.trg_table_scope_cascade() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_table_scope_cascade() TO "anon";

GRANT EXECUTE ON FUNCTION public.trg_table_scope_cascade() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.trg_table_scope_cascade() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_table_scope_cascade()'::regprocedure)) IS DISTINCT FROM '20b1bb2cdc7a82c600050b68679b8706' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_table_scope_cascade()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_tournament_place_collision()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing uuid;
BEGIN
  IF NEW.position IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.position IS NOT DISTINCT FROM OLD.position THEN
    RETURN NEW;
  END IF;

  SELECT tp.user_id INTO v_existing
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.tournament_id
     AND tp.position = NEW.position
     AND tp.user_id <> NEW.user_id
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- Keep the forensic row: it is how the next reader learns this happened
    -- and which two players raced. Written before the raise so the INSERT is
    -- in a separate autonomous-ish path? It is not - it rolls back with the
    -- statement. That is acceptable: the RAISE below carries both user ids and
    -- the elimination path reports it as elimination_write_failed, which is a
    -- louder signal than a row in a table nobody queries.
    INSERT INTO tournament_place_collisions
      (tournament_id, place, user_id, existing_user_id, db_role, application)
    VALUES
      (NEW.tournament_id, NEW.position, NEW.user_id, v_existing,
       current_user, current_setting('application_name', true));

    RAISE EXCEPTION
      'finishing place % in tournament % is already held by % - refusing to stamp % on it (a contested place is paid TWICE, the prize idempotency key includes the user id)',
      NEW.position, NEW.tournament_id, v_existing, NEW.user_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.trg_tournament_place_collision() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_tournament_place_collision() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_tournament_place_collision() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_tournament_place_collision() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_tournament_place_collision()'::regprocedure)) IS DISTINCT FROM 'f27ba41503d58160618395dc24ebeb93' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_tournament_place_collision()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_tournament_player_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text;
BEGIN
  v_name := public.fn_player_display_name(NEW.user_id);
  IF v_name IS NOT NULL AND v_name <> '' THEN
    NEW.username := v_name;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.trg_tournament_player_name() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_tournament_player_name() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_tournament_player_name() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trg_tournament_player_name() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_tournament_player_name()'::regprocedure)) IS DISTINCT FROM '6fc3fa52bf8a283d35909e4421918901' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_tournament_player_name()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.trg_tournament_table_close_requires_empty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_parent_status text;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NOT (
       (lower(NEW.status::text) = 'closed'
        AND lower(OLD.status::text) IS DISTINCT FROM 'closed')
       OR (COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false))
     ) THEN
    RETURN NEW;
  END IF;

  SELECT upper(t.status::text)
    INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;

  /* Terminal cleanup has its own atomic settlement/seat-release contracts.
     The dangerous path is a joinable or playing event whose table is being
     removed underneath a field that may still acquire a seat. */
  IF v_parent_status IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
        WHERE s.table_id = OLD.id
          AND s.left_at IS NULL
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_CLOSE_NOT_EMPTY: table % still has a live seat', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF lower(NEW.status::text) = 'closed' THEN
    NEW.current_players := 0;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.trg_tournament_table_close_requires_empty() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.trg_tournament_table_close_requires_empty() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trg_tournament_table_close_requires_empty() TO "postgres";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.trg_tournament_table_close_requires_empty()'::regprocedure)) IS DISTINCT FROM '5dd4fa3f22683dd4a3b23a861fd8ff3b' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.trg_tournament_table_close_requires_empty()'; END IF; END $body$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.update_updated_at_column() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO "postgres";

GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO "service_role";

DO $body$ BEGIN IF md5(pg_get_functiondef('public.update_updated_at_column()'::regprocedure)) IS DISTINCT FROM '54801f8bc343c4928383a3e7a1d57d61' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: public.update_updated_at_column()'; END IF; END $body$;

CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();

ALTER TABLE public.table_seats ENABLE TRIGGER "a00_f06_source_seat";

CREATE TRIGGER a0_tournament_live_seat_root_guard BEFORE INSERT OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_tournament_live_seat_acquisition_requires_authority();

ALTER TABLE public.table_seats ENABLE TRIGGER "a0_tournament_live_seat_root_guard";

CREATE TRIGGER aa_tournament_live_seat_proof_lock BEFORE INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION trg_lock_and_validate_tournament_live_seat();

ALTER TABLE public.table_seats ENABLE TRIGGER "aa_tournament_live_seat_proof_lock";

CREATE TRIGGER ab_refuse_live_seat_on_closed_tournament_table BEFORE INSERT OR UPDATE OF table_id, user_id, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION trg_refuse_live_seat_on_closed_tournament_table();

ALTER TABLE public.table_seats ENABLE TRIGGER "ab_refuse_live_seat_on_closed_tournament_table";

CREATE TRIGGER cancelled_tournament_seat_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_seat_is_immutable();

ALTER TABLE public.table_seats ENABLE TRIGGER "cancelled_tournament_seat_is_immutable";

CREATE TRIGGER poker_arena_chip_seat_guard BEFORE INSERT OR UPDATE OF table_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_chip_seat();

ALTER TABLE public.table_seats ENABLE TRIGGER "poker_arena_chip_seat_guard";

CREATE TRIGGER poker_bind_diamond_seat AFTER INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_poker_bind_diamond_seat();

ALTER TABLE public.table_seats ENABLE TRIGGER "poker_bind_diamond_seat";

CREATE TRIGGER terminal_tournament_seat_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_terminal_tournament_seat_is_immutable();

ALTER TABLE public.table_seats ENABLE TRIGGER "terminal_tournament_seat_is_immutable";

CREATE CONSTRAINT TRIGGER tournament_live_seat_has_active_roster AFTER INSERT ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_assert_live_tournament_seat_has_roster();

ALTER TABLE public.table_seats ENABLE TRIGGER "tournament_live_seat_has_active_roster";

CREATE CONSTRAINT TRIGGER tournament_live_seat_update_has_active_roster AFTER UPDATE OF table_id, user_id, left_at ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_assert_live_tournament_seat_has_roster();

ALTER TABLE public.table_seats ENABLE TRIGGER "tournament_live_seat_update_has_active_roster";

CREATE TRIGGER trg_ca_arena_seat_is_same_asset AFTER INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_arena_seat_is_same_asset();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_ca_arena_seat_is_same_asset";

CREATE TRIGGER trg_ca_guard_seat_creation BEFORE INSERT OR UPDATE OF left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_seat_creation();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_ca_guard_seat_creation";

CREATE TRIGGER trg_cash_game_roster_track AFTER INSERT OR UPDATE OF left_at, user_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_cash_game_roster_track();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_cash_game_roster_track";

CREATE TRIGGER trg_clear_sitout_on_turnover BEFORE UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_clear_sitout_on_turnover();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_clear_sitout_on_turnover";

CREATE TRIGGER trg_enforce_four_table_limit BEFORE INSERT OR UPDATE OF left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_table_limit();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_enforce_four_table_limit";

CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_guard_retired_club_mutation";

CREATE TRIGGER trg_log_seat_stack_exit BEFORE DELETE OR UPDATE OF left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_log_seat_stack_exit();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_log_seat_stack_exit";

CREATE TRIGGER trg_new_seat_clear_sitout BEFORE INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_new_seat_clear_sitout();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_new_seat_clear_sitout";

CREATE TRIGGER trg_no_live_seat_on_finished_game BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_no_live_seat_on_finished_game();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_no_live_seat_on_finished_game";

CREATE TRIGGER trg_notify_blinding_off AFTER UPDATE OF is_sitting_out, is_away ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_notify_blinding_off();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_notify_blinding_off";

CREATE TRIGGER trg_one_live_seat_per_tournament BEFORE INSERT OR UPDATE OF user_id, left_at, table_id ON public.table_seats FOR EACH ROW WHEN ((new.left_at IS NULL)) EXECUTE FUNCTION fn_guard_one_live_tournament_seat();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_one_live_seat_per_tournament";

CREATE TRIGGER trg_refuse_seat_on_closed_cluster_table BEFORE INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_refuse_seat_on_closed_cluster_table();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_refuse_seat_on_closed_cluster_table";

CREATE TRIGGER trg_refuse_seat_revive_on_closed_cluster_table BEFORE UPDATE OF user_id, left_at, table_id ON public.table_seats FOR EACH ROW WHEN (((new.left_at IS NULL) AND ((old.left_at IS NOT NULL) OR (old.user_id IS DISTINCT FROM new.user_id) OR (old.table_id IS DISTINCT FROM new.table_id)))) EXECUTE FUNCTION fn_refuse_seat_on_closed_cluster_table();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_refuse_seat_revive_on_closed_cluster_table";

CREATE TRIGGER trg_seat_change_syncs_seat_first_count AFTER INSERT OR DELETE OR UPDATE OF left_at ON public.table_seats FOR EACH ROW WHEN ((pg_trigger_depth() < 2)) EXECUTE FUNCTION fn_seat_change_syncs_seat_first_count();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_seat_change_syncs_seat_first_count";

CREATE TRIGGER trg_seat_insert_cancel_waitlist AFTER INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_seat_insert_cancel_waitlist();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_seat_insert_cancel_waitlist";

CREATE TRIGGER trg_stamp_seat_horse_id BEFORE INSERT OR UPDATE OF user_id, horse_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_horse_id();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_stamp_seat_horse_id";

CREATE TRIGGER trg_stamp_sit_out_at BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_sit_out_at();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_stamp_sit_out_at";

CREATE TRIGGER trg_table_seats_human_user_club_only BEFORE INSERT OR UPDATE OF table_id, user_id, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_table_seats_human_user_club_only";

CREATE TRIGGER trg_table_seats_lightning_anchor_delete_guard BEFORE DELETE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_table_seats_lightning_anchor_delete_guard";

CREATE TRIGGER trg_table_seats_lightning_anchor_guard BEFORE UPDATE ON public.table_seats FOR EACH ROW WHEN (((old.stack IS DISTINCT FROM new.stack) OR (old.left_at IS DISTINCT FROM new.left_at) OR (old.user_id IS DISTINCT FROM new.user_id))) EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_table_seats_lightning_anchor_guard";

CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_follows_seat AFTER UPDATE ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.left_at IS DISTINCT FROM new.left_at) OR (old.user_id IS DISTINCT FROM new.user_id) OR (old.is_sitting_out IS DISTINCT FROM new.is_sitting_out) OR (old.leave_pending IS DISTINCT FROM new.leave_pending) OR ((COALESCE(old.stack, (0)::numeric) > (0)::numeric) IS DISTINCT FROM (COALESCE(new.stack, (0)::numeric) > (0)::numeric)))) EXECUTE FUNCTION fn_table_seats_lightning_pool_follows_seat();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_table_seats_lightning_pool_follows_seat";

CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_on_insert AFTER INSERT ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.left_at IS NULL) AND (new.user_id IS NOT NULL) AND (COALESCE(new.stack, (0)::numeric) > (0)::numeric) AND (COALESCE(new.is_sitting_out, false) = false) AND (COALESCE(new.leave_pending, false) = false))) EXECUTE FUNCTION fn_table_seats_lightning_pool_follows_seat();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_table_seats_lightning_pool_on_insert";

CREATE TRIGGER trg_table_seats_stamp_club BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_club();

ALTER TABLE public.table_seats ENABLE TRIGGER "trg_table_seats_stamp_club";

CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();

ALTER TABLE public.table_seats ENABLE TRIGGER "union_pnl_original_inventory";

CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.table_seats FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();

ALTER TABLE public.table_seats ENABLE TRIGGER "union_pnl_original_inventory_no_truncate";

CREATE CONSTRAINT TRIGGER zz_close_session_when_seat_vacated AFTER UPDATE OF left_at ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_fn_close_session_when_seat_vacated();

ALTER TABLE public.table_seats ENABLE TRIGGER "zz_close_session_when_seat_vacated";

CREATE TRIGGER zz_freeze_entry_guard BEFORE INSERT OR UPDATE OF left_at, user_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_refuse_new_entries_while_frozen();

ALTER TABLE public.table_seats ENABLE TRIGGER "zz_freeze_entry_guard";

CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('stack', 'left_at', 'sit_out_at');

ALTER TABLE public.table_seats ENABLE TRIGGER "zz_freeze_guard";

CREATE TRIGGER zz_restriction_seat_guard BEFORE INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_refuse_restricted_entry('cash');

ALTER TABLE public.table_seats ENABLE TRIGGER "zz_restriction_seat_guard";

CREATE TRIGGER zz_restriction_seat_revive_guard BEFORE UPDATE OF user_id, left_at ON public.table_seats FOR EACH ROW WHEN (((new.left_at IS NULL) AND ((old.left_at IS NOT NULL) OR (old.user_id IS DISTINCT FROM new.user_id)))) EXECUTE FUNCTION fn_ca_refuse_restricted_entry('cash');

ALTER TABLE public.table_seats ENABLE TRIGGER "zz_restriction_seat_revive_guard";

CREATE CONSTRAINT TRIGGER zzz_diamond_seat_keeps_custody AFTER INSERT OR DELETE OR UPDATE ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_seat_keeps_custody();

ALTER TABLE public.table_seats ENABLE TRIGGER "zzz_diamond_seat_keeps_custody";

CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy();

ALTER TABLE public.table_seats ENABLE TRIGGER "zzz_stamp_seat_occupancy";

CREATE TRIGGER zzzz_stamp_active_seat_game_scope BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_active_seat_game_scope();

ALTER TABLE public.table_seats ENABLE TRIGGER "zzzz_stamp_active_seat_game_scope";

CREATE TRIGGER zzzzz_require_live_seat_parent BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_require_live_seat_parent();

ALTER TABLE public.table_seats ENABLE TRIGGER "zzzzz_require_live_seat_parent";

CREATE TRIGGER zzzzz_seat_parent_keys_match BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION trg_seat_parent_keys_match();

ALTER TABLE public.table_seats ENABLE TRIGGER "zzzzz_seat_parent_keys_match";

CREATE CONSTRAINT TRIGGER zzzzzz_tournament_felt_may_not_exceed_supply AFTER INSERT OR UPDATE OF stack, left_at ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_felt_may_not_exceed_supply();

ALTER TABLE public.table_seats ENABLE TRIGGER "zzzzzz_tournament_felt_may_not_exceed_supply";

CREATE TRIGGER a00_f06_lifecycle BEFORE INSERT OR DELETE OR UPDATE OF id, tournament_id, status, lifecycle, is_deleted, f06_lifecycle ON public.tables FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_table_guard();

ALTER TABLE public.tables ENABLE TRIGGER "a00_f06_lifecycle";

CREATE TRIGGER aa_tournament_table_launch_proof_lock BEFORE INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION trg_lock_and_classify_tournament_table();

ALTER TABLE public.tables ENABLE TRIGGER "aa_tournament_table_launch_proof_lock";

CREATE TRIGGER ab_tournament_table_close_requires_empty BEFORE UPDATE OF status, is_deleted ON public.tables FOR EACH ROW EXECUTE FUNCTION trg_tournament_table_close_requires_empty();

ALTER TABLE public.tables ENABLE TRIGGER "ab_tournament_table_close_requires_empty";

CREATE TRIGGER cancelled_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_evidence_is_immutable();

ALTER TABLE public.tables ENABLE TRIGGER "cancelled_tournament_evidence_is_immutable";

CREATE TRIGGER poker_arena_table_guard BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_arena_structure();

ALTER TABLE public.tables ENABLE TRIGGER "poker_arena_table_guard";

CREATE TRIGGER tables_updated_at BEFORE UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.tables ENABLE TRIGGER "tables_updated_at";

CREATE TRIGGER tournament_table_inherits_committed_blinds BEFORE INSERT ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_tournament_table_inherits_committed_blinds();

ALTER TABLE public.tables ENABLE TRIGGER "tournament_table_inherits_committed_blinds";

CREATE TRIGGER tournament_table_terminal_close_is_irreversible BEFORE INSERT OR DELETE OR UPDATE OF id, tournament_id, status, current_players, lifecycle, terminal_closed_at ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_tournament_table_terminal_close_is_irreversible();

ALTER TABLE public.tables ENABLE TRIGGER "tournament_table_terminal_close_is_irreversible";

CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();

ALTER TABLE public.tables ENABLE TRIGGER "trg_guard_retired_club_mutation";

CREATE TRIGGER trg_on_table_status_change AFTER UPDATE OF status ON public.tables FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION fn_on_table_status_change();

ALTER TABLE public.tables ENABLE TRIGGER "trg_on_table_status_change";

CREATE TRIGGER trg_tables_auto_cashout_on_close AFTER UPDATE OF status ON public.tables FOR EACH ROW WHEN (((new.status IS DISTINCT FROM old.status) AND (lower(COALESCE(new.status, ''::text)) = ANY (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text])))) EXECUTE FUNCTION trg_auto_cashout_on_table_close();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_auto_cashout_on_close";

CREATE TRIGGER trg_tables_autostart_guard BEFORE INSERT OR UPDATE OF auto_start_players, max_players ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_tables_autostart_guard();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_autostart_guard";

CREATE TRIGGER trg_tables_block_deleted_revival BEFORE UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_block_deleted_table_revival();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_block_deleted_revival";

CREATE TRIGGER trg_tables_capture_management_contract AFTER INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_capture_managed_game_contract();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_capture_management_contract";

CREATE TRIGGER trg_tables_closed_main_releases_index BEFORE INSERT OR UPDATE OF lifecycle, is_deleted, main_index, cluster_id ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_closed_cluster_main_releases_index();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_closed_main_releases_index";

CREATE TRIGGER trg_tables_cluster_table_ceiling BEFORE INSERT ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_cluster_table_ceiling();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_cluster_table_ceiling";

CREATE TRIGGER trg_tables_creation_guard BEFORE INSERT ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_tables_creation_guard();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_creation_guard";

CREATE TRIGGER trg_tables_emit_game_management_event AFTER INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_emit_managed_game_row_event();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_emit_game_management_event";

CREATE TRIGGER trg_tables_managed_delete_guard BEFORE DELETE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_delete();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_managed_delete_guard";

CREATE TRIGGER trg_tables_managed_lifecycle_guard BEFORE UPDATE OF status, is_deleted ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_lifecycle();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_managed_lifecycle_guard";

CREATE TRIGGER trg_tables_sync_club_counts_del AFTER DELETE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_sync_club_table_counts();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_sync_club_counts_del";

CREATE TRIGGER trg_tables_sync_club_counts_ins AFTER INSERT ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_sync_club_table_counts();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_sync_club_counts_ins";

CREATE TRIGGER trg_tables_sync_club_counts_upd AFTER UPDATE OF status, is_deleted, club_id, union_id, tournament_id ON public.tables FOR EACH ROW WHEN (((new.status IS DISTINCT FROM old.status) OR (new.is_deleted IS DISTINCT FROM old.is_deleted) OR (new.club_id IS DISTINCT FROM old.club_id) OR (new.union_id IS DISTINCT FROM old.union_id) OR (new.tournament_id IS DISTINCT FROM old.tournament_id))) EXECUTE FUNCTION fn_sync_club_table_counts();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_sync_club_counts_upd";

CREATE TRIGGER trg_tables_sync_rit BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_tables_sync_rit();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_sync_rit";

CREATE TRIGGER trg_tables_union_ownership BEFORE INSERT ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_union_ownership();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_union_ownership";

CREATE TRIGGER trg_tables_union_ownership_upd BEFORE UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_enforce_table_union_ownership_update();

ALTER TABLE public.tables ENABLE TRIGGER "trg_tables_union_ownership_upd";

CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();

ALTER TABLE public.tables ENABLE TRIGGER "union_pnl_original_inventory";

CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tables FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();

ALTER TABLE public.tables ENABLE TRIGGER "union_pnl_original_inventory_no_truncate";

CREATE TRIGGER zz_cancel_cash_seat_moves_on_table_close AFTER UPDATE OF status, seat_admission_key ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_cancel_cash_seat_moves_on_table_close();

ALTER TABLE public.tables ENABLE TRIGGER "zz_cancel_cash_seat_moves_on_table_close";

CREATE TRIGGER zz_close_sessions_when_table_closes AFTER UPDATE OF status, is_deleted ON public.tables FOR EACH ROW EXECUTE FUNCTION trg_fn_close_sessions_when_table_closes();

ALTER TABLE public.tables ENABLE TRIGGER "zz_close_sessions_when_table_closes";

CREATE TRIGGER zz_tables_kill_pot_guard BEFORE INSERT OR UPDATE OF kill_mode, kill_threshold_bb, game_variant, game_type, tournament_id, bomb_pot_enabled, big_blind, club_id ON public.tables FOR EACH ROW WHEN ((new.kill_mode IS DISTINCT FROM 'off'::text)) EXECUTE FUNCTION fn_tables_kill_pot_guard();

ALTER TABLE public.tables ENABLE TRIGGER "zz_tables_kill_pot_guard";

CREATE TRIGGER zzzz_stamp_table_game_scope BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_game_scope();

ALTER TABLE public.tables ENABLE TRIGGER "zzzz_stamp_table_game_scope";

CREATE TRIGGER zzzz_stamp_table_seat_admission BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_seat_admission();

ALTER TABLE public.tables ENABLE TRIGGER "zzzz_stamp_table_seat_admission";

CREATE TRIGGER zzzzz_table_parent_keys_guard BEFORE UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_admission_key IS DISTINCT FROM new.seat_admission_key)) EXECUTE FUNCTION trg_table_parent_keys_guard();

ALTER TABLE public.tables ENABLE TRIGGER "zzzzz_table_parent_keys_guard";

CREATE TRIGGER zzzzz_table_scope_cascade AFTER UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_game_scope IS DISTINCT FROM new.seat_game_scope)) EXECUTE FUNCTION trg_table_scope_cascade();

ALTER TABLE public.tables ENABLE TRIGGER "zzzzz_table_scope_cascade";

CREATE TRIGGER zzzzzz_tables_stakes_follows_its_own_blinds BEFORE UPDATE OF small_blind, big_blind, stakes ON public.tables FOR EACH ROW WHEN (((new.tournament_id IS NOT NULL) AND ((old.small_blind IS DISTINCT FROM new.small_blind) OR (old.big_blind IS DISTINCT FROM new.big_blind) OR (old.stakes IS DISTINCT FROM new.stakes)))) EXECUTE FUNCTION fn_tables_stakes_follows_its_own_blinds();

ALTER TABLE public.tables ENABLE TRIGGER "zzzzzz_tables_stakes_follows_its_own_blinds";

CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();

ALTER TABLE public.tournament_players ENABLE TRIGGER "a00_f06_source_roster";

CREATE CONSTRAINT TRIGGER a_player_is_not_eliminated_from_a_game_that_never_started AFTER INSERT OR UPDATE ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.status = ANY (ARRAY['eliminated'::text, 'winner'::text]))) EXECUTE FUNCTION fn_player_needs_a_started_game();

ALTER TABLE public.tournament_players ENABLE TRIGGER "a_player_is_not_eliminated_from_a_game_that_never_started";

CREATE TRIGGER aa_serialize_tournament_player_insert BEFORE INSERT ON public.tournament_players FOR EACH STATEMENT EXECUTE FUNCTION fn_serialize_entry_statement();

ALTER TABLE public.tournament_players ENABLE TRIGGER "aa_serialize_tournament_player_insert";

CREATE TRIGGER aa_tournament_player_launch_proof_lock BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_lock_tournament_player_launch_proof();

ALTER TABLE public.tournament_players ENABLE TRIGGER "aa_tournament_player_launch_proof_lock";

CREATE TRIGGER cancelled_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_evidence_is_immutable();

ALTER TABLE public.tournament_players ENABLE TRIGGER "cancelled_tournament_evidence_is_immutable";

CREATE TRIGGER satellite_target_player_provenance_is_immutable BEFORE INSERT OR DELETE OR UPDATE OF id, tournament_id, user_id, is_satellite_qualifier, source_satellite_id ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_satellite_target_player_provenance_is_immutable();

ALTER TABLE public.tournament_players ENABLE TRIGGER "satellite_target_player_provenance_is_immutable";

CREATE TRIGGER seed_bounty_head AFTER INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_seed_bounty_head();

ALTER TABLE public.tournament_players ENABLE TRIGGER "seed_bounty_head";

CREATE TRIGGER terminal_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_terminal_tournament_evidence_is_immutable();

ALTER TABLE public.tournament_players ENABLE TRIGGER "terminal_tournament_evidence_is_immutable";

CREATE CONSTRAINT TRIGGER tournament_elimination_has_a_place AFTER INSERT OR UPDATE OF status, "position" ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_tournament_elimination_has_a_place();

ALTER TABLE public.tournament_players ENABLE TRIGGER "tournament_elimination_has_a_place";

CREATE TRIGGER tournament_place_collision_watch BEFORE INSERT OR UPDATE OF "position" ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_tournament_place_collision();

ALTER TABLE public.tournament_players ENABLE TRIGGER "tournament_place_collision_watch";

CREATE TRIGGER tournament_player_name BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_tournament_player_name();

ALTER TABLE public.tournament_players ENABLE TRIGGER "tournament_player_name";

CREATE CONSTRAINT TRIGGER tournament_roster_cannot_orphan_live_seat AFTER DELETE ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_assert_live_tournament_seat_has_roster();

ALTER TABLE public.tournament_players ENABLE TRIGGER "tournament_roster_cannot_orphan_live_seat";

CREATE CONSTRAINT TRIGGER tournament_roster_update_cannot_orphan_live_seat AFTER UPDATE OF tournament_id, user_id, status ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_assert_live_tournament_seat_has_roster();

ALTER TABLE public.tournament_players ENABLE TRIGGER "tournament_roster_update_cannot_orphan_live_seat";

CREATE TRIGGER trg_ca_tournament_entry_gate BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_entry_gate();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_ca_tournament_entry_gate";

CREATE TRIGGER trg_daily_missions_tournament_registered AFTER UPDATE ON public.tournament_players REFERENCING OLD TABLE AS previous_rows NEW TABLE AS updated_rows FOR EACH STATEMENT EXECUTE FUNCTION fn_daily_missions_tournament_registered_updated();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_daily_missions_tournament_registered";

CREATE TRIGGER trg_daily_missions_tournament_registered_insert AFTER INSERT ON public.tournament_players REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION fn_daily_missions_tournament_registered_inserted();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_daily_missions_tournament_registered_insert";

CREATE TRIGGER trg_enforce_booking_game_cap BEFORE INSERT OR UPDATE OF status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_enforce_booking_game_cap();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_enforce_booking_game_cap";

CREATE TRIGGER trg_enforce_tournament_capacity BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_enforce_tournament_capacity();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_enforce_tournament_capacity";

CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_guard_retired_club_mutation";

CREATE TRIGGER trg_refuse_reentry_with_pending_bounty BEFORE UPDATE OF status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_refuse_reentry_with_pending_bounty();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_refuse_reentry_with_pending_bounty";

CREATE TRIGGER trg_refuse_zero_chip_field_elimination BEFORE UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_refuse_zero_chip_field_elimination();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_refuse_zero_chip_field_elimination";

CREATE TRIGGER trg_sync_tournament_current_players AFTER INSERT OR DELETE OR UPDATE OF status, tournament_id ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_sync_tournament_current_players();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_sync_tournament_current_players";

CREATE TRIGGER trg_tournament_players_bagged_custody_fence BEFORE INSERT OR DELETE OR UPDATE OF chips, status, current_bounty, tournament_id ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_tournament_players_bagged_custody_fence();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_tournament_players_bagged_custody_fence";

CREATE TRIGGER trg_tournament_players_human_user_club_only BEFORE INSERT OR UPDATE OF tournament_id, user_id ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_tournament_players_human_user_club_only";

CREATE TRIGGER trg_tournament_players_stamp_club BEFORE INSERT OR UPDATE ON public.tournament_players FOR EACH ROW WHEN ((new.club_id IS NULL)) EXECUTE FUNCTION fn_stamp_entry_club();

ALTER TABLE public.tournament_players ENABLE TRIGGER "trg_tournament_players_stamp_club";

CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();

ALTER TABLE public.tournament_players ENABLE TRIGGER "union_pnl_original_inventory";

CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournament_players FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();

ALTER TABLE public.tournament_players ENABLE TRIGGER "union_pnl_original_inventory_no_truncate";

CREATE TRIGGER zz_freeze_entry_guard BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_refuse_new_entries_while_frozen();

ALTER TABLE public.tournament_players ENABLE TRIGGER "zz_freeze_entry_guard";

CREATE TRIGGER zz_restriction_tourney_guard BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_ca_refuse_restricted_entry('tournaments');

ALTER TABLE public.tournament_players ENABLE TRIGGER "zz_restriction_tourney_guard";

CREATE TRIGGER zz_stamp_tournament_elimination_sequence BEFORE INSERT OR UPDATE OF status, elimination_sequence ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_elimination_sequence();

ALTER TABLE public.tournament_players ENABLE TRIGGER "zz_stamp_tournament_elimination_sequence";

CREATE TRIGGER zzzz_freeze_batched_tournament_result BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_freeze_batched_tournament_result();

ALTER TABLE public.tournament_players ENABLE TRIGGER "zzzz_freeze_batched_tournament_result";

CREATE TRIGGER zzzz_refuse_finalized_tournament_entry BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_refuse_finalized_tournament_entry();

ALTER TABLE public.tournament_players ENABLE TRIGGER "zzzz_refuse_finalized_tournament_entry";
COMMIT;
