-- ═══════════════════════════════════════════════════════════════════════════
--  THE REALTIME POLLER DECODES ONLY WHAT SOMEONE READS
--  Dan, 2026-09-06: "fully fix and get to the root cause of the issues we're
--  having with the lagging Realtime WAL stream ... fix any and all issues so
--  they stop happening."
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THE LAG ACTUALLY IS, MEASURED
--
-- Supabase Realtime reads every change on every published table through ONE
-- single-threaded poller: `realtime.list_changes` -> wal2json -> `apply_rls`
-- per change. Since the 09-02 stats reset that call has run 823,737 times for
-- 220,823 seconds of database time - 68% of one core, continuously.
--
-- Probed against live WAL on 2026-09-06 14:45 UTC with a temporary slot, the
-- changes fully materialised first so no lazy-evaluation artefact could
-- distort the split:
--
--     15 seconds of WAL, 27 MB, 1,643 published row changes
--     wal2json decode of all of them              4,735 ms
--     apply_rls, summed over every table         18,146 ms
--     ------------------------------------------------------
--     TOTAL                                      22,881 ms
--
-- **22.9 seconds of database time to process 15 seconds of WAL.** One thread
-- cannot do that, so the slot falls behind; and a logical slot that is behind
-- must read WAL from disk instead of memory, which is slower, so being behind
-- makes it fall further behind. There is no cliff to notice, which is why this
-- was only ever found by opening a SQL editor.
--
-- Where the 18,146 ms went, and why - cost tracks COLUMN COUNT, because
-- apply_rls runs roughly one dynamic cast plus one column-privilege check per
-- column per change:
--
--     table                changes   ms/change      ms   cols  repl.identity
--     tables                   221       28.40   6,277    154   default
--     tournaments               62       39.40   2,443    110   FULL  <-- x2 cols
--     table_seats              362        5.22   1,891     22   default
--     table_hole_cards         571        3.30   1,883      7   default
--     clubs                     49       35.96   1,762     92   default
--     profiles                  14       45.29     634    120   default
--     everything else          364           -   3,256      -   -
--
-- WHAT THIS MIGRATION CHANGES, and the engine change it ships beside
--
--  1. `table_hole_cards` LEAVES the publication. 571 of 1,643 changes - 35% of
--     everything decoded - and `delivered: 0`. Not "few subscribers": none.
--     The hero's cards have arrived on the engine socket since PR #3032 (live
--     2026-09-05 00:55 UTC), sent BEFORE the database write and re-pushed on
--     every SUBSCRIBE, with the bounded recovery poll behind that. The row is
--     still written and still read by the poll; it simply stops being decoded
--     and RLS-checked for an audience of zero.
--
--     THIS IS NOT THE 2026-08-31 TRIM, which removed it while the Realtime row
--     push was the ONLY delivery path and blinded every table for four hours
--     (restored by 20260901000200). That migration recorded the precondition
--     for doing this properly - "deliver hole cards as a private frame on the
--     engine socket the player already holds and then drop this table from
--     realtime for good" - and #3032 is that change. The client subscription
--     is removed in the same pull request, so there is no dead channel left
--     erroring against a table that is no longer published.
--
--  2. `tournaments` goes to REPLICA IDENTITY DEFAULT. FULL logs the entire old
--     row on every UPDATE, so apply_rls casts and privilege-checks 110 columns
--     TWICE - which is why it is the most expensive row on the platform at
--     39.4 ms despite being narrower than `tables`. Nothing reads `payload.old`
--     beyond the primary key: the only `.old` access on this table in either
--     repo is `payload.old.id` on DELETE (TournamentDetails.tsx), which DEFAULT
--     still carries. The migration asserts the table has taken zero deletes
--     since the stats reset, so no filtered DELETE delivery is being given up
--     either. `20260905161915` already did this for every published table that
--     happened to have no subscriber at that instant; `tournaments` had one, so
--     it was skipped. This finishes the job for the one table where it pays.
--
--  3. The RLS helpers the poller executes per delivery become LANGUAGE sql
--     (`is_club_member`, `is_club_admin`, `fn_is_union_overseer`,
--     `fn_union_oversees_club`, `fn_club_is_in_downline`,
--     `fn_club_cashier_can_transact`). Same bodies, same results, same ACLs.
--     A SQL function is run by the SQL function manager against a cached plan
--     with no PL/pgSQL frame - which also takes OUR functions out of the
--     nested-PL/pgSQL path that trips `plpgsql_check`'s pldbgapi2 statement
--     stack. That bug crashed the poller 21 times in 24 hours
--     ("cannot find parent statement on pldbgapi2 call stack", raised inside
--     realtime.apply_rls); each crash can drop the temporary slot, and every
--     change between the crash and the restart reaches nobody.
--
--  4. `fn_aggregate_gto_v31_next` stops creating a TEMP TABLE per call - 648
--     calls and ~11 temp tables a minute in the hour before this migration,
--     still running. Each one is DDL: catalog rows plus relcache and syscache
--     invalidations broadcast to EVERY backend, the poller's connection
--     included, where they discard the very plans apply_rls re-prepares per
--     change. It now creates the scratch table once per session (ON COMMIT
--     DELETE ROWS) and empties it per call, and the body is patched in place
--     from the catalogue rather than retyped, so nothing else can drift.
--
--     `ca_rebuild_table_chunk` has the same shape (3,175 temp tables in three
--     hours on 2026-09-04) and is deliberately left alone: its backfill has
--     finished, it produced ZERO DDL events in the hour before this migration,
--     and its CREATE TABLE AS form cannot be corrected by a string replace.
--     See the note at section 3 and the changelog.
--
--  5. `ca_log_ddl_event` / `ca_log_ddl_drop` stop recording pg_temp objects,
--     and the existing ones are pruned: 349,953 of that table's 359,842 rows
--     (97%, 172 MB) were this noise.
--
--  6. `fn_request_manual_bomb_pot` announces on ONE topic,
--     `engine:bomb-requests`, instead of `table:<id>`. The engine joined one
--     Realtime channel per bomb-pot table (76) plus one per live tournament
--     (425) on a single socket against a hard cap of 100: 123,219
--     `ChannelRateLimitReached: Too many channels` in 24 hours, ~1.4 every
--     second, every one retried - and past the cap those joins did not exist,
--     so an unknown share of tables were not listening at all. Realtime runs
--     the channel layer and the WAL poller in the same node, so that loop was
--     also stealing CPU from the poller. The engine now holds ONE channel and
--     dispatches on `payload.table_id` (server/src/services/BombRequestBus.ts),
--     and the tournament broadcast stops joining channels entirely.
--
--     ORDERING: this half applies immediately, the engine half on the next
--     `server/**` deploy. In between, a manual bomb request is announced on a
--     topic nothing listens to and arrives instead through
--     `tables.bomb_pot_manual_pending`, which the same function writes in the
--     same transaction and the engine re-reads on its throttled refresh. That
--     column is exactly why the broadcast is allowed to be best-effort.
--
-- WHAT IS DELIBERATELY NOT DONE HERE
--
-- `table_seats` and `clubs` stay published and stay REPLICA IDENTITY DEFAULT:
-- both have live subscribers whose filters need the row, and neither is worth
-- a correctness risk. The largest remaining line, `tables` at 6,277 ms, is not
-- fixed by a migration at all - it is fixed by the engine writing the recount
-- only when it changed (93.4% of them did not), which ships in this same pull
-- request as `tableCountChangedFilter`.
--
-- ASSERTIONS. Aborts rather than proceeding if the board moved: if
-- `tournaments` has taken a delete, if it is no longer REPLICA IDENTITY FULL,
-- if `table_hole_cards` is already unpublished, or if a function signature
-- drifted from the one that was read.
--
-- ROLLBACK, each line independent:
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.table_hole_cards;
--   ALTER TABLE public.tournaments REPLICA IDENTITY FULL;
--   (functions: re-apply the previous definitions, which are preserved in
--    supabase_migrations.schema_migrations.statements)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '180s';

-- ── 0. The board has not moved since it was measured ──────────────────────
DO $$
DECLARE v_del bigint; v_pub boolean; v_ri "char";
BEGIN
  SELECT n_tup_del INTO v_del FROM pg_stat_user_tables WHERE relname = 'tournaments';
  IF COALESCE(v_del, 0) > 0 THEN
    RAISE EXCEPTION
      'tournaments has taken % deletes since the stats reset. Under REPLICA IDENTITY DEFAULT a filtered subscription stops receiving DELETEs, which was safe only because that number was zero. Re-measure before applying.', v_del;
  END IF;

  SELECT relreplident INTO v_ri FROM pg_class WHERE oid = 'public.tournaments'::regclass;
  IF v_ri <> 'f' THEN
    RAISE EXCEPTION 'tournaments replica identity is %, not FULL - somebody already changed it. Re-measure.', v_ri;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'table_hole_cards'
  ) INTO v_pub;
  IF NOT v_pub THEN
    RAISE EXCEPTION 'table_hole_cards is already out of supabase_realtime - somebody else acted. Re-measure.';
  END IF;

  PERFORM 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'is_club_member'
     AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_user_id uuid';
  IF NOT FOUND THEN RAISE EXCEPTION 'is_club_member(uuid,uuid) signature drifted'; END IF;

  PERFORM 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_request_manual_bomb_pot'
     AND pg_get_function_identity_arguments(p.oid) = 'p_table_id uuid';
  IF NOT FOUND THEN RAISE EXCEPTION 'fn_request_manual_bomb_pot(uuid) signature drifted'; END IF;
END $$;

-- ── 1. Stop decoding what nobody reads ────────────────────────────────────
ALTER PUBLICATION supabase_realtime DROP TABLE public.table_hole_cards;
ALTER TABLE public.tournaments REPLICA IDENTITY DEFAULT;

-- ── 2. The RLS helpers the poller runs per delivery: PL/pgSQL -> SQL ──────
-- Bodies are unchanged in meaning, and were proven equivalent against 1,316
-- real (club, user[, target]) cases with zero mismatches before this was
-- applied - including every shape that matters: active members, lapsed
-- members, club owners, union owners and admins, agents with downlines, and
-- all-NULL arguments.
--
-- ⚠ READ THIS BEFORE COPYING THE PATTERN. The two INVOKER functions below
-- (`is_club_member`, `is_club_admin`) were PUT BACK to PL/pgSQL twenty
-- minutes later by migration 20260906150640. Dropping their `SET search_path`
-- made them inlinable, and a function an RLS policy calls should not be
-- inlinable without measuring that policy afterwards. The four SECURITY
-- DEFINER helpers keep the SQL form: those can never be inlined, and they are
-- the ones that take our code off the pldbgapi2 crash path.
--
-- The statements for the two invoker functions are left here as applied,
-- because this file is the record of what ran; 20260906150640 is the record
-- of what it is now.

CREATE OR REPLACE FUNCTION public.is_club_member(p_club_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members
     WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_club_admin(p_club_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.clubs WHERE id = p_club_id AND owner_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.club_members
     WHERE club_id = p_club_id AND user_id = p_user_id
       AND role IN ('owner', 'co_owner', 'admin') AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_is_union_overseer(p_union_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_union_id IS NOT NULL AND p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id AND u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = p_union_id AND a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = p_union_id AND COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.club_members m
                WHERE m.club_id = p_union_id AND m.user_id = p_user_id
                  AND m.role IN ('owner','co_owner','admin')
                  AND m.status IN ('active','approved'))
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_union_oversees_club(p_club_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  -- union_clubs first, then clubs.union_id: the same two-step lookup, and the
  -- same NULL-in-NULL-out behaviour, as the PL/pgSQL body this replaces.
  SELECT p_club_id IS NOT NULL AND p_user_id IS NOT NULL AND public.fn_is_union_overseer(
    COALESCE(
      (SELECT uc.union_id FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1),
      (SELECT c.union_id FROM public.clubs c WHERE c.id = p_club_id)
    ),
    p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_club_is_in_downline(
  p_club_id uuid, p_upline_user_id uuid, p_member_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  -- The three guards live in the BASE CASE rather than in front of the whole
  -- statement, so a null or self-referential call yields no starting row and
  -- the recursion never begins - the same cheap exit the PL/pgSQL version got
  -- from returning early, without relying on AND short-circuiting around a CTE.
  WITH RECURSIVE dl AS (
    SELECT cm.user_id, 1 AS depth
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.agent_id = p_upline_user_id
       AND p_upline_user_id IS NOT NULL
       AND p_member_user_id IS NOT NULL
       AND p_upline_user_id <> p_member_user_id
    UNION
    SELECT cm.user_id, dl.depth + 1
      FROM public.club_members cm
      JOIN dl ON cm.agent_id = dl.user_id
     WHERE cm.club_id = p_club_id
       AND dl.depth < 20   -- a malformed cycle must not spin forever
  )
  SELECT EXISTS (SELECT 1 FROM dl WHERE dl.user_id = p_member_user_id);
$$;

CREATE OR REPLACE FUNCTION public.fn_club_cashier_can_transact(
  p_club_id uuid, p_actor uuid, p_target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  -- The scope is resolved ONCE and then branched on. Writing it as two WHEN
  -- conditions would call fn_club_cashier_scope twice for every 'downline'
  -- actor, which the PL/pgSQL version did not.
  SELECT CASE
    WHEN p_club_id IS NULL OR p_actor IS NULL OR p_target IS NULL THEN false
    ELSE (
      SELECT CASE s.scope
        WHEN 'all'      THEN true
        WHEN 'downline' THEN public.fn_club_is_in_downline(p_club_id, p_actor, p_target)
        ELSE false
      END
      FROM (SELECT public.fn_club_cashier_scope(p_club_id, p_actor) AS scope) s
    )
  END;
$$;

-- These four are SECURITY DEFINER and never consult auth.*; they are read-only
-- and were already closed to anon. Restated so the grants are explicit rather
-- than inherited from a default.
REVOKE ALL ON FUNCTION public.fn_is_union_overseer(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_union_oversees_club(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_club_is_in_downline(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_club_cashier_can_transact(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_union_overseer(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_oversees_club(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_is_in_downline(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_can_transact(uuid, uuid, uuid) TO authenticated, service_role;

-- ── 3. One scratch table per SESSION, not one per call ────────────────
-- `fn_aggregate_gto_v31_next` creates a temp table, indexes it, comments a
-- column on it and drops it ON COMMIT - on EVERY call. Measured in the hour
-- before this migration: 648 calls, 1,296 create/drop pairs, ~11 temp tables a
-- minute, still running. Each one is DDL, and DDL sends relcache and syscache
-- invalidations to EVERY backend - the Realtime poller's connection included,
-- where it discards the very plans `apply_rls` re-prepares per change.
--
-- The body is NOT retyped here. It is read back from the catalogue and two
-- lines are replaced, so everything else stays byte-identical to what is
-- running and this migration cannot quietly alter the aggregation. TRUNCATE
-- is swapped for DELETE because TRUNCATE on a temp table is itself a catalog
-- write - a second invalidation per call on top of the create/drop pair.
--
-- `ca_rebuild_table_chunk` has the same shape (a CREATE TEMP TABLE ... AS per
-- chunk, 3,175 of them in three hours on 2026-09-04) and is deliberately NOT
-- touched: its backfill has finished - zero `_chunk` DDL events in the hour
-- before this migration - so it is not currently costing anything, and its
-- CTAS form cannot be corrected by a string replace. Hand-retyping 150 lines
-- of live chip-attribution arithmetic to save nothing today is the wrong
-- trade. It is recorded in the changelog as the next one to do, with the note
-- that it needs the scratch table declared with explicit column types.
DO $mig$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_aggregate_gto_v31_next';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_aggregate_gto_v31_next not found';
  END IF;
  IF position('on commit drop' in v_def) = 0 THEN
    RAISE EXCEPTION 'fn_aggregate_gto_v31_next no longer contains "on commit drop" - it changed underneath this migration, re-read it before applying';
  END IF;
  IF position('truncate table tmp_agg31;' in v_def) = 0 THEN
    RAISE EXCEPTION 'fn_aggregate_gto_v31_next no longer contains the truncate - it changed underneath this migration, re-read it before applying';
  END IF;

  v_def := replace(v_def, 'on commit drop', 'on commit delete rows');
  v_def := replace(v_def, 'truncate table tmp_agg31;', 'delete from tmp_agg31;');
  EXECUTE v_def;
END $mig$;

-- ── 4. The DDL log stops recording scratch tables ─────────────────────────
CREATE OR REPLACE FUNCTION public.ca_log_ddl_event()
 RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    -- 2026-09-06: a temp table is DDL too, and two RPCs made 5,300 of them in
    -- three hours. 97% of this log (349,953 rows, 172 MB) was pg_temp, which
    -- nothing reads and which buried the DDL that matters.
    IF cmd.schema_name = 'pg_temp' OR cmd.object_identity LIKE 'pg_temp.%' THEN
      CONTINUE;
    END IF;
    INSERT INTO public.ca_ddl_events
      (command_tag, object_type, object_identity, schema_name,
       triggers_pgrst_reload, application_name, query_snippet)
    VALUES
      (cmd.command_tag, cmd.object_type, cmd.object_identity, cmd.schema_name,
       cmd.command_tag IN (
         'CREATE SCHEMA','ALTER SCHEMA','CREATE TABLE','CREATE TABLE AS',
         'SELECT INTO','ALTER TABLE','CREATE FOREIGN TABLE',
         'ALTER FOREIGN TABLE','CREATE VIEW','ALTER VIEW',
         'CREATE MATERIALIZED VIEW','ALTER MATERIALIZED VIEW',
         'CREATE FUNCTION','ALTER FUNCTION','CREATE TRIGGER','CREATE TYPE',
         'ALTER TYPE','CREATE RULE','COMMENT'
       ) AND cmd.schema_name IS DISTINCT FROM 'pg_temp',
       current_setting('application_name', true),
       left(current_query(), 300));
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  NULL; -- never break DDL for the sake of a log line
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_log_ddl_drop()
 RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.is_temporary OR obj.schema_name = 'pg_temp'
       OR obj.object_identity LIKE 'pg_temp.%' THEN
      CONTINUE;
    END IF;
    INSERT INTO public.ca_ddl_events
      (command_tag, object_type, object_identity, schema_name,
       triggers_pgrst_reload, application_name, query_snippet)
    VALUES
      ('DROP ' || upper(coalesce(obj.object_type, 'OBJECT')),
       obj.object_type, obj.object_identity, obj.schema_name,
       obj.object_type IN (
         'schema','table','foreign table','view','materialized view',
         'function','trigger','type','rule'
       ) AND obj.is_temporary IS FALSE,
       current_setting('application_name', true),
       left(current_query(), 300));
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$;

DELETE FROM public.ca_ddl_events
 WHERE schema_name = 'pg_temp' OR object_identity LIKE 'pg_temp.%';

-- ── 5. One topic for every manual bomb request ────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_request_manual_bomb_pot(p_table_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_enabled boolean;
  v_role text;
  v_is_owner boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT club_id, bomb_pot_enabled INTO v_club, v_enabled
  FROM public.tables WHERE id = p_table_id;

  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF v_enabled IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bomb_pots_disabled');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_club AND c.owner_id = v_uid)
    INTO v_is_owner;
  SELECT lower(cm.role) INTO v_role
  FROM public.club_members cm
  WHERE cm.club_id = v_club AND cm.user_id = v_uid
  LIMIT 1;

  IF NOT (v_is_owner OR v_role IN ('owner', 'co_owner', 'admin')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  UPDATE public.tables SET bomb_pot_manual_pending = true WHERE id = p_table_id;
  INSERT INTO public.bomb_pot_manual_requests (table_id, club_id, requested_by)
  VALUES (p_table_id, v_club, v_uid);

  -- The push (2026-08-29, re-routed 2026-09-06): ONE engine-wide topic. The
  -- engine used to join a Realtime channel per bomb-pot table to hear this;
  -- with 76 such tables plus one per live tournament on a single socket capped
  -- at 100 channels, that produced 123,219 ChannelRateLimitReached errors in
  -- 24 hours and left an unknown share of tables not listening at all. The
  -- engine now holds ONE channel and dispatches on payload.table_id.
  --
  -- Wrapped because a broadcast that fails must never fail the REQUEST: the
  -- column above is the durable record and the engine's throttled refresh is
  -- the backstop that makes this push optional.
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object('table_id', p_table_id, 'requested_by', v_uid),
      'bomb_pot_manual_requested',
      'engine:bomb-requests',
      false
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_request_manual_bomb_pot: realtime.send failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_request_manual_bomb_pot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_request_manual_bomb_pot(uuid) TO authenticated, service_role;

-- ── 6. Prove it landed ────────────────────────────────────────────────────
DO $$
DECLARE v_sql int;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables
              WHERE pubname='supabase_realtime' AND tablename='table_hole_cards') THEN
    RAISE EXCEPTION 'post-check: table_hole_cards is still published';
  END IF;
  IF (SELECT relreplident FROM pg_class WHERE oid='public.tournaments'::regclass) <> 'd' THEN
    RAISE EXCEPTION 'post-check: tournaments replica identity did not change';
  END IF;

  SELECT count(*) INTO v_sql
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
   WHERE n.nspname='public' AND l.lanname='sql'
     AND (p.proname IN ('is_club_member','fn_is_union_overseer','fn_union_oversees_club',
                        'fn_club_is_in_downline','fn_club_cashier_can_transact')
          OR (p.proname='is_club_admin'
              AND pg_get_function_identity_arguments(p.oid)='p_club_id uuid, p_user_id uuid'));
  IF v_sql <> 6 THEN
    RAISE EXCEPTION 'post-check: expected 6 RLS helpers in LANGUAGE sql, found %', v_sql;
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_ddl_events
              WHERE schema_name='pg_temp' OR object_identity LIKE 'pg_temp.%') THEN
    RAISE EXCEPTION 'post-check: pg_temp rows remain in ca_ddl_events';
  END IF;

  IF position('engine:bomb-requests' in
      (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='fn_request_manual_bomb_pot')) = 0 THEN
    RAISE EXCEPTION 'post-check: bomb request still announces on the per-table topic';
  END IF;
END $$;

COMMIT;
