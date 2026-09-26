-- 20260926045132_lightning_phase_5_and_9_remediation_two_the_seat_is_the_anch.sql
--
-- LIGHTNING PHASES 5 AND 9, REMEDIATION TWO: THE SEAT IS THE ANCHOR, THE POOL
-- FOLLOWS IT, AND A HALT IS A STOP ONLY ONCE THE ENGINE HAS SEEN IT.
--
-- 20260921151618 (conversion), 20260925204249 (halt, reaper), 20260925215731
-- (formation barrier) and 20260926023047 (its remediation) are applied and
-- dark: lightning_enabled is false on every Cluster and every lightning table
-- is empty. An independent audit found the defects below; each is reproduced
-- on its own estate by scripts/dev/test-lightning-remediation-two.sh BEFORE
-- this file is applied, and proved repaired after it, with a bad twin and a
-- good twin one thing apart.
--
-- THE DESIGN RULE THIS FILE ENFORCES: the physical seat (table_seats) is the
-- economic anchor and the pool is an overlay on it. Conversion, pool entry and
-- formation move no chips; only settlement does.
--
-- DEFECT 1 (P0). The commit could not see a hand in flight. It counted
-- hand_history rows with ended_at IS NULL, and hand_history is written only at
-- settlement, always with ended_at - so it counted nothing, ever - while the
-- engine re-reads a halt about once a minute. The commit now counts incomplete
-- hand_state_snapshots (written after every action, one per table, completed
-- after settlement) and refuses, as a structured not-ready answer, until every
-- live member table holding an unexpired engine lease has reported through the
-- new fn_cash_table_observe_dealing_halt that it has stopped
-- (tables.dealing_halt_observed_at >= dealing_halted_at). A table with no live
-- lease has no engine and is exempt. fn_cash_cluster_open_table now opens a
-- table already halted in any Cluster not in must_move, and reads the Cluster
-- FOR SHARE so a table cannot slip in between a conversion's decision and its
-- halt; a straggler the commit finds unhalted is halted and waited for.
-- cash_hand_participant_manifests was considered and not used: it carries no
-- settled marker, so reading it means a join to hand_history over a million
-- rows to learn what one indexed snapshot row already says.
--
-- DEFECT 2 (P1). Nothing took a player out of the pool, and nobody arriving
-- after the conversion got in. lightning_pool_session.anchor_seat_id (NOT NULL,
-- a foreign key to table_seats, one open session per anchor) is written by the
-- conversion - the seat its DISTINCT ON (ts.user_id) already picks - and by
-- the new fn_lightning_pool_enter. Two DEFERRED constraint triggers on
-- table_seats, whose WHEN clauses admit only an arrival, a departure, a
-- turnover, a sit-out or sit-in, a leave request or its withdrawal, or a stack
-- crossing zero: a departing anchor exits its session and closes its slot (and
-- a player still seated elsewhere in the Cluster re-enters through that
-- seat), and a seat that becomes eligible in a lightning Cluster enters the
-- pool. DEFERRED, not immediate, because the buy-in inserts the seat BEFORE it
-- opens the cash session a pool session must be subordinate to.
--
-- DEFECT 3 (P1). Two copies of the stack. fn_lightning_pool_stack now returns
-- the anchor seat's table_seats.stack (0 once it has left); starting_stack is
-- a snapshot and net_result a statistic. Formation's candidates must also have
-- a live-eligible anchor - fn_lightning_anchor_is_live_eligible, the seated
-- half of fn_cash_cluster_live_eligible asked of one seat, because that
-- function is a COUNT over a UNION that includes the pool itself - and an open
-- cash session, and formation locks the anchor seats FOR SHARE, before the
-- slots, and folds them into its money comparison.
--
-- DEFECT 4 (P1, money). A player in a live Lightning hand could be cashed out
-- or topped up. A BEFORE UPDATE trigger on table_seats, WHEN the stack, the
-- departure or the occupant changes, refuses with LIGHTNING_HAND_IN_PROGRESS
-- (SQLSTATE PLT01) a change to a seat anchoring an open pool session whose
-- player is in hand (fn_lightning_player_in_hand), unless
-- ca.lightning_settlement_hand names that hand. Its first statement is a probe
-- of a partial index that is empty for every ordinary seat.
--
-- DEFECT 5 (P2). An UPDATE moving a participant out of a locked hand into an
-- unlocked one passed; the OLD hand's latch is now asked too.
--
-- DEFECT 6 (P2). begin_dealing re-checked nothing outside the instance. It now
-- takes the Cluster row FOR SHARE first and abandons the instance, with a
-- reason, when the Cluster is not lightning, Lightning is disabled, the epoch
-- moved, or a participant's pool session, slot, anchor or cash session is no
-- longer live; its deadline is judged by clock_timestamp().
--
-- DEFECT 7 (P2). Impossible states were retried. The barrier's own re-checks
-- and its money comparison (moved inside the atomic block) raise PLT02; the
-- handler retries only a lock timeout, a deadlock, a serialization failure and
-- a unique violation on an index two matchers can race for. Anything else
-- freezes the Cluster through its own cluster_mode ('frozen' - every
-- formation, opening and deal refuses a Cluster that is not lightning), writes
-- stack_invariant_failed and cluster_frozen with the evidence, and answers
-- formation_invariant_failed with retry false.
--
-- DEFECT 8 (P2). fn_lightning_pool_slots_sync took the slots with no Cluster
-- lock while formation takes the Cluster then the slots; it now takes
-- cash_games FOR UPDATE SKIP LOCKED first, obeys the pass deadline
-- fn_cash_clusters_tick_all publishes, and closes a slot no earlier than it
-- opened. fn_cash_clusters_to_tick is NOT narrowed - the ClusterController
-- builds its row map from it - so fn_cash_cluster_tick reads cluster_mode
-- plainly first and stands down without taking the row.
--
-- DEFECT 9 (P2). One failed abort rolled the whole conversion reap back; each
-- abort now has its own sub-block and a lightning_pending_on_reap_failed row.
--
-- DEFECT 10 (P2). The specification's events: cluster_epoch_started,
-- pool_player_joined, pool_player_left, instance_created, instance_started,
-- instance_completed, instance_destroyed, pool_player_reserved,
-- pool_player_released and hand_created (with every participant's seat,
-- position and blind role; it replaces lightning_hand_formed, which nothing
-- outside the Phase 9 harness read). cash_cluster_events gains event_version
-- and request_id.
--
-- DEFECT 11 (P3). fn_lightning_form_hand gains p_request_id (the nine-argument
-- signature is dropped, grants and comment carried) and lightning_hand gains a
-- unique request_id, so a retried formation answers with the hand it formed.
-- DELETE is revoked from service_role on the seven lightning tables and
-- cash_cluster_conversion (TRUNCATE too on the latter); the conversion records
-- chips_at_begin and chips_at_commit; lightning_blind_ledger.debt_since is kept
-- by a trigger and is the P2 oldest-blind-debt-age tie-break in place of
-- updated_at, which every formation moved.
--
-- DEFECT 12. Proofs of the files before this one that it makes false are
-- listed in docs/changelog/2026-09-26-lightning-phase-5-9-remediation-2.md
-- under Corrections, and the harness proves that exactly those, and no others,
-- are false after it. Every proof below is containment: it names what this
-- file put there, never the size of a set a later file may grow.
--
-- @live-proof: (SELECT a.atttypid = 'timestamptz'::regtype FROM pg_attribute a WHERE a.attrelid = 'public.tables'::regclass AND a.attname = 'dealing_halt_observed_at' AND NOT a.attisdropped)
-- @live-proof: (SELECT NOT p.prosecdef AND p.prorettype = 'timestamptz'::regtype AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND pg_get_functiondef(p.oid) ~ 'SET dealing_halt_observed_at = clock_timestamp\(\)' FROM pg_proc p WHERE p.oid = 'public.fn_cash_table_observe_dealing_halt(uuid)'::regprocedure)
-- @live-proof: (SELECT s ~ 'FROM public\.hand_state_snapshots h' AND s ~ 'h\.is_complete = false' AND s !~ 'hand_history' AND s ~ 'halt_not_observed' AND s ~ 'public\.engine_table_leases l' AND s ~ 'fn_engine_lease_stale_seconds\(\)' AND s ~ 'tb\.dealing_halt_observed_at < tb\.dealing_halted_at' AND position('halt_not_observed' in s) < position('INSERT INTO public.lightning_pool_session' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'state, entered_at, starting_stack, anchor_seat_id\)' AND s ~ 'ts\.stack, ts\.id' AND s ~ 'chips_at_commit = v_before' AND s ~ '''pool_player_joined''' AND s ~ 'ca\.request_id' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'WHERE id = p_game_id FOR SHARE' AND s ~ 'IF g\.cluster_mode IS DISTINCT FROM ''must_move'' THEN' AND s ~ 'THEN ''lightning_pending_on'' ELSE ''lightning'' END' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'SET chips_at_begin' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_begin_pending_on(uuid,uuid)'::regprocedure) AS s) q) AND (SELECT count(*) = 2 FROM pg_attribute a WHERE a.attrelid = 'public.cash_cluster_conversion'::regclass AND a.attname IN ('chips_at_begin', 'chips_at_commit') AND NOT a.attisdropped)
-- @live-proof: (SELECT a.attnotnull AND a.atttypid = 'uuid'::regtype FROM pg_attribute a WHERE a.attrelid = 'public.lightning_pool_session'::regclass AND a.attname = 'anchor_seat_id' AND NOT a.attisdropped)
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass AND c.contype = 'f' AND c.confrelid = 'public.table_seats'::regclass AND c.convalidated AND pg_get_constraintdef(c.oid) ~ '^FOREIGN KEY \(anchor_seat_id\) REFERENCES (public\.)?table_seats\(id\)'))
-- @live-proof: (SELECT i.indisunique AND pg_get_expr(i.indpred, i.indrelid) ~ 'exited_at IS NULL' AND pg_get_indexdef(i.indexrelid) ~ '\(anchor_seat_id\)' FROM pg_index i WHERE i.indexrelid = 'public.lightning_pool_session_one_open_per_anchor'::regclass)
-- @live-proof: (SELECT p.prorettype = 'uuid'::regtype AND NOT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND pg_get_functiondef(p.oid) ~ 'fn_lightning_anchor_is_live_eligible\(s\.id, g\.id, s\.user_id\)' AND pg_get_functiondef(p.oid) ~ '''pool_player_joined''' AND pg_get_functiondef(p.oid) ~ 'fn_lightning_pool_slot_open\(v_ps, v_now\)' AND pg_get_functiondef(p.oid) ~ 'anchor_seat_id\)' FROM pg_proc p WHERE p.oid = 'public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure)
-- @live-proof: (SELECT count(*) = 2 AND bool_and(t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O' AND t.tgqual IS NOT NULL AND t.tgfoid = 'public.fn_table_seats_lightning_pool_follows_seat()'::regprocedure) FROM pg_trigger t WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname IN ('trg_table_seats_lightning_pool_on_insert', 'trg_table_seats_lightning_pool_follows_seat'))
-- @live-proof: (SELECT pg_get_triggerdef(t.oid) ~ 'old\.left_at IS DISTINCT FROM new\.left_at' AND pg_get_triggerdef(t.oid) ~ 'old\.is_sitting_out IS DISTINCT FROM new\.is_sitting_out' AND pg_get_triggerdef(t.oid) ~ 'old\.leave_pending IS DISTINCT FROM new\.leave_pending' AND pg_get_triggerdef(t.oid) ~ 'COALESCE\(old\.stack' AND (t.tgtype::integer & 16) <> 0 FROM pg_trigger t WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_pool_follows_seat')
-- @live-proof: (SELECT (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 16) <> 0 AND (t.tgtype::integer & 4) = 0 AND t.tgenabled = 'O' AND pg_get_triggerdef(t.oid) ~ 'old\.stack IS DISTINCT FROM new\.stack' AND pg_get_triggerdef(t.oid) ~ 'old\.left_at IS DISTINCT FROM new\.left_at' AND t.tgfoid = 'public.fn_table_seats_lightning_anchor_guard()'::regprocedure FROM pg_trigger t WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_anchor_guard')
-- @live-proof: (SELECT p.prosecdef AND s ~ 'LIGHTNING_HAND_IN_PROGRESS' AND s ~ 'ERRCODE = ''PLT01''' AND s ~ 'ca\.lightning_settlement_hand' AND s ~ 'ps\.anchor_seat_id = OLD\.id AND ps\.exited_at IS NULL' AND position('ps.anchor_seat_id = OLD.id' in s) < position('fn_lightning_player_in_hand' in s) FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_table_seats_lightning_anchor_guard()'::regprocedure)
-- @live-proof: (SELECT s ~ 'r\.state = ''committed''' AND s ~ 'i\.state IN \(''forming'', ''reserved'', ''dealing'', ''settling''\)' FROM (SELECT pg_get_functiondef('public.fn_lightning_player_in_hand(uuid,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'ts\.stack' AND s ~ 'ts\.left_at IS NOT NULL' AND s ~ 'anchor_seat_id' AND s !~ 'starting_stack' AND s !~ 'net_result' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_pool_stack(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'coalesce\(ts\.is_sitting_out, false\) = false' AND s ~ 'coalesce\(ts\.leave_pending, false\) = false' AND s ~ 'coalesce\(ts\.stack, 0\) > 0' AND s ~ 'ts\.left_at IS NULL' AND s ~ 'coalesce\(tb\.lifecycle, ''''\) <> ''closed''' FROM (SELECT pg_get_functiondef('public.fn_lightning_anchor_is_live_eligible(uuid,uuid,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT count(*) >= 1 AND bool_and(pg_get_function_identity_arguments(p.oid) ~ 'p_request_id uuid' AND pg_get_functiondef(p.oid) ~ 'fn_lightning_anchor_is_live_eligible\(ps\.anchor_seat_id, g\.id, ps\.player_id\)' AND pg_get_functiondef(p.oid) ~ 'cps\.closed_at IS NULL' AND pg_get_functiondef(p.oid) ~ 'FROM public\.table_seats ts[^;]*FOR SHARE') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_lightning_form_hand')
-- @live-proof: (SELECT count(*) >= 1 AND bool_and(s ~ 'WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation OR SQLSTATE ''PLT02''' AND s ~ 'formation_invariant_failed' AND s ~ '''stack_invariant_failed''' AND s ~ '''cluster_frozen''' AND s ~ 'SET cluster_mode = ''frozen''' AND s !~ 'ERRCODE = ''check_violation''' AND s ~ 'lightning_reservation_one_active_per_player' AND position('INTO v_money_after' in s) < position('OR SQLSTATE ''PLT02''' in s)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE n.nspname = 'public' AND p.proname = 'fn_lightning_form_hand')
-- @live-proof: (SELECT count(*) >= 1 AND bool_and(s ~ 'request_id_belongs_to_another_cluster' AND s ~ '''replayed'', true' AND s ~ 'lh\.request_id = p_request_id' AND s ~ '''hand_created''' AND s ~ '''participants''' AND s ~ '''pool_player_reserved''' AND s ~ '''instance_created''' AND s !~ 'lightning_hand_formed') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE n.nspname = 'public' AND p.proname = 'fn_lightning_form_hand')
-- @live-proof: (SELECT i.indisunique AND pg_get_indexdef(i.indexrelid) ~ '\(request_id\)' FROM pg_index i WHERE i.indexrelid = 'public.lightning_hand_one_per_request'::regclass) AND (SELECT a.atttypid = 'uuid'::regtype FROM pg_attribute a WHERE a.attrelid = 'public.lightning_hand'::regclass AND a.attname = 'request_id' AND NOT a.attisdropped)
-- @live-proof: (SELECT s ~ 'oh\.hand_id = OLD\.hand_id AND oh\.participants_locked_at IS NOT NULL' FROM (SELECT pg_get_functiondef('public.fn_lightning_hand_player_is_immutable()'::regprocedure) AS s) q) AND (SELECT s ~ 'NEW\.request_id IS DISTINCT FROM OLD\.request_id' FROM (SELECT pg_get_functiondef('public.fn_lightning_hand_is_immutable()'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'WHERE cg\.id = v_cluster FOR SHARE' AND s ~ 'participant_left_the_pool' AND s ~ 'IF i\.deadline_at <= v_now THEN' AND s !~ 'deadline_at <= p_now' AND s ~ '''instance_started''' AND s ~ 'fn_lightning_instance_abandon\(' AND position('FOR SHARE' in s) < position('WHERE li.id = p_instance_id FOR UPDATE' in s) FROM (SELECT pg_get_functiondef('public.fn_lightning_instance_begin_dealing(uuid,interval,timestamp with time zone)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'FOR UPDATE SKIP LOCKED' AND s ~ 'GREATEST\(p_now, sl\.opened_at\)' AND s ~ 'ca\.cluster_pass_deadline' AND position('FOR UPDATE SKIP LOCKED' in s) < position('UPDATE public.lightning_pool_slot' in s) FROM (SELECT pg_get_functiondef('public.fn_lightning_pool_slots_sync(uuid,timestamp with time zone)'::regprocedure) AS s) q)
-- @live-proof: (SELECT position('lightning_cluster_stands_down' in s) > 0 AND position('lightning_cluster_stands_down' in s) < position('WHERE id = p_game_id FOR UPDATE' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q) AND (SELECT pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure) ~ 'ca\.cluster_pass_deadline')
-- @live-proof: (SELECT s ~ 'EXCEPTION WHEN OTHERS THEN' AND s ~ 'lightning_pending_on_reap_failed' AND position('EXCEPTION WHEN OTHERS THEN' in s) < position('lightning_pending_on_reaped' in s) FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure) AS s) q)
-- @live-proof: (SELECT count(*) = 2 FROM pg_attribute a WHERE a.attrelid = 'public.cash_cluster_events'::regclass AND NOT a.attisdropped AND ((a.attname = 'event_version' AND a.attnotnull AND a.atttypid = 'smallint'::regtype) OR (a.attname = 'request_id' AND a.atttypid = 'uuid'::regtype)))
-- @live-proof: (SELECT (SELECT count(*) FROM regexp_matches(pg_get_functiondef('public.fn_cash_cluster_epoch_follows_its_game()'::regprocedure), '''cluster_epoch_started''', 'g')) >= 2) AND (SELECT s ~ '''instance_completed''' AND s ~ '''instance_destroyed''' AND s ~ '''pool_player_released''' FROM (SELECT pg_get_functiondef('public.fn_lightning_instance_releases_its_reservations()'::regprocedure) AS s) q) AND (SELECT pg_get_functiondef('public.fn_lightning_instance_open(uuid,smallint,smallint,interval,timestamp with time zone)'::regprocedure) ~ '''instance_created''')
-- @live-proof: (SELECT s ~ 'coalesce\(bl\.debt_since, sl\.opened_at\) ASC' AND s !~ 'bl\.updated_at' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q) AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_blind_ledger'::regclass AND t.tgname = 'trg_lightning_blind_ledger_tracks_debt_since' AND t.tgenabled = 'O' AND (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 4) <> 0 AND (t.tgtype::integer & 16) <> 0)
-- @live-proof: (SELECT NOT has_table_privilege('service_role', 'public.lightning_hand', 'DELETE') AND NOT has_table_privilege('service_role', 'public.lightning_hand_player', 'DELETE') AND NOT has_table_privilege('service_role', 'public.lightning_instance', 'DELETE') AND NOT has_table_privilege('service_role', 'public.lightning_reservation', 'DELETE') AND NOT has_table_privilege('service_role', 'public.lightning_pool_slot', 'DELETE') AND NOT has_table_privilege('service_role', 'public.lightning_pool_session', 'DELETE') AND NOT has_table_privilege('service_role', 'public.lightning_blind_ledger', 'DELETE') AND NOT has_table_privilege('service_role', 'public.cash_cluster_conversion', 'DELETE') AND NOT has_table_privilege('service_role', 'public.cash_cluster_conversion', 'TRUNCATE'))
-- @live-proof: (SELECT count(*) = 3 FROM public.ca_declared_money_triggers d WHERE d.table_name = 'table_seats' AND d.trigger_name IN ('trg_table_seats_lightning_anchor_guard', 'trg_table_seats_lightning_pool_on_insert', 'trg_table_seats_lightning_pool_follows_seat'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_table_observe_dealing_halt', 'fn_lightning_anchor_is_live_eligible', 'fn_lightning_pool_stack', 'fn_lightning_player_in_hand', 'fn_lightning_pool_enter', 'fn_lightning_blind_ledger_debt_since', 'fn_table_seats_lightning_anchor_guard', 'fn_table_seats_lightning_pool_follows_seat', 'fn_lightning_form_hand') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse'))

BEGIN;

-- THE DDL DOES NOT QUEUE BEHIND THE ENGINE. Eight seconds, then a clean
-- refusal that changed nothing, to be re-run once and never in a loop. The
-- hot tables - table_seats, tables and cash_cluster_events - are touched only
-- in SECTION 9, the last thing before COMMIT, under a tighter wait, so the
-- locks their DDL takes are held for milliseconds rather than for the length
-- of this file.
SET LOCAL lock_timeout = '8s';

-- ===========================================================================
-- SECTION 1. THE COLD COLUMNS. Every table here is empty in production and
-- read by nothing outside the Lightning functions. ONE ADD COLUMN PER ALTER.
-- ===========================================================================

-- DEFECT 2: THE SEAT IS THE ANCHOR. Nullable at birth only so that a pool
-- session written before this file can be anchored honestly before NOT NULL
-- goes on; the foreign key to table_seats is added in SECTION 9 with the other
-- hot-table DDL, because REFERENCES takes SHARE ROW EXCLUSIVE on table_seats.
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS anchor_seat_id uuid;

-- DEFECT 11: formation idempotency, the conversion's two chip totals, and the
-- age of a blind debt.
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.cash_cluster_conversion ADD COLUMN IF NOT EXISTS chips_at_begin numeric(14,2);
ALTER TABLE public.cash_cluster_conversion ADD COLUMN IF NOT EXISTS chips_at_commit numeric(14,2);
ALTER TABLE public.lightning_blind_ledger ADD COLUMN IF NOT EXISTS debt_since timestamptz;

-- A POOL SESSION WRITTEN BEFORE THIS FILE IS ANCHORED TO THE SEAT THE
-- CONVERSION WOULD HAVE PICKED: the player's own seat in the Cluster, a live
-- eligible one first, then the earliest joined, then the lowest id - the
-- conversion's own DISTINCT ON order. Production holds no pool session, so
-- this matches nothing there; an estate that does gets the truth, and a
-- session with no seat anywhere in its Cluster is refused BY NAME rather than
-- by the generic NOT NULL message, because nothing here will invent one.
UPDATE public.lightning_pool_session ps
   SET anchor_seat_id = (
     SELECT ts.id
       FROM public.table_seats ts
       JOIN public.tables tb ON tb.id = ts.table_id
      WHERE tb.cluster_id = ps.cluster_id AND ts.user_id = ps.player_id
      ORDER BY (ts.left_at IS NULL AND coalesce(tb.is_deleted, false) = false
                AND coalesce(tb.lifecycle, '') <> 'closed'
                AND coalesce(ts.is_sitting_out, false) = false
                AND coalesce(ts.leave_pending, false) = false
                AND coalesce(ts.stack, 0) > 0) DESC,
               ts.joined_at, ts.id
      LIMIT 1)
 WHERE ps.anchor_seat_id IS NULL;

DO $anchor$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.anchor_seat_id IS NULL) THEN
    RAISE EXCEPTION 'LIGHTNING_POOL_SESSION_HAS_NO_SEAT: % pool session(s) belong to a player with no seat anywhere in their Cluster, and this file will not invent an anchor; close them deliberately and apply again',
      (SELECT count(*) FROM public.lightning_pool_session ps WHERE ps.anchor_seat_id IS NULL);
  END IF;
END
$anchor$;

ALTER TABLE public.lightning_pool_session ALTER COLUMN anchor_seat_id SET NOT NULL;

-- ONE OPEN POOL SESSION PER ANCHOR SEAT, and the index-probe fast path of the
-- anchor guard in SECTION 9: a stack update on an ordinary seat asks this
-- partial index one question and gets no row. The plain index serves the
-- foreign key, so that a DELETE of a seat never scans this table.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_pool_session_one_open_per_anchor
  ON public.lightning_pool_session (anchor_seat_id) WHERE exited_at IS NULL;
CREATE INDEX IF NOT EXISTS lightning_pool_session_by_anchor_seat
  ON public.lightning_pool_session (anchor_seat_id);

-- ONE HAND PER FORMATION REQUEST. A plain unique index: NULL request ids never
-- collide, so a caller that does not supply one is not constrained by it.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_hand_one_per_request
  ON public.lightning_hand (request_id);

COMMENT ON COLUMN public.lightning_pool_session.anchor_seat_id IS
  'The table_seats row this pool session is the overlay of. The seat is the economic anchor: fn_lightning_pool_stack reads its stack, trg_table_seats_lightning_anchor_guard refuses to change it while its player is in a Lightning hand, and when its left_at is set the session is exited and its slot closed. Written by fn_cash_cluster_commit_lightning (the seat its DISTINCT ON picked) and by fn_lightning_pool_enter. At most one open session per anchor (lightning_pool_session_one_open_per_anchor).';
COMMENT ON COLUMN public.lightning_hand.request_id IS
  'The p_request_id fn_lightning_form_hand was called with, unique across hands (lightning_hand_one_per_request), so a retried formation answers with the hand it already formed instead of forming a second one. NULL when the caller supplied none. Immutable from birth.';
COMMENT ON COLUMN public.cash_cluster_conversion.chips_at_begin IS
  'Forensics: the sum of table_seats.stack over the Cluster''s seated rows at fn_cash_cluster_begin_pending_on, the instant its tables were halted.';
COMMENT ON COLUMN public.cash_cluster_conversion.chips_at_commit IS
  'Forensics: the same sum at fn_cash_cluster_commit_lightning, which asserts it did not change during its own transaction. A difference from chips_at_begin is money that moved while the Cluster was PENDING_ON: hands finishing, buy-ins and cash-outs, each of which is legal.';
COMMENT ON COLUMN public.lightning_blind_ledger.debt_since IS
  'When this player''s blind obligation (missed_bb_debt, missed_sb_debt, bb_owed or sb_owed) FIRST became unresolved; NULL while nothing is owed. Kept by trg_lightning_blind_ledger_tracks_debt_since on every write, and read by fn_lightning_blind_order as the P2 oldest-blind-debt-age tie-break.';

-- ===========================================================================
-- SECTION 2. THE NEW FUNCTIONS. None is SECURITY DEFINER except the two
-- table_seats trigger functions, which must see lightning rows through row
-- level security whoever writes the seat; none mentions a horse (Law 10.5).
-- ===========================================================================

-- DEFECT 1: THE ENGINE SAYS IT HAS STOPPED. Called by the engine when its
-- table is parked at the halt gate between hands. It stamps
-- dealing_halt_observed_at only when the table is halted and the halt has not
-- already been observed, so an engine that calls it on every pass of its park
-- loop writes the row once per halt rather than once per pass; it returns the
-- stamp that stands, or NULL when the table is not halted.
CREATE OR REPLACE FUNCTION public.fn_cash_table_observe_dealing_halt(p_table_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_halted   timestamptz;
  v_observed timestamptz;
BEGIN
  SELECT t.dealing_halted_at, t.dealing_halt_observed_at
    INTO v_halted, v_observed
    FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_halted IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_observed IS NOT NULL AND v_observed >= v_halted THEN
    RETURN v_observed;
  END IF;
  -- The halt is re-read by the UPDATE itself: a halt lifted between the read
  -- above and this write stamps nothing and answers NULL.
  UPDATE public.tables t
     SET dealing_halt_observed_at = clock_timestamp()
   WHERE t.id = p_table_id AND t.dealing_halted_at IS NOT NULL
  RETURNING t.dealing_halt_observed_at INTO v_observed;
  RETURN v_observed;
END
$fn$;

-- DEFECT 3: ONE SEATED-ELIGIBILITY PREDICATE FOR THE POOL. This is the seated
-- half of fn_cash_cluster_live_eligible, word for word, asked of ONE seat
-- rather than counted over a Cluster. It is not a call to that function
-- because that function returns a COUNT over the UNION of the seated half and
-- the pool half: asked about a pool member it would count the pool session
-- itself, which is the question being answered. The harness proves the two
-- agree on every seat shape that decides eligibility. is_away takes no part,
-- exactly as it takes none in the population.
CREATE OR REPLACE FUNCTION public.fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE ts.id = p_seat_id
       AND tb.cluster_id = p_cluster_id AND coalesce(tb.is_deleted, false) = false
       AND coalesce(tb.lifecycle, '') <> 'closed'
       AND ts.left_at IS NULL
       AND ts.user_id IS NOT NULL
       AND (p_player_id IS NULL OR ts.user_id = p_player_id)
       AND coalesce(ts.is_sitting_out, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0);
$fn$;

-- DEFECT 3: ONE COPY OF THE STACK. The pool's stack IS the anchor seat's
-- stack. starting_stack stays the snapshot the conversion or the entry took,
-- and net_result stays a statistic; neither is money any more. A seat that has
-- left, or has turned over to somebody else, backs no stack at all.
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_stack(p_pool_session_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE WHEN ts.id IS NULL
                OR ts.left_at IS NOT NULL
                OR ts.user_id IS DISTINCT FROM s.player_id THEN 0::numeric
              ELSE round(coalesce(ts.stack, 0), 2) END
    FROM public.lightning_pool_session s
    LEFT JOIN public.table_seats ts ON ts.id = s.anchor_seat_id
   WHERE s.id = p_pool_session_id;
$fn$;

-- DEFECT 4: IS THIS PLAYER IN A LIVE LIGHTNING HAND. A committed reservation
-- on an instance that has not reached complete or abandoned - the same claim
-- lightning_reservation_one_active_per_player turns into a bar on matching,
-- read through that index.
CREATE OR REPLACE FUNCTION public.fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.lightning_reservation r
      JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
     WHERE r.cluster_id = p_cluster_id
       AND r.player_id = p_player_id
       AND r.state = 'committed'
       AND i.state IN ('forming', 'reserved', 'dealing', 'settling'));
$fn$;

-- DEFECT 2: THE POOL'S DOOR AFTER THE CONVERSION. A seat that is live
-- eligible, at a table of a Cluster in cluster_mode 'lightning', enters the
-- pool at the Cluster's current epoch anchored to that seat, with the seat's
-- stack as its snapshot, under the cash session the player already has - the
-- conversion's own subordination rule and its own question for finding it.
-- A player who already has an open pool session in the Cluster keeps it: the
-- answer is that session, and only its slot is made sure of. Returns the pool
-- session id, or NULL when the seat is not one that belongs in the pool.
--
-- NO LOCK ON THE CLUSTER ROW. This is called from table_seats triggers, which
-- already hold the seat, and formation takes the Cluster row and then the
-- anchor seats; a Cluster lock taken here would close that cycle. The mode and
-- the epoch come from one read of one row, which the conversion writes in one
-- statement, and a racing entry for the same player is decided by
-- lightning_pool_session_one_open, whose violation is answered with the
-- session that won.
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  s     record;
  g     record;
  v_ps  uuid;
  v_cps uuid;
  v_now timestamptz := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
BEGIN
  SELECT ts.id, ts.user_id, ts.table_id, ts.stack, tb.cluster_id
    INTO s
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.id = p_seat_id;
  IF NOT FOUND OR s.cluster_id IS NULL OR s.user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT cg.id, cg.cluster_mode, cg.lightning_enabled, cg.cluster_epoch
    INTO g FROM public.cash_games cg WHERE cg.id = s.cluster_id;
  IF NOT FOUND OR g.cluster_mode IS DISTINCT FROM 'lightning'
     OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN NULL;
  END IF;

  IF NOT public.fn_lightning_anchor_is_live_eligible(s.id, g.id, s.user_id) THEN
    RETURN NULL;
  END IF;

  SELECT ps.id INTO v_ps
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.player_id = s.user_id AND ps.exited_at IS NULL;
  IF v_ps IS NOT NULL THEN
    PERFORM public.fn_lightning_pool_slot_open(v_ps, v_now);
    RETURN v_ps;
  END IF;

  SELECT cps.id INTO v_cps
    FROM public.cash_player_session cps
   WHERE cps.player_id = s.user_id AND cps.closed_at IS NULL
     AND (cps.cluster_id = g.id
          OR cps.scope_id IN (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id)
          OR cps.table_id IN (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id))
   ORDER BY coalesce(cps.cluster_id = g.id, false) DESC, cps.opened_at DESC, cps.id
   LIMIT 1;
  IF v_cps IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    INSERT INTO public.lightning_pool_session
      (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, entered_at,
       starting_stack, anchor_seat_id)
    VALUES (g.id, g.cluster_epoch, s.user_id, v_cps, 'active', v_now, s.stack, s.id)
    RETURNING id INTO v_ps;
  EXCEPTION WHEN unique_violation THEN
    SELECT ps.id INTO v_ps
      FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = g.id AND ps.player_id = s.user_id AND ps.exited_at IS NULL;
    RETURN v_ps;
  END;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
  VALUES (g.id, s.table_id, 'pool_player_joined', jsonb_build_object(
    'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch, 'player_id', s.user_id,
    'pool_session_id', v_ps, 'anchor_seat_id', s.id, 'starting_stack', s.stack,
    'cash_player_session_id', v_cps, 'via', 'fn_lightning_pool_enter', 'at', v_now), g.cluster_epoch);

  PERFORM public.fn_lightning_pool_slot_open(v_ps, v_now);
  RETURN v_ps;
END
$fn$;

-- DEFECT 11: THE AGE OF A BLIND DEBT. A BEFORE trigger rather than a line in a
-- writer, because the writers of these four columns are the settlement phase
-- nobody has written yet: whoever writes them, debt_since is set the moment an
-- obligation first becomes unresolved, kept while it stays unresolved, and
-- cleared when it is resolved.
CREATE OR REPLACE FUNCTION public.fn_lightning_blind_ledger_debt_since()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF coalesce(NEW.missed_bb_debt, 0) > 0 OR coalesce(NEW.missed_sb_debt, 0) > 0
     OR coalesce(NEW.bb_owed, 0) > 0 OR coalesce(NEW.sb_owed, 0) > 0 THEN
    IF TG_OP = 'UPDATE' AND OLD.debt_since IS NOT NULL THEN
      NEW.debt_since := OLD.debt_since;
    ELSE
      NEW.debt_since := coalesce(NEW.debt_since, clock_timestamp());
    END IF;
  ELSE
    NEW.debt_since := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

-- DEFECT 4: THE ANCHOR STACK MOVES ONLY BY LIGHTNING SETTLEMENT WHILE ITS
-- PLAYER IS IN A LIGHTNING HAND. BEFORE UPDATE, fired only when the stack, the
-- departure or the occupant changes (the trigger's WHEN clause). The first
-- statement is an index probe of lightning_pool_session_one_open_per_anchor,
-- and for every seat that anchors no open pool session - every seat in the
-- estate today - it is the only statement. SECURITY DEFINER because the rows
-- it must see sit behind row level security, and a writer that cannot see
-- them must not pass for that reason.
CREATE OR REPLACE FUNCTION public.fn_table_seats_lightning_anchor_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ps     uuid;
  v_player uuid;
  v_cluster uuid;
  v_hand   uuid;
BEGIN
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
$fn$;

-- DEFECT 2: THE POOL FOLLOWS THE SEAT. Fired DEFERRED, at commit, by two
-- constraint triggers whose WHEN clauses admit only a change that can move a
-- seat into or out of the pool: an arrival, a departure, a turnover, a sit-out
-- or sit-in, a leave request or its withdrawal, and a stack crossing zero.
-- Deferred because a buy-in inserts the seat BEFORE it opens the cash session
-- the pool session must be subordinate to (atomic_table_buyin_... and the horse
-- seat path both do), and a revive updates the seat before it does the same;
-- at commit both exist.
--
-- A departing or turned-over anchor exits its pool session, closes its slot and
-- records pool_player_left; a player still seated elsewhere in the Cluster is
-- entered again through that seat. A seat that is eligible now, at a table of
-- a lightning Cluster, enters the pool through fn_lightning_pool_enter, which
-- answers with the session the player already has when there is one.
CREATE OR REPLACE FUNCTION public.fn_table_seats_lightning_pool_follows_seat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
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
$fn$;

COMMENT ON FUNCTION public.fn_cash_table_observe_dealing_halt(uuid) IS
  'Called by the engine when its table is parked at the halt gate between hands. Stamps tables.dealing_halt_observed_at with clock_timestamp() if and only if the table is halted and this halt has not already been observed, and returns the stamp that stands (NULL when not halted). fn_cash_cluster_commit_lightning refuses (halt_not_observed) until every member table holding a live engine lease has dealing_halt_observed_at >= dealing_halted_at.';
COMMENT ON FUNCTION public.fn_lightning_anchor_is_live_eligible(uuid, uuid, uuid) IS
  'The seated half of fn_cash_cluster_live_eligible asked of one seat: on a live, undeleted table of the Cluster, not left, occupied (by p_player_id when given), not sitting out, not leave_pending, stack > 0. The pool entry, the formation candidate filter and begin_dealing all ask this; the harness proves it agrees with the population.';
COMMENT ON FUNCTION public.fn_lightning_pool_stack(uuid) IS
  'The stack of a pool session is the stack of its anchor seat: table_seats.stack, or 0 once the anchor has left or turned over. starting_stack is a snapshot and net_result a statistic; neither is read here. Formation snapshots this into lightning_hand_player.stack_before under a FOR SHARE lock on the anchor seat.';
COMMENT ON FUNCTION public.fn_lightning_player_in_hand(uuid, uuid) IS
  'True if and only if the player holds a committed reservation in the Cluster on an instance in forming, reserved, dealing or settling. The anchor guard refuses any change to that player''s anchor stack, departure or occupant while this is true, except by the settlement of that hand.';
COMMENT ON FUNCTION public.fn_lightning_pool_enter(uuid, timestamp with time zone) IS
  'Enters the player on an eligible seat of a lightning-mode Cluster into its pool at the current epoch: a pool session anchored to that seat (starting_stack = the seat stack, under the player''s existing open cash session) and its slot, recording pool_player_joined. Returns the player''s existing open pool session instead when there is one. NULL when the seat does not belong in the pool. Fired from the table_seats constraint triggers and callable by service_role.';
COMMENT ON FUNCTION public.fn_lightning_blind_ledger_debt_since() IS
  'BEFORE INSERT OR UPDATE on lightning_blind_ledger: debt_since is set when an obligation first becomes unresolved, kept while it stays so, and cleared when it is resolved.';
COMMENT ON FUNCTION public.fn_table_seats_lightning_anchor_guard() IS
  'BEFORE UPDATE on table_seats, only when stack, left_at or user_id changes: refuses with LIGHTNING_HAND_IN_PROGRESS (SQLSTATE PLT01) a change to a seat that anchors an open pool session whose player is in a live Lightning hand, unless ca.lightning_settlement_hand names that hand. One index probe for every other seat.';
COMMENT ON FUNCTION public.fn_table_seats_lightning_pool_follows_seat() IS
  'Deferred AFTER INSERT and AFTER UPDATE on table_seats: exits the pool session (and closes the slot) of an anchor that left or turned over, re-entering a player still seated elsewhere in the Cluster, and enters an eligible seat of a lightning-mode Cluster into the pool through fn_lightning_pool_enter.';

-- ===========================================================================
-- SECTION 3. THE FORMATION BARRIER (DEFECTS 3, 7, 10 AND 11). ASSERTED
-- SUBSTITUTION INTO fn_lightning_form_hand, ONTO A NEW SIGNATURE.
-- ===========================================================================
--
-- The shape every re-cut in this file has, spelled out once. The installed
-- body is read from the catalogue - never from a file - and each anchor is
-- counted in the text AS IT STANDS AT THAT MOMENT, so an anchor an earlier
-- replacement duplicated is caught too. c[k] is how many times anchor k must
-- occur (one, except where the barrier genuinely repeats a line), or nothing
-- is substituted. The result is EXECUTEd, read BACK from the catalogue and
-- asserted to carry the new behaviour and every sibling it was written next
-- to. A body that already carries the new behaviour is left alone, so a
-- second application changes nothing.
--
-- The barrier gains p_request_id, so its signature changes: the substituted
-- text is created as the ten-argument overload and the nine-argument one is
-- dropped in this same transaction, with its grants and comment carried over.

DO $recut_form_hand$
DECLARE
  v_old  constant text := 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)';
  v_new_sig constant text := 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid)';
  v_src  text;
  v_new  text;
  v_live text;
  v_cmt  text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
-- 1. the signature
$a$p_matcher_version text DEFAULT NULL::text)
 RETURNS jsonb$a$,
-- 2. the declarations
$a$  v_ttl       interval := GREATEST($a$,
-- 3. the replay, after the matcher_version refusal
$a$    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'matcher_version_required');
  END IF;$a$,
-- 4. the barrier's own version names the signature it is
$a$'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)'::regprocedure$a$,
-- 5. the anchor seats, locked FOR SHARE before the slots
$a$  -- BARRIER STEP 1, AND THE LOCK THAT MAKES IT MEAN SOMETHING.$a$,
-- 6. the candidate filter
$a$       AND ps.exited_at IS NULL AND ps.state = 'active'
       AND public.fn_lightning_pool_stack(ps.id) > 0$a$,
-- 7. the money guard OUTSIDE the atomic block, removed: it moves inside
$a$  -- F12'S SHAPE, ONE PHASE ON. The conversion asserts no chips moved when a
  -- Cluster becomes a pool; this asserts no chips moved when a hand is formed
  -- out of it. It is uncaught on purpose: money moving during formation is not
  -- a thing to retry.
  SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                    || ':' || coalesce(ps.net_result::text, 'null')
                    || ':' || coalesce(ps.ending_stack::text, 'null')
                    || ':' || coalesce(ps.exited_at::text, 'open'), '|' ORDER BY ps.id)
    INTO v_money_after
    FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);
  IF v_money_after IS DISTINCT FROM v_money_before THEN
    RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY: the pool sessions of the % participants of hand % in Cluster % were rewritten while it was formed (% became %), and forming a hand is a seating transition, not an economic transaction',
      v_n, v_hand, g.id, v_money_before, v_money_after USING ERRCODE = 'check_violation';
  END IF;
$a$,
-- 8. the money snapshot BEFORE now also reads the anchor seat
$a$                    || ':' || coalesce(ps.exited_at::text, 'open'), '|' ORDER BY ps.id)
    INTO v_money_before$a$,
-- 9. the hand carries its request
$a$       rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version)$a$,
$a$            v_rules_version, btrim(p_matcher_version), v_blind_version, v_lightning_version, v_rake_version);$a$,
-- 11-14. the re-checks are impossible states, not races
$a$    -- THE BARRIER'S OWN PRE-COMMIT RE-CHECKS, raised as check_violation so
    -- that they land in this block's own handler and take the whole formation
    -- with them rather than leaving a half-formed hand behind.$a$,
$a$        v_hand, v_n, (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand)
        USING ERRCODE = 'check_violation';$a$,
$a$                  WHERE r.lightning_instance_id = v_instance AND r.state = 'committed'), v_n
        USING ERRCODE = 'check_violation';$a$,
$a$'LIGHTNING_FORMATION_SET_IS_WRONG: hand % does not have exactly one big blind, one small blind and one button',
        v_hand USING ERRCODE = 'check_violation';$a$,
$a$'LIGHTNING_FORMATION_SET_IS_WRONG: hand % seated a player with no stack to post from',
        v_hand USING ERRCODE = 'check_violation';
    END IF;
$a$,
-- 16. the handler's class list gains the invariant class, at the end of
-- its first line, so the list the earlier files pinned still reads as it did
$a$    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation
$a$,
-- 17. and splits the invariant path from the retry path
$a$      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      -- Everything above is now rolled back. This INSERT is in the OUTER$a$,
-- 18. the success events
$a$  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (g.id, 'lightning_hand_formed', jsonb_build_object(
    'hand_id', v_hand, 'instance_id', v_instance, 'players', v_n,
    'target_size', v_target, 'max_size', v_max,
    'bb', v_bb, 'sb', v_sb, 'btn', v_btn, 'matcher_version', btrim(p_matcher_version),
    'at', p_now), v_epoch);$a$,
-- 19-22. every remaining event carries the request
$a$  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
$a$,
$a$      'legal', v_n, 'target_size', v_target, 'at', p_now), v_epoch);$a$,
$a$        'players', v_n, 'target_size', v_target, 'at', p_now), v_epoch);$a$,
$a$        'at', p_now), coalesce(v_epoch, 0));$a$,
-- 23. and the answer names it
$a$                            'seats', v_seats, 'state', 'reserved');$a$];
  c      integer[] := ARRAY[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1];
  b      text[] := ARRAY[
-- 1
$b$p_matcher_version text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb$b$,
-- 2
$b$  -- 2026-09-26: the replayed hand, the constraint a refusal names, and
  -- nothing else.
  v_replay    record;
  v_constraint text;
  v_ttl       interval := GREATEST($b$,
-- 3
$b$    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'matcher_version_required');
  END IF;

  -- A RETRY IS ANSWERED WITH THE HAND IT ALREADY FORMED (2026-09-26). A
  -- matcher that lost the answer to a formation - a timeout, a dropped
  -- connection - retries with the same p_request_id and is told what happened
  -- instead of forming a second hand out of the same players. Answered before
  -- the freeze, because reading what already happened is not forming a hand;
  -- two racing calls with one request id are decided by
  -- lightning_hand_one_per_request, whose violation is a retry, and the retry
  -- lands here.
  IF p_request_id IS NOT NULL THEN
    SELECT lh.hand_id, lh.cluster_id, lh.cluster_epoch, lh.lightning_instance_id, lh.player_count
      INTO v_replay FROM public.lightning_hand lh WHERE lh.request_id = p_request_id;
    IF FOUND THEN
      IF v_replay.cluster_id IS DISTINCT FROM p_cluster_id THEN
        RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                                  'reason', 'request_id_belongs_to_another_cluster',
                                  'request_id', p_request_id);
      END IF;
      RETURN jsonb_build_object('ok', true, 'formed', true, 'retry', false, 'replayed', true,
        'hand_id', v_replay.hand_id, 'instance_id', v_replay.lightning_instance_id,
        'cluster_id', v_replay.cluster_id, 'cluster_epoch', v_replay.cluster_epoch,
        'players', v_replay.player_count,
        'bb', (SELECT hp.player_id FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_replay.hand_id AND hp.blind_role = 'bb'),
        'sb', (SELECT hp.player_id FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_replay.hand_id AND hp.blind_role = 'sb'),
        'btn', (SELECT hp.player_id FROM public.lightning_hand_player hp
                 WHERE hp.hand_id = v_replay.hand_id AND hp."position" = 'btn'),
        'seats', (SELECT jsonb_agg(jsonb_build_object(
                           'player_id', hp.player_id, 'pool_slot_id', hp.pool_slot_id,
                           'pool_session_id', sl.pool_session_id, 'stack_before', hp.stack_before,
                           'seat', hp.seat, 'position', hp."position", 'blind_role', hp.blind_role)
                         ORDER BY hp.seat)
                    FROM public.lightning_hand_player hp
                    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
                   WHERE hp.hand_id = v_replay.hand_id),
        'state', (SELECT li.state FROM public.lightning_instance li
                   WHERE li.id = v_replay.lightning_instance_id),
        'request_id', p_request_id);
    END IF;
  END IF;$b$,
-- 4
$b$'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid)'::regprocedure$b$,
-- 5
$b$  -- THE ANCHOR SEATS, FOR SHARE, FIRST (2026-09-26). The seat is the economic
  -- anchor and fn_lightning_pool_stack reads it, so from here to commit
  -- nothing may change a candidate's seat stack, departure or occupant - and
  -- they are taken BEFORE the slots and the pool sessions, because the
  -- deferred table_seats trigger that exits a departing anchor holds that seat
  -- and then writes its session and slot: a formation that already held those
  -- and waited on the seat would close the cycle. In seat id order, so two
  -- matchers queue rather than deadlock.
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.id IN (SELECT ps.anchor_seat_id
                     FROM public.lightning_pool_slot sl
                     JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
                    WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
                      AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand))
   ORDER BY ts.id
   FOR SHARE;

  -- BARRIER STEP 1, AND THE LOCK THAT MAKES IT MEAN SOMETHING.$b$,
-- 6
$b$       AND ps.exited_at IS NULL AND ps.state = 'active'
       AND public.fn_lightning_pool_stack(ps.id) > 0
       -- THE SAME QUESTION THE POPULATION ASKS (2026-09-26): the anchor seat is
       -- live eligible - not left, not sitting out, not leaving, chips on it,
       -- at a live table of this Cluster, held by this player - and the cash
       -- session the pool session is subordinate to is still open.
       AND public.fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, g.id, ps.player_id)
       AND EXISTS (SELECT 1 FROM public.cash_player_session cps
                    WHERE cps.id = ps.cash_player_session_id AND cps.closed_at IS NULL)$b$,
-- 7
$b$  -- F12'S SHAPE, ONE PHASE ON, is measured INSIDE the atomic block since
  -- 2026-09-26, so that money moving during a formation is caught as the
  -- impossible state it is: rolled back, the Cluster frozen and the evidence
  -- written, rather than an uncaught error that leaves no row saying why.
$b$,
-- 8
$b$                    || ':' || coalesce(ps.exited_at::text, 'open')
                    || ':' || coalesce((SELECT ts.stack::text || '@' || coalesce(ts.left_at::text, 'seated')
                                          || '@' || coalesce(ts.user_id::text, 'empty')
                                          FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id), 'no_anchor'),
                    '|' ORDER BY ps.id)
    INTO v_money_before$b$,
-- 9
$b$       rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version,
       request_id)$b$,
$b$            v_rules_version, btrim(p_matcher_version), v_blind_version, v_lightning_version, v_rake_version,
            p_request_id);$b$,
-- 11
$b$    -- THE BARRIER'S OWN PRE-COMMIT RE-CHECKS. Each is a state the locks above
    -- make impossible, so each raises PLT02, LIGHTNING_FORMATION_INVARIANT
    -- (2026-09-26), which the handler below does NOT retry: it rolls the block
    -- back, freezes the Cluster and writes the evidence.$b$,
$b$        v_hand, v_n, (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand)
        USING ERRCODE = 'PLT02';$b$,
$b$                  WHERE r.lightning_instance_id = v_instance AND r.state = 'committed'), v_n
        USING ERRCODE = 'PLT02';$b$,
$b$'LIGHTNING_FORMATION_SET_IS_WRONG: hand % does not have exactly one big blind, one small blind and one button',
        v_hand USING ERRCODE = 'PLT02';$b$,
$b$'LIGHTNING_FORMATION_SET_IS_WRONG: hand % seated a player with no stack to post from',
        v_hand USING ERRCODE = 'PLT02';
    END IF;

    -- F12'S SHAPE, ONE PHASE ON (moved inside the block 2026-09-26). Every
    -- money column of every participant's pool session AND its anchor seat,
    -- which are held FOR SHARE, compared with the snapshot taken before the
    -- first write.
    SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                      || ':' || coalesce(ps.net_result::text, 'null')
                      || ':' || coalesce(ps.ending_stack::text, 'null')
                      || ':' || coalesce(ps.exited_at::text, 'open')
                      || ':' || coalesce((SELECT ts.stack::text || '@' || coalesce(ts.left_at::text, 'seated')
                                            || '@' || coalesce(ts.user_id::text, 'empty')
                                            FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id), 'no_anchor'),
                      '|' ORDER BY ps.id)
      INTO v_money_after
      FROM public.lightning_pool_session ps
     WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);
    IF v_money_after IS DISTINCT FROM v_money_before THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY: the pool sessions or anchor seats of the % participants of hand % in Cluster % were rewritten while it was formed (% became %), and forming a hand is a seating transition, not an economic transaction',
        v_n, v_hand, g.id, v_money_before, v_money_after USING ERRCODE = 'PLT02';
    END IF;
$b$,
-- 16
$b$    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation OR SQLSTATE 'PLT02'
$b$,
-- 17
$b$      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_constraint = CONSTRAINT_NAME;
      -- ONLY A RACE IS RETRIED (2026-09-26). A lock timeout, a deadlock victim,
      -- a serialization failure, and a unique violation on one of the indexes
      -- two matchers can genuinely race for, are what specification 732-733
      -- means by "retry where safe". Everything else that lands here - the
      -- barrier's own PLT02 re-checks, the immutability and discipline
      -- triggers, a CHECK, a foreign key, a unique index nobody races for - is
      -- a state the locks this function holds make impossible. Retrying it
      -- would form the same wrong hand again, so it is not retried: the block
      -- is already rolled back, the Cluster is frozen through its own
      -- cluster_mode (the row is held FOR UPDATE since the start, and every
      -- formation, opening and deal refuses a Cluster that is not lightning),
      -- and the evidence is written in the two events an operator will look
      -- for.
      IF NOT (v_sqlstate IN ('55P03', '40P01', '40001')
              OR (v_sqlstate = '23505' AND v_constraint IN (
                    'lightning_reservation_one_active_per_player',
                    'lightning_reservation_one_pending_per_slot',
                    'lightning_reservation_one_seat_per_instance',
                    'lightning_reservation_one_seat_per_player_instance',
                    'lightning_pool_slot_one_open',
                    'lightning_pool_slot_one_open_per_player',
                    'lightning_hand_one_per_request'))) THEN
        UPDATE public.cash_games cg
           SET cluster_mode = 'frozen', updated_at = now()
         WHERE cg.id = g.id AND cg.cluster_mode = 'lightning';
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
        VALUES
          (g.id, 'stack_invariant_failed', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', v_epoch,
             'hand_id', v_hand, 'instance_id', v_instance,
             'sqlstate', v_sqlstate, 'message', v_msg, 'constraint', v_constraint,
             'players', (SELECT jsonb_agg(x -> 'player_id' ORDER BY (x ->> 'seat')::integer)
                           FROM jsonb_array_elements(v_seats) x),
             'seats', v_seats, 'money_before', v_money_before, 'money_after', v_money_after,
             'matcher_version', btrim(p_matcher_version), 'at', p_now), v_epoch, p_request_id),
          (g.id, 'cluster_frozen', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', v_epoch, 'from_mode', 'lightning', 'to_mode', 'frozen',
             'reason', 'stack_invariant_failed', 'sqlstate', v_sqlstate, 'message', v_msg,
             'hand_id', v_hand, 'instance_id', v_instance, 'at', clock_timestamp()), v_epoch, p_request_id);
        RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false, 'frozen', true,
                                  'reason', 'formation_invariant_failed',
                                  'sqlstate', v_sqlstate, 'message', v_msg, 'constraint', v_constraint,
                                  'cluster_id', g.id, 'cluster_epoch', v_epoch);
      END IF;
      -- Everything above is now rolled back. This INSERT is in the OUTER$b$,
-- 18
$b$  -- THE EVENTS OF A FORMED HAND (2026-09-26): the instance that was created,
  -- ONE reservation event carrying every player it holds, and the hand with
  -- every participant's seat, position and blind role. hand_created replaces
  -- the kind 20260925215731 wrote here, which nothing outside the Phase 9
  -- harness read.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES
    (g.id, 'instance_created', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'instance_id', v_instance, 'hand_id', v_hand,
       'target_size', v_target, 'max_size', v_max, 'via', 'fn_lightning_form_hand', 'at', p_now),
     v_epoch, p_request_id),
    (g.id, 'pool_player_reserved', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'instance_id', v_instance, 'hand_id', v_hand,
       'players', (SELECT jsonb_agg(x -> 'player_id' ORDER BY (x ->> 'seat')::integer)
                     FROM jsonb_array_elements(v_seats) x),
       'at', p_now), v_epoch, p_request_id),
    (g.id, 'hand_created', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'hand_id', v_hand, 'instance_id', v_instance,
       'players', v_n, 'target_size', v_target, 'max_size', v_max,
       'bb', v_bb, 'sb', v_sb, 'btn', v_btn,
       'participants', (SELECT jsonb_agg(jsonb_build_object(
                                 'player_id', x -> 'player_id', 'seat', x -> 'seat',
                                 'position', x -> 'position', 'blind_role', x -> 'blind_role',
                                 'stack_before', x -> 'stack_before')
                               ORDER BY (x ->> 'seat')::integer)
                          FROM jsonb_array_elements(v_seats) x),
       'matcher_version', btrim(p_matcher_version), 'at', p_now), v_epoch, p_request_id);$b$,
-- 19
$b$  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
$b$,
$b$      'legal', v_n, 'target_size', v_target, 'at', p_now), v_epoch, p_request_id);$b$,
$b$        'players', v_n, 'target_size', v_target, 'at', p_now), v_epoch, p_request_id);$b$,
$b$        'at', p_now), coalesce(v_epoch, 0), p_request_id);$b$,
-- 23
$b$                            'seats', v_seats, 'state', 'reserved', 'request_id', p_request_id);$b$];
BEGIN
  IF to_regprocedure(v_new_sig) IS NOT NULL
     AND pg_get_functiondef(to_regprocedure(v_new_sig)) ~ 'formation_invariant_failed' THEN
    RAISE NOTICE 'fn_lightning_form_hand already takes p_request_id and freezes on an invariant; leaving it alone';
  ELSE
    IF to_regprocedure(v_old) IS NULL THEN
      RAISE EXCEPTION 'fn_lightning_form_hand has neither the nine-argument signature this file re-cuts nor the ten-argument one it produces';
    END IF;
    v_src := pg_get_functiondef(to_regprocedure(v_old));
    v_cmt := obj_description(to_regprocedure(v_old), 'pg_proc');
    v_new := v_src;
    IF array_length(a, 1) IS DISTINCT FROM array_length(b, 1) OR array_length(a, 1) IS DISTINCT FROM array_length(c, 1) THEN
      RAISE EXCEPTION 'the anchor, replacement and count lists of the fn_lightning_form_hand re-cut are not the same length';
    END IF;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION 'fn_lightning_form_hand carries anchor % % time(s) rather than %; refusing to substitute blind', k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
    EXECUTE format('DROP FUNCTION %s', v_old);
    IF v_cmt IS NOT NULL THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', v_new_sig, v_cmt);
    END IF;
  END IF;

  v_live := pg_get_functiondef(to_regprocedure(v_new_sig));
  FOREACH r IN ARRAY ARRAY[
      'p_request_id uuid DEFAULT NULL::uuid', 'request_id_belongs_to_another_cluster', '''replayed'', true',
      'fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, g.id, ps.player_id)',
      'cps.closed_at IS NULL', 'ORDER BY ts.id
   FOR SHARE', 'formation_invariant_failed', 'stack_invariant_failed', 'cluster_frozen',
      'SET cluster_mode = ''frozen''',
      'hand_created', 'pool_player_reserved', 'instance_created', '''participants''',
      'timestamp with time zone,text,uuid)''::regprocedure',
      -- and every sibling the re-cut was written next to
      'matcher_version_required', 'fn_platform_frozen', 'formation_contended',
      'fn_lightning_reap_formations(p_now, 200, g.id)', 'insufficient_legal_candidates',
      'bb_choice_is_not_p2_legal', 'LIGHTNING_FORMATION_MOVED_MONEY', 'v_money_after IS DISTINCT FROM v_money_before',
      'participants_locked_at = p_now', 'OR lock_not_available OR deadlock_detected OR serialization_failure THEN',
      'WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation OR SQLSTATE ''PLT02''
      OR exclusion_violation'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_lightning_form_hand does not carry "%"', r;
    END IF;
  END LOOP;
  IF position('lightning_hand_formed' in v_live) > 0 OR position('ERRCODE = ''check_violation''' in v_live) > 0 THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_form_hand still raises check_violation or emits lightning_hand_formed';
  END IF;
  -- The anchor seats are locked before the slots, and the money comparison is
  -- inside the atomic block, before its handler.
  IF NOT (position('FROM public.table_seats ts' in v_live) < position('FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
     AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand)
   ORDER BY sl.player_id
   FOR UPDATE' in v_live)
          AND position('INTO v_money_after' in v_live) < position('OR SQLSTATE ''PLT02''' in v_live)) THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_form_hand locks in the wrong order or measures money outside its atomic block';
  END IF;
  IF to_regprocedure(v_old) IS NOT NULL THEN
    RAISE EXCEPTION 'the nine-argument fn_lightning_form_hand still exists';
  END IF;
  IF regexp_replace(v_live, '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse' OR v_live ~ 'SECURITY DEFINER' THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_form_hand mentions a horse or runs as its owner';
  END IF;
END
$recut_form_hand$;

REVOKE ALL ON FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone, text, uuid) TO service_role;

-- ===========================================================================
-- SECTION 4. THE REST OF THE LIGHTNING FAMILY (DEFECTS 5, 6, 8, 10 AND 11),
-- EACH BY ASSERTED SUBSTITUTION IN THE SHAPE SECTION 3 SPELLS OUT.
-- ===========================================================================

-- DEFECT 6: begin_dealing looks outside the instance. It takes the Cluster row
-- FOR SHARE before the instance (the order formation takes them in), and
-- abandons the instance with a reason - which hands its players back through
-- trg_lightning_instance_releases_its_reservations - when the Cluster is no
-- longer lightning, Lightning is disabled, the epoch has moved, or a
-- participant's pool session, slot, anchor seat or cash session is no longer
-- live. The deadline is tested against clock_timestamp(): a caller's old
-- p_now cannot make a dead formation look alive.
DO $recut_begin_dealing$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_instance_begin_dealing(uuid,interval,timestamp with time zone)'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_instance_begin_dealing(uuid,interval,timestamp with time zone)'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
$a$  i          record;
$a$,
$a$  SELECT li.id, li.state, li.hand_id, li.cluster_id, li.cluster_epoch, li.deadline_at
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;$a$,
$a$  IF i.deadline_at <= p_now THEN$a$,
$a$  UPDATE public.lightning_instance li
     SET state = 'dealing', started_at = p_now, deadline_at = p_now + v_window
   WHERE li.id = i.id;

  RETURN jsonb_build_object('ok', true, 'dealing', true, 'instance_id', i.id,$a$,
$a$                            'deadline_at', p_now + v_window);$a$];
  b      text[] := ARRAY[
$b$  i          record;
  g          record;
  v_cluster  uuid;
  v_why      text;
  v_gone     text;
  -- THE DEADLINE IS JUDGED BY THE DATABASE'S CLOCK (2026-09-26), never by the
  -- caller's: an old p_now would make an expired formation look alive.
  v_now      timestamptz := clock_timestamp();
$b$,
$b$  -- THE CLUSTER ROW FIRST, FOR SHARE (2026-09-26), in the order formation
  -- takes it, so that nothing can convert, freeze or disable the Cluster
  -- between the checks below and the release into gameplay.
  SELECT li.cluster_id INTO v_cluster FROM public.lightning_instance li WHERE li.id = p_instance_id;
  SELECT cg.id, cg.cluster_mode, cg.lightning_enabled, cg.cluster_epoch
    INTO g FROM public.cash_games cg WHERE cg.id = v_cluster FOR SHARE;

  SELECT li.id, li.state, li.hand_id, li.cluster_id, li.cluster_epoch, li.deadline_at, li.created_at
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;$b$,
$b$  IF i.deadline_at <= v_now THEN$b$,
$b$  -- THE WORLD OUTSIDE THE INSTANCE (2026-09-26). Everything above asks the
  -- instance about itself. A hand is released into gameplay only while its
  -- Cluster is still a Lightning pool at the epoch it was formed in, and while
  -- every participant is still in that pool: an open pool session, an open
  -- slot, an anchor seat that is live eligible, and an open cash session. If
  -- not, the formation is void and is abandoned HERE, so its players are
  -- handed back now rather than when the reaper finds it.
  v_why := CASE
    WHEN g.id IS NULL THEN 'cluster_not_found'
    WHEN g.cluster_mode IS DISTINCT FROM 'lightning' THEN 'cluster_is_not_lightning'
    WHEN coalesce(g.lightning_enabled, false) = false THEN 'lightning_disabled'
    WHEN g.cluster_epoch IS DISTINCT FROM i.cluster_epoch
      OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                      WHERE e.cluster_id = i.cluster_id AND e.epoch = i.cluster_epoch
                        AND e.ended_at IS NULL) THEN 'epoch_is_not_current'
    ELSE NULL END;
  IF v_why IS NULL THEN
    SELECT string_agg(hp.player_id::text, ',' ORDER BY hp.seat) INTO v_gone
      FROM public.lightning_hand_player hp
      JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
     WHERE hp.hand_id = h.hand_id
       AND (sl.closed_at IS NOT NULL
            OR ps.exited_at IS NOT NULL
            OR NOT public.fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, i.cluster_id, ps.player_id)
            OR NOT EXISTS (SELECT 1 FROM public.cash_player_session cps
                            WHERE cps.id = ps.cash_player_session_id AND cps.closed_at IS NULL));
    IF v_gone IS NOT NULL THEN
      v_why := 'participant_left_the_pool';
    END IF;
  END IF;
  IF v_why IS NOT NULL THEN
    PERFORM public.fn_lightning_instance_abandon(
      i.id, 'begin_dealing refused: ' || v_why || coalesce(' [' || v_gone || ']', ''), v_now);
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'abandoned', true, 'reason', v_why,
                              'instance_id', i.id, 'hand_id', h.hand_id, 'players', v_gone,
                              'cluster_mode', g.cluster_mode);
  END IF;

  UPDATE public.lightning_instance li
     SET state = 'dealing', started_at = GREATEST(v_now, i.created_at),
         deadline_at = GREATEST(v_now, i.created_at) + v_window
   WHERE li.id = i.id;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (i.cluster_id, 'instance_started', jsonb_build_object(
    'cluster_id', i.cluster_id, 'cluster_epoch', i.cluster_epoch, 'instance_id', i.id,
    'hand_id', h.hand_id, 'players', v_players,
    'deadline_at', GREATEST(v_now, i.created_at) + v_window, 'at', v_now), i.cluster_epoch);

  RETURN jsonb_build_object('ok', true, 'dealing', true, 'instance_id', i.id,$b$,
$b$                            'deadline_at', GREATEST(v_now, i.created_at) + v_window);$b$];
BEGIN
  IF v_src ~ 'participant_left_the_pool' THEN
    RAISE NOTICE 'fn_lightning_instance_begin_dealing already looks outside the instance; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_instance_begin_dealing carries anchor % % time(s) rather than once; refusing to substitute blind', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_live := pg_get_functiondef(v_fn);
  FOREACH r IN ARRAY ARRAY['WHERE cg.id = v_cluster FOR SHARE', 'participant_left_the_pool', 'cluster_is_not_lightning',
                           'lightning_disabled', 'epoch_is_not_current', 'fn_lightning_instance_abandon(',
                           'IF i.deadline_at <= v_now THEN', 'instance_started',
                           'fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, i.cluster_id, ps.player_id)',
                           'fn_platform_frozen', 'participant_set_is_not_locked', 'participant_set_does_not_agree',
                           'reservations_do_not_match_the_seats'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_lightning_instance_begin_dealing does not carry "%"', r;
    END IF;
  END LOOP;
  IF position('FOR SHARE' in v_live) > position('WHERE li.id = p_instance_id FOR UPDATE' in v_live)
     OR v_live ~ 'deadline_at <= p_now' THEN
    RAISE EXCEPTION 'fn_lightning_instance_begin_dealing takes the instance before the Cluster, or still trusts the caller''s clock';
  END IF;
END
$recut_begin_dealing$;

-- DEFECT 5: A PARTICIPANT CANNOT BE MOVED OUT OF A LOCKED HAND. The trigger
-- judged an UPDATE by NEW.hand_id alone, so moving a row from a locked hand to
-- an unlocked one passed as "an edit to an unlocked hand".
DO $recut_hand_player$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_hand_player_is_immutable()'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_hand_player_is_immutable()'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  a      text := $a$  IF TG_OP = 'DELETE' THEN v_hand := OLD.hand_id; ELSE v_hand := NEW.hand_id; END IF;$a$;
  b      text := $b$  IF TG_OP = 'DELETE' THEN v_hand := OLD.hand_id; ELSE v_hand := NEW.hand_id; END IF;

  -- THE HAND A ROW LEAVES IS ASKED TOO (2026-09-26). Judged by NEW alone, an
  -- UPDATE moving a participant OUT of a locked hand into an unlocked one was
  -- an edit to an unlocked hand, and passed. A row whose OLD hand is latched
  -- keeps its hand_id, whatever hand it is being moved to.
  IF TG_OP = 'UPDATE' AND NEW.hand_id IS DISTINCT FROM OLD.hand_id
     AND EXISTS (SELECT 1 FROM public.lightning_hand oh
                  WHERE oh.hand_id = OLD.hand_id AND oh.participants_locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_PLAYER_IS_IMMUTABLE: player % of locked hand % may not be moved to hand %; the participant set of a locked hand is fixed',
      OLD.player_id, OLD.hand_id, NEW.hand_id USING ERRCODE = 'check_violation';
  END IF;$b$;
BEGIN
  IF v_src ~ 'THE HAND A ROW LEAVES IS ASKED TOO' THEN
    RAISE NOTICE 'fn_lightning_hand_player_is_immutable already asks the hand a row leaves; leaving it alone';
  ELSE
    v_n := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_lightning_hand_player_is_immutable carries its anchor % time(s) rather than once', v_n;
    END IF;
    EXECUTE replace(v_src, a, b);
  END IF;
  v_live := pg_get_functiondef(v_fn);
  IF position('oh.hand_id = OLD.hand_id AND oh.participants_locked_at IS NOT NULL' in v_live) = 0
     OR position('LIGHTNING_NO_ADDITIONAL_PLAYER_INSERTION' in v_live) = 0
     OR position('LIGHTNING_NO_PARTICIPANT_SUBSTITUTION' in v_live) = 0
     OR position('LIGHTNING_NO_SILENT_SEAT_SWAP' in v_live) = 0
     OR position('LIGHTNING_NO_BLIND_REASSIGNMENT' in v_live) = 0
     OR position('THE HAND A ROW LEAVES IS ASKED TOO' in v_live) > position('SELECT h.participants_locked_at INTO v_locked' in v_live) THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_hand_player_is_immutable lost a rule, or asks the leaving hand after it has already let an unlocked target through';
  END IF;
END
$recut_hand_player$;

-- DEFECT 11: the request a hand was formed for is part of what it is.
DO $recut_hand$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_hand_is_immutable()'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_hand_is_immutable()'::regprocedure);
  v_n    integer;
  a      text := $a$     OR NEW.rake_version IS DISTINCT FROM OLD.rake_version THEN$a$;
  b      text := $b$     OR NEW.rake_version IS DISTINCT FROM OLD.rake_version
     -- and the request it was formed for (2026-09-26)
     OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN$b$;
BEGIN
  IF v_src ~ 'NEW\.request_id IS DISTINCT FROM OLD\.request_id' THEN
    RAISE NOTICE 'fn_lightning_hand_is_immutable already freezes request_id; leaving it alone';
  ELSE
    v_n := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_lightning_hand_is_immutable carries its anchor % time(s) rather than once', v_n;
    END IF;
    EXECUTE replace(v_src, a, b);
  END IF;
  IF position('NEW.request_id IS DISTINCT FROM OLD.request_id' in pg_get_functiondef(v_fn)) = 0
     OR position('LIGHTNING_HAND_IS_BORN_UNLOCKED' in pg_get_functiondef(v_fn)) = 0
     OR position('THE LATCH IS ONE-WAY' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_hand_is_immutable lost a rule';
  END IF;
END
$recut_hand$;

-- DEFECT 11: THE OLDEST BLIND-DEBT AGE IS THE AGE OF THE DEBT. It was the
-- ledger row's updated_at, which every formation moves for every participant,
-- so the "oldest debt" was really "least recently dealt". The P2 key is
-- otherwise identical, and the barrier's big-blind check compares the
-- debt_age this function returns, so the two cannot disagree.
DO $recut_blind_order$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  a      text[] := ARRAY[
$a$                    coalesce(bl.updated_at, sl.opened_at) ASC,$a$,
$a$         coalesce(bl.updated_at, sl.opened_at),$a$];
  b      text[] := ARRAY[
$b$                    coalesce(bl.debt_since, sl.opened_at) ASC,$b$,
$b$         coalesce(bl.debt_since, sl.opened_at),$b$];
BEGIN
  IF v_src ~ 'bl\.debt_since' THEN
    RAISE NOTICE 'fn_lightning_blind_order already ages a debt by debt_since; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_blind_order carries anchor % % time(s) rather than once', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_live := regexp_replace(pg_get_functiondef(v_fn), '--[^' || chr(10) || ']*', '', 'g');
  IF v_live !~ 'ORDER BY \(coalesce\(bl\.missed_bb_debt, 0\) > 0 OR coalesce\(bl\.bb_owed, 0\) > 0\) DESC,[[:space:]]+sl\.last_bb_at ASC NULLS FIRST,[[:space:]]+coalesce\(bl\.debt_since, sl\.opened_at\) ASC,[[:space:]]+sl\.opened_at ASC,[[:space:]]+sl\.player_id ASC\)'
     OR v_live ~ 'updated_at' THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_blind_order does not carry the P2 key with debt_since as its third term';
  END IF;
END
$recut_blind_order$;

-- DEFECT 8: THE SLOT PASS TAKES THE CLUSTER ROW FIRST, AND NEVER WAITS FOR IT.
-- Formation takes cash_games FOR UPDATE and then the slots; the pass took the
-- slots with no Cluster lock at all, which is the inversion. It now takes the
-- row in the same mode formation does, SKIP LOCKED - a Cluster that is forming
-- a hand is simply skipped this pass - checks the pass deadline its caller set
-- before every slot it opens, and closes a slot no earlier than it opened.
DO $recut_slots_sync$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_pool_slots_sync(uuid,timestamp with time zone)'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_pool_slots_sync(uuid,timestamp with time zone)'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
$a$  v_frozen boolean := public.fn_platform_frozen();
$a$,
$a$  SELECT id, cluster_mode, lightning_enabled, cluster_epoch
    INTO g FROM public.cash_games WHERE id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;$a$,
$a$     SET closed_at = p_now,$a$,
$a$  LOOP
    IF coalesce((public.fn_lightning_pool_slot_open(s.id, p_now) ->> 'opened')::boolean, false) THEN$a$,
$a$                            'slots_closed', v_closed, 'slots_opened', v_opened);$a$];
  b      text[] := ARRAY[
$b$  v_frozen boolean := public.fn_platform_frozen();
  v_deferred boolean := false;
  v_deadline timestamptz := nullif(current_setting('ca.cluster_pass_deadline', true), '')::timestamptz;
$b$,
$b$  -- THE CLUSTER ROW FIRST, IN FORMATION'S OWN MODE, AND WITHOUT WAITING
  -- (2026-09-26). A Cluster whose row is held - a formation in flight - is
  -- skipped this pass and taken the next; the pass is never parked behind it.
  SELECT id, cluster_mode, lightning_enabled, cluster_epoch
    INTO g FROM public.cash_games WHERE id = p_cluster_id
     FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.cash_games WHERE id = p_cluster_id) THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'cluster_busy', 'skipped', true,
                                'slots_closed', 0, 'slots_opened', 0);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;$b$,
$b$     SET closed_at = GREATEST(p_now, sl.opened_at),$b$,
$b$  LOOP
    -- THE PASS BUDGET (2026-09-26). fn_cash_clusters_tick_all sets
    -- ca.cluster_pass_deadline; past it, the rest of this Cluster's slots are
    -- left for the next pass rather than stretching this one.
    IF v_deadline IS NOT NULL AND clock_timestamp() > v_deadline THEN
      v_deferred := true;
      EXIT;
    END IF;
    IF coalesce((public.fn_lightning_pool_slot_open(s.id, p_now) ->> 'opened')::boolean, false) THEN$b$,
$b$                            'slots_closed', v_closed, 'slots_opened', v_opened,
                            'deferred', v_deferred);$b$];
BEGIN
  IF v_src ~ 'cluster_busy' THEN
    RAISE NOTICE 'fn_lightning_pool_slots_sync already takes the Cluster row first; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_pool_slots_sync carries anchor % % time(s) rather than once', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_live := pg_get_functiondef(v_fn);
  FOREACH r IN ARRAY ARRAY['FOR UPDATE SKIP LOCKED', 'cluster_busy', 'GREATEST(p_now, sl.opened_at)',
                           'ca.cluster_pass_deadline', '''deferred'', v_deferred',
                           'pool_session_exited', 'epoch_advanced', 'cluster_is_not_lightning'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_lightning_pool_slots_sync does not carry "%"', r;
    END IF;
  END LOOP;
  IF position('FOR UPDATE SKIP LOCKED' in v_live) > position('UPDATE public.lightning_pool_slot' in v_live) THEN
    RAISE EXCEPTION 'fn_lightning_pool_slots_sync touches the slots before it holds the Cluster row';
  END IF;
END
$recut_slots_sync$;

-- DEFECT 10: instance_created from the door that opens an instance on its own.
DO $recut_instance_open$
DECLARE
  v_fn  constant regprocedure := 'public.fn_lightning_instance_open(uuid,smallint,smallint,interval,timestamp with time zone)'::regprocedure;
  v_src text := pg_get_functiondef('public.fn_lightning_instance_open(uuid,smallint,smallint,interval,timestamp with time zone)'::regprocedure);
  v_n   integer;
  a     text := $a$  RETURNING id INTO v_id;$a$;
  b     text := $b$  RETURNING id INTO v_id;

  -- SPECIFICATION EVENT instance_created (2026-09-26).
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (g.id, 'instance_created', jsonb_build_object(
    'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch, 'instance_id', v_id,
    'target_size', v_target, 'max_size', v_max, 'via', 'fn_lightning_instance_open',
    'deadline_at', p_now + v_window, 'at', p_now), g.cluster_epoch);$b$;
BEGIN
  IF v_src ~ 'instance_created' THEN
    RAISE NOTICE 'fn_lightning_instance_open already records instance_created; leaving it alone';
  ELSE
    v_n := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_lightning_instance_open carries its anchor % time(s) rather than once', v_n;
    END IF;
    EXECUTE replace(v_src, a, b);
  END IF;
  IF position('''instance_created''' in pg_get_functiondef(v_fn)) = 0
     OR position('fn_platform_frozen' in pg_get_functiondef(v_fn)) = 0
     OR position('fn_lightning_reap_formations(p_now, 200, g.id)' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_instance_open lost a rule or does not record instance_created';
  END IF;
END
$recut_instance_open$;

-- DEFECT 10: EVERY ROAD INTO A TERMINAL STATE SAYS SO. This trigger already
-- hands the players back on every road - abandon, the reaper, begin_dealing's
-- refusal and the settlement nobody has written yet - so it is where the
-- terminal events are written: instance_completed or instance_destroyed, with
-- the reason and whether a dealing hand was voided, and ONE
-- pool_player_released carrying every player it released.
DO $recut_releases$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_instance_releases_its_reservations()'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_instance_releases_its_reservations()'::regprocedure);
  v_new  text;
  v_n    integer;
  k      integer;
  a      text[] := ARRAY[
$a$AS $function$
BEGIN
$a$,
$a$  UPDATE public.lightning_reservation r
     SET state = 'released',
         resolved_at = clock_timestamp(),
         reason = coalesce(r.reason, 'instance_' || NEW.state)
   WHERE r.lightning_instance_id = NEW.id
     AND r.state IN ('pending', 'committed');
  RETURN NULL;$a$];
  b      text[] := ARRAY[
$b$AS $function$
DECLARE
  v_players uuid[];
BEGIN
$b$,
$b$  WITH released AS (
    UPDATE public.lightning_reservation r
       SET state = 'released',
           resolved_at = clock_timestamp(),
           reason = coalesce(r.reason, 'instance_' || NEW.state)
     WHERE r.lightning_instance_id = NEW.id
       AND r.state IN ('pending', 'committed')
    RETURNING r.player_id)
  SELECT coalesce(array_agg(released.player_id ORDER BY released.player_id), ARRAY[]::uuid[])
    INTO v_players FROM released;

  -- SPECIFICATION EVENTS (2026-09-26): how the instance ended, and who it
  -- gave back, in one row each.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (NEW.cluster_id,
          CASE WHEN NEW.state = 'complete' THEN 'instance_completed' ELSE 'instance_destroyed' END,
          jsonb_build_object(
            'cluster_id', NEW.cluster_id, 'cluster_epoch', NEW.cluster_epoch,
            'instance_id', NEW.id, 'hand_id', NEW.hand_id,
            'from_state', OLD.state, 'to_state', NEW.state, 'reason', NEW.abandon_reason,
            'hand_voided', NEW.state = 'abandoned' AND OLD.state IN ('dealing', 'settling'),
            'players', to_jsonb(v_players), 'at', clock_timestamp()),
          NEW.cluster_epoch);
  IF cardinality(v_players) > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
    VALUES (NEW.cluster_id, 'pool_player_released', jsonb_build_object(
      'cluster_id', NEW.cluster_id, 'cluster_epoch', NEW.cluster_epoch,
      'instance_id', NEW.id, 'hand_id', NEW.hand_id, 'players', to_jsonb(v_players),
      'reason', coalesce(NEW.abandon_reason, 'instance_' || NEW.state), 'at', clock_timestamp()),
      NEW.cluster_epoch);
  END IF;
  RETURN NULL;$b$];
BEGIN
  IF v_src ~ 'pool_player_released' THEN
    RAISE NOTICE 'fn_lightning_instance_releases_its_reservations already records its events; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_instance_releases_its_reservations carries anchor % % time(s) rather than once', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  IF position('instance_destroyed' in pg_get_functiondef(v_fn)) = 0
     OR position('instance_completed' in pg_get_functiondef(v_fn)) = 0
     OR position('pool_player_released' in pg_get_functiondef(v_fn)) = 0
     OR position('r.state IN (''pending'', ''committed'')' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_instance_releases_its_reservations lost its release or its events';
  END IF;
END
$recut_releases$;

-- DEFECT 11: debt_since is kept by a trigger on every write to the ledger.
DO $debt_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.lightning_blind_ledger'::regclass
                   AND tgname = 'trg_lightning_blind_ledger_tracks_debt_since') THEN
    CREATE TRIGGER trg_lightning_blind_ledger_tracks_debt_since
      BEFORE INSERT OR UPDATE ON public.lightning_blind_ledger
      FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_blind_ledger_debt_since();
  END IF;
END
$debt_trigger$;

-- A ledger row already owing when this file is applied is aged from now: the
-- moment it first became unresolved was never recorded, and inventing an
-- earlier one would reorder P2 on a guess. Production holds no ledger row.
UPDATE public.lightning_blind_ledger bl
   SET debt_since = clock_timestamp()
 WHERE bl.debt_since IS NULL
   AND (bl.missed_bb_debt > 0 OR bl.missed_sb_debt > 0 OR bl.bb_owed > 0 OR bl.sb_owed > 0);

-- ===========================================================================
-- SECTION 5. THE CONVERSION AND THE CLUSTER CONTROLLER (DEFECTS 1, 2, 8, 9,
-- 10 AND 11), EACH BY ASSERTED SUBSTITUTION.
-- ===========================================================================

-- DEFECTS 1, 2, 10 AND 11 IN THE COMMIT.
--
-- THE IN-FLIGHT TEST NOW READS A ROW THAT EXISTS WHILE A HAND IS IN FLIGHT.
-- hand_history is written at settlement, always with ended_at, so
-- "ended_at IS NULL" counted nothing, ever. hand_state_snapshots is written by
-- the engine after every action of a hand (save_hand_state_snapshot) with
-- is_complete = false - at most one such row per table, by
-- idx_hand_snapshots_one_active_per_table - and is completed after settlement
-- (complete_hand_snapshot). That is the real signal, and it is kept. The
-- six-hour window and the member-table filters stay exactly as they were, for
-- the reason they were written: a snapshot abandoned by a dead engine on a
-- closed table must not wedge a conversion for ever. Measured before this was
-- written: 2,160 incomplete snapshots in production, 1,734 of them older than
-- an hour and 2,124 on tables with no engine lease at all.
--
-- AND THE COMMIT WAITS FOR THE ENGINE TO SAY IT HAS STOPPED. The engine
-- re-reads the halt about once a minute, so a halt is not a stop until the
-- engine has seen it. Every live member table that holds an unexpired engine
-- lease (engine_table_leases, the lease claim_table_lease_v2 grants and
-- heartbeat_table_leases_v4 keeps, stale after fn_engine_lease_stale_seconds)
-- must have dealing_halt_observed_at >= dealing_halted_at, stamped by
-- fn_cash_table_observe_dealing_halt from the halt gate between hands. A table
-- with no live lease has no engine and so no hand being dealt, and is exempt.
-- A member table that is not halted at all - one opened between PENDING_ON and
-- here - is halted now, and the commit answers not-ready so that the next
-- attempt finds it halted and observed. Both are answered the way every other
-- precondition here is: a structured refusal, the conversion left PENDING_ON
-- for the next attempt or for the reaper.
DO $recut_commit$
DECLARE
  v_fn   constant regprocedure := 'public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
$a$  v_epoch    integer;
$a$,
$a$    FROM public.hand_history h
    JOIN public.tables tb ON tb.id = h.table_id$a$,
$a$     AND h.ended_at IS NULL
     AND h.started_at > clock_timestamp() - interval '6 hours';
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'hands_in_flight',
      'hands_in_flight', v_inflight);
  END IF;$a$,
$a$  PERFORM set_config('ca.epoch_reason', 'lightning_on', true);$a$,
$a$    state, entered_at, starting_stack)$a$,
$a$         'active', clock_timestamp(), ts.stack$a$,
$a$  GET DIAGNOSTICS v_pool = ROW_COUNT;$a$,
$a$     SET status = 'committed', epoch_after = v_epoch, closed_at = clock_timestamp()$a$,
$a$  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (g.id, 'lightning_on', jsonb_build_object($a$,
$a$    'pool_sessions', v_pool, 'chip_total', v_before));$a$];
  b      text[] := ARRAY[
$b$  v_epoch    integer;
  v_unobserved        integer;
  v_unobserved_tables jsonb;
  v_stragglers        integer;
$b$,
$b$    FROM public.hand_state_snapshots h
    JOIN public.tables tb ON tb.id = h.table_id$b$,
$b$     AND h.is_complete = false
     AND h.updated_at > clock_timestamp() - interval '6 hours';
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'hands_in_flight',
      'hands_in_flight', v_inflight);
  END IF;

  -- THE HALT IS A STOP ONLY ONCE THE ENGINE HAS SEEN IT (2026-09-26). A member
  -- table that is not halted at all is halted now; then every live member
  -- table an engine holds an unexpired lease on must have observed its halt.
  UPDATE public.tables tb
     SET dealing_halted_at = clock_timestamp(), dealing_halted_reason = 'lightning_pending_on'
   WHERE tb.cluster_id = g.id
     AND tb.dealing_halted_at IS NULL
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed';
  GET DIAGNOSTICS v_stragglers = ROW_COUNT;

  SELECT count(*)::integer, coalesce(jsonb_agg(tb.id ORDER BY tb.id), '[]'::jsonb)
    INTO v_unobserved, v_unobserved_tables
    FROM public.tables tb
    JOIN public.engine_table_leases l ON l.table_id = tb.id
   WHERE tb.cluster_id = g.id
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND l.heartbeat_at >= clock_timestamp() - make_interval(secs => public.fn_engine_lease_stale_seconds())
     AND (tb.dealing_halted_at IS NULL
          OR tb.dealing_halt_observed_at IS NULL
          OR tb.dealing_halt_observed_at < tb.dealing_halted_at);
  IF v_unobserved > 0 OR v_stragglers > 0 THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'halt_not_observed',
      'tables_not_observed', v_unobserved, 'tables', v_unobserved_tables,
      'tables_newly_halted', v_stragglers);
  END IF;$b$,
$b$  PERFORM set_config('ca.epoch_reason', 'lightning_on', true);
  -- The epoch writer records cluster_epoch_started with this request.
  PERFORM set_config('ca.request_id', p_request_id::text, true);$b$,
$b$    state, entered_at, starting_stack, anchor_seat_id)$b$,
$b$         'active', clock_timestamp(), ts.stack, ts.id$b$,
$b$  GET DIAGNOSTICS v_pool = ROW_COUNT;

  -- pool_player_joined, one per player the conversion entered (2026-09-26).
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  SELECT g.id, 'pool_player_joined', jsonb_build_object(
           'cluster_id', g.id, 'cluster_epoch', v_epoch, 'player_id', ps.player_id,
           'pool_session_id', ps.id, 'anchor_seat_id', ps.anchor_seat_id,
           'starting_stack', ps.starting_stack, 'cash_player_session_id', ps.cash_player_session_id,
           'via', 'fn_cash_cluster_commit_lightning', 'conversion_id', v_conv.id, 'at', ps.entered_at),
         v_epoch, p_request_id
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.cluster_epoch = v_epoch AND ps.exited_at IS NULL
   ORDER BY ps.entered_at, ps.id;$b$,
$b$     SET status = 'committed', epoch_after = v_epoch, closed_at = clock_timestamp(),
         chips_at_commit = v_before$b$,
$b$  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_on', jsonb_build_object($b$,
$b$    'pool_sessions', v_pool, 'chip_total', v_before), p_request_id);$b$];
BEGIN
  IF v_src ~ 'halt_not_observed' THEN
    RAISE NOTICE 'fn_cash_cluster_commit_lightning already waits for the halt to be observed; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_cash_cluster_commit_lightning carries anchor % % time(s) rather than once; refusing to substitute blind', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_live := pg_get_functiondef(v_fn);
  FOREACH r IN ARRAY ARRAY['FROM public.hand_state_snapshots h', 'h.is_complete = false', 'halt_not_observed',
                           'public.engine_table_leases l', 'fn_engine_lease_stale_seconds()',
                           'tb.dealing_halt_observed_at < tb.dealing_halted_at', 'anchor_seat_id)',
                           'ts.stack, ts.id', 'pool_player_joined', 'chips_at_commit = v_before',
                           'ca.request_id',
                           -- and the siblings
                           'hands_in_flight', 'LIGHTNING_CONVERSION_MOVED_MONEY',
                           'LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND', 'LIGHTNING_CONVERSION_STRANDED_A_PLAYER',
                           'population_fell_below_on_threshold_at_boundary', 'already_committed',
                           'SELECT DISTINCT ON (ts.user_id)'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_cash_cluster_commit_lightning does not carry "%"', r;
    END IF;
  END LOOP;
  IF regexp_replace(v_live, '--[^' || chr(10) || ']*', '', 'g') ~ 'hand_history|is_horse' THEN
    RAISE EXCEPTION 'the re-cut fn_cash_cluster_commit_lightning still reads hand_history, or mentions a horse';
  END IF;
  -- The observation is required before anything is written for a player.
  IF position('halt_not_observed' in v_live) > position('INSERT INTO public.lightning_pool_session' in v_live) THEN
    RAISE EXCEPTION 'fn_cash_cluster_commit_lightning creates pool sessions before it has checked the halt was observed';
  END IF;
END
$recut_commit$;

-- DEFECT 11: the chips on the Cluster's seats the instant its tables halted.
DO $recut_begin$
DECLARE
  v_fn  constant regprocedure := 'public.fn_cash_cluster_begin_pending_on(uuid,uuid)'::regprocedure;
  v_src text := pg_get_functiondef('public.fn_cash_cluster_begin_pending_on(uuid,uuid)'::regprocedure);
  v_n   integer;
  a     text := $a$  RETURNING * INTO v_prior;$a$;
  b     text := $b$  RETURNING * INTO v_prior;

  -- FORENSICS (2026-09-26): the chips on the Cluster's seats at the instant
  -- its tables were halted, beside the ones the commit will record.
  UPDATE public.cash_cluster_conversion cc
     SET chips_at_begin = (SELECT coalesce(sum(ts.stack), 0)
                             FROM public.table_seats ts
                             JOIN public.tables tb ON tb.id = ts.table_id
                            WHERE tb.cluster_id = g.id AND ts.left_at IS NULL)
   WHERE cc.id = v_prior.id;$b$;
BEGIN
  IF v_src ~ 'chips_at_begin' THEN
    RAISE NOTICE 'fn_cash_cluster_begin_pending_on already records chips_at_begin; leaving it alone';
  ELSE
    v_n := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_cash_cluster_begin_pending_on carries its anchor % time(s) rather than once', v_n;
    END IF;
    EXECUTE replace(v_src, a, b);
  END IF;
  IF position('SET chips_at_begin' in pg_get_functiondef(v_fn)) = 0
     OR position('dealing_halted_reason = ''lightning_pending_on''' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_cash_cluster_begin_pending_on lost its halt or does not record chips_at_begin';
  END IF;
END
$recut_begin$;

-- DEFECT 1: A TABLE BORN INSIDE A HALTED CLUSTER IS BORN HALTED. The Cluster
-- row is read FOR SHARE, so a table cannot be opened in the gap between a
-- conversion's decision and its halt, and a Cluster in any mode other than
-- must_move gets a table that is halted from its first instant: PENDING_ON's
-- own reason in pending_on, 'lightning' otherwise, which is the reason the
-- conversion leaves on every other table of a Cluster that is past must_move.
DO $recut_open_table$
DECLARE
  v_fn  constant regprocedure := 'public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure;
  v_src text := pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure);
  v_new text;
  v_n   integer;
  k     integer;
  a     text[] := ARRAY[
$a$  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;$a$,
$a$  ) RETURNING id INTO v_table_id;$a$];
  b     text[] := ARRAY[
$b$  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR SHARE;$b$,
$b$  ) RETURNING id INTO v_table_id;

  -- BORN HALTED IN A CLUSTER THAT IS NOT DEALING CASH (2026-09-26).
  IF g.cluster_mode IS DISTINCT FROM 'must_move' THEN
    UPDATE public.tables t
       SET dealing_halted_at = clock_timestamp(),
           dealing_halted_reason = CASE WHEN g.cluster_mode = 'pending_on'
                                        THEN 'lightning_pending_on' ELSE 'lightning' END
     WHERE t.id = v_table_id;
  END IF;$b$];
BEGIN
  IF v_src ~ 'BORN HALTED IN A CLUSTER' THEN
    RAISE NOTICE 'fn_cash_cluster_open_table already opens a halted table in a halted Cluster; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_cash_cluster_open_table carries anchor % % time(s) rather than once', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  IF position('WHERE id = p_game_id FOR SHARE' in pg_get_functiondef(v_fn)) = 0
     OR position('THEN ''lightning_pending_on'' ELSE ''lightning'' END' in pg_get_functiondef(v_fn)) = 0
     OR position('INSERT INTO public.tables' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_cash_cluster_open_table does not open a halted table in a halted Cluster';
  END IF;
END
$recut_open_table$;

-- DEFECT 8: THE TICK STANDS DOWN BEFORE IT LOCKS. fn_cash_clusters_to_tick
-- keeps every Cluster, because the ClusterController builds its row map from
-- that list (main1_table_id, enabled, eligible horses) and a Lightning Cluster
-- missing from it could not be woken or found. So the tick itself asks
-- cluster_mode with a plain read first, and a Cluster that is not in must_move
-- stands down without ever taking cash_games FOR UPDATE - the lock that
-- inverted against formation. The check after the lock stays, for a Cluster
-- that changes mode between the two.
DO $recut_tick$
DECLARE
  v_fn  constant regprocedure := 'public.fn_cash_cluster_tick(uuid,integer)'::regprocedure;
  v_src text := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  v_new text;
  v_n   integer;
  k     integer;
  a     text[] := ARRAY[
$a$  g record; t record; r record;$a$,
$a$  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;$a$];
  b     text[] := ARRAY[
$b$  g record; t record; r record;
  g_mode record;$b$,
$b$  -- STAND DOWN BEFORE THE LOCK (2026-09-26). A plain read of the mode; a
  -- Cluster that is converting or converted is left without its row being
  -- taken, so the tick never holds a Lightning Cluster's row against a
  -- formation.
  SELECT cg.must_move, cg.cluster_mode, cg.cluster_epoch INTO g_mode
    FROM public.cash_games cg WHERE cg.id = p_game_id;
  IF FOUND AND g_mode.must_move AND g_mode.cluster_mode IS DISTINCT FROM 'must_move' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lightning_cluster_stands_down',
      'cluster_mode', g_mode.cluster_mode, 'cluster_epoch', g_mode.cluster_epoch,
      'locked', false);
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;$b$];
BEGIN
  IF v_src ~ 'STAND DOWN BEFORE THE LOCK' THEN
    RAISE NOTICE 'fn_cash_cluster_tick already stands down before it locks; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_cash_cluster_tick carries anchor % % time(s) rather than once', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  IF position('STAND DOWN BEFORE THE LOCK' in pg_get_functiondef(v_fn)) = 0
     OR position('STAND DOWN BEFORE THE LOCK' in pg_get_functiondef(v_fn))
        > position('SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;' in pg_get_functiondef(v_fn))
     OR position('IF g.cluster_mode IS DISTINCT FROM ''must_move'' THEN' in pg_get_functiondef(v_fn)) = 0
     OR position('fn_platform_frozen' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_cash_cluster_tick does not stand down before its lock, or lost the check after it';
  END IF;
END
$recut_tick$;

-- DEFECT 8: THE PASS BUDGET REACHES THE LIGHTNING LOOP. The per-game loop
-- stopped starting games at v_budget; the Lightning sync loop in front of it
-- had no budget at all. The pass now publishes its deadline in
-- ca.cluster_pass_deadline, which fn_lightning_pool_slots_sync checks before
-- every slot, and stops starting Clusters past it.
DO $recut_tick_all$
DECLARE
  v_fn  constant regprocedure := 'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure;
  v_src text := pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure);
  v_new text;
  v_n   integer;
  k     integer;
  a     text[] := ARRAY[
$a$  PERFORM set_config('lock_timeout', v_lock_wait, true);$a$,
$a$  LOOP
    BEGIN
      v_lightning_synced := v_lightning_synced || jsonb_build_object(
        'cluster_id', lc.id, 'result', public.fn_lightning_pool_slots_sync(lc.id));$a$];
  b     text[] := ARRAY[
$b$  PERFORM set_config('lock_timeout', v_lock_wait, true);
  -- THE PASS'S DEADLINE, published for the Lightning slot sync (2026-09-26).
  PERFORM set_config('ca.cluster_pass_deadline', (v_now + v_budget)::text, true);$b$,
$b$  LOOP
    IF clock_timestamp() - v_now > v_budget THEN
      v_lightning_synced := v_lightning_synced || jsonb_build_object(
        'cluster_id', lc.id, 'deferred', true);
      CONTINUE;
    END IF;
    BEGIN
      v_lightning_synced := v_lightning_synced || jsonb_build_object(
        'cluster_id', lc.id, 'result', public.fn_lightning_pool_slots_sync(lc.id));$b$];
BEGIN
  IF v_src ~ 'ca\.cluster_pass_deadline' THEN
    RAISE NOTICE 'fn_cash_clusters_tick_all already budgets its Lightning loop; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_cash_clusters_tick_all carries anchor % % time(s) rather than once', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  IF position('ca.cluster_pass_deadline' in pg_get_functiondef(v_fn)) = 0
     OR (SELECT count(*) FROM regexp_matches(pg_get_functiondef(v_fn), 'EXCEPTION WHEN OTHERS THEN', 'g')) <> 4
     OR position('fn_lightning_reap_formations()' in pg_get_functiondef(v_fn)) = 0
     OR position('fn_cash_cluster_reap_stuck_conversions()' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_cash_clusters_tick_all does not budget its Lightning loop, or lost a sub-block';
  END IF;
END
$recut_tick_all$;

-- DEFECT 9: ONE FAILED ABORT COSTS ONE CONVERSION, NOT THE PASS. Each abort
-- runs in its own sub-block; a failure is recorded as a
-- lightning_pending_on_reap_failed event (written after the sub-block has
-- rolled back, so it survives) and the reaper moves on to the next.
DO $recut_reap_conv$
DECLARE
  v_fn  constant regprocedure := 'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure;
  v_src text := pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure);
  v_new text;
  v_n   integer;
  k     integer;
  a     text[] := ARRAY[
$a$  v_rows    jsonb   := '[]'::jsonb;
$a$,
$a$    v_res := public.fn_cash_cluster_abort_pending_on(
      c.cluster_id, c.conversion_request_id,
      format('reaped: PENDING_ON for %s, past the %s this estate allows a conversion to hold its tables',
             justify_interval(p_now - c.opened_at), v_age));
    v_aborted := coalesce((v_res ->> 'aborted')::boolean, false);$a$,
$a$    'ok', true, 'examined', v_seen, 'reaped', v_reaped, 'skipped', v_skipped,$a$];
  b     text[] := ARRAY[
$b$  v_rows    jsonb   := '[]'::jsonb;
  v_failed  integer := 0;
  v_sqlstate text;
  v_msg     text;
$b$,
$b$    BEGIN
      v_res := public.fn_cash_cluster_abort_pending_on(
        c.cluster_id, c.conversion_request_id,
        format('reaped: PENDING_ON for %s, past the %s this estate allows a conversion to hold its tables',
               justify_interval(p_now - c.opened_at), v_age));
      v_aborted := coalesce((v_res ->> 'aborted')::boolean, false);
    EXCEPTION WHEN OTHERS THEN
      -- ONE CONVERSION'S FAILURE (2026-09-26): its abort is rolled back, the
      -- failure is a row, and the queue behind it is still reaped.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_aborted := false;
      v_failed := v_failed + 1;
      v_res := jsonb_build_object('ok', false, 'aborted', false, 'reason', 'abort_failed',
                                  'sqlstate', v_sqlstate, 'message', v_msg);
      INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (c.cluster_id, 'lightning_pending_on_reap_failed', jsonb_build_object(
        'cluster_id', c.cluster_id, 'conversion_id', c.id,
        'conversion_request_id', c.conversion_request_id, 'opened_at', c.opened_at,
        'sqlstate', v_sqlstate, 'message', v_msg, 'at', clock_timestamp()));
    END;$b$,
$b$    'ok', true, 'examined', v_seen, 'reaped', v_reaped, 'skipped', v_skipped,
    'failed', v_failed,$b$];
BEGIN
  IF v_src ~ 'lightning_pending_on_reap_failed' THEN
    RAISE NOTICE 'fn_cash_cluster_reap_stuck_conversions already isolates each abort; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_cash_cluster_reap_stuck_conversions carries anchor % % time(s) rather than once', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  IF position('EXCEPTION WHEN OTHERS THEN' in pg_get_functiondef(v_fn)) = 0
     OR position('lightning_pending_on_reap_failed' in pg_get_functiondef(v_fn)) = 0
     OR position('lightning_pending_on_reaped' in pg_get_functiondef(v_fn)) = 0
     OR position('fn_cash_cluster_pool_health' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_cash_cluster_reap_stuck_conversions does not isolate each abort';
  END IF;
END
$recut_reap_conv$;

-- DEFECT 10: cluster_epoch_started, from the one writer of cash_cluster_epoch.
DO $recut_epoch$
DECLARE
  v_fn  constant regprocedure := 'public.fn_cash_cluster_epoch_follows_its_game()'::regprocedure;
  v_src text := pg_get_functiondef('public.fn_cash_cluster_epoch_follows_its_game()'::regprocedure);
  v_new text;
  v_n   integer;
  k     integer;
  a     text[] := ARRAY[
$a$    ON CONFLICT (cluster_id, epoch) DO NOTHING;
    RETURN NULL;$a$,
$a$            coalesce(nullif(current_setting('ca.epoch_reason', true), ''), 'unstated'));
    RETURN NULL;$a$];
  b     text[] := ARRAY[
$b$    ON CONFLICT (cluster_id, epoch) DO NOTHING;
    IF FOUND THEN
      -- SPECIFICATION EVENT cluster_epoch_started (2026-09-26): the genesis epoch.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (NEW.id, 'cluster_epoch_started', jsonb_build_object(
        'cluster_id', NEW.id, 'cluster_epoch', NEW.cluster_epoch, 'previous_epoch', NULL,
        'mode', NEW.cluster_mode, 'started_by', 'genesis', 'at', clock_timestamp()),
        NEW.cluster_epoch, nullif(current_setting('ca.request_id', true), '')::uuid);
    END IF;
    RETURN NULL;$b$,
$b$            coalesce(nullif(current_setting('ca.epoch_reason', true), ''), 'unstated'));
    -- SPECIFICATION EVENT cluster_epoch_started (2026-09-26).
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (NEW.id, 'cluster_epoch_started', jsonb_build_object(
      'cluster_id', NEW.id, 'cluster_epoch', NEW.cluster_epoch, 'previous_epoch', OLD.cluster_epoch,
      'mode', NEW.cluster_mode,
      'started_by', coalesce(nullif(current_setting('ca.epoch_reason', true), ''), 'unstated'),
      'at', clock_timestamp()),
      NEW.cluster_epoch, nullif(current_setting('ca.request_id', true), '')::uuid);
    RETURN NULL;$b$];
BEGIN
  IF v_src ~ 'cluster_epoch_started' THEN
    RAISE NOTICE 'fn_cash_cluster_epoch_follows_its_game already records cluster_epoch_started; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_cash_cluster_epoch_follows_its_game carries anchor % % time(s) rather than once', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(pg_get_functiondef(v_fn), '''cluster_epoch_started''', 'g')) <> 2
     OR position('CLUSTER_EPOCH_GOES_FORWARD' in pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'the re-cut fn_cash_cluster_epoch_follows_its_game does not record cluster_epoch_started on both roads';
  END IF;
END
$recut_epoch$;

-- ===========================================================================
-- SECTION 6. WHO MAY CALL WHAT, AND WHAT NOBODY MAY DELETE (DEFECT 11).
-- ===========================================================================

REVOKE ALL ON FUNCTION public.fn_cash_table_observe_dealing_halt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_table_observe_dealing_halt(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_anchor_is_live_eligible(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_anchor_is_live_eligible(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_stack(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_stack(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_player_in_hand(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_player_in_hand(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_enter(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_enter(uuid, timestamp with time zone) TO service_role;
-- Trigger functions cannot be called as an RPC; the grant to service_role is
-- the family's rule (every fn_lightning_ function is executable by it and by
-- no browser role), and the two table_seats functions are granted to nobody.
REVOKE ALL ON FUNCTION public.fn_lightning_blind_ledger_debt_since() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_blind_ledger_debt_since() TO service_role;
REVOKE ALL ON FUNCTION public.fn_table_seats_lightning_anchor_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_table_seats_lightning_pool_follows_seat() FROM PUBLIC, anon, authenticated;

-- HISTORY IS CLOSED, NOT DELETED. No function in the estate and no line of
-- server/src deletes from any of these (measured before this was written:
-- zero catalogue bodies match DELETE FROM on them, and server/src does not
-- name them), so the application loses nothing. TRUNCATE was already revoked
-- from the seven lightning tables by 20260926023047; cash_cluster_conversion
-- loses it here. A cascade from cash_games still runs, as the owner.
REVOKE DELETE ON public.lightning_reservation, public.lightning_instance, public.lightning_pool_session,
                 public.lightning_blind_ledger, public.lightning_pool_slot, public.lightning_hand,
                 public.lightning_hand_player, public.cash_cluster_conversion
  FROM service_role, anon, authenticated, PUBLIC;
REVOKE TRUNCATE ON public.cash_cluster_conversion FROM service_role, anon, authenticated, PUBLIC;

-- ===========================================================================
-- SECTION 9. THE HOT TABLES, LAST. table_seats is written by every hand,
-- tables is read by every engine loop and cash_cluster_events by every tick.
-- Each statement below takes a lock that blocks their writers (ADD COLUMN and
-- the constraint triggers take more), and a lock is held to COMMIT, so they
-- come after every function above and nothing slow follows them. A tighter
-- wait than the file's eight seconds: a DDL statement waiting on a hot table
-- makes every later writer wait behind it.
-- ===========================================================================

SET LOCAL lock_timeout = '3s';

-- DEFECT 1.
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS dealing_halt_observed_at timestamptz;

-- DEFECT 10. One ADD COLUMN per ALTER; a constant default is a catalogue
-- change, not a rewrite.
ALTER TABLE public.cash_cluster_events ADD COLUMN IF NOT EXISTS event_version smallint NOT NULL DEFAULT 1;
ALTER TABLE public.cash_cluster_events ADD COLUMN IF NOT EXISTS request_id uuid;

DO $hot$
BEGIN
  -- DEFECT 2: the anchor is a real seat. The table is empty in production, so
  -- validating it reads nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_pool_session'::regclass
                    AND conname = 'lightning_pool_session_anchor_seat_fkey') THEN
    ALTER TABLE public.lightning_pool_session
      ADD CONSTRAINT lightning_pool_session_anchor_seat_fkey
      FOREIGN KEY (anchor_seat_id) REFERENCES public.table_seats(id);
  END IF;

  -- DEFECT 4: the anchor guard. BEFORE UPDATE, and its WHEN clause admits only
  -- a change to the stack, the departure or the occupant, so a row update that
  -- touches none of them never reaches PL/pgSQL.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.table_seats'::regclass
                   AND tgname = 'trg_table_seats_lightning_anchor_guard') THEN
    CREATE TRIGGER trg_table_seats_lightning_anchor_guard
      BEFORE UPDATE ON public.table_seats
      FOR EACH ROW
      WHEN (OLD.stack IS DISTINCT FROM NEW.stack
            OR OLD.left_at IS DISTINCT FROM NEW.left_at
            OR OLD.user_id IS DISTINCT FROM NEW.user_id)
      EXECUTE FUNCTION public.fn_table_seats_lightning_anchor_guard();
  END IF;

  -- DEFECT 2: the pool follows the seat, deferred to commit. The WHEN clauses
  -- keep every ordinary stack update - a stack that stays above zero - from
  -- queueing anything at all.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.table_seats'::regclass
                   AND tgname = 'trg_table_seats_lightning_pool_on_insert') THEN
    CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_on_insert
      AFTER INSERT ON public.table_seats
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (NEW.left_at IS NULL AND NEW.user_id IS NOT NULL AND coalesce(NEW.stack, 0) > 0
            AND coalesce(NEW.is_sitting_out, false) = false
            AND coalesce(NEW.leave_pending, false) = false)
      EXECUTE FUNCTION public.fn_table_seats_lightning_pool_follows_seat();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.table_seats'::regclass
                   AND tgname = 'trg_table_seats_lightning_pool_follows_seat') THEN
    CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_follows_seat
      AFTER UPDATE ON public.table_seats
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (OLD.left_at IS DISTINCT FROM NEW.left_at
            OR OLD.user_id IS DISTINCT FROM NEW.user_id
            OR OLD.is_sitting_out IS DISTINCT FROM NEW.is_sitting_out
            OR OLD.leave_pending IS DISTINCT FROM NEW.leave_pending
            OR (coalesce(OLD.stack, 0) > 0) IS DISTINCT FROM (coalesce(NEW.stack, 0) > 0))
      EXECUTE FUNCTION public.fn_table_seats_lightning_pool_follows_seat();
  END IF;
END
$hot$;

-- THE ONE-TIME SWEEP. Anybody already seated, eligible, at a table of a
-- Cluster that is lightning when this file is applied - a player who sat down
-- after the conversion while nothing let them in - is entered through the same
-- door the triggers use from now on. Production has no lightning Cluster, so
-- this enters nobody there; an estate that has one is made whole.
DO $sweep$
DECLARE s record;
BEGIN
  FOR s IN
    SELECT ts.id
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
      JOIN public.cash_games g ON g.id = tb.cluster_id
     WHERE g.cluster_mode = 'lightning'
       AND public.fn_lightning_anchor_is_live_eligible(ts.id, g.id, ts.user_id)
       AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                        WHERE ps.cluster_id = g.id AND ps.player_id = ts.user_id AND ps.exited_at IS NULL)
     ORDER BY ts.joined_at, ts.id
  LOOP
    PERFORM public.fn_lightning_pool_enter(s.id);
  END LOOP;
END
$sweep$;

-- THREE TRIGGERS ON A MONEY TABLE, DECLARED IN THE MIGRATION THAT CREATES THEM.
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note) VALUES
  ('table_seats', 'trg_table_seats_lightning_anchor_guard',
   'Lightning remediation two (20260926045132). BEFORE UPDATE, WHEN stack, left_at or user_id changes: refuses (LIGHTNING_HAND_IN_PROGRESS, SQLSTATE PLT01) any change to a seat that anchors an open Lightning pool session whose player is in a live Lightning hand, unless ca.lightning_settlement_hand names that hand. Writes nothing; one index probe for every other seat.'),
  ('table_seats', 'trg_table_seats_lightning_pool_on_insert',
   'Lightning remediation two (20260926045132). Deferred AFTER INSERT, WHEN the seat is live eligible: enters the seat into the Lightning pool of a lightning-mode Cluster (fn_lightning_pool_enter). Writes lightning_pool_session, lightning_pool_slot and cash_cluster_events only; never a stack.'),
  ('table_seats', 'trg_table_seats_lightning_pool_follows_seat',
   'Lightning remediation two (20260926045132). Deferred AFTER UPDATE, WHEN left_at, user_id, is_sitting_out or leave_pending changes or the stack crosses zero: exits the pool session of an anchor that left or turned over and enters a seat that became eligible. Writes lightning_pool_session, lightning_pool_slot and cash_cluster_events only; never a stack.')
ON CONFLICT (table_name, trigger_name) DO NOTHING;

COMMENT ON COLUMN public.tables.dealing_halt_observed_at IS
  'When the engine last reported, through fn_cash_table_observe_dealing_halt from its halt gate between hands, that it has seen this table''s dealing halt. A halt is a stop only once dealing_halt_observed_at >= dealing_halted_at; fn_cash_cluster_commit_lightning waits for that on every member table with a live engine lease.';
COMMENT ON COLUMN public.cash_cluster_events.event_version IS
  'The version of the payload shape of this event kind. 1 for every kind written today.';
COMMENT ON COLUMN public.cash_cluster_events.request_id IS
  'The request id of the call that wrote this event, when the caller supplied one: the formation''s p_request_id, the conversion''s p_request_id (and the epoch it opened). NULL otherwise.';

-- THE POST-APPLY READ-BACK OF THE HOT HALF. What the catalogue now says, not
-- what this file meant.
DO $readback$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('tables.dealing_halt_observed_at', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.tables'::regclass
        AND attname = 'dealing_halt_observed_at' AND NOT attisdropped)),
    ('cash_cluster_events.event_version NOT NULL DEFAULT 1', EXISTS (SELECT 1 FROM pg_attribute a
        JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'public.cash_cluster_events'::regclass AND a.attname = 'event_version'
          AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = '1')),
    ('cash_cluster_events.request_id', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.cash_cluster_events'::regclass
        AND attname = 'request_id' AND NOT attisdropped)),
    ('the anchor foreign key', EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lightning_pool_session'::regclass
        AND contype = 'f' AND confrelid = 'public.table_seats'::regclass AND convalidated)),
    ('anchor_seat_id NOT NULL', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.lightning_pool_session'::regclass
        AND attname = 'anchor_seat_id' AND attnotnull)),
    ('the guard fires before update only when stack, left_at or user_id moves', EXISTS (SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_anchor_guard'
          AND (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 16) <> 0 AND t.tgenabled = 'O'
          AND pg_get_triggerdef(t.oid) ~ 'old\.stack IS DISTINCT FROM new\.stack'
          AND pg_get_triggerdef(t.oid) ~ 'old\.left_at IS DISTINCT FROM new\.left_at')),
    ('the two deferred pool triggers', (SELECT count(*) = 2 FROM pg_trigger t
        WHERE t.tgrelid = 'public.table_seats'::regclass
          AND t.tgname IN ('trg_table_seats_lightning_pool_on_insert', 'trg_table_seats_lightning_pool_follows_seat')
          AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O' AND t.tgqual IS NOT NULL)),
    ('the three declarations', (SELECT count(*) = 3 FROM public.ca_declared_money_triggers
        WHERE table_name = 'table_seats' AND trigger_name IN ('trg_table_seats_lightning_anchor_guard',
          'trg_table_seats_lightning_pool_on_insert', 'trg_table_seats_lightning_pool_follows_seat'))),
    ('service_role may delete no Lightning history', NOT (
        has_table_privilege('service_role', 'public.lightning_hand', 'DELETE')
        OR has_table_privilege('service_role', 'public.lightning_hand_player', 'DELETE')
        OR has_table_privilege('service_role', 'public.lightning_instance', 'DELETE')
        OR has_table_privilege('service_role', 'public.lightning_reservation', 'DELETE')
        OR has_table_privilege('service_role', 'public.lightning_pool_slot', 'DELETE')
        OR has_table_privilege('service_role', 'public.lightning_pool_session', 'DELETE')
        OR has_table_privilege('service_role', 'public.lightning_blind_ledger', 'DELETE')
        OR has_table_privilege('service_role', 'public.cash_cluster_conversion', 'DELETE')
        OR has_table_privilege('service_role', 'public.cash_cluster_conversion', 'TRUNCATE'))),
    ('no new body mentions a horse', NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND p.proname IN ('fn_cash_table_observe_dealing_halt', 'fn_lightning_anchor_is_live_eligible',
                            'fn_lightning_pool_stack', 'fn_lightning_player_in_hand', 'fn_lightning_pool_enter',
                            'fn_lightning_blind_ledger_debt_since', 'fn_table_seats_lightning_anchor_guard',
                            'fn_table_seats_lightning_pool_follows_seat')
          AND pg_get_functiondef(p.oid) ~ 'is_horse')),
    ('no browser role executes a new function', NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND p.proname IN ('fn_cash_table_observe_dealing_halt', 'fn_lightning_anchor_is_live_eligible',
                            'fn_lightning_pool_stack', 'fn_lightning_player_in_hand', 'fn_lightning_pool_enter',
                            'fn_lightning_form_hand', 'fn_table_seats_lightning_anchor_guard',
                            'fn_table_seats_lightning_pool_follows_seat')
          AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_REMEDIATION_TWO_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
