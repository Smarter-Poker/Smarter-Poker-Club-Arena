-- Disposable minimal schema for exact maintenance helpers. No production migration.
ALTER TABLE tournaments ADD COLUMN addon_period_ends_at timestamptz,ADD COLUMN on_break boolean DEFAULT false;
ALTER TABLE tables ADD COLUMN bomb_pot_next_due_at timestamptz,ADD COLUMN break_eligible_since timestamptz,ADD COLUMN cluster_id uuid;
CREATE TABLE table_seats(id uuid PRIMARY KEY,left_at timestamptz,sit_out_at timestamptz);
CREATE TABLE table_waitlist(id uuid PRIMARY KEY,hold_expires_at timestamptz);
CREATE TABLE chip_transactions(id uuid PRIMARY KEY,reversible_until timestamptz);
CREATE TABLE tournament_bounty_awards(id uuid PRIMARY KEY,reveal_deadline_at timestamptz);
CREATE TABLE tournament_players(id uuid PRIMARY KEY,rebuy_prompt_until timestamptz);
CREATE TABLE cash_player_session(id uuid PRIMARY KEY,closed_at timestamptz,stay_running boolean,stay_last_tick_at timestamptz);
CREATE TABLE cash_rejoin_constraints(id uuid PRIMARY KEY,expires_at timestamptz);
CREATE TABLE cash_seat_moves(id uuid PRIMARY KEY,state text,expires_at timestamptz);
CREATE TABLE engine_presence_parked(table_id uuid PRIMARY KEY,parked_at timestamptz,disconnect_states jsonb);
CREATE TABLE hand_state_snapshots(id uuid PRIMARY KEY,is_complete boolean,updated_at timestamptz,disconnect_states jsonb);
CREATE TABLE engine_maintenance_thaws(freeze_started_at timestamptz PRIMARY KEY,thawed_at timestamptz DEFAULT now(),
 frozen_seconds numeric,shifted jsonb,thawed_by text,announced_at timestamptz,ownership_token uuid,
 contract_version integer,release_target_at timestamptz,release_generation integer DEFAULT 0);
CREATE TABLE engine_maintenance_thaw_targets(freeze_started_at timestamptz,step text,target_id uuid,
 credited_seconds numeric NOT NULL DEFAULT 0,PRIMARY KEY(freeze_started_at,step,target_id));
CREATE TABLE audit_clock_epochs(tournament_id uuid PRIMARY KEY,epoch_id uuid UNIQUE NOT NULL,
 base_anchor timestamptz NOT NULL,local_credited numeric NOT NULL DEFAULT 0);
CREATE TABLE audit_clock_pauses(tournament_id uuid NOT NULL,epoch_id uuid NOT NULL,owner_id uuid PRIMARY KEY,
 kind text NOT NULL,started_at timestamptz NOT NULL,ended_at timestamptz,credit_applied numeric,CHECK(ended_at IS NULL OR ended_at>=started_at));
CREATE TABLE audit_clock_thaw_epoch_bindings(freeze_started_at timestamptz,tournament_id uuid,epoch_id uuid NOT NULL,
 PRIMARY KEY(freeze_started_at,tournament_id));
CREATE TABLE audit_clock_thaw_windows(freeze_started_at timestamptz PRIMARY KEY,closed boolean NOT NULL DEFAULT false);
CREATE FUNCTION audit_bind_clock_thaw_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.step='level_started_at' THEN
  INSERT INTO audit_clock_thaw_epoch_bindings
  SELECT NEW.freeze_started_at,e.tournament_id,e.epoch_id FROM audit_clock_epochs e
  WHERE e.tournament_id=NEW.target_id ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER audit_bind_clock_epoch AFTER INSERT ON engine_maintenance_thaw_targets
 FOR EACH ROW EXECUTE FUNCTION audit_bind_clock_thaw_epoch();

-- Audit wrapper supplies the parent-write transaction witness to the earlier protocol candidate.
-- It is not a proposed production service authorization interface.
CREATE FUNCTION audit_allow_clock_write(p_event uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO audit_clock_operations VALUES(v_id,p_event,0,pg_current_xact_id(),NULL);RETURN v_id;
END $$;
CREATE FUNCTION audit_finish_clock_write(p_id uuid) RETURNS void LANGUAGE sql AS $$
 UPDATE audit_clock_operations SET result='{"audit_only":true}' WHERE id=p_id
$$;
CREATE FUNCTION audit_apply_thaw(p_start timestamptz,p_seconds numeric,p_mode text,p_close boolean)
 RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_event uuid;v_id uuid;v_ids uuid[]:='{}';v_result jsonb;
BEGIN
 -- The real outer authority uses the exclusive maintenance gate. This fixture
 -- does not replace its ownership, scheduling, freeze or release predicates.
 PERFORM pg_advisory_xact_lock(530090,1);
 IF p_mode NOT IN ('broad','suffix') OR p_seconds<=0 THEN RAISE EXCEPTION 'invalid audit thaw';END IF;
 IF EXISTS(SELECT 1 FROM audit_clock_thaw_windows WHERE freeze_started_at=p_start AND closed) THEN
  IF EXISTS(SELECT 1 FROM engine_maintenance_thaws WHERE freeze_started_at=p_start AND frozen_seconds=p_seconds) THEN
   RETURN jsonb_build_object('replayed',true);
  END IF;
  RAISE EXCEPTION 'CLOCK_THAW_ALREADY_CLOSED' USING ERRCODE='55000';
 END IF;
 FOR v_event IN SELECT tournament_id FROM audit_clock_epochs ORDER BY tournament_id LOOP
  PERFORM audit_clock_event_gate(ARRAY[v_event],true);
  v_id:=audit_allow_clock_write(v_event);v_ids:=array_append(v_ids,v_id);
 END LOOP;
 IF EXISTS(SELECT 1 FROM audit_clock_thaw_epoch_bindings b JOIN audit_clock_epochs e USING(tournament_id)
 WHERE b.freeze_started_at=p_start AND b.epoch_id<>e.epoch_id) THEN
  RAISE EXCEPTION 'CLOCK_THAW_EPOCH_MISMATCH' USING ERRCODE='55000';
 END IF;
 INSERT INTO audit_clock_thaw_windows VALUES(p_start,false) ON CONFLICT DO NOTHING;
 INSERT INTO engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted)
 VALUES(p_start,p_seconds,'{}') ON CONFLICT DO NOTHING;
 IF NOT COALESCE((SELECT (shifted->>'_targets_snapshotted')::boolean FROM engine_maintenance_thaws WHERE freeze_started_at=p_start),false) THEN
  PERFORM fn_snapshot_maintenance_thaw_targets(p_start,p_seconds);
 END IF;
 IF p_mode='broad' THEN
  v_result:=fn_thaw_platform_checkpointed(p_start,p_seconds,'clock audit');
  -- This re-expresses the target-marking predicate in the captured five-argument
  -- outer authority, after a completed broad checkpoint.
  UPDATE engine_maintenance_thaw_targets x SET credited_seconds=t.frozen_seconds
  FROM engine_maintenance_thaws t WHERE x.freeze_started_at=p_start AND t.freeze_started_at=p_start
  AND x.credited_seconds<t.frozen_seconds AND (
   (x.step<>'level_started_at' AND t.shifted?x.step)
   OR (x.step='level_started_at' AND (t.shifted?'level_started_at'
    OR x.target_id<=NULLIF(t.shifted->>'level_started_at_cursor','')::uuid)));
 ELSE
  UPDATE engine_maintenance_thaws SET frozen_seconds=p_seconds,release_target_at=p_start+make_interval(secs=>p_seconds),
   release_generation=release_generation+1,shifted=shifted-'complete' WHERE freeze_started_at=p_start;
  v_result:=fn_credit_maintenance_thaw_targets(p_start,p_seconds);
 END IF;
 IF p_close THEN
  IF NOT COALESCE((v_result->>'complete')::boolean,false) THEN RAISE EXCEPTION 'CLOCK_THAW_INCOMPLETE';END IF;
  UPDATE audit_clock_thaw_windows SET closed=true WHERE freeze_started_at=p_start;
 END IF;
 FOREACH v_id IN ARRAY v_ids LOOP PERFORM audit_finish_clock_write(v_id);END LOOP;
 RETURN v_result;
END $$;

CREATE FUNCTION audit_local_pause_credit(p_event uuid,p_at timestamptz) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE v_epoch audit_clock_epochs%ROWTYPE;v_local tstzmultirange;v_maintenance tstzmultirange;v_total numeric;
BEGIN
 SELECT * INTO STRICT v_epoch FROM audit_clock_epochs WHERE tournament_id=p_event;
 SELECT COALESCE(range_agg(tstzrange(greatest(p.started_at,v_epoch.base_anchor),least(COALESCE(p.ended_at,p_at),p_at),'[)')),'{}')
 INTO v_local FROM audit_clock_pauses p WHERE p.tournament_id=p_event AND p.epoch_id=v_epoch.epoch_id
 AND greatest(p.started_at,v_epoch.base_anchor)<least(COALESCE(p.ended_at,p_at),p_at);
 SELECT COALESCE(range_agg(tstzrange(x.freeze_started_at,x.freeze_started_at+make_interval(secs=>x.credited_seconds),'[)')),'{}')
 INTO v_maintenance FROM engine_maintenance_thaw_targets x
 JOIN audit_clock_thaw_epoch_bindings b ON b.freeze_started_at=x.freeze_started_at AND b.tournament_id=x.target_id
 WHERE x.step='level_started_at' AND x.target_id=p_event AND b.epoch_id=v_epoch.epoch_id;
 SELECT COALESCE(sum(extract(epoch FROM upper(r)-lower(r))),0) INTO v_total FROM unnest(v_local-v_maintenance)r;
 RETURN v_total;
END $$;
CREATE FUNCTION audit_close_pause(p_owner uuid,p_end timestamptz) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE v_pause audit_clock_pauses%ROWTYPE;v_epoch audit_clock_epochs%ROWTYPE;v_due numeric;v_op uuid;
BEGIN
 SELECT * INTO STRICT v_pause FROM audit_clock_pauses WHERE owner_id=p_owner;
 PERFORM audit_clock_event_gate(ARRAY[v_pause.tournament_id],true);
 SELECT * INTO STRICT v_pause FROM audit_clock_pauses WHERE owner_id=p_owner FOR UPDATE;
 SELECT * INTO STRICT v_epoch FROM audit_clock_epochs WHERE tournament_id=v_pause.tournament_id FOR UPDATE;
 IF v_pause.epoch_id<>v_epoch.epoch_id THEN RAISE EXCEPTION 'CLOCK_PAUSE_EPOCH_MISMATCH' USING ERRCODE='55000';END IF;
 IF v_pause.ended_at IS NOT NULL THEN
  IF v_pause.ended_at<>p_end THEN RAISE EXCEPTION 'CLOCK_PAUSE_CLOSE_CONFLICT' USING ERRCODE='22023';END IF;
  RETURN v_pause.credit_applied;
 END IF;
 IF EXISTS(SELECT 1 FROM audit_clock_thaw_windows WHERE NOT closed AND freeze_started_at<p_end) THEN
  RAISE EXCEPTION 'CLOCK_THAW_NOT_FINAL' USING ERRCODE='55000';
 END IF;
 UPDATE audit_clock_pauses SET ended_at=p_end WHERE owner_id=p_owner;
 v_due:=audit_local_pause_credit(v_pause.tournament_id,p_end)-v_epoch.local_credited;
 IF v_due<0 THEN RAISE EXCEPTION 'CLOCK_PAUSE_CREDIT_WENT_BACKWARD' USING ERRCODE='55000';END IF;
 v_op:=audit_allow_clock_write(v_pause.tournament_id);
 UPDATE tournaments SET level_started_at=level_started_at+make_interval(secs=>v_due) WHERE id=v_pause.tournament_id;
 UPDATE audit_clock_epochs SET local_credited=local_credited+v_due WHERE tournament_id=v_pause.tournament_id;
 UPDATE audit_clock_pauses SET credit_applied=v_due WHERE owner_id=p_owner;
 PERFORM audit_finish_clock_write(v_op);RETURN v_due;
END $$;
