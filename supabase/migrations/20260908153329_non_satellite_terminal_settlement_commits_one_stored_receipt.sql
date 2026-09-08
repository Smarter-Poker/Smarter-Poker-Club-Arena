-- 20260908153329_non_satellite_terminal_settlement_commits_one_stored_receipt.sql
--
-- A tournament used to cross five independently retryable finish doors:
-- cash places or a deal, mystery chests, bounty residual, rake and finally the
-- lifecycle update. A process crash between them left a COMPLETING event and a
-- later repair timer tried to infer which money was still owed. This migration
-- installs one service-only terminal transaction. It calls exactly one cash
-- authority, proves every other durable money row, closes the event and stores
-- an immutable receipt. A replay reads and verifies that receipt; it calls no
-- payer and moves no money.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $terminal_prerequisites$
BEGIN
  IF to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_settle_tournament_final_table_deal(uuid)') IS NULL
     OR to_regprocedure('public.fn_mystery_bounty_settle(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_finalize_bounty_pool(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_settle_tournament_rake(uuid,text)') IS NULL
     OR to_regprocedure(
          'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure(
          'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)') IS NULL
     OR to_regprocedure(
          'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)') IS NULL
     OR to_regprocedure('public.fn_mystery_bounty_pay(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION
      'terminal settlement requires the cash, bounty, mystery and rake authorities';
  END IF;
  IF to_regclass('public.tournament_payouts') IS NULL
     OR to_regclass('public.tournament_obligations') IS NULL
     OR to_regclass('public.tournament_escrow') IS NULL
     OR to_regclass('public.tournament_rake_settlements') IS NULL
     OR to_regclass('public.tournament_bounty_chests') IS NULL
     OR to_regclass('public.tournament_bounty_awards') IS NULL
     OR to_regclass('public.tournament_bounty_award_recipients') IS NULL THEN
    RAISE EXCEPTION 'terminal settlement is missing required durable evidence tables';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.tournament_payouts'::regclass
       AND c.conname = 'tournament_payouts_source_check'
       AND c.convalidated
  ) THEN
    RAISE EXCEPTION
      'terminal settlement requires the closed tournament payout source vocabulary';
  END IF;
END;
$terminal_prerequisites$;

-- A live split-pot bounty can credit several claimant wallets. The historical
-- function locks its event first but then pays claimants in weight order, not
-- the canonical wallet order used by terminal cash. Runtime also marks the
-- loser eliminated before invoking it, so a database deadlock victim is not a
-- harmless retry. Serialize this audited live authority on the same global
-- settlement lock before any row lock. This removes the cycle at its root and
-- makes a bounty already in flight finish before terminal closure can inspect
-- its pool or obligations.
DO $harden_collect_bounty_terminal_lock$
DECLARE
  v_definition text;
  v_hardened text;
  v_begin_needle constant text := $needle$BEGIN
  IF p_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN$needle$;
  v_begin_replacement constant text := $replacement$BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  IF p_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN$replacement$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure;
  IF v_definition IS NULL
     OR md5(v_definition) <> 'effcc6b46f0dc40381c419e2fff2aeed'
     OR (length(v_definition)-length(replace(
           v_definition,v_begin_needle,'')))
          / length(v_begin_needle) <> 1 THEN
    RAISE EXCEPTION
      'fn_collect_bounty changed since the audited terminal-lock baseline';
  END IF;
  v_hardened := replace(v_definition,v_begin_needle,v_begin_replacement);
  EXECUTE v_hardened;
END;
$harden_collect_bounty_terminal_lock$;

REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  TO service_role;

-- During the rolling window the five component finish RPCs and the legacy
-- satellite-seat RPC must remain
-- service-callable for the old server, while the new terminal wrapper calls
-- those same bodies internally. Their historical bank orders differ: rake
-- reaches its union/club destination before club_wallets, while the wrapper
-- pre-owns all shared banks. Put every terminal money component behind the
-- same cross-format transaction lock used by the wrapper and satellite
-- authority before it can own any row. Reacquiring the same advisory lock
-- from inside a wrapper is transaction-local and immediate. A direct rolling
-- caller and a wrapped finish therefore cannot interleave their bank or
-- recipient locks at all.
DO $serialize_rolling_terminal_components$
DECLARE
  v_signature text;
  v_definition text;
  v_hardened text;
  v_begin integer;
  v_begin_token constant text := E'\nBEGIN\n';
  v_lock constant text := E'\nBEGIN\n  PERFORM pg_advisory_xact_lock(hashtextextended(\'ca:tournament-terminal-settlement:v1\',0));\n';
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_settle_tournament_places(uuid,uuid)',
    'public.fn_settle_tournament_final_table_deal(uuid)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_settle_tournament_rake(uuid,text)',
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_definition
      FROM pg_proc p
     WHERE p.oid = to_regprocedure(v_signature);
    v_begin := position(v_begin_token IN v_definition);
    IF v_definition IS NULL OR v_begin = 0
       OR v_definition LIKE
          '%ca:tournament-terminal-settlement:v1%' THEN
      RAISE EXCEPTION
        'rolling terminal component % cannot receive its canonical lock',
        v_signature;
    END IF;
    v_hardened := overlay(v_definition PLACING v_lock
                           FROM v_begin FOR length(v_begin_token));
    EXECUTE v_hardened;
  END LOOP;
END;
$serialize_rolling_terminal_components$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(
  uuid,uuid,uuid,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(
  uuid,uuid,uuid,text,integer)
  TO service_role;

-- Phase 6.1 made the obligation payer reject every non-engine provenance that
-- was not explicitly named in ca_settle_sources. These three existing bounty
-- authorities call it under their own fixed function names. Without these
-- declarations a funded bounty finish returns adjustment_required and the
-- terminal transaction correctly rolls back forever. They are platform-owned
-- settlement sources, not operator adjustments.
INSERT INTO public.ca_settle_sources(source,note) VALUES
  ('final_table_deal',
   'Derived live chop share, paid only inside the atomic final-table-deal authority.'),
  ('fn_finalize_bounty_pool',
   'Platform bounty residual authority, invoked inside fn_complete_tournament_terminal.'),
  ('fn_mystery_bounty_settle',
   'Platform mystery residual authority, invoked inside fn_complete_tournament_terminal.'),
  ('fn_mystery_bounty_pay',
   'Platform revealed mystery chest authority, invoked by fn_mystery_bounty_settle.')
ON CONFLICT (source) DO UPDATE SET note=EXCLUDED.note;

-- The satellite authority introduced terminal_closed_at and stamps it in the
-- same transaction as its money receipt. Enforce the shared table shape before
-- installing the irreversible guard for every terminal tournament path.
ALTER TABLE public.tables
  ADD CONSTRAINT tables_terminal_closed_shape
  CHECK (terminal_closed_at IS NULL OR (
    lower(COALESCE(status::text,'')) = 'closed'
    AND lower(COALESCE(lifecycle,'')) = 'closed'
    AND current_players IS NOT DISTINCT FROM 0
  )) NOT VALID;
ALTER TABLE public.tables VALIDATE CONSTRAINT tables_terminal_closed_shape;

CREATE OR REPLACE FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_table_guard$
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
$terminal_table_guard$;

REVOKE ALL ON FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_table_terminal_close_is_irreversible
  BEFORE INSERT OR DELETE OR UPDATE OF id,tournament_id,status,current_players,
    lifecycle,terminal_closed_at ON public.tables
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_table_terminal_close_is_irreversible();

-- Hand stack settlement used to lock seats in caller-supplied JSON order.
-- Terminal close locks the whole table, so two different JSON orders could
-- meet it on different seat rows and cycle. Preserve the audited hand writer
-- byte-for-byte from the 20260908042156 canonical-request authority, including
-- the 20260908045608 zero-delta departed-seat refinement, except for one
-- canonical bulk prelock, the tournament-player mirror and the zero-seat
-- release at the same durable hand boundary. The definition hash makes
-- upstream drift a migration stop, never a best-effort textual patch.
DO $harden_hand_stack_lock_order$
DECLARE
  v_definition text;
  v_hardened text;
  v_declaration_needle text := $needle$  v_tournament_id uuid; v_prev_settled timestamptz; v_grants jsonb := '{}'::jsonb;
  v_explained numeric := 0;$needle$;
  v_declaration_replacement text := $replacement$  v_tournament_id uuid; v_prev_settled timestamptz; v_grants jsonb := '{}'::jsonb;
  v_explained numeric := 0;
  -- The hand result is also the durable final-stack boundary for a tournament.
  v_tournament_status text;
  v_payload_stack_count integer := 0;
  v_target_user_count integer := 0;
  v_tournament_player_count integer := 0;
  v_tournament_player_user_ids uuid[] := ARRAY[]::uuid[];
  v_tournament_player_chips jsonb := '[]'::jsonb;
  v_zero_stack_seat_count integer := 0;
  v_zero_stack_seat_ids uuid[] := ARRAY[]::uuid[];
  v_zero_stack_user_ids uuid[] := ARRAY[]::uuid[];
  v_zero_stack_vacated_at timestamptz;
  v_table_live_seat_count integer := 0;$replacement$;
  v_loop_needle text := $needle$    -- lock seats, compute deltas / targets
    FOR e IN SELECT * FROM jsonb_array_elements(v_canonical) LOOP$needle$;
  v_loop_replacement text := $replacement$    -- ONE LOCK ORDER WITH TERMINAL CLOSE (20260908): tournament,
    -- target tournament players by user_id/id, then target seats by id. The
    -- terminal authority takes the same order. A hand that waited behind a
    -- terminal commit sees COMPLETED and is refused before touching a seat.
    SELECT tb.tournament_id INTO v_tournament_id
      FROM public.tables tb WHERE tb.id = p_table_id;
    IF v_tournament_id IS NOT NULL THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_tournament_status
        FROM public.tournaments t
       WHERE t.id = v_tournament_id
       FOR UPDATE;
      IF NOT FOUND OR v_tournament_status <> 'RUNNING' THEN
        RAISE EXCEPTION
          'tournament % is not RUNNING at the durable hand boundary',
          v_tournament_id USING ERRCODE = '55000';
      END IF;
      SELECT count(*),count(DISTINCT (x.value->>'user_id')::uuid)
        INTO v_payload_stack_count,v_target_user_count
        FROM jsonb_array_elements(v_canonical) AS x(value);
      IF v_target_user_count <> v_payload_stack_count THEN
        RAISE EXCEPTION 'tournament hand % contains duplicate player stacks',
          p_hand_number USING ERRCODE = '22023';
      END IF;
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing'
         AND tp.user_id IN (
           SELECT (x.value->>'user_id')::uuid
             FROM jsonb_array_elements(v_canonical) AS x(value))
       ORDER BY tp.user_id,tp.id
       FOR UPDATE;
      SELECT count(*) INTO v_tournament_player_count
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing'
         AND tp.user_id IN (
           SELECT (x.value->>'user_id')::uuid
             FROM jsonb_array_elements(v_canonical) AS x(value));
      IF v_tournament_player_count <> v_target_user_count THEN
        RAISE EXCEPTION
          'tournament % hand % does not map every stack to one playing player',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;
      -- A zero-seat vacate fires the seat-first table count trigger. Own the
      -- table before the seats, matching terminal close, so that trigger only
      -- reacquires a row this transaction already holds.
      PERFORM 1 FROM public.tables tb
       WHERE tb.id = p_table_id AND tb.tournament_id = v_tournament_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament table % changed while hand % was locking',
          p_table_id,p_hand_number USING ERRCODE = '40001';
      END IF;
    END IF;

    -- Acquire every live target seat once in durable row-id order before the
    -- original loop. The loop's individual SELECT FOR UPDATE calls then
    -- reacquire locks that this transaction already owns. v_canonical is also
    -- the immutable replay identity, so lock, write and receipt use one roster.
    PERFORM 1
      FROM public.table_seats ts
      JOIN (
        SELECT DISTINCT (x.value->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(v_canonical) AS x(value)
      ) target ON target.user_id = ts.user_id
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
     ORDER BY ts.id
     FOR UPDATE OF ts;

    -- lock seats, compute deltas / targets
    FOR e IN SELECT * FROM jsonb_array_elements(v_canonical) LOOP$replacement$;
  v_sync_needle text := $needle$    END LOOP;
    /* THE LEAVER STILL OWES WHAT THEY BET, AND IS STILL OWED WHAT THEY WON.$needle$;
  v_sync_replacement text := $replacement$    END LOOP;

    -- A successful tournament hand has one durable stack source. Mirror the
    -- exact resulting/rebased live seat targets into the matching playing
    -- tournament_players rows while both sets are still locked. Any missing,
    -- duplicate or divergent row rejects the whole hand subtransaction.
    IF v_tournament_id IS NOT NULL THEN
      UPDATE public.tournament_players tp
         SET chips = target.stack
        FROM (
          SELECT x.key::uuid AS user_id,x.value::numeric AS stack
            FROM jsonb_each_text(v_targets) AS x(key,value)
        ) target
       WHERE tp.tournament_id = v_tournament_id
         AND tp.user_id = target.user_id
         AND tp.status::text = 'playing';

      SELECT count(*),
             COALESCE(array_agg(tp.user_id ORDER BY tp.user_id),ARRAY[]::uuid[]),
             COALESCE(jsonb_agg(jsonb_build_object(
               'user_id',tp.user_id,'chips',tp.chips)
               ORDER BY tp.user_id),'[]'::jsonb)
        INTO v_tournament_player_count,v_tournament_player_user_ids,
             v_tournament_player_chips
        FROM public.tournament_players tp
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = tp.user_id
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing';
      IF v_tournament_player_count <>
           (SELECT count(*) FROM jsonb_each(v_targets))
         OR EXISTS (
           SELECT 1
             FROM jsonb_each_text(v_targets) target
            WHERE NOT EXISTS (
              SELECT 1
                FROM public.tournament_players tp
                JOIN public.table_seats ts
                  ON ts.table_id = p_table_id
                 AND ts.user_id = tp.user_id
                 AND ts.left_at IS NULL
               WHERE tp.tournament_id = v_tournament_id
                 AND tp.status::text = 'playing'
                 AND tp.user_id = target.key::uuid
                 AND tp.chips IS NOT DISTINCT FROM target.value::numeric
                 AND ts.stack IS NOT DISTINCT FROM target.value::numeric)) THEN
        RAISE EXCEPTION
          'tournament % hand % did not durably sync every final seat stack',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;

      -- A named zero-stack tournament seat is finished on the felt at this
      -- same durable hand boundary. Keep tournament_players playing with
      -- chips=0 so the rebuy/elimination state machine can decide its life,
      -- but release the physical seat now. This replaces the former
      -- PostgREST vacate followed by a compensating chips-zero write.
      SELECT count(*),
             COALESCE(array_agg(ts.id ORDER BY ts.id),ARRAY[]::uuid[]),
             COALESCE(array_agg(ts.user_id ORDER BY ts.user_id),ARRAY[]::uuid[])
        INTO v_zero_stack_seat_count,v_zero_stack_seat_ids,
             v_zero_stack_user_ids
        FROM public.table_seats ts
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = ts.user_id
       WHERE ts.table_id = p_table_id
         AND ts.left_at IS NULL
         AND ts.stack = 0
         AND target.value::numeric = 0;
      IF v_zero_stack_seat_count <>
           (SELECT count(*) FROM jsonb_each_text(v_targets) target
             WHERE target.value::numeric = 0) THEN
        RAISE EXCEPTION
          'tournament % hand % cannot identify every named zero-stack seat',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;

      IF v_zero_stack_seat_count > 0 THEN
        v_zero_stack_vacated_at := clock_timestamp();
        UPDATE public.table_seats ts
           SET left_at = v_zero_stack_vacated_at,
               status = 'left',
               leave_pending = false,
               is_sitting_out = false,
               is_away = false,
               sit_out_at = NULL,
               scheduled_leave_hands = NULL
         WHERE ts.id = ANY(v_zero_stack_seat_ids)
           AND ts.table_id = p_table_id
           AND ts.left_at IS NULL
           AND ts.stack = 0;
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated <> v_zero_stack_seat_count
           OR EXISTS (
             SELECT 1
               FROM unnest(v_zero_stack_seat_ids) expected(id)
              WHERE NOT EXISTS (
                SELECT 1 FROM public.table_seats ts
                 WHERE ts.id = expected.id
                   AND ts.table_id = p_table_id
                   AND ts.stack = 0
                   AND ts.left_at = v_zero_stack_vacated_at
                   AND ts.status = 'left'
                   AND COALESCE(ts.leave_pending,false) IS FALSE
                   AND COALESCE(ts.is_sitting_out,false) IS FALSE
                   AND COALESCE(ts.is_away,false) IS FALSE
                   AND ts.sit_out_at IS NULL
                   AND ts.scheduled_leave_hands IS NULL))
           OR EXISTS (
             SELECT 1
               FROM public.table_seats ts
               JOIN jsonb_each_text(v_targets) target
                 ON target.key::uuid = ts.user_id
              WHERE ts.table_id = p_table_id
                AND ts.left_at IS NULL
                AND target.value::numeric = 0) THEN
          RAISE EXCEPTION
            'tournament % hand % did not atomically vacate every zero-stack seat',
            v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
        END IF;
      END IF;

      SELECT count(*) INTO v_table_live_seat_count
        FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.left_at IS NULL;
      UPDATE public.tables tb
         SET current_players = v_table_live_seat_count,
             updated_at = now()
       WHERE tb.id = p_table_id
         AND tb.current_players IS DISTINCT FROM v_table_live_seat_count;
      IF NOT EXISTS (
        SELECT 1 FROM public.tables tb
         WHERE tb.id = p_table_id
           AND tb.tournament_id = v_tournament_id
           AND tb.current_players = v_table_live_seat_count) THEN
        RAISE EXCEPTION
          'tournament % hand % did not persist its exact live-seat count',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;
    END IF;

    /* THE LEAVER STILL OWES WHAT THEY BET, AND IS STILL OWED WHAT THEY WON.$replacement$;
  v_result_needle text := $needle$      'conservation_checked', v_delta_mode OR p_rake IS NOT NULL, 'request', v_request);$needle$;
  v_result_replacement text := $replacement$      'conservation_checked', v_delta_mode OR p_rake IS NOT NULL,
      'tournament_id', v_tournament_id,
      'tournament_players_synced', v_tournament_id IS NOT NULL,
      'tournament_player_count', v_tournament_player_count,
      'tournament_player_user_ids', to_jsonb(v_tournament_player_user_ids),
      'tournament_player_chips', v_tournament_player_chips,
      'tournament_zero_stack_seats_vacated', v_tournament_id IS NOT NULL,
      'tournament_zero_stack_seat_count', v_zero_stack_seat_count,
      'tournament_zero_stack_seat_ids', to_jsonb(v_zero_stack_seat_ids),
      'tournament_zero_stack_user_ids', to_jsonb(v_zero_stack_user_ids),
      'tournament_table_live_seat_count', v_table_live_seat_count,
      'request', v_request);$replacement$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
  IF v_definition IS NULL OR md5(v_definition) <> '027f6ca632a9aca339efd1c896e7f6a6'
     OR (length(v_definition)-length(replace(v_definition,v_declaration_needle,'')))
          / length(v_declaration_needle) <> 1
     OR (length(v_definition)-length(replace(v_definition,v_loop_needle,'')))
          / length(v_loop_needle) <> 1
     OR (length(v_definition)-length(replace(v_definition,v_sync_needle,'')))
          / length(v_sync_needle) <> 1
     OR (length(v_definition)-length(replace(v_definition,v_result_needle,'')))
          / length(v_result_needle) <> 1 THEN
    RAISE EXCEPTION
      'hand stack authority changed since audited lock-order baseline';
  END IF;
  v_hardened := replace(v_definition,v_declaration_needle,
                         v_declaration_replacement);
  v_hardened := replace(v_hardened,v_loop_needle,v_loop_replacement);
  v_hardened := replace(v_hardened,v_sync_needle,v_sync_replacement);
  v_hardened := replace(v_hardened,v_result_needle,v_result_replacement);
  EXECUTE v_hardened;
END;
$harden_hand_stack_lock_order$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric)
  TO service_role;

-- Live mystery draw and pay formerly acquired a chest/award before the event
-- row. Terminal close owns the event first and then inventory, so an in-flight
-- reveal could form award -> tournament against tournament -> award. Preserve
-- both audited bodies exactly except for a tournament-first serialization
-- lock (and, for pay, the same obligation/chest/award/recipient order).
DO $harden_mystery_live_lock_order$
DECLARE
  v_pay_definition text;
  v_pay_hardened text;
  v_pay_decl_needle text := $needle$  v_prior numeric; v_settle jsonb;$needle$;
  v_pay_decl_replacement text := $replacement$  v_prior numeric; v_settle jsonb;
  v_tournament_id uuid;$replacement$;
  v_pay_lock_needle text := $needle$  SELECT * INTO v_a FROM public.tournament_bounty_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;$needle$;
  v_pay_lock_replacement text := $replacement$  SELECT a.tournament_id INTO v_tournament_id
    FROM public.tournament_bounty_awards a WHERE a.id = p_award_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found');
  END IF;
  PERFORM 1 FROM public.tournaments t
   WHERE t.id = v_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mystery award % lost tournament %',
      p_award_id,v_tournament_id USING ERRCODE = 'P0404';
  END IF;
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.user_id,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = v_tournament_id ORDER BY c.id FOR UPDATE;
  SELECT * INTO v_a FROM public.tournament_bounty_awards
   WHERE id = p_award_id AND tournament_id = v_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;
  PERFORM 1 FROM public.tournament_bounty_award_recipients r
   WHERE r.award_id = p_award_id ORDER BY r.user_id,r.id FOR UPDATE;$replacement$;
  v_reserve_definition text;
  v_reserve_hardened text;
  v_reserve_lock_needle text := $needle$  -- IDEMPOTENCY, TWO WAYS. op_id catches the same call retrying; the$needle$;
  v_reserve_lock_replacement text := $replacement$  -- Tournament first: terminal close and every live mystery inventory writer
  -- serialize before either can own a chest or award row.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  -- IDEMPOTENCY, TWO WAYS. op_id catches the same call retrying; the$replacement$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_pay_definition
    FROM pg_proc p
   WHERE p.oid = 'public.fn_mystery_bounty_pay(uuid)'::regprocedure;
  IF v_pay_definition IS NULL
     OR md5(v_pay_definition) <> '778b910c18c7bba9ce7d53eb153eebe0'
     OR (length(v_pay_definition)-length(replace(
           v_pay_definition,v_pay_decl_needle,'')))
          / length(v_pay_decl_needle) <> 1
     OR (length(v_pay_definition)-length(replace(
           v_pay_definition,v_pay_lock_needle,'')))
          / length(v_pay_lock_needle) <> 1 THEN
    RAISE EXCEPTION 'mystery bounty pay changed since audited lock-order baseline';
  END IF;
  v_pay_hardened := replace(v_pay_definition,v_pay_decl_needle,
                            v_pay_decl_replacement);
  v_pay_hardened := replace(v_pay_hardened,v_pay_lock_needle,
                            v_pay_lock_replacement);
  EXECUTE v_pay_hardened;

  SELECT pg_get_functiondef(p.oid) INTO v_reserve_definition
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)'::regprocedure;
  IF v_reserve_definition IS NULL
     OR md5(v_reserve_definition) <> 'ff7385b39344d810564dd4c35d71b7c0'
     OR (length(v_reserve_definition)-length(replace(
           v_reserve_definition,v_reserve_lock_needle,'')))
          / length(v_reserve_lock_needle) <> 1 THEN
    RAISE EXCEPTION 'mystery bounty reserve changed since audited lock-order baseline';
  END IF;
  v_reserve_hardened := replace(v_reserve_definition,v_reserve_lock_needle,
                                v_reserve_lock_replacement);
  EXECUTE v_reserve_hardened;
END;
$harden_mystery_live_lock_order$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer) TO service_role;

-- Drain every older tournament writer before the cutover inventory is taken.
-- A timestamp cannot classify a transaction that began before this migration
-- and committed while DDL waited. Identity captured behind the write barrier
-- makes every later COMPLETED row receipt-required without clock inference.
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.tournament_terminal_settlement_cutover (
  authority                         text PRIMARY KEY
    CHECK (authority = 'fn_complete_tournament_terminal:v1'),
  migration_version                 text NOT NULL
    CHECK (migration_version = '20260908153329'),
  installed_at                      timestamptz NOT NULL,
  preexisting_completed_ids         uuid[] NOT NULL,
  CHECK (array_position(preexisting_completed_ids, NULL) IS NULL)
);

ALTER TABLE public.tournament_terminal_settlement_cutover
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_terminal_settlement_cutover
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.tournament_terminal_settlement_cutover
  (authority, migration_version, installed_at,
   preexisting_completed_ids)
SELECT 'fn_complete_tournament_terminal:v1', '20260908153329',
       clock_timestamp(), ARRAY(
         SELECT t.id
           FROM public.tournaments t
          WHERE upper(COALESCE(t.status::text, '')) = 'COMPLETED'
            AND NOT (
                 lower(COALESCE(t.variant::text, '')) = 'satellite'
              OR upper(COALESCE(t.tournament_type::text, '')) = 'SATELLITE'
              OR t.satellite_target_id IS NOT NULL
              OR t.satellite_target IS NOT NULL)
          ORDER BY t.id
       );

COMMENT ON TABLE public.tournament_terminal_settlement_cutover IS
  'Owner-only terminal cutover watermark captured behind a tournament write barrier. Every completed non-satellite outside the immutable preexisting inventory must carry an exact terminal receipt.';

CREATE TABLE public.tournament_terminal_settlements (
  tournament_id          uuid PRIMARY KEY
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  winner_id              uuid NOT NULL,
  settlement_mode        text NOT NULL
    CHECK (settlement_mode IN ('places','final_table_deal')),
  started_status         text NOT NULL
    CHECK (started_status IN ('RUNNING','COMPLETING')),
  prize_pool             numeric(15,2) NOT NULL
    CHECK (prize_pool >= 0 AND prize_pool = round(prize_pool, 2)),
  bounty_pool            numeric(15,2) NOT NULL
    CHECK (bounty_pool >= 0 AND bounty_pool = round(bounty_pool, 2)),
  cash_payout_count      integer NOT NULL CHECK (cash_payout_count >= 0),
  cash_payout_total      numeric(15,2) NOT NULL
    CHECK (cash_payout_total >= 0 AND cash_payout_total = round(cash_payout_total, 2)),
  bounty_payout_total    numeric(15,2) NOT NULL
    CHECK (bounty_payout_total >= 0 AND bounty_payout_total = round(bounty_payout_total, 2)),
  mystery_was_active     boolean NOT NULL,
  mystery_pool_cents     bigint NOT NULL CHECK (mystery_pool_cents >= 0),
  cash_receipt           jsonb NOT NULL CHECK (jsonb_typeof(cash_receipt) = 'object'),
  mystery_receipt        jsonb NOT NULL CHECK (jsonb_typeof(mystery_receipt) = 'object'),
  bounty_receipt         jsonb NOT NULL CHECK (jsonb_typeof(bounty_receipt) = 'object'),
  closed_table_count     integer NOT NULL CHECK (closed_table_count >= 0),
  closed_table_ids       uuid[] NOT NULL,
  source_seat_count      integer NOT NULL CHECK (source_seat_count >= 0),
  source_seat_ids        uuid[] NOT NULL,
  released_seat_count    integer NOT NULL CHECK (released_seat_count >= 0),
  released_seat_ids      uuid[] NOT NULL,
  rake_amount            numeric(15,2) NOT NULL
    CHECK (rake_amount >= 0 AND rake_amount = round(rake_amount, 2)),
  rake_destination       text NOT NULL CHECK (length(btrim(rake_destination)) > 0),
  rake_settled_at        timestamptz NOT NULL,
  rake_attributed_at     timestamptz NOT NULL,
  rake_attributed_users  integer NOT NULL CHECK (rake_attributed_users >= 0),
  escrow_closed_at       timestamptz NOT NULL,
  escrow_close_note      text NOT NULL CHECK (length(btrim(escrow_close_note)) > 0),
  completed_at           timestamptz NOT NULL,
  settled_at             timestamptz NOT NULL DEFAULT transaction_timestamp(),
  receipt_version        integer NOT NULL DEFAULT 1 CHECK (receipt_version = 1),
  CHECK (cash_payout_total = prize_pool),
  CHECK (bounty_payout_total = bounty_pool),
  CHECK ((mystery_was_active AND mystery_pool_cents > 0)
      OR (NOT mystery_was_active AND mystery_pool_cents = 0)),
  CHECK (closed_table_count = cardinality(closed_table_ids)),
  CHECK (source_seat_count = cardinality(source_seat_ids)),
  CHECK (released_seat_count = cardinality(released_seat_ids)),
  CHECK (array_position(closed_table_ids, NULL) IS NULL),
  CHECK (array_position(source_seat_ids, NULL) IS NULL),
  CHECK (array_position(released_seat_ids, NULL) IS NULL),
  CHECK (released_seat_ids <@ source_seat_ids),
  CHECK (rake_settled_at <= settled_at AND rake_attributed_at <= settled_at),
  CHECK (escrow_closed_at <= settled_at),
  CHECK (completed_at <= settled_at)
);

ALTER TABLE public.tournament_terminal_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_terminal_settlements
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.tournament_terminal_settlements IS
  'Immutable all-or-nothing non-satellite completion receipt: exact cash authority result, bounty close, durable attributed rake, released seats, closed tables and completed lifecycle state.';

CREATE OR REPLACE FUNCTION public.fn_tournament_terminal_receipts_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $terminal_receipts_append_only$
BEGIN
  RAISE EXCEPTION
    'tournament terminal settlement evidence is immutable; % is refused for tournament %',
    TG_OP, OLD.tournament_id USING ERRCODE = 'restrict_violation';
END;
$terminal_receipts_append_only$;

REVOKE ALL ON FUNCTION public.fn_tournament_terminal_receipts_are_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_terminal_settlements_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_terminal_settlements
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_terminal_receipts_are_append_only();

-- A plain parent/receipt lookup in a row trigger is not enough after a writer
-- has waited for a child tuple: READ COMMITTED keeps the command snapshot that
-- existed before the wait. Give every mutable receipt-owned child its own
-- one-way marker instead. These nullable, no-default columns are an expand-only
-- catalog change; existing rows are neither rewritten nor guessed. A
-- synchronous parent-status trigger stamps every child in the same transaction
-- as COMPLETED/CANCELLED. A queued UPDATE/DELETE then resumes on the newest
-- tuple version and sees OLD.terminal_closed_at without consulting a stale
-- snapshot.
ALTER TABLE public.tournament_players
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_obligations
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_payouts
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_rake_settlements
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.rake_records
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_bounty_chests
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_bounty_awards
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_guarantee_overlays
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.table_seats
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.wallet_transactions
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_bounty_award_recipients
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_escrow
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.spin_reserve_ledger
  ADD COLUMN terminal_closed_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_ca_terminal_marker_transition_is_exact(
  p_old jsonb,
  p_new jsonb,
  p_tournament_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_marker_transition$
  SELECT COALESCE(
    p_old ? 'terminal_closed_at'
    AND p_new ? 'terminal_closed_at'
    AND NULLIF(p_old->>'terminal_closed_at','') IS NULL
    AND NULLIF(p_new->>'terminal_closed_at','') IS NOT NULL
    AND (p_new - 'terminal_closed_at') IS NOT DISTINCT FROM
        (p_old - 'terminal_closed_at')
    AND EXISTS (
      SELECT 1
        FROM public.tournaments t
       WHERE t.id = p_tournament_id
         AND upper(COALESCE(t.status::text,'')) IN
             ('COMPLETED','CANCELLED','CANCELED')
         AND t.ended_at IS NOT NULL
         AND isfinite(t.ended_at)
         AND NULLIF(p_new->>'terminal_closed_at','')::timestamptz
               IS NOT DISTINCT FROM t.ended_at
    ),false)
$terminal_marker_transition$;

REVOKE ALL ON FUNCTION public.fn_ca_terminal_marker_transition_is_exact(
  jsonb,jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- A terminal receipt is not immutable if a service caller can append a new
-- payout, obligation, roster row or other tournament-owned evidence after the
-- close. INSERT takes a parent share lock before creating a row. Unlike key
-- share, this conflicts with terminal's non-key status change. The insert either
-- commits before terminal owns the tournament, so the terminal verifier sees
-- it, or waits behind terminal and is refused. UPDATE and DELETE never take a
-- child-to-parent lock. Their row-owned marker is the race-free terminal fact;
-- the parent/receipt read remains only the compatibility fence for terminal
-- receipts committed before these marker columns existed.
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_evidence_guard$
DECLARE
  v_tournament_id uuid;
  v_status text;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
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
$terminal_evidence_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DO $install_terminal_evidence_guards$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'tournament_players',
    'tournament_obligations',
    'tournament_payouts',
    'chip_ledger',
    'tournament_rake_settlements',
    'rake_records',
    'tournament_bounty_chests',
    'tournament_bounty_awards',
    'tournament_guarantee_overlays',
    'tournament_satellite_awards',
    'tournament_satellite_remainders',
    'tournament_refund_entitlements',
    'tournament_refund_tranches',
    'spin_reserve_ledger',
    'tournament_spin_cancellation_unwinds'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS terminal_tournament_evidence_is_immutable ON public.%I',
      v_table);
    EXECUTE format(
      'CREATE TRIGGER terminal_tournament_evidence_is_immutable '
      || 'BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW '
      || 'EXECUTE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()',
      v_table);
  END LOOP;
END;
$install_terminal_evidence_guards$;

-- A seat has no tournament_id of its own, so bind it through its table. New
-- membership locks the parent first and cannot cross a terminal boundary.
-- Existing rows are already frozen by terminal's source-seat prelock; after a
-- waiter resumes, any mutation or deletion of a terminal seat is refused.
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_seat_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_seat_guard$
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
  IF TG_OP <> 'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id = NEW.table_id;
  END IF;
  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
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
$terminal_seat_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_tournament_seat_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_tournament_seat_is_immutable ON public.table_seats;
CREATE TRIGGER terminal_tournament_seat_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_terminal_tournament_seat_is_immutable();

-- The parent tuple is its own race-free lifecycle fact. Once OLD is terminal,
-- reject before any receipt lookup: a writer queued before terminal commit
-- resumes with the newest OLD tuple even though its statement snapshot cannot
-- see the just-committed receipt. The initial live -> terminal transition is
-- allowed because OLD is not terminal; the deferred verifier still requires
-- one exact receipt before that transaction can commit.
CREATE OR REPLACE FUNCTION public.fn_receipted_tournament_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $receipted_tournament_guard$
BEGIN
  IF upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED') THEN
    RAISE EXCEPTION 'terminal tournament % is immutable after closure',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$receipted_tournament_guard$;

REVOKE ALL ON FUNCTION public.fn_receipted_tournament_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS receipted_tournament_is_immutable ON public.tournaments;
CREATE TRIGGER receipted_tournament_is_immutable
  BEFORE DELETE OR UPDATE OF status,variant,tournament_type,
    satellite_target_id,satellite_target,satellite_seats,
    prize_pool,prize_pool_finalized,bounty_pool,bounty_pool_paid,
    is_bounty,is_pko,is_mystery_bounty,mystery_bounty_stage,
    mystery_bounty_pool_cents,club_id,ended_at,current_players,on_break,
    break_started_at,break_ends_at
  ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_receipted_tournament_is_immutable();

CREATE OR REPLACE FUNCTION public.fn_ca_has_committed_tournament_receipt(
  p_tournament_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $has_terminal_receipt$
  SELECT COALESCE((
    SELECT (upper(COALESCE(t.status::text,'')) = 'COMPLETED'
       AND (EXISTS (
              SELECT 1 FROM public.tournament_terminal_settlements h
               WHERE h.tournament_id = t.id)
         OR EXISTS (
              SELECT 1 FROM public.tournament_satellite_settlements h
               WHERE h.tournament_id = t.id)))
       OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
       AND EXISTS (
              SELECT 1 FROM public.tournament_cancellation_receipts h
               WHERE h.tournament_id = t.id))
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
  ),false)
$has_terminal_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_has_committed_tournament_receipt(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Recipient rows do not carry tournament_id. Bind them through their award so
-- a completed mystery receipt cannot later gain, lose or rewrite a payee.
CREATE OR REPLACE FUNCTION public.fn_terminal_bounty_recipient_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_bounty_recipient_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.award_id IS DISTINCT FROM OLD.award_id THEN
    RAISE EXCEPTION 'bounty recipient award ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT a.tournament_id INTO v_old_tournament_id
      FROM public.tournament_bounty_awards a WHERE a.id = OLD.award_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.tournament_id INTO v_new_tournament_id
      FROM public.tournament_bounty_awards a WHERE a.id = NEW.award_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new bounty recipient cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal bounty recipient evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'bounty recipient terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal bounty recipient evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal bounty recipient evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_bounty_recipient_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_bounty_recipient_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_bounty_recipient_is_immutable
  ON public.tournament_bounty_award_recipients;
CREATE TRIGGER terminal_bounty_recipient_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.tournament_bounty_award_recipients
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_terminal_bounty_recipient_is_immutable();

-- Bounty receipt verification reads wallet_transactions by related_entity_id.
-- Evaluate OLD and NEW ownership so a privileged update cannot move a row
-- into or out of a completed receipt after the close.
CREATE OR REPLACE FUNCTION public.fn_terminal_wallet_transaction_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_wallet_transaction_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.related_entity_id IS DISTINCT FROM OLD.related_entity_id THEN
    RAISE EXCEPTION 'wallet transaction ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT t.id INTO v_old_tournament_id FROM public.tournaments t
     WHERE t.id = OLD.related_entity_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.id INTO v_new_tournament_id FROM public.tournaments t
     WHERE t.id = NEW.related_entity_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new wallet transaction cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'wallet transaction terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_wallet_transaction_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_wallet_transaction_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_wallet_transaction_is_immutable
  ON public.wallet_transactions;
CREATE TRIGGER terminal_wallet_transaction_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_terminal_wallet_transaction_is_immutable();

-- Credit keys are polymorphic text. Resolve only the three tournament receipt
-- namespaces and freeze both sides of an UPDATE. Unrelated wallet keys retain
-- their existing lifecycle.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_id_from_credit_key(p_key text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $tournament_from_credit_key$
DECLARE
  v_id_text text;
  v_id uuid;
BEGIN
  IF p_key LIKE 'tourney:%' OR p_key LIKE 'mb-residual:%' THEN
    v_id_text := split_part(p_key,':',2);
    IF v_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN v_id_text::uuid;
    END IF;
  ELSIF p_key LIKE 'mb:%' THEN
    v_id_text := split_part(p_key,':',2);
    IF v_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT a.tournament_id INTO v_id
        FROM public.tournament_bounty_awards a WHERE a.id = v_id_text::uuid;
      RETURN v_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$tournament_from_credit_key$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_id_from_credit_key(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_terminal_credit_key_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_credit_key_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_new_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'wallet credit idempotency keys are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_old_tournament_id := public.fn_ca_tournament_id_from_credit_key(OLD.key);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_tournament_id := public.fn_ca_tournament_id_from_credit_key(NEW.key);
  END IF;
  -- Recognized payout claims are append-only financial evidence. An existing
  -- row is already locked before this row trigger runs, so UPDATE/DELETE must
  -- refuse immediately instead of reversing the terminal root lock order.
  IF TG_OP <> 'INSERT'
     AND COALESCE(v_old_tournament_id,v_new_tournament_id) IS NOT NULL THEN
    RAISE EXCEPTION 'tournament wallet credit claims are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal wallet credit key evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_new_tournament_id IS NOT NULL
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal wallet credit key evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_credit_key_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_credit_key_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_credit_key_is_immutable
  ON public.wallet_credit_idempotency;
CREATE TRIGGER terminal_credit_key_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.wallet_credit_idempotency
  FOR EACH ROW EXECUTE FUNCTION public.fn_terminal_credit_key_is_immutable();

-- Both atomic completion authorities have already stamped exact-zero escrow
-- before lifecycle. The old after-status observer would rewrite that proof,
-- so detach it now and freeze the source bank once its receipt is committed.
DROP TRIGGER IF EXISTS zz_ca_escrow_close ON public.tournaments;

CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_escrow_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_escrow_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'tournament escrow ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament escrow cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tournament escrow terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_escrow_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_tournament_escrow_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_tournament_escrow_is_immutable
  ON public.tournament_escrow;
CREATE TRIGGER terminal_tournament_escrow_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_escrow
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_terminal_tournament_escrow_is_immutable();

-- This is a synchronous ownership transition, not a watcher or reconciler.
-- It runs inside the one status-changing transaction after the parent row is
-- terminal and stamps every mutable row that a terminal receipt will verify.
-- Tables use their pre-existing terminal_closed_at invariant and are closed by
-- each authority immediately after the parent transition. Append-only journal,
-- idempotency, refund, satellite and original Spin receipt rows need no marker
-- because their own guards already refuse every UPDATE/DELETE. Mutable Spin
-- cancellation reversal rows are stamped below; every INSERT guard still takes
-- the parent lock.
CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_terminal_evidence_markers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $stamp_terminal_evidence_markers$
DECLARE
  v_terminal_at timestamptz;
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) NOT IN
       ('COMPLETED','CANCELLED','CANCELED')
     OR (TG_OP = 'UPDATE' AND upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED')) THEN
    RETURN NEW;
  END IF;
  v_terminal_at := NEW.ended_at;
  IF v_terminal_at IS NULL OR NOT isfinite(v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % requires one finite close marker',NEW.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.tournament_players
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_obligations
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_payouts
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_rake_settlements
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.rake_records
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_chests
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_awards
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_guarantee_overlays
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.table_seats s
     SET terminal_closed_at = v_terminal_at
    FROM public.tables tb
   WHERE tb.id = s.table_id AND tb.tournament_id = NEW.id
     AND s.terminal_closed_at IS NULL;
  UPDATE public.wallet_transactions
     SET terminal_closed_at = v_terminal_at
   WHERE related_entity_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_award_recipients r
     SET terminal_closed_at = v_terminal_at
    FROM public.tournament_bounty_awards a
   WHERE a.id = r.award_id AND a.tournament_id = NEW.id
     AND r.terminal_closed_at IS NULL;
  UPDATE public.tournament_escrow
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  -- Contribution and jackpot-draw rows already have an unconditional
  -- append-only guard. Cancellation reversal/surplus rows intentionally do
  -- not, so give precisely those mutable Spin rows the terminal tuple marker.
  UPDATE public.spin_reserve_ledger
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id
     AND kind NOT IN ('contribution','jackpot_draw')
     AND terminal_closed_at IS NULL;

  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=NEW.id
                AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=NEW.id
          AND s.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=NEW.id
          AND r.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=NEW.id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % did not stamp every mutable evidence row',
      NEW.id USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$stamp_terminal_evidence_markers$;

REVOKE ALL ON FUNCTION public.fn_stamp_tournament_terminal_evidence_markers()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS stamp_tournament_terminal_evidence_markers
  ON public.tournaments;
CREATE TRIGGER stamp_tournament_terminal_evidence_markers
  AFTER INSERT OR UPDATE OF status ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_stamp_tournament_terminal_evidence_markers();

-- A delivered target registration remains live gameplay state, so chips and
-- status may continue changing. Its identity and satellite provenance cannot.
-- New provenance rows and target fee evidence tied to a completed source are
-- also refused, while writes during the source's COMPLETING transaction pass.
CREATE OR REPLACE FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_target_player_guard$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_status text;
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
        IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
          RAISE EXCEPTION 'completed satellite target provenance is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_source_ids) source(id)
     WHERE public.fn_ca_has_committed_tournament_receipt(source.id)
  ) THEN
    RAISE EXCEPTION 'completed satellite target provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$satellite_target_player_guard$;

REVOKE ALL ON FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS satellite_target_player_provenance_is_immutable
  ON public.tournament_players;
CREATE TRIGGER satellite_target_player_provenance_is_immutable
  BEFORE INSERT OR DELETE OR UPDATE OF id,tournament_id,user_id,
    is_satellite_qualifier,source_satellite_id
  ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_satellite_target_player_provenance_is_immutable();

CREATE OR REPLACE FUNCTION public.fn_satellite_target_rake_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_target_rake_guard$
DECLARE
  v_old_source_id uuid;
  v_new_source_id uuid;
  v_text text;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_text := OLD.metadata->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_old_source_id := v_text::uuid;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_text := NEW.metadata->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_new_source_id := v_text::uuid;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.metadata->>'satellite_id') IS DISTINCT FROM
         (OLD.metadata->>'satellite_id') THEN
    RAISE EXCEPTION 'satellite target rake ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker
     AND public.fn_ca_terminal_marker_transition_is_exact(
           to_jsonb(OLD),to_jsonb(NEW),OLD.tournament_id) THEN
    RETURN NEW;
  END IF;
  -- A recognized satellite fee row is append-only. Refusing an already-locked
  -- UPDATE/DELETE before any parent lookup removes the child-to-source lock
  -- edge. INSERT locks the target first, then the source, matching the
  -- canonical satellite authority.
  IF TG_OP <> 'INSERT'
     AND COALESCE(v_old_source_id,v_new_source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'satellite target rake rows are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite rake evidence'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_source_id IS NOT NULL
     AND v_new_source_id IS DISTINCT FROM NEW.tournament_id THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_source_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'completed satellite target rake evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_new_source_id IS NOT NULL
     AND v_new_source_id IS DISTINCT FROM v_old_source_id THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id = v_new_source_id FOR SHARE;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_source_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_source_id) THEN
    RAISE EXCEPTION 'completed satellite target rake evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$satellite_target_rake_guard$;

REVOKE ALL ON FUNCTION public.fn_satellite_target_rake_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS satellite_target_rake_is_immutable
  ON public.rake_records;
CREATE TRIGGER satellite_target_rake_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.rake_records
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_target_rake_is_immutable();

-- The seat transfer journal is queried by source liability and key, not only
-- by chip_ledger.tournament_id. Resolve every ownership witness and take the
-- source root lock on every operation. Terminal completion never waits on a
-- journal row, so a concurrent maintenance rewrite safely waits and is then
-- refused instead of slipping in after receipt verification.
CREATE OR REPLACE FUNCTION public.fn_satellite_transfer_ledger_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_transfer_ledger_guard$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_target_id uuid;
  v_text text;
  v_row jsonb;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.from_entity_id IS DISTINCT FROM OLD.from_entity_id
       OR NEW.to_entity_id IS DISTINCT FROM OLD.to_entity_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR (NEW.metadata->>'satellite_id') IS DISTINCT FROM
          (OLD.metadata->>'satellite_id')) THEN
    RAISE EXCEPTION 'satellite transfer journal ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_row IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  ] LOOP
    IF v_row IS NULL THEN CONTINUE; END IF;
    v_text := v_row->>'tournament_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    IF v_row->>'from_type' = 'prize_liability' THEN
      v_text := v_row->>'from_entity_id';
      IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_source_ids := array_append(v_source_ids,v_text::uuid);
      END IF;
    END IF;
    v_text := split_part(COALESCE(v_row->>'idempotency_key',''),':',2);
    IF COALESCE(v_row->>'idempotency_key','') LIKE 'tourney:%:seat:%:pool_transfer'
       AND v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    v_text := v_row->'metadata'->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
  END LOOP;
  IF TG_OP <> 'INSERT' AND cardinality(v_source_ids) > 0 THEN
    RAISE EXCEPTION 'satellite transfer journal is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.to_type = 'prize_liability' THEN
    SELECT t.id INTO v_target_id FROM public.tournaments t
     WHERE t.id = NEW.to_entity_id;
    IF v_target_id IS NOT NULL THEN
      -- The transfer's AFTER trigger writes target escrow, so own the target
      -- before any source root exactly as fn_settle_satellite_tournament does.
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_target_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'terminal target cannot accept a satellite transfer journal'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  FOR v_source_id IN
    SELECT DISTINCT source.id FROM unnest(v_source_ids) source(id)
     WHERE source.id IS NOT NULL ORDER BY source.id
  LOOP
    IF TG_OP = 'INSERT' AND v_source_id IS DISTINCT FROM v_target_id THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_source_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'completed satellite transfer journal is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF public.fn_ca_has_committed_tournament_receipt(v_source_id) THEN
      RAISE EXCEPTION 'completed satellite transfer journal is immutable'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$satellite_transfer_ledger_guard$;

REVOKE ALL ON FUNCTION public.fn_satellite_transfer_ledger_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS satellite_transfer_ledger_is_immutable
  ON public.chip_ledger;
CREATE TRIGGER satellite_transfer_ledger_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_satellite_transfer_ledger_is_immutable();

-- Mystery payouts crossed the obligation cutover while long-running events
-- were still live. Credits before 2026-09-02 are proved by their immutable
-- `mb:<award>:<recipient>` / `mb-residual:<event>` wallet keys; newer credits
-- are proved by the cumulative mystery obligation and every immutable key that
-- made up that obligation. This owner-only helper proves the two eras as one
-- exact partition. It never backfills or guesses. Both first completion and
-- receipt replay call this same body, so compatibility cannot be looser on the
-- first pass than it is forever after.
CREATE OR REPLACE FUNCTION public.fn_ca_mystery_bounty_completion_evidence(
  p_tournament_id uuid,
  p_winner_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $mystery_completion_evidence$
DECLARE
  v_t record;
  v_inventory_cents bigint;
  v_completed_award_cents bigint;
  v_void_chest_cents bigint;
  v_legacy_award_cents bigint;
  v_legacy_residual_cents bigint;
  v_legacy_residual_amount numeric;
  v_legacy_credit_cents bigint;
  v_obligation_cents bigint;
  v_evidence_mode text;
BEGIN
  IF p_tournament_id IS NULL OR p_winner_user_id IS NULL THEN
    RAISE EXCEPTION 'mystery completion evidence requires tournament and winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.id,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND
     OR COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
     OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
     OR COALESCE(v_t.mystery_bounty_pool_cents,0) <= 0 THEN
    RAISE EXCEPTION 'tournament % has no complete funded mystery inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_winner_user_id
  ) THEN
    RAISE EXCEPTION 'mystery completion winner % is not in tournament %',
      p_winner_user_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(sum(c.amount_cents),0),
         COALESCE(sum(c.amount_cents) FILTER (WHERE c.status = 'void'),0)
    INTO v_inventory_cents,v_void_chest_cents
    FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = p_tournament_id;
  SELECT COALESCE(sum(a.amount_cents) FILTER (
           WHERE a.status = 'completed'),0)
    INTO v_completed_award_cents
    FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id;

  IF v_inventory_cents IS DISTINCT FROM v_t.mystery_bounty_pool_cents
     OR v_completed_award_cents + v_void_chest_cents
          IS DISTINCT FROM v_t.mystery_bounty_pool_cents
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_chests c
        WHERE c.tournament_id = p_tournament_id
          AND (c.amount_cents <= 0 OR c.status NOT IN ('paid','void')
            OR (c.status = 'paid' AND (c.award_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_awards a
               WHERE a.id = c.award_id
                 AND a.tournament_id = p_tournament_id
                 AND a.chest_id = c.id
                 AND a.amount_cents = c.amount_cents
                 AND a.status = 'completed')))
            OR (c.status = 'void' AND c.award_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_awards a
               WHERE a.id = c.award_id
                 AND a.tournament_id = p_tournament_id
                 AND a.chest_id = c.id
                 AND a.amount_cents = c.amount_cents
                 AND a.status = 'void'))))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_awards a
        JOIN public.tournament_bounty_chests c ON c.id = a.chest_id
       WHERE a.tournament_id = p_tournament_id
         AND (c.tournament_id IS DISTINCT FROM p_tournament_id
           OR c.award_id IS DISTINCT FROM a.id
           OR c.amount_cents IS DISTINCT FROM a.amount_cents
           OR a.status NOT IN ('completed','void')
           OR (a.status = 'completed' AND (
             c.status <> 'paid' OR a.paid_at IS NULL
             OR (SELECT count(*)
                   FROM public.tournament_bounty_award_recipients r
                  WHERE r.award_id = a.id AND r.amount_cents > 0) < 1
             OR (SELECT COALESCE(sum(r.amount_cents),0)
                   FROM public.tournament_bounty_award_recipients r
                  WHERE r.award_id = a.id) <> a.amount_cents
             OR EXISTS (
               SELECT 1 FROM public.tournament_bounty_award_recipients r
                WHERE r.award_id = a.id
                  AND (r.amount_cents <= 0 OR r.paid_at IS NULL))))
           OR (a.status = 'void' AND (
             c.status <> 'void' OR a.paid_at IS NOT NULL OR EXISTS (
               SELECT 1 FROM public.tournament_bounty_award_recipients r
                WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_chests c
        WHERE c.tournament_id = p_tournament_id
          AND c.status = 'paid'
          AND (SELECT count(*) FROM public.tournament_bounty_awards a
                WHERE a.id = c.award_id AND a.chest_id = c.id
                  AND a.tournament_id = p_tournament_id
                  AND a.status = 'completed') <> 1)
  THEN
    RAISE EXCEPTION 'tournament % has malformed or open mystery inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every legacy award key must name one exact completed recipient. A key with
  -- an award prefix but the wrong user or amount is contradictory evidence,
  -- not a reason to classify the recipient as obligation-era.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_bounty_awards a
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'mb:' || a.id::text || ':%'
     WHERE a.tournament_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_award_recipients r
          WHERE r.award_id = a.id
            AND k.key = 'mb:' || a.id::text || ':' || r.user_id::text
            AND k.user_id = r.user_id
            AND k.amount IS NOT NULL
            AND k.amount::text NOT IN ('NaN','Infinity','-Infinity')
            AND k.amount = round(r.amount_cents / 100.0,2)))
     OR EXISTS (
       SELECT 1 FROM public.wallet_credit_idempotency k
        WHERE k.key LIKE 'mb-residual:' || p_tournament_id::text || '%'
          AND k.key <> 'mb-residual:' || p_tournament_id::text)
  THEN
    RAISE EXCEPTION 'tournament % has malformed legacy mystery credit keys',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(sum(r.amount_cents),0)
    INTO v_legacy_award_cents
    FROM public.tournament_bounty_awards a
    JOIN public.tournament_bounty_award_recipients r ON r.award_id = a.id
    JOIN public.wallet_credit_idempotency k
      ON k.key = 'mb:' || a.id::text || ':' || r.user_id::text
     AND k.user_id = r.user_id
     AND k.amount = round(r.amount_cents / 100.0,2)
   WHERE a.tournament_id = p_tournament_id
     AND a.status = 'completed' AND r.paid_at IS NOT NULL;

  SELECT k.amount
    INTO v_legacy_residual_amount
    FROM public.wallet_credit_idempotency k
   WHERE k.key = 'mb-residual:' || p_tournament_id::text;
  IF FOUND AND (
       v_legacy_residual_amount IS NULL
       OR v_legacy_residual_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_legacy_residual_amount <= 0
       OR v_legacy_residual_amount <> round(v_legacy_residual_amount,2)
  ) THEN
    RAISE EXCEPTION 'tournament % has a malformed legacy mystery residual',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_legacy_residual_cents := CASE
    WHEN v_legacy_residual_amount IS NULL THEN 0
    ELSE round(v_legacy_residual_amount * 100)::bigint END;
  IF v_legacy_residual_cents > 0 AND NOT EXISTS (
    SELECT 1 FROM public.wallet_credit_idempotency k
     WHERE k.key = 'mb-residual:' || p_tournament_id::text
       AND k.user_id = p_winner_user_id
       AND k.amount::text NOT IN ('NaN','Infinity','-Infinity')
       AND k.amount > 0 AND k.amount = round(k.amount,2)
       AND round(k.amount * 100)::bigint = v_void_chest_cents
  ) THEN
    RAISE EXCEPTION 'tournament % legacy mystery residual is not its exact void inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_legacy_credit_cents := v_legacy_award_cents + v_legacy_residual_cents;

  -- Obligation credits use one immutable key per cumulative increment. The
  -- suffix is the prior paid cents. Ordered intervals must cover [0,paid)
  -- exactly, which proves no missing, overlapping or invented increment.
  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'mystery_bounty'
       AND (o.place IS NOT NULL OR o.user_id IS NULL
         OR o.amount_owed IS NULL OR o.amount_paid IS NULL
         OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR o.amount_paid <= 0 OR o.amount_paid <> round(o.amount_paid,2)
         OR o.amount_owed IS DISTINCT FROM o.amount_paid
         OR o.settled_at IS NULL
         OR o.pending_credit_token IS NOT NULL
         OR o.pending_credit_key IS NOT NULL
         OR o.pending_credit_amount IS NOT NULL))
     OR EXISTS (
       SELECT 1
         FROM public.tournament_obligations o
         JOIN public.wallet_credit_idempotency k
           ON k.key LIKE 'tourney:' || p_tournament_id::text ||
                         ':obl:' || o.id::text || ':%'
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'mystery_bounty'
          AND (k.user_id IS DISTINCT FROM o.user_id
            OR k.amount IS NULL
            OR k.amount::text IN ('NaN','Infinity','-Infinity')
            OR k.amount <= 0 OR k.amount <> round(k.amount,2)
            OR split_part(k.key,':',5) !~ '^[0-9]+$'))
     OR EXISTS (
       WITH key_intervals AS (
         SELECT o.id,o.amount_paid,
                CASE WHEN split_part(k.key,':',5) ~ '^[0-9]+$'
                     THEN split_part(k.key,':',5)::bigint END
                  AS starts_at_cents,
                CASE WHEN k.amount IS NOT NULL
                           AND k.amount::text NOT IN
                               ('NaN','Infinity','-Infinity')
                           AND k.amount > 0 AND k.amount = round(k.amount,2)
                     THEN round(k.amount * 100)::bigint END
                  AS paid_cents
           FROM public.tournament_obligations o
           JOIN public.wallet_credit_idempotency k
             ON k.key LIKE 'tourney:' || p_tournament_id::text ||
                           ':obl:' || o.id::text || ':%'
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'mystery_bounty'
       ), exact_intervals AS (
         SELECT i.*,
                COALESCE(sum(i.paid_cents) OVER (
                  PARTITION BY i.id ORDER BY i.starts_at_cents
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)
                  AS expected_start_cents,
                sum(i.paid_cents) OVER (PARTITION BY i.id) AS total_key_cents
           FROM key_intervals i
       )
       SELECT 1
         FROM public.tournament_obligations o
         LEFT JOIN exact_intervals i ON i.id = o.id
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'mystery_bounty'
        GROUP BY o.id,o.amount_paid
       HAVING count(i.id) = 0
           OR bool_or(i.starts_at_cents <> i.expected_start_cents)
           OR max(i.total_key_cents) <>
                round(o.amount_paid * 100)::bigint)
  THEN
    RAISE EXCEPTION 'tournament % has incomplete mystery obligation credit keys',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0) * 100)::bigint
    INTO v_obligation_cents
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'mystery_bounty';

  -- Allocate every uncovered paid recipient to that recipient's obligation,
  -- and every uncovered void chest to the champion's obligation. This is an
  -- exact per-user partition, stronger than a pool-only total.
  IF EXISTS (
    WITH uncovered AS (
      SELECT r.user_id,sum(r.amount_cents)::bigint AS cents
        FROM public.tournament_bounty_awards a
        JOIN public.tournament_bounty_award_recipients r ON r.award_id = a.id
        LEFT JOIN public.wallet_credit_idempotency k
          ON k.key = 'mb:' || a.id::text || ':' || r.user_id::text
         AND k.user_id = r.user_id
         AND k.amount = round(r.amount_cents / 100.0,2)
       WHERE a.tournament_id = p_tournament_id
         AND a.status = 'completed' AND r.paid_at IS NOT NULL
         AND k.key IS NULL
       GROUP BY r.user_id
      UNION ALL
      SELECT p_winner_user_id,v_void_chest_cents
       WHERE v_void_chest_cents > 0
         AND v_legacy_residual_cents = 0
    ), expected AS (
      SELECT u.user_id,sum(u.cents)::bigint AS cents
        FROM uncovered u GROUP BY u.user_id
    ), obligated AS (
      SELECT o.user_id,round(sum(o.amount_paid) * 100)::bigint AS cents
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'mystery_bounty'
       GROUP BY o.user_id
    )
    SELECT 1 FROM expected e
    FULL JOIN obligated o USING (user_id)
     WHERE COALESCE(e.cents,0) IS DISTINCT FROM COALESCE(o.cents,0)
  ) OR v_legacy_credit_cents + v_obligation_cents
         IS DISTINCT FROM v_t.mystery_bounty_pool_cents THEN
    RAISE EXCEPTION
      'tournament % mystery credit eras do not exactly cover its pool (% legacy + % obligation <> %)',
      p_tournament_id,v_legacy_credit_cents,v_obligation_cents,
      v_t.mystery_bounty_pool_cents USING ERRCODE = 'P0404';
  END IF;

  v_evidence_mode := CASE
    WHEN v_legacy_credit_cents > 0 AND v_obligation_cents > 0 THEN 'mixed'
    WHEN v_legacy_credit_cents > 0 THEN 'legacy_wallet_keys'
    ELSE 'obligations'
  END;
  RETURN jsonb_build_object(
    'evidence_version',1,
    'evidence_mode',v_evidence_mode,
    'pool_cents',v_t.mystery_bounty_pool_cents,
    'inventory_cents',v_inventory_cents,
    'completed_award_cents',v_completed_award_cents,
    'void_chest_cents',v_void_chest_cents,
    'legacy_award_credit_cents',v_legacy_award_cents,
    'legacy_residual_credit_cents',v_legacy_residual_cents,
    'legacy_credit_cents',v_legacy_credit_cents,
    'obligation_cents',v_obligation_cents);
END;
$mystery_completion_evidence$;

REVOKE ALL ON FUNCTION public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid) IS
  'Owner-only STABLE proof that a complete mystery inventory is partitioned exactly between legacy mb wallet keys and cumulative obligation credit-key intervals. It never moves or repairs money.';

-- Owner-only and STABLE by design. Both first completion and replay pass
-- through this same proof. A STABLE function cannot hide a repair write.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_terminal_receipt(
  p_tournament_id uuid,
  p_observed_winner_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $terminal_receipt$
DECLARE
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_r record;
  v_cash_count integer;
  v_cash_total numeric(15,2);
  v_cash_obligation_total numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_roster_count integer;
  v_winner_count integer;
  v_raw_winner_id uuid;
  v_raw_winner_amount numeric(15,2);
  v_bubble jsonb;
  v_durable_payouts jsonb;
  v_durable_deal_shares jsonb;
  v_durable_bubble jsonb;
  v_durable_table_ids uuid[];
  v_durable_table_count integer;
  v_durable_seat_ids uuid[];
  v_durable_seat_count integer;
  v_durable_released_count integer;
  v_mystery_evidence jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF p_observed_winner_id IS NOT NULL
     AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'tournament % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;

  SELECT t.id,t.status,t.variant,t.tournament_type,t.satellite_target_id,
         t.satellite_target,t.prize_pool,t.bounty_pool,t.bounty_pool_paid,
         t.is_bounty,t.is_pko,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents,t.club_id,t.ended_at,t.on_break,
         t.break_started_at,t.break_ends_at
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt lost tournament %', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF lower(COALESCE(v_t.variant::text, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'terminal receipt % belongs to a satellite', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text, '')) <> 'COMPLETED'
     OR v_t.ended_at IS DISTINCT FROM v_h.completed_at
     OR COALESCE(v_t.on_break, false)
     OR v_t.break_started_at IS NOT NULL
     OR v_t.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is not durably closed by its receipt',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Every mutable child carries the same tuple-owned close fact. This makes a
  -- replay prove the synchronous marker transition itself, while queued
  -- writers can reject from OLD after a row-lock wait without relying on a
  -- pre-wait statement snapshot of the parent or receipt.
  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=p_tournament_id
                AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND s.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=p_tournament_id
          AND r.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at) THEN
    RAISE EXCEPTION 'tournament % mutable evidence lacks its exact terminal marker',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Table closure is money-adjacent terminal state, not an asynchronous UI
  -- cleanup. The immutable identities prove that no tournament table vanished,
  -- appeared or reopened after this receipt and that every seat released by
  -- the terminal transaction still has its exact terminal state.
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_table_ids,v_durable_table_count
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_seat_ids,v_durable_seat_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_durable_released_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.id = ANY(v_h.released_seat_ids)
     AND s.left_at IS NOT DISTINCT FROM v_h.completed_at
     AND COALESCE(s.status,'') = 'left'
     AND COALESCE(s.leave_pending,false) IS FALSE
     AND COALESCE(s.is_sitting_out,false) IS FALSE;
  IF v_durable_table_ids IS DISTINCT FROM v_h.closed_table_ids
     OR v_durable_table_count IS DISTINCT FROM v_h.closed_table_count
     OR v_durable_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR v_durable_seat_count IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.terminal_closed_at IS DISTINCT FROM v_h.completed_at
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % table or seat closure differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.prize_pool,2) IS DISTINCT FROM v_h.prize_pool
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.bounty_pool,2) IS DISTINCT FROM v_h.bounty_pool THEN
    RAISE EXCEPTION 'tournament % pools differ from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE tp.status::text = 'winner'
                            AND tp.position = 1)
    INTO v_roster_count,v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_roster_count < 1 OR v_winner_count <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.status::text = 'winner' AND tp.position = 1
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL)
     OR (SELECT count(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT count(DISTINCT tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT min(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> 1
     OR (SELECT max(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text NOT IN ('winner','eliminated')) THEN
    RAISE EXCEPTION 'tournament % has ambiguous or incomplete final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF jsonb_typeof(v_h.cash_receipt->'payouts') <> 'array'
     OR COALESCE((v_h.cash_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_h.cash_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_h.cash_receipt->>'status','')) <> 'COMPLETING'
     OR v_h.cash_receipt->>'winner_amount' IS NULL
     OR (v_h.cash_receipt->>'winner_amount')::numeric < 0
     OR (v_h.cash_receipt->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_h.cash_receipt->>'winner_amount')::numeric,2)
     OR (v_h.settlement_mode = 'final_table_deal'
         AND v_h.cash_receipt->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % stored a malformed cash authority receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric
    INTO v_raw_winner_id,v_raw_winner_amount
    FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
   WHERE (p->>'place')::integer = 1;
  IF v_raw_winner_id IS DISTINCT FROM v_h.winner_id
     OR v_raw_winner_amount IS DISTINCT FROM
          (v_h.cash_receipt->>'winner_amount')::numeric
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
        WHERE p->>'place' IS NULL OR p->>'user_id' IS NULL
           OR p->>'amount' IS NULL
           OR (p->>'place')::integer < 1
           OR (p->>'amount')::numeric < 0
           OR (p->>'amount')::numeric IS DISTINCT FROM
                round((p->>'amount')::numeric,2)
           OR NOT EXISTS (
             SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.position = (p->>'place')::integer
                AND tp.user_id = (p->>'user_id')::uuid))
     OR (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) < 1
     OR (SELECT count(DISTINCT (p->>'place')::integer)
           FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p)
          <> (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) THEN
    RAISE EXCEPTION 'tournament % cash receipt does not name exact finishers',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Satellite and bounty records never consume the ordinary prize pool.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source IN ('satellite_seat','satellite_ticket','satellite_remainder')
  ) THEN
    RAISE EXCEPTION 'non-satellite tournament % carries satellite payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_count IS DISTINCT FROM v_h.cash_payout_count
     OR v_cash_total IS DISTINCT FROM v_h.cash_payout_total
     OR v_cash_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash payout evidence is incomplete or malformed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_h.prize_pool = 0 AND v_durable_payouts = '[]'::jsonb THEN
    -- A zero-cash event has a real winner and no wallet/payout mutation. Keep
    -- that explicit standings line in the receipt without inventing durable
    -- payment evidence.
    v_durable_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_h.winner_id,'amount',0));
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_deal_shares
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
       GROUP BY tp.position,p.user_id
    ) q;
  IF (SELECT count(*) FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'bubble_protection') > 1 THEN
    RAISE EXCEPTION 'tournament % has multiple durable bubble payout lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',p.amount)
    INTO v_durable_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  v_durable_bubble := COALESCE(v_durable_bubble,'null'::jsonb);
  IF v_h.cash_receipt->'payouts' IS DISTINCT FROM v_durable_payouts
     OR jsonb_typeof(v_h.cash_receipt->'deal_shares') <> 'array'
     OR v_h.cash_receipt->'deal_shares' IS DISTINCT FROM
          (CASE WHEN v_h.settlement_mode = 'final_table_deal'
                THEN v_durable_deal_shares ELSE '[]'::jsonb END)
     OR COALESCE(v_h.cash_receipt->'bubble_protection','null'::jsonb)
          IS DISTINCT FROM v_durable_bubble
     OR ((SELECT round(COALESCE(sum((p->>'amount')::numeric),0),2)
            FROM jsonb_array_elements(v_durable_payouts) p)
         + (CASE WHEN v_durable_bubble = 'null'::jsonb THEN 0
                 ELSE (v_durable_bubble->>'amount')::numeric END))
          IS DISTINCT FROM v_h.cash_payout_total THEN
    RAISE EXCEPTION
      'tournament % stored cash lines differ from complete durable payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0),2)
    INTO v_cash_obligation_total
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('place','bubble_protection','final_table_deal');
  IF v_cash_obligation_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND (o.amount_owed IS NULL OR o.amount_paid IS NULL
            OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_owed < 0 OR o.amount_paid < 0
            OR o.amount_owed IS DISTINCT FROM round(o.amount_owed,2)
            OR o.amount_paid IS DISTINCT FROM round(o.amount_paid,2)
            OR o.amount_paid IS DISTINCT FROM o.amount_owed
            OR o.settled_at IS NULL)) THEN
    RAISE EXCEPTION 'tournament % has incomplete or malformed obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2)
    INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id AND lower(w.category) = 'bounty';
  IF v_bounty_total IS DISTINCT FROM v_h.bounty_payout_total
     OR v_bounty_total IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id = p_tournament_id
          AND lower(w.category) = 'bounty'
          AND (lower(w.type) <> 'credit' OR w.amount <= 0
            OR w.amount::text IN ('NaN','Infinity','-Infinity')
            OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % bounty pool is underfunded, overfunded or still open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.bounty_pool > 0 THEN
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false))
       OR COALESCE((v_h.bounty_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.bounty_receipt->>'funded')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament % bounty receipt is not a funded close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false)
        OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                    WHERE o.tournament_id = p_tournament_id
                      AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.tournament_id = p_tournament_id)
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                    WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.mystery_was_active THEN
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_h.winner_id);
    IF COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
       OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
       OR COALESCE(v_t.mystery_bounty_pool_cents,0)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR (SELECT COALESCE(sum(c.amount_cents),0)
             FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR v_h.mystery_receipt->'payment_evidence'
            IS DISTINCT FROM v_mystery_evidence
       OR COALESCE((v_h.mystery_receipt->>'residual_paid_cents')::bigint,-1)
            IS DISTINCT FROM
              COALESCE((v_mystery_evidence->>'void_chest_cents')::bigint,0)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id
                     AND c.status NOT IN ('paid','void'))
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id
                     AND a.status NOT IN ('completed','void'))
       OR EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.tournament_id = p_tournament_id
            AND ((a.status = 'completed' AND (
                  a.paid_at IS NULL OR
                  (SELECT COALESCE(sum(r.amount_cents),0)
                     FROM public.tournament_bounty_award_recipients r
                    WHERE r.award_id = a.id) <> a.amount_cents OR
                  EXISTS (SELECT 1
                            FROM public.tournament_bounty_award_recipients r
                           WHERE r.award_id = a.id
                             AND r.amount_cents > 0 AND r.paid_at IS NULL)))
              OR (a.status = 'void' AND EXISTS (
                  SELECT 1 FROM public.tournament_bounty_award_recipients r
                   WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))) THEN
      RAISE EXCEPTION 'tournament % has open or inconsistent mystery bounty evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_h.mystery_pool_cents <> 0
       OR COALESCE(v_h.mystery_receipt->>'reason','')
            NOT IN ('never_activated','not_a_mystery_tournament')
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'tournament % stored an invalid non-active mystery close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at
     OR v_e.close_note IS DISTINCT FROM v_h.escrow_close_note THEN
    RAISE EXCEPTION 'tournament % escrow is not an exact durable zero close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF v_r.tournament_id IS NULL
     OR v_r.amount IS DISTINCT FROM v_rake_total
     OR v_r.amount IS DISTINCT FROM v_h.rake_amount
     OR v_r.destination IS DISTINCT FROM v_h.rake_destination
     OR v_r.settled_at IS DISTINCT FROM v_h.rake_settled_at
     OR v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at
     OR v_r.attributed_users IS DISTINCT FROM v_h.rake_attributed_users
     OR v_r.attributed_users IS NULL OR v_r.attributed_users < 0
     OR v_r.attribution_error IS NOT NULL
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'club_treasury:%')) THEN
    RAISE EXCEPTION 'tournament % rake is not durably and successfully attributed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_bubble := CASE WHEN v_h.cash_receipt ? 'bubble_protection'
                    THEN v_h.cash_receipt->'bubble_protection'
                   ELSE 'null'::jsonb END;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status','COMPLETED',
    'tournament_id',v_h.tournament_id,
    'winner_id',v_h.winner_id,
    'mode',v_h.settlement_mode,
    'settlement_mode',v_h.settlement_mode,
    'payouts',v_h.cash_receipt->'payouts',
    'deal_shares',v_h.cash_receipt->'deal_shares',
    'winner_amount',(v_h.cash_receipt->>'winner_amount')::numeric,
    'bubble_protection',v_bubble,
    'cash',v_h.cash_receipt,
    'mystery_bounty',v_h.mystery_receipt,
    'bounty',v_h.bounty_receipt,
    'closed_table_count',v_h.closed_table_count,
    'source_seat_count',v_h.source_seat_count,
    'released_seat_count',v_h.released_seat_count,
    'table_closure',jsonb_build_object(
      'closed_table_count',v_h.closed_table_count,
      'closed_table_ids',to_jsonb(v_h.closed_table_ids),
      'source_seat_count',v_h.source_seat_count,
      'source_seat_ids',to_jsonb(v_h.source_seat_ids),
      'released_seat_count',v_h.released_seat_count,
      'released_seat_ids',to_jsonb(v_h.released_seat_ids)),
    'rake',jsonb_build_object(
      'amount',v_h.rake_amount,
      'destination',v_h.rake_destination,
      'attributed',true,
      'attributed_users',v_h.rake_attributed_users,
      'settled_at',v_h.rake_settled_at,
      'attributed_at',v_h.rake_attributed_at),
    'escrow',jsonb_build_object(
      'prize_balance',v_e.prize_balance,
      'bounty_balance',v_e.bounty_balance,
      'fee_balance',v_e.fee_balance,
      'closed_at',v_h.escrow_closed_at,
      'close_note',v_h.escrow_close_note),
    'cash_payout_total',v_h.cash_payout_total,
    'bounty_payout_total',v_h.bounty_payout_total,
    'receipt_version',v_h.receipt_version,
    'settled_at',v_h.settled_at);
END;
$terminal_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- A privileged client must not be able to publish COMPLETED without the
-- receipt written by the atomic authority. This is deferred because the
-- authority deliberately closes lifecycle first and inserts its receipt next,
-- in the same transaction. At commit, a receipt-backed event is re-verified;
-- a receiptless non-satellite transition is rejected and all writes roll back.
CREATE OR REPLACE FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_status_guard$
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant::text,'')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type::text,'')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL
     OR NEW.satellite_target IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'non-satellite tournament % cannot become COMPLETED without its atomic terminal receipt',
      NEW.id USING ERRCODE = '55000';
  END IF;
  PERFORM public.fn_ca_tournament_terminal_receipt(NEW.id,NULL);
  RETURN NEW;
END;
$terminal_status_guard$;

REVOKE ALL ON FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER non_satellite_completed_requires_terminal_receipt
  AFTER INSERT OR UPDATE OF status ON public.tournaments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_non_satellite_completed_requires_terminal_receipt();

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(
  p_tournament_id uuid,
  p_observed_winner_id uuid,
  p_settlement_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '45s'
AS $complete_terminal$
DECLARE
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_cash jsonb;
  v_mystery jsonb;
  v_mystery_evidence jsonb;
  v_bounty jsonb;
  v_rake_result jsonb;
  v_rake record;
  v_prior_rake record;
  v_winner_id uuid;
  v_winner_count integer;
  v_is_bounty boolean;
  v_mystery_active boolean := false;
  v_mystery_stage text := 'pending';
  v_mystery_pool_cents bigint := 0;
  v_inventory_cents bigint := 0;
  v_cash_count integer;
  v_bubble_line_count integer;
  v_cash_total numeric(15,2);
  v_cash_before numeric(15,2);
  v_bounty_before numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_expected_fee numeric(15,2);
  v_started_status text;
  v_completed_at timestamptz;
  v_rows integer;
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_event_union_id uuid;
  v_current_union_id uuid;
  v_locked_current_union_id uuid;
  v_deal_shares jsonb := '[]'::jsonb;
  v_full_payouts jsonb := '[]'::jsonb;
  v_cash_bubble jsonb := 'null'::jsonb;
  v_full_winner_amount numeric(15,2);
BEGIN
  -- All satellite and non-satellite terminal money commits use this exact
  -- first lock. It eliminates cross-event cycles on shared club, union and
  -- recipient wallets without weakening any event-local row proof.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));

  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal completion requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal settlement mode %', p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'places' AND p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'places completion requires an observed winner id'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Receipt first is the replay boundary. No money authority appears above it.
  IF EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = p_tournament_id
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_terminal_settlements h
       WHERE h.tournament_id = p_tournament_id
         AND h.settlement_mode = v_mode
         AND (p_observed_winner_id IS NULL
              OR h.winner_id = p_observed_winner_id)
    ) THEN
      RAISE EXCEPTION 'terminal replay parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    RETURN public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
  END IF;

  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite; use its whole-pool authority',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  v_started_status := upper(COALESCE(v_t.status::text,''));
  IF v_started_status NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % cannot complete from status % without a receipt',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2)
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.bounty_pool < 0
     OR v_t.bounty_pool IS DISTINCT FROM round(v_t.bounty_pool,2) THEN
    RAISE EXCEPTION 'tournament % has malformed cash or bounty pools',
      p_tournament_id USING ERRCODE = '22003';
  END IF;

  -- Cross-event bank order is tournament -> club_wallets -> union_wallets
  -- (sorted) -> clubs, before a cash authority can apply an overlay. Rake uses
  -- club_wallets before its union/club destination; guarantee funding uses the
  -- union/club destination. Pre-owning both paths prevents two same-scope
  -- finishes from taking those shared banks in opposite order.
  v_event_union_id := CASE WHEN COALESCE(v_t.is_private,false)
                           THEN NULL ELSE v_t.union_id END;
  IF v_t.club_id IS NOT NULL THEN
    SELECT c.union_id INTO v_current_union_id
      FROM public.clubs c WHERE c.id = v_t.club_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % refers to missing club %',
        p_tournament_id,v_t.club_id USING ERRCODE = 'P0404';
    END IF;
    PERFORM 1 FROM public.club_wallets cw
     WHERE cw.club_id = v_t.club_id
     ORDER BY cw.club_id FOR NO KEY UPDATE;
    PERFORM 1 FROM public.union_wallets uw
     WHERE uw.union_id IN (
       SELECT DISTINCT x.union_id
         FROM unnest(ARRAY[v_event_union_id,v_current_union_id]::uuid[]) x(union_id)
        WHERE x.union_id IS NOT NULL)
     ORDER BY uw.union_id FOR NO KEY UPDATE;
    SELECT c.union_id INTO v_locked_current_union_id
      FROM public.clubs c
     WHERE c.id = v_t.club_id
     FOR NO KEY UPDATE;
    IF v_locked_current_union_id IS DISTINCT FROM v_current_union_id THEN
      RAISE EXCEPTION 'club % changed union while tournament % claimed terminal banks',
        v_t.club_id,p_tournament_id USING ERRCODE = '40001';
    END IF;
  END IF;

  -- Freeze every tournament-owned evidence set before the first payer. The
  -- canonical payers reacquire only rows already owned by this transaction.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id ORDER BY p.id FOR SHARE;
  PERFORM 1 FROM public.tournament_guarantee_overlays g
   WHERE g.tournament_id = p_tournament_id
   ORDER BY g.tournament_id FOR UPDATE;
  -- The final-table deal authority uses this same order after its money sets.
  -- Holding these locks before any bounty or rake row prevents a reversed
  -- terminal lock chain while retaining the tournament row as the root lock.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  v_closed_table_count := cardinality(v_closed_table_ids);
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_seat_count := cardinality(v_source_seat_ids);
  PERFORM 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
   ORDER BY w.id FOR SHARE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = p_tournament_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id ORDER BY a.id FOR UPDATE;
  PERFORM 1
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM 1 FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament
   ORDER BY rr.id FOR SHARE;
  PERFORM 1 FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;

  v_is_bounty := COALESCE(v_t.is_bounty,false)
              OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND lower(w.category) = 'bounty'
       AND (lower(w.type) <> 'credit' OR w.amount <= 0
         OR w.amount::text IN ('NaN','Infinity','-Infinity')
         OR w.amount IS DISTINCT FROM round(w.amount,2))
  ) OR v_bounty_before < 0 OR v_bounty_before > v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_bounty_before THEN
    RAISE EXCEPTION 'tournament % has overpaid or contradictory bounty evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_is_bounty THEN
    IF v_t.bounty_pool <= 0 THEN
      RAISE EXCEPTION 'funded bounty tournament % has no positive bounty pool',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_t.bounty_pool <> 0 OR v_bounty_before <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery_stage := COALESCE(v_t.mystery_bounty_stage,'');
    IF v_mystery_stage NOT IN ('pending','active','complete') THEN
      RAISE EXCEPTION 'tournament % has ambiguous mystery stage % without a receipt',
        p_tournament_id,v_t.mystery_bounty_stage USING ERRCODE = '55000';
    END IF;
    -- A rolling cutover may meet an event whose old finish path already
    -- completed the mystery inventory but never completed cash, rake or the
    -- lifecycle. Treat both active and complete as a funded mystery branch.
    -- Active is settled below; complete must already prove the entire mystery
    -- obligation and every inventory row before the wrapper can continue.
    v_mystery_active := v_mystery_stage IN ('active','complete');
    IF v_mystery_active THEN
      v_mystery_pool_cents := COALESCE(v_t.mystery_bounty_pool_cents,0);
      SELECT COALESCE(sum(c.amount_cents),0) INTO v_inventory_cents
        FROM public.tournament_bounty_chests c
       WHERE c.tournament_id = p_tournament_id;
      IF v_mystery_pool_cents <= 0
         OR v_inventory_cents IS DISTINCT FROM v_mystery_pool_cents
         OR v_mystery_pool_cents > round(v_t.bounty_pool * 100)::bigint
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id
              AND (c.amount_cents <= 0 OR c.status NOT IN
                   ('available','reserved','revealed','paid','void')))
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_awards a
            WHERE a.tournament_id = p_tournament_id
              AND (a.amount_cents <= 0 OR a.status NOT IN
                   ('reserved','revealed','paid','completed','void'))) THEN
        RAISE EXCEPTION 'tournament % mystery bounty inventory is not exactly funded',
          p_tournament_id USING ERRCODE = 'P0404';
      END IF;
    ELSIF COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'pending mystery tournament % already carries inventory',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
     OR COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'non-mystery tournament % carries mystery bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_cash_before
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_before < 0 OR v_cash_before > v_t.prize_pool
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id = p_tournament_id
                   AND p.source IN
                     ('satellite_seat','satellite_ticket','satellite_remainder')) THEN
    RAISE EXCEPTION 'tournament % has invalid pre-terminal cash evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF v_rake_total < 0 OR v_rake_total::text IN ('NaN','Infinity','-Infinity')
     OR v_rake_total IS DISTINCT FROM round(v_rake_total,2) THEN
    RAISE EXCEPTION 'tournament % has malformed rake records',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT rs.* INTO v_prior_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_prior_rake.amount IS DISTINCT FROM v_rake_total
       OR v_prior_rake.settled_at IS NULL
       OR v_prior_rake.attributed_at IS NULL
       OR v_prior_rake.attributed_users IS NULL
       OR v_prior_rake.attributed_users < 0
       OR v_prior_rake.attribution_error IS NOT NULL
       OR lower(v_prior_rake.destination) IN ('pending','')
       OR (v_prior_rake.amount > 0 AND v_t.club_id IS NOT NULL
           AND (v_prior_rake.attributed_users < 1
             OR (v_prior_rake.destination NOT LIKE 'union:%'
                 AND v_prior_rake.destination NOT LIKE 'club_treasury:%'))) THEN
      RAISE EXCEPTION 'tournament % has a partial or unattributed prior rake row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_expected_fee := 0;
  ELSE
    v_expected_fee := v_rake_total;
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM round(v_t.prize_pool-v_cash_before,2)
     OR v_e.bounty_balance IS DISTINCT FROM round(v_t.bounty_pool-v_bounty_before,2)
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee
     OR v_e.prize_balance < 0 OR v_e.bounty_balance < 0
     OR v_e.fee_balance < 0
     OR v_e.closed_at IS NOT NULL
     OR v_e.close_note IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % escrow does not exactly fund its remaining obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Exactly one branch calls exactly one cash authority.
  IF v_mode = 'places' THEN
    v_cash := public.fn_settle_tournament_places(
      p_tournament_id,p_observed_winner_id);
  ELSE
    v_cash := public.fn_settle_tournament_final_table_deal(p_tournament_id);
  END IF;
  IF COALESCE((v_cash->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_cash->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_cash->>'status','')) <> 'COMPLETING'
     OR jsonb_typeof(v_cash->'payouts') <> 'array'
     OR jsonb_array_length(v_cash->'payouts') < 1
     OR v_cash->>'winner_amount' IS NULL
     OR (v_cash->>'winner_amount')::numeric < 0
     OR (v_cash->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_cash->>'winner_amount')::numeric,2)
     OR (v_mode = 'final_table_deal'
         AND v_cash->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % cash authority returned a partial result: %',
      p_tournament_id,v_cash USING ERRCODE = 'P0404';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) <> 'COMPLETING'
     OR COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2) THEN
    RAISE EXCEPTION 'tournament % cash authority did not claim one finalized pool',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  SELECT tp.user_id INTO v_winner_id
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  IF v_winner_count <> 1 OR v_winner_id IS NULL
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_winner_id
          AND (tp.eliminated_at IS NOT NULL
            OR tp.elimination_sequence IS NOT NULL))
     OR (p_observed_winner_id IS NOT NULL
         AND v_winner_id IS DISTINCT FROM p_observed_winner_id)
     OR (SELECT count(*) FROM jsonb_array_elements(v_cash->'payouts') p
          WHERE (p->>'place')::integer = 1
            AND (p->>'user_id')::uuid = v_winner_id
            AND (p->>'amount')::numeric =
                (v_cash->>'winner_amount')::numeric) <> 1 THEN
    RAISE EXCEPTION 'tournament % cash authority left an ambiguous winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_total IS DISTINCT FROM v_t.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash pool did not settle exactly',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  -- The deal authority returns only the still-live chop shares. That is the
  -- right presentation input for the table animation, but it is not the full
  -- prize-pool receipt when eliminated fixed places were already earned.
  -- Store both contracts explicitly: deal_shares is exactly the live chop;
  -- payouts is every non-bubble cash entitlement reconstructed from durable
  -- payout evidence and final standings. Bubble protection remains a distinct
  -- line, so sum(payouts.amount) + bubble_protection.amount is the full pool.
  IF v_mode = 'final_table_deal' THEN
    v_deal_shares := v_cash->'payouts';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_full_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_t.prize_pool = 0 AND v_full_payouts = '[]'::jsonb THEN
    -- The cash authority returns the derived zero-dollar winner line, but a
    -- zero payment correctly creates no tournament_payouts row.
    v_full_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_winner_id,'amount',0));
  END IF;
  SELECT count(*) INTO v_bubble_line_count
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  IF v_bubble_line_count > 1 THEN
    RAISE EXCEPTION 'tournament % has more than one durable bubble payout line',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',p.amount)
    INTO v_cash_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  v_cash_bubble := COALESCE(v_cash_bubble,'null'::jsonb);
  SELECT (p->>'amount')::numeric INTO v_full_winner_amount
    FROM jsonb_array_elements(v_full_payouts) p
   WHERE (p->>'place')::integer = 1;
  IF v_full_winner_amount IS NULL THEN
    RAISE EXCEPTION 'tournament % has no durable winner cash line',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_cash := v_cash || jsonb_build_object(
    'payouts',v_full_payouts,
    'deal_shares',v_deal_shares,
    'bubble_protection',v_cash_bubble,
    'winner_amount',v_full_winner_amount);

  IF v_mystery_stage = 'active' THEN
    v_mystery := public.fn_mystery_bounty_settle(
      p_tournament_id,v_winner_id);
    IF COALESCE((v_mystery->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'variance_cents')::bigint,1) <> 0 THEN
      RAISE EXCEPTION 'tournament % mystery bounty close was partial: %',
        p_tournament_id,v_mystery USING ERRCODE = 'P0404';
    END IF;
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := v_mystery || jsonb_build_object(
      'payment_evidence',v_mystery_evidence,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint);
  ELSIF v_mystery_stage = 'complete' THEN
    -- No payer is rerun for an already-complete inventory. The preflight
    -- proved exact terminal chests, awards and mystery obligations while all
    -- rows were locked. Store that durable replay result in the new receipt.
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := jsonb_build_object(
      'ok',true,'reason','already_complete',
      'pool_cents',v_mystery_pool_cents,
      'settled_cents',v_mystery_pool_cents,
      'unclaimed_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'balanced',true,'variance_cents',0,
      'payment_evidence',v_mystery_evidence);
  ELSIF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery := jsonb_build_object(
      'ok',true,'reason','never_activated','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  ELSE
    v_mystery := jsonb_build_object(
      'ok',true,'reason','not_a_mystery_tournament','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  END IF;

  IF v_is_bounty THEN
    v_bounty := public.fn_finalize_bounty_pool(p_tournament_id,v_winner_id);
    IF COALESCE((v_bounty->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_bounty->>'funded')::boolean,false) IS NOT TRUE
       OR v_bounty->>'residual' IS NULL
       OR (v_bounty->>'residual')::numeric < 0 THEN
      RAISE EXCEPTION 'tournament % bounty pool close was partial: %',
        p_tournament_id,v_bounty USING ERRCODE = 'P0404';
    END IF;
  ELSE
    v_bounty := jsonb_build_object(
      'ok',true,'funded',true,'residual',0,
      'reason','not_a_bounty_tournament');
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  IF v_bounty_total IS DISTINCT FROM v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_t.bounty_pool
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w
                 WHERE w.related_entity_id = p_tournament_id
                   AND lower(w.category) = 'bounty'
                   AND (lower(w.type) <> 'credit' OR w.amount <= 0
                     OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND (o.amount_paid IS DISTINCT FROM o.amount_owed
                     OR o.settled_at IS NULL))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id
                   AND c.status NOT IN ('paid','void'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id
                   AND a.status NOT IN ('completed','void'))
     OR (v_mystery_active AND (
          v_mystery_evidence IS NULL
          OR COALESCE((v_mystery_evidence->>'pool_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents
          OR COALESCE((v_mystery_evidence->>'legacy_credit_cents')::bigint,-1)
             + COALESCE((v_mystery_evidence->>'obligation_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.status = 'completed'
          AND (a.paid_at IS NULL
            OR (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id = a.id) <> a.amount_cents
            OR EXISTS (SELECT 1
                         FROM public.tournament_bounty_award_recipients r
                        WHERE r.award_id = a.id
                          AND r.amount_cents > 0 AND r.paid_at IS NULL))) THEN
    RAISE EXCEPTION 'tournament % bounty obligations or chests remain open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- current_bounty is the live head/cache, not payment evidence. The older
  -- finalizer clears only the champion when it itself pays a positive ordinary
  -- residual; an already-exhausted pool or mystery residual can therefore
  -- leave a stale live head after every chip is durably paid. Once exact pool,
  -- obligation and inventory conservation is proved above, zero every head in
  -- this same terminal commit so no completed player advertises open value.
  IF v_is_bounty THEN
    UPDATE public.tournament_players
       SET current_bounty = 0
     WHERE tournament_id = p_tournament_id
       AND COALESCE(current_bounty,0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % still has a live bounty head after close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee THEN
    RAISE EXCEPTION 'tournament % cash/bounty close did not preserve fee escrow',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id,'engine.fn_complete_tournament_terminal');
  IF COALESCE((v_rake_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % rake authority refused: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;
  SELECT rs.* INTO v_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;
  IF v_rake.tournament_id IS NULL
     OR v_rake.amount IS DISTINCT FROM v_rake_total
     OR v_rake.settled_at IS NULL OR v_rake.attributed_at IS NULL
     OR v_rake.attributed_users IS NULL OR v_rake.attributed_users < 0
     OR v_rake.attribution_error IS NOT NULL
     OR lower(v_rake.destination) IN ('pending','')
     OR (v_rake.amount > 0 AND v_t.club_id IS NOT NULL
         AND (v_rake.attributed_users < 1
           OR (v_rake.destination NOT LIKE 'union:%'
               AND v_rake.destination NOT LIKE 'club_treasury:%'))) THEN
    RAISE EXCEPTION 'tournament % rake attribution did not complete: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % did not close all three escrow banks',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());
  -- Persist the exact-zero proof before lifecycle. The historical after-status
  -- observer was detached above; this authority is now the only owner of the
  -- terminal escrow marker.
  UPDATE public.tournament_escrow
     SET closed_at = v_completed_at,
         close_note = 'terminal receipt: exact zero',
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its exact zero escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Explicitly release every live seat and close every tournament table in
  -- this transaction. No timer, table manager or lifecycle watcher is part of
  -- the completion contract. IDs and counts are captured for immutable replay.
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at = v_completed_at,
           status = 'left',
           leave_pending = false,
           is_sitting_out = false,
           is_away = false,
           sit_out_at = NULL,
           scheduled_leave_hands = NULL
      FROM public.tables tb
     WHERE tb.id = s.table_id
       AND tb.tournament_id = p_tournament_id
       AND s.left_at IS NULL
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(r.id ORDER BY r.id),ARRAY[]::uuid[])
    INTO v_released_seat_ids
    FROM released r;
  v_released_seat_count := cardinality(v_released_seat_ids);

  -- Preserve an earlier departure time, but canonicalize every other mutable
  -- occupancy flag before the immutable source-seat snapshot is committed.
  UPDATE public.table_seats s
     SET status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE s.id = ANY(v_source_seat_ids)
     AND s.left_at IS NOT NULL
     AND (s.status IS DISTINCT FROM 'left'
       OR s.leave_pending IS DISTINCT FROM false
       OR s.is_sitting_out IS DISTINCT FROM false
       OR s.is_away IS DISTINCT FROM false
       OR s.sit_out_at IS NOT NULL
       OR s.scheduled_leave_hands IS NOT NULL);

  -- Publish terminal lifecycle after every seat is released but before table
  -- rows close. The managed table-status observer therefore sees a genuinely
  -- terminal parent and does not emit a false live-tournament incident. The
  -- deferred receipt constraint still requires the receipt later in this same
  -- transaction; any table or receipt failure rolls this update back too.
  UPDATE public.tournaments
     SET status = 'COMPLETED',
         ended_at = v_completed_at,
         on_break = false,
         break_started_at = NULL,
         break_ends_at = NULL,
         updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status::text,'')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its terminal lifecycle claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_completed_at,
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_closed_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % did not durably release every seat and close every table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.tournament_terminal_settlements
    (tournament_id,winner_id,settlement_mode,started_status,
     prize_pool,bounty_pool,cash_payout_count,cash_payout_total,
     bounty_payout_total,mystery_was_active,mystery_pool_cents,
     cash_receipt,mystery_receipt,bounty_receipt,
     closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
     released_seat_count,released_seat_ids,
     rake_amount,rake_destination,rake_settled_at,rake_attributed_at,
     rake_attributed_users,escrow_closed_at,escrow_close_note,
     completed_at,settled_at,receipt_version)
  VALUES
    (p_tournament_id,v_winner_id,v_mode,v_started_status,
     v_t.prize_pool,v_t.bounty_pool,v_cash_count,v_cash_total,
     v_bounty_total,v_mystery_active,v_mystery_pool_cents,
     v_cash,v_mystery,v_bounty,
     v_closed_table_count,v_closed_table_ids,
     v_source_seat_count,v_source_seat_ids,
     v_released_seat_count,v_released_seat_ids,
     v_rake.amount,v_rake.destination,v_rake.settled_at,v_rake.attributed_at,
     v_rake.attributed_users,v_completed_at,'terminal receipt: exact zero',
     v_completed_at,transaction_timestamp(),1);

  RETURN public.fn_ca_tournament_terminal_receipt(
    p_tournament_id,p_observed_winner_id);
END;
$complete_terminal$;

REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  TO service_role;

-- A network error is not evidence that PostgreSQL rolled back. This resolver
-- takes the identical global terminal lock first, then the event row, so it
-- cannot report RUNNING while an earlier completion transaction is still able
-- to commit. It moves no money. A committed outcome includes the same verified
-- immutable receipt returned by the terminal authority.
CREATE OR REPLACE FUNCTION public.fn_resolve_tournament_terminal_outcome(
  p_tournament_id uuid,
  p_observed_winner_id uuid,
  p_settlement_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '45s'
AS $terminal_outcome$
DECLARE
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_t record;
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_receipt jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal outcome requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal outcome mode %',p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite',p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_h FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_h.settlement_mode IS DISTINCT FROM v_mode
       OR (p_observed_winner_id IS NOT NULL
           AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id) THEN
      RAISE EXCEPTION 'terminal outcome parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    v_receipt := public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
    RETURN jsonb_build_object(
      'ok',true,
      'terminal_committed',true,
      'definitively_not_committed',false,
      'status','COMPLETED',
      'mode',v_mode,
      'tournament_id',p_tournament_id,
      'receipt',v_receipt);
  END IF;

  IF upper(COALESCE(v_t.status::text,'')) = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed tournament % has no atomic terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % has non-terminal-outcome status %',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,
    'terminal_committed',false,
    'definitively_not_committed',true,
    'status',upper(v_t.status::text),
    'mode',v_mode,
    'tournament_id',p_tournament_id,
    'receipt','null'::jsonb);
END;
$terminal_outcome$;

REVOKE ALL ON FUNCTION public.fn_resolve_tournament_terminal_outcome(
  uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_tournament_terminal_outcome(
  uuid,uuid,text) TO service_role;

COMMENT ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) IS
  'Service-only non-satellite terminal transaction. Exactly one cash authority, bounty closure, attributed rake, table and seat closure, lifecycle close and immutable receipt commit together; replay only verifies stored durable state.';
COMMENT ON FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid) IS
  'Owner-only STABLE verifier for an immutable terminal receipt. It reads exact cash, bounty, escrow, rake, table, seat and lifecycle evidence and moves no money.';
COMMENT ON FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text) IS
  'Service-only serialized transport-outcome resolver. It waits behind the global terminal transaction lock and returns either the verified committed receipt or definitive no-receipt RUNNING/COMPLETING state.';

INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
  ('fn_ca_mystery_bounty_completion_evidence','approved',
   'Owner-only STABLE mixed-era mystery credit proof; reads immutable legacy and obligation keys and moves no money.'),
  ('fn_ca_tournament_terminal_receipt','approved',
   'Owner-only STABLE proof of the immutable non-satellite terminal receipt; it moves no money.'),
  ('fn_complete_tournament_terminal','approved',
   'Service-only all-or-nothing non-satellite finish: one cash authority, bounty pools, attributed rake, lifecycle and receipt.'),
  ('fn_resolve_tournament_terminal_outcome','approved',
   'Service-only serialized read after an ambiguous transport result; moves no money and returns a verified stored receipt when committed.')
ON CONFLICT (proname) DO UPDATE
   SET status = EXCLUDED.status,notes = EXCLUDED.notes;

DO $verify_terminal_authority$
DECLARE
  v_source text;
  v_receipt_source text;
  v_hand_source text;
  v_mystery_pay_source text;
  v_mystery_reserve_source text;
  v_table_guard_source text;
  v_outcome_source text;
  v_component_signature text;
  v_component_source text;
  v_collect_bounty_source text;
  v_satellite_award_source text;
  v_mystery_evidence_source text;
  v_satellite_receipt_source text;
  v_terminal_marker_source text;
  v_terminal_stamp_source text;
  v_terminal_evidence_guard_source text;
  v_terminal_parent_guard_source text;
BEGIN
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_receipt_source FROM pg_proc
   WHERE oid = 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_hand_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
  SELECT prosrc INTO v_mystery_pay_source FROM pg_proc
   WHERE oid = 'public.fn_mystery_bounty_pay(uuid)'::regprocedure;
  SELECT prosrc INTO v_mystery_reserve_source FROM pg_proc
   WHERE oid =
     'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)'::regprocedure;
  SELECT prosrc INTO v_table_guard_source FROM pg_proc
   WHERE oid =
     'public.fn_tournament_table_terminal_close_is_irreversible()'::regprocedure;
  SELECT prosrc INTO v_outcome_source FROM pg_proc
   WHERE oid =
     'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_collect_bounty_source FROM pg_proc
   WHERE oid =
     'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure;
  SELECT prosrc INTO v_mystery_evidence_source FROM pg_proc
   WHERE oid =
            'public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_satellite_receipt_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_terminal_marker_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'::regprocedure;
  SELECT prosrc INTO v_terminal_stamp_source FROM pg_proc
   WHERE oid =
     'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure;
  SELECT prosrc INTO v_terminal_evidence_guard_source FROM pg_proc
   WHERE oid =
     'public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure;
  SELECT prosrc INTO v_terminal_parent_guard_source FROM pg_proc
   WHERE oid =
     'public.fn_receipted_tournament_is_immutable()'::regprocedure;
  IF v_collect_bounty_source IS NULL
     OR position('ca:tournament-terminal-settlement:v1'
                   IN v_collect_bounty_source) = 0
     OR position('pg_advisory_xact_lock('
                   IN v_collect_bounty_source) = 0
     OR position('pg_advisory_xact_lock('
                   IN v_collect_bounty_source) >
        position('FOR UPDATE' IN v_collect_bounty_source) THEN
    RAISE EXCEPTION
      'live bounty authority lost its terminal-first serialization';
  END IF;
  FOREACH v_component_signature IN ARRAY ARRAY[
    'public.fn_settle_tournament_places(uuid,uuid)',
    'public.fn_settle_tournament_final_table_deal(uuid)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_settle_tournament_rake(uuid,text)',
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'
  ] LOOP
    SELECT prosrc INTO v_component_source FROM pg_proc
     WHERE oid = to_regprocedure(v_component_signature);
    IF v_component_source IS NULL
       OR position('ca:tournament-terminal-settlement:v1'
                     IN v_component_source) = 0
       OR position('pg_advisory_xact_lock('
                     IN v_component_source) = 0
       OR position('pg_advisory_xact_lock('
                     IN v_component_source) >
          position('FOR UPDATE' IN v_component_source) THEN
      RAISE EXCEPTION
        'rolling terminal component % lost the shared lock order',
        v_component_signature;
    END IF;
  END LOOP;
  SELECT prosrc INTO v_satellite_award_source FROM pg_proc
   WHERE oid =
     'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure;
  IF v_satellite_award_source IS NULL
     OR position('WHERE id = p_target_id' IN v_satellite_award_source) = 0
     OR position('WHERE id = p_satellite_id' IN v_satellite_award_source) = 0
     OR position('WHERE id = p_target_id' IN v_satellite_award_source) >
          position('WHERE id = p_satellite_id' IN v_satellite_award_source) THEN
    RAISE EXCEPTION
      'rolling satellite award lost its target-before-source row-lock order';
  END IF;
  IF v_source IS NULL
     OR (length(v_source)-length(replace(v_source,
          'public.fn_settle_tournament_places(','')))
          / length('public.fn_settle_tournament_places(') <> 1
     OR (length(v_source)-length(replace(v_source,
          'public.fn_settle_tournament_final_table_deal(','')))
          / length('public.fn_settle_tournament_final_table_deal(') <> 1
     OR position('IF v_mode = ''places'' THEN' IN v_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_source) >
          position('SELECT t.* INTO v_t FROM public.tournaments' IN v_source)
     OR position('RETURN public.fn_ca_tournament_terminal_receipt' IN v_source) = 0
     OR position('public.fn_mystery_bounty_settle(' IN v_source) = 0
     OR position('public.fn_finalize_bounty_pool(' IN v_source) = 0
     OR position('public.fn_settle_tournament_rake(' IN v_source) = 0
     OR position('UPDATE public.table_seats' IN v_source) = 0
     OR position('UPDATE public.tables' IN v_source) = 0
     OR position('terminal_closed_at = v_completed_at' IN v_source) = 0
     OR position('ORDER BY tp.user_id,tp.id FOR UPDATE' IN v_source) = 0
     OR position('ORDER BY g.tournament_id FOR UPDATE' IN v_source) = 0
     OR position('PERFORM 1 FROM public.club_wallets' IN v_source) = 0
     OR position('PERFORM 1 FROM public.union_wallets' IN v_source) <
          position('PERFORM 1 FROM public.club_wallets' IN v_source)
     OR position('public.fn_settle_tournament_places(' IN v_source) <
          position('PERFORM 1 FROM public.union_wallets' IN v_source)
     OR position('''deal_shares'',v_deal_shares' IN v_source) = 0
     OR position('INSERT INTO public.tournament_terminal_settlements' IN v_source) = 0
     OR position('SET status = ''COMPLETED''' IN v_source) = 0
     OR v_source LIKE '%EXCEPTION WHEN OTHERS%' THEN
    RAISE EXCEPTION 'terminal authority lost its one-cash, fail-closed or receipt invariant';
  END IF;
  IF v_receipt_source IS NULL
     OR v_receipt_source ~* '\m(insert|update|delete|merge|call|perform)\M'
     OR (SELECT provolatile FROM pg_proc
          WHERE oid = 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure)
          <> 's' THEN
    RAISE EXCEPTION 'terminal replay verifier is not read-only and STABLE';
  END IF;
  IF v_mystery_evidence_source IS NULL
     OR v_mystery_evidence_source ~*
          '\m(insert|update|delete|merge|call|perform)\M'
     OR (SELECT provolatile FROM pg_proc
          WHERE oid =
            'public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)'::regprocedure)
          <> 's'
     OR position('public.fn_ca_mystery_bounty_completion_evidence('
                   IN v_source) = 0
     OR position('public.fn_ca_mystery_bounty_completion_evidence('
                   IN v_receipt_source) = 0
     OR position('v_legacy_credit_cents + v_obligation_cents'
                   IN v_mystery_evidence_source) = 0 THEN
    RAISE EXCEPTION 'mixed-era mystery proof is mutable, absent or not shared';
  END IF;
  IF v_hand_source IS NULL
     OR position('ORDER BY tp.user_id,tp.id' IN v_hand_source) = 0
     OR position('ORDER BY ts.id' IN v_hand_source) <
          position('ORDER BY tp.user_id,tp.id' IN v_hand_source)
     OR position('UPDATE public.tournament_players tp' IN v_hand_source) = 0
     OR position('SET chips = target.stack' IN v_hand_source) = 0
     OR position('''tournament_players_synced''' IN v_hand_source) = 0
     OR position('''tournament_player_chips''' IN v_hand_source) = 0
     OR position('SET left_at = v_zero_stack_vacated_at' IN v_hand_source) = 0
     OR position('SET left_at = v_zero_stack_vacated_at' IN v_hand_source) <
          position('UPDATE public.tournament_players tp' IN v_hand_source)
     OR position('''tournament_zero_stack_seats_vacated'''
                   IN v_hand_source) = 0
     OR position('''tournament_zero_stack_seat_ids'''
                   IN v_hand_source) = 0
     OR position('''tournament_zero_stack_user_ids'''
                   IN v_hand_source) = 0 THEN
    RAISE EXCEPTION 'hand stack authority lost canonical locks or player-chip sync';
  END IF;
  IF v_mystery_pay_source IS NULL
     OR position('PERFORM 1 FROM public.tournaments t' IN v_mystery_pay_source) = 0
     OR position('PERFORM 1 FROM public.tournaments t' IN v_mystery_pay_source) >
          position('SELECT * INTO v_a FROM public.tournament_bounty_awards'
            IN v_mystery_pay_source)
     OR position('ORDER BY o.kind,o.place NULLS LAST,o.user_id,o.id FOR UPDATE'
          IN v_mystery_pay_source) = 0
     OR v_mystery_reserve_source IS NULL
     OR position('PERFORM 1 FROM public.tournaments t' IN v_mystery_reserve_source) = 0
     OR position('PERFORM 1 FROM public.tournaments t' IN v_mystery_reserve_source) >
          position('FROM public.tournament_bounty_awards' IN v_mystery_reserve_source) THEN
    RAISE EXCEPTION 'live mystery authorities lost tournament-first lock order';
  END IF;
  IF v_table_guard_source IS NULL
     OR position('TG_OP = ''INSERT''' IN v_table_guard_source) = 0
     OR position('FOR SHARE' IN v_table_guard_source) = 0
     OR position('TG_OP = ''DELETE''' IN v_table_guard_source) = 0
     OR position('terminal_closed_at' IN v_table_guard_source) = 0
     OR position('NEW.id IS DISTINCT FROM OLD.id' IN v_table_guard_source) = 0
     OR position('new table % cannot supply a terminal marker'
                   IN v_table_guard_source) = 0
     OR position('live tournament table % cannot supply a terminal marker'
                   IN v_table_guard_source) = 0
     OR position('unscoped table % cannot supply a terminal marker'
                   IN v_table_guard_source) = 0
     OR position('NEW.current_players IS DISTINCT FROM 0'
                   IN v_table_guard_source) = 0
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.tables'::regclass
          AND c.conname = 'tables_terminal_closed_shape'
          AND pg_get_constraintdef(c.oid) LIKE
            '%current_players IS NOT DISTINCT FROM 0%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid = 'public.tournaments'::regclass
          AND g.tgname = 'non_satellite_completed_requires_terminal_receipt'
          AND g.tgdeferrable AND g.tginitdeferred)
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid = 'public.tables'::regclass
          AND g.tgname = 'tournament_table_terminal_close_is_irreversible') THEN
    RAISE EXCEPTION 'terminal lifecycle or table membership guard is absent';
  END IF;
  IF v_terminal_marker_source IS NULL
     OR position('p_new - ''terminal_closed_at'''
                   IN v_terminal_marker_source) = 0
     OR position('p_old - ''terminal_closed_at'''
                   IN v_terminal_marker_source) = 0
     OR position('isfinite(t.ended_at)' IN v_terminal_marker_source) = 0
     OR position('IS NOT DISTINCT FROM t.ended_at'
                   IN v_terminal_marker_source) = 0
     OR v_terminal_stamp_source IS NULL
     OR position('UPDATE public.tournament_players'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_obligations'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_payouts'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_rake_settlements'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.rake_records'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_bounty_chests'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_bounty_awards'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_guarantee_overlays'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.table_seats'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.wallet_transactions'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_bounty_award_recipients'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_escrow'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.spin_reserve_ledger'
                   IN v_terminal_stamp_source) = 0
     OR position('terminal_closed_at IS DISTINCT FROM v_terminal_at'
                   IN v_terminal_stamp_source) = 0
     OR v_terminal_stamp_source LIKE '%EXCEPTION WHEN%'
     OR v_terminal_evidence_guard_source IS NULL
     OR position('v_old_marker IS NOT NULL'
                   IN v_terminal_evidence_guard_source) = 0
     OR position('fn_ca_terminal_marker_transition_is_exact('
                   IN v_terminal_evidence_guard_source) = 0
     OR position('v_old_marker IS NOT NULL'
                   IN v_terminal_evidence_guard_source) >
        position('SELECT upper(COALESCE(t.status::text,''''))'
                   IN v_terminal_evidence_guard_source)
     OR v_terminal_parent_guard_source IS NULL
     OR position('upper(COALESCE(OLD.status::text,'''')) IN'
                   IN v_terminal_parent_guard_source) = 0
     OR position('tournament_terminal_settlements'
                   IN v_terminal_parent_guard_source) <> 0 THEN
    RAISE EXCEPTION
      'terminal tuple-marker transition, stamp or immediate guard is incomplete';
  END IF;
  IF v_receipt_source IS NULL
     OR position('mutable evidence lacks its exact terminal marker'
                   IN v_receipt_source) = 0
     OR position('s.terminal_closed_at IS DISTINCT FROM v_h.completed_at'
                   IN v_receipt_source) = 0
     OR position('x.kind NOT IN (''contribution'',''jackpot_draw'')'
                   IN v_receipt_source) = 0 THEN
    RAISE EXCEPTION
      'terminal replay no longer proves every mutable child marker';
  END IF;
  IF v_satellite_receipt_source IS NULL
     OR position('v_source.ended_at IS DISTINCT FROM v_h.source_closed_at'
                   IN v_satellite_receipt_source) = 0
     OR position('tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at'
                   IN v_satellite_receipt_source) = 0
     OR has_function_privilege('service_role',
          'public.fn_ca_satellite_settlement_receipt(uuid,uuid)','EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_settlements s
         JOIN public.tournaments t ON t.id = s.tournament_id
         CROSS JOIN LATERAL unnest(s.source_table_ids)
           AS source_tables(source_table_id)
         JOIN public.tables tb ON tb.id = source_tables.source_table_id
        WHERE tb.terminal_closed_at IS DISTINCT FROM t.ended_at
     ) THEN
    RAISE EXCEPTION
      'satellite receipt or historical terminal marker is not exact';
  END IF;
  IF v_outcome_source IS NULL
     OR position('pg_advisory_xact_lock(' IN v_outcome_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_outcome_source) >
          position('SELECT t.* INTO v_t FROM public.tournaments' IN v_outcome_source)
     OR position('FOR UPDATE' IN v_outcome_source) <
          position('pg_advisory_xact_lock(' IN v_outcome_source)
     OR position('public.fn_ca_tournament_terminal_receipt(' IN v_outcome_source) = 0
     OR position('''definitively_not_committed'',true' IN v_outcome_source) = 0
     OR position('public.fn_settle_' IN v_outcome_source) <> 0 THEN
    RAISE EXCEPTION 'terminal transport outcome resolver lost serialization or purity';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
      OR has_function_privilege('service_role',
        'public.fn_ca_tournament_terminal_receipt(uuid,uuid)','EXECUTE')
      OR has_function_privilege('service_role',
        'public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)','EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)',
       'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)',
       'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)',
       'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_stamp_tournament_terminal_evidence_markers()','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_stamp_tournament_terminal_evidence_markers()','EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_stamp_tournament_terminal_evidence_markers()','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)','EXECUTE')
     OR has_table_privilege('service_role',
       'public.tournament_terminal_settlements','SELECT')
     OR has_table_privilege('service_role',
       'public.tournament_terminal_settlement_cutover','SELECT') THEN
    RAISE EXCEPTION 'terminal authority has an unsafe function or table ACL';
  END IF;
  IF (SELECT count(*) FROM public.tournament_terminal_settlement_cutover c
       WHERE c.authority = 'fn_complete_tournament_terminal:v1'
         AND c.migration_version = '20260908153329'
         AND c.installed_at >= transaction_timestamp()
         AND c.installed_at <= clock_timestamp()
         AND array_position(c.preexisting_completed_ids, NULL) IS NULL
         AND cardinality(c.preexisting_completed_ids) =
             (SELECT count(DISTINCT captured.id)
                FROM unnest(c.preexisting_completed_ids) captured(id))) <> 1 THEN
    RAISE EXCEPTION 'terminal settlement cutover watermark is not exact';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.fn_terminal_tournament_evidence_is_immutable()'),
           ('public.fn_terminal_tournament_seat_is_immutable()'),
           ('public.fn_receipted_tournament_is_immutable()'),
           ('public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'),
           ('public.fn_stamp_tournament_terminal_evidence_markers()'),
           ('public.fn_ca_has_committed_tournament_receipt(uuid)'),
           ('public.fn_terminal_bounty_recipient_is_immutable()'),
           ('public.fn_terminal_wallet_transaction_is_immutable()'),
           ('public.fn_ca_tournament_id_from_credit_key(text)'),
           ('public.fn_terminal_credit_key_is_immutable()'),
           ('public.fn_terminal_tournament_escrow_is_immutable()'),
           ('public.fn_satellite_target_player_provenance_is_immutable()'),
           ('public.fn_satellite_target_rake_is_immutable()'),
           ('public.fn_satellite_transfer_ledger_is_immutable()')
         ) required(signature)
        WHERE to_regprocedure(required.signature) IS NULL
     ) OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('tournament_players'),
           ('tournament_obligations'),
           ('tournament_payouts'),
           ('tournament_rake_settlements'),
           ('rake_records'),
           ('tournament_bounty_chests'),
           ('tournament_bounty_awards'),
           ('tournament_guarantee_overlays'),
           ('table_seats'),
           ('wallet_transactions'),
           ('tournament_bounty_award_recipients'),
           ('tournament_escrow'),
           ('spin_reserve_ledger')
         ) required(relname)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_attribute a
           WHERE a.attrelid = format('public.%I',required.relname)::regclass
             AND a.attname = 'terminal_closed_at'
             AND a.atttypid = 'timestamptz'::regtype
             AND a.attnum > 0
             AND NOT a.attisdropped
             AND NOT a.attnotnull
             AND a.attidentity = ''
             AND a.attgenerated = ''
             AND a.attacl IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM pg_attrdef d
                WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))
     ) OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'::regprocedure
          AND p.prosecdef AND p.provolatile = 's'
     ) OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure
          AND p.prosecdef
     ) OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
        WHERE p.oid IN (
          'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'::regprocedure,
          'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure)
          AND privilege.privilege_type='EXECUTE'
          AND privilege.grantee<>p.proowner
     ) OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger g
         JOIN pg_attribute a
           ON a.attrelid=g.tgrelid AND a.attname='status'
        WHERE g.tgrelid='public.tournaments'::regclass
          AND g.tgname='stamp_tournament_terminal_evidence_markers'
          AND g.tgfoid=
            'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure
          AND NOT g.tgisinternal AND g.tgenabled='O'
          AND g.tgtype=21
          AND g.tgattr::text=a.attnum::text
     ) OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('tables','tournament_table_terminal_close_is_irreversible',
             'public.fn_tournament_table_terminal_close_is_irreversible()',31),
           ('table_seats','terminal_tournament_seat_is_immutable',
             'public.fn_terminal_tournament_seat_is_immutable()',31),
           ('tournaments','receipted_tournament_is_immutable',
             'public.fn_receipted_tournament_is_immutable()',27),
           ('tournament_bounty_award_recipients',
             'terminal_bounty_recipient_is_immutable',
             'public.fn_terminal_bounty_recipient_is_immutable()',31),
           ('wallet_transactions','terminal_wallet_transaction_is_immutable',
             'public.fn_terminal_wallet_transaction_is_immutable()',31),
           ('wallet_credit_idempotency','terminal_credit_key_is_immutable',
             'public.fn_terminal_credit_key_is_immutable()',31),
           ('tournament_escrow','terminal_tournament_escrow_is_immutable',
             'public.fn_terminal_tournament_escrow_is_immutable()',31),
           ('tournament_players','satellite_target_player_provenance_is_immutable',
             'public.fn_satellite_target_player_provenance_is_immutable()',31),
           ('rake_records','satellite_target_rake_is_immutable',
             'public.fn_satellite_target_rake_is_immutable()',31),
           ('chip_ledger','satellite_transfer_ledger_is_immutable',
             'public.fn_satellite_transfer_ledger_is_immutable()',31)
         ) required(relname,trigger_name,function_signature,expected_tgtype)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_trigger g
           WHERE g.tgrelid = format('public.%I',required.relname)::regclass
             AND g.tgname = required.trigger_name
             AND g.tgfoid = to_regprocedure(required.function_signature)
             AND NOT g.tgisinternal AND g.tgenabled = 'O'
             AND g.tgtype=required.expected_tgtype)
     ) OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('tournament_players'),
           ('tournament_obligations'),
           ('tournament_payouts'),
           ('chip_ledger'),
           ('tournament_rake_settlements'),
           ('rake_records'),
           ('tournament_bounty_chests'),
           ('tournament_bounty_awards'),
           ('tournament_guarantee_overlays'),
           ('tournament_satellite_awards'),
           ('tournament_satellite_remainders'),
           ('tournament_refund_entitlements'),
           ('tournament_refund_tranches'),
           ('spin_reserve_ledger'),
           ('tournament_spin_cancellation_unwinds')
         ) required(relname)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_trigger g
           WHERE g.tgrelid=format('public.%I',required.relname)::regclass
             AND g.tgname='terminal_tournament_evidence_is_immutable'
             AND g.tgfoid=
               'public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure
             AND NOT g.tgisinternal AND g.tgenabled='O'
             AND g.tgtype=31 AND g.tgattr::text='')
     ) OR (SELECT count(*)
             FROM pg_trigger g
            WHERE g.tgname = 'terminal_tournament_evidence_is_immutable'
              AND g.tgfoid =
                'public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure
              AND NOT g.tgisinternal AND g.tgenabled='O'
              AND g.tgtype=31 AND g.tgattr::text='') <> 15
       OR EXISTS (
         SELECT 1 FROM pg_trigger g
          WHERE g.tgrelid = 'public.tournaments'::regclass
            AND g.tgname = 'zz_ca_escrow_close'
            AND NOT g.tgisinternal AND g.tgenabled IN ('O','A')) THEN
    RAISE EXCEPTION
      'terminal evidence immutability guards or escrow watcher retirement are incomplete';
  END IF;
END;
$verify_terminal_authority$;

COMMIT;
