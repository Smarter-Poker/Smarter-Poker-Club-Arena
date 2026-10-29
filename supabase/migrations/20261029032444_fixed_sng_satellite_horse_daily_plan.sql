-- Preparation only: private metadata/functions; no live roster relation lock.
-- Paired daily activation: 20261029034842_activate_fixed_sng_satellite_horse_paid_guard.sql.
-- Owner October29: a union-wide handful of horse-assisted fixed satellite starts,
-- spread randomly through each Chicago day, then a paid max-1 human-entry wait.
-- Persist 120-150 seconds; the existing 30-second engine tick completes the
-- nominal 120-180-second opportunity without adding a new timer.
-- Previous producer filled every board. Admission now belongs to the same roster
-- transaction that already pays the ordinary entry; a failed purchase rolls its
-- claim back. No wallet writer, settlement, prize, rake or human entry is changed.
-- Random plans and first-paid claims survive engine restarts. Missed slots expire.
-- No FK on hot gameplay relations. Pause wait time using the durable v3 thaw
-- interval ledger; overlapping receipts are merged and expired waits never reopen.
-- @live-proof: to_regprocedure('public.fn_sng_satellite_horse_fill_plan(uuid)') IS NOT NULL
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE smarter_private.sng_horse_days (
 union_id uuid NOT NULL, local_day date NOT NULL, slots jsonb NOT NULL,
 PRIMARY KEY(union_id,local_day),
 CHECK(jsonb_array_length(slots) BETWEEN 3 AND 5)
);
CREATE TABLE smarter_private.sng_horse_claims (
 tournament_id uuid PRIMARY KEY, union_id uuid NOT NULL, local_day date NOT NULL,
 slot integer, first_paid_at timestamptz NOT NULL, wait_seconds integer NOT NULL,
 legacy boolean NOT NULL DEFAULT false,
 CHECK(wait_seconds BETWEEN 0 AND 150),
 CHECK(legacy OR wait_seconds BETWEEN 120 AND 150),
 UNIQUE(union_id,local_day,slot)
);
ALTER TABLE smarter_private.sng_horse_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.sng_horse_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.sng_horse_days,smarter_private.sng_horse_claims FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.sng_horse_wait_until(p_first timestamptz,p_seconds integer)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $fn$
DECLARE deadline timestamptz:=p_first+make_interval(secs=>p_seconds); pause tstzrange;
BEGIN
 -- The live freeze predicate refuses admission throughout an active/unfinished
 -- owner. Only completed v3 intervals are credited here. The notice boundary is
 -- conservative: purchase freeze may begin 30 seconds before announced_at.
 FOR pause IN SELECT unnest(range_agg(tstzrange(
   greatest(p_first,least(coalesce(h.announced_at-interval '30 seconds',h.freeze_started_at),h.freeze_started_at)),
   h.release_target_at,'[)')))
 FROM public.engine_maintenance_thaws h
 WHERE h.contract_version=3 AND h.release_target_at IS NOT NULL
   AND coalesce((h.shifted->>'complete')::boolean,false)
   AND h.release_target_at>p_first
   AND least(coalesce(h.announced_at-interval '30 seconds',h.freeze_started_at),h.freeze_started_at)<h.release_target_at
 LOOP
   IF lower(pause)<deadline THEN deadline:=deadline+(upper(pause)-lower(pause)); END IF;
 END LOOP;
 RETURN deadline;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.sng_horse_wait_until(timestamptz,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.sng_horse_plan(p_tournament_id uuid,p_claim boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE t public.tournaments%ROWTYPE; c smarter_private.sng_horse_claims%ROWTYPE;
 d date; now_at timestamptz:=clock_timestamp(); day_start timestamptz; day_end timestamptz;
 slots jsonb; n integer; i integer; due timestamptz; expires timestamptz;
 first_at timestamptz; deadline timestamptz; claimed integer; chosen integer;
 players integer; target integer; chosen_board uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'SNG_HORSE_PLAN_REQUIRES_READ_COMMITTED' USING ERRCODE='0A000'; END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 IF public.fn_entry_purchases_frozen() THEN
   RETURN jsonb_build_object('ok',false,'target_players',0,'reason','platform_frozen','wait_until',NULL); END IF;
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id FOR NO KEY UPDATE;
 IF NOT FOUND OR public.fn_ca_is_fixed_sng_satellite(to_jsonb(t)) IS NOT TRUE
   OR t.format_contract<>'sng-v1' OR t.union_id IS NULL
   OR upper(coalesce(t.status,'')) NOT IN('ANNOUNCED','REGISTERING') THEN
   RETURN jsonb_build_object('ok',false,'target_players',0,'reason','not_registering_fixed_satellite','wait_until',NULL); END IF;
 SELECT * INTO c FROM smarter_private.sng_horse_claims WHERE tournament_id=t.id;
 IF NOT FOUND THEN
   -- An already bought promise is honoured, including boards admitted before
   -- installation or yesterday. It still counts against its actual first day.
   SELECT min(coalesce(tp.registered_at,now_at)) INTO first_at FROM public.tournament_players tp
     JOIN public.profiles h ON h.id=tp.user_id AND h.is_horse IS TRUE
     WHERE tp.tournament_id=t.id;
   IF first_at IS NOT NULL THEN
     INSERT INTO smarter_private.sng_horse_claims(tournament_id,union_id,local_day,first_paid_at,wait_seconds,legacy)
       VALUES(t.id,t.union_id,(first_at AT TIME ZONE 'America/Chicago')::date,first_at,0,true)
       ON CONFLICT(tournament_id) DO NOTHING;
     SELECT * INTO c FROM smarter_private.sng_horse_claims WHERE tournament_id=t.id;
   END IF;
 END IF;
 IF c.tournament_id IS NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.tournaments target_row
     WHERE target_row.id=coalesce(t.satellite_target_id,t.satellite_target)
       AND upper(coalesce(target_row.status,'')) IN('ANNOUNCED','REGISTERING')
       AND target_row.start_time IS NOT NULL AND isfinite(target_row.start_time)
       AND target_row.start_time>now_at
       AND public.fn_ca_satellite_target_accepts_new_feeder(target_row.id) IS TRUE) THEN
     RETURN jsonb_build_object('ok',false,'target_players',0,'reason','target_unavailable','wait_until',NULL); END IF;
   d:=(now_at AT TIME ZONE 'America/Chicago')::date;
   -- All paths own the tournament admission row before this nonblocking union
   -- day lock. Another board gets a bounded busy refusal, never a lock cycle.
   IF NOT pg_try_advisory_xact_lock(hashtextextended('ca:sng-horse-day:'||t.union_id::text||':'||d::text,0)) THEN
     RETURN jsonb_build_object('ok',false,'target_players',0,'reason','union_day_busy','wait_until',NULL); END IF;
   SELECT x.slots INTO slots FROM smarter_private.sng_horse_days x WHERE union_id=t.union_id AND local_day=d;
   IF NOT FOUND THEN
     -- A refused paid transaction cannot persist a random draw. The service
     -- planning RPC commits the day first; old callers fail closed until then.
     IF p_claim THEN RETURN jsonb_build_object('ok',false,'target_players',0,'reason','plan_not_initialized','wait_until',NULL); END IF;
     day_start:=d::timestamp AT TIME ZONE 'America/Chicago';
     day_end:=(d+1)::timestamp AT TIME ZONE 'America/Chicago';
     n:=3+floor(random()*3)::integer; slots:='[]'::jsonb;
     FOR i IN 0..n-1 LOOP
       -- Actual local midnight endpoints handle 23/25-hour DST days. Every
       -- stratum has one random opening and a finite <=20-minute opportunity.
       due:=day_start+(day_end-day_start)*((i+random()*0.8)/n);
       expires:=least(due+interval '20 minutes',day_start+(day_end-day_start)*((i+1)::numeric/n));
       slots:=slots||jsonb_build_array(jsonb_build_object('slot',i,'due',due,'expires',expires));
     END LOOP;
     INSERT INTO smarter_private.sng_horse_days VALUES(t.union_id,d,slots);
     -- Existing natural paid boards count once even if completed/withdrawn.
     INSERT INTO smarter_private.sng_horse_claims(tournament_id,union_id,local_day,first_paid_at,wait_seconds,legacy)
       SELECT old.id,t.union_id,d,min(coalesce(tp.registered_at,now_at)),0,true
       FROM public.tournaments old JOIN public.tournament_players tp ON tp.tournament_id=old.id
       JOIN public.profiles h ON h.id=tp.user_id AND h.is_horse IS TRUE
       WHERE old.union_id=t.union_id AND old.format_contract='sng-v1'
         AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(old))
       GROUP BY old.id HAVING (min(coalesce(tp.registered_at,now_at)) AT TIME ZONE 'America/Chicago')::date=d
       ON CONFLICT(tournament_id) DO NOTHING;
   END IF;
   now_at:=clock_timestamp();
   SELECT count(*) INTO claimed FROM smarter_private.sng_horse_claims WHERE union_id=t.union_id AND local_day=d;
   IF claimed>=jsonb_array_length(slots) THEN
     RETURN jsonb_build_object('ok',false,'target_players',0,'reason','daily_budget','wait_until',NULL); END IF;
   SELECT (s->>'slot')::integer INTO chosen FROM jsonb_array_elements(slots)s
     WHERE (s->>'due')::timestamptz<=now_at AND (s->>'expires')::timestamptz>now_at
       AND NOT EXISTS(SELECT 1 FROM smarter_private.sng_horse_claims x
         WHERE x.union_id=t.union_id AND x.local_day=d AND x.slot=(s->>'slot')::integer)
     ORDER BY (s->>'slot')::integer LIMIT 1;
   IF chosen IS NULL THEN
     RETURN jsonb_build_object('ok',false,'target_players',0,'reason','no_current_slot','wait_until',NULL); END IF;
   chosen_board:=NULLIF(slots->chosen->>'tournament_id','')::uuid;
   IF chosen_board IS NULL THEN
     IF p_claim THEN RETURN jsonb_build_object('ok',false,'target_players',0,'reason','choice_not_initialized','wait_until',NULL); END IF;
     SELECT candidate.id INTO chosen_board FROM public.tournaments candidate
     JOIN public.tournaments target_row ON target_row.id=coalesce(candidate.satellite_target_id,candidate.satellite_target)
     WHERE candidate.union_id=t.union_id AND candidate.format_contract='sng-v1'
       AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(candidate))
       AND upper(coalesce(candidate.status,'')) IN('ANNOUNCED','REGISTERING')
       AND coalesce(candidate.current_players,0)<candidate.max_players
       AND upper(coalesce(target_row.status,'')) IN('ANNOUNCED','REGISTERING')
       AND target_row.start_time IS NOT NULL AND isfinite(target_row.start_time) AND target_row.start_time>now_at
       AND public.fn_ca_satellite_target_accepts_new_feeder(target_row.id) IS TRUE
       AND NOT EXISTS(SELECT 1 FROM smarter_private.sng_horse_claims x WHERE x.tournament_id=candidate.id)
       AND NOT EXISTS(SELECT 1 FROM public.tournament_players tp JOIN public.profiles h ON h.id=tp.user_id AND h.is_horse IS TRUE WHERE tp.tournament_id=candidate.id)
     ORDER BY random() LIMIT 1;
     IF chosen_board IS NOT NULL THEN
       slots:=jsonb_set(slots,ARRAY[chosen::text,'tournament_id'],to_jsonb(chosen_board));
       UPDATE smarter_private.sng_horse_days day_row SET slots=jsonb_set(day_row.slots,ARRAY[chosen::text,'tournament_id'],to_jsonb(chosen_board))
         WHERE day_row.union_id=t.union_id AND day_row.local_day=d;
     END IF;
   END IF;
   IF chosen_board IS DISTINCT FROM t.id THEN
     RETURN jsonb_build_object('ok',false,'target_players',0,'reason','different_random_board','wait_until',NULL); END IF;
   IF p_claim THEN
     INSERT INTO smarter_private.sng_horse_claims(tournament_id,union_id,local_day,slot,first_paid_at,wait_seconds)
       VALUES(t.id,t.union_id,d,chosen,now_at,120+floor(random()*31)::integer) RETURNING * INTO c;
   ELSE
     RETURN jsonb_build_object('ok',true,'target_players',t.max_players-1,'reason','preseed','wait_until',NULL);
   END IF;
 END IF;
 deadline:=CASE WHEN c.legacy THEN c.first_paid_at ELSE smarter_private.sng_horse_wait_until(c.first_paid_at,c.wait_seconds) END;
 target:=CASE WHEN deadline>now_at THEN t.max_players-1 ELSE t.max_players END;
 SELECT count(*) INTO players FROM public.tournament_players WHERE tournament_id=t.id AND status IN('registered','playing');
 IF p_claim AND players>=target THEN
   RAISE EXCEPTION 'SNG_HORSE_HUMAN_WAIT: paid roster must reserve its human chair' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('ok',true,'target_players',target,
   'reason',CASE WHEN deadline>now_at THEN 'human_wait' ELSE 'fill' END,'wait_until',deadline);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.sng_horse_plan(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_sng_satellite_horse_fill_plan(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
 -- Preparation precedes the actual roster-trigger lock in the daily window.
 -- Engine doors may see the RPC early, but no automated entry is permitted
 -- until the exact authoritative guard is installed and enabled normally.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g
   WHERE g.tgrelid='public.tournament_players'::regclass
     AND g.tgname='ca_fixed_sng_horse_paid_admission'
     AND g.tgfoid='public.fn_ca_fixed_sng_horse_paid_admission()'::regprocedure
     AND g.tgtype=7 AND g.tgenabled='O' AND NOT g.tgisinternal
     AND g.tgnargs=0 AND g.tgqual IS NULL AND g.tgconstraint=0) THEN
   RETURN jsonb_build_object('ok',false,'target_players',0,'reason','guard_not_installed','wait_until',NULL); END IF;
 RETURN smarter_private.sng_horse_plan(p_tournament_id,false);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_sng_satellite_horse_fill_plan(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sng_satellite_horse_fill_plan(uuid) TO service_role;

CREATE FUNCTION public.fn_ca_fixed_sng_horse_paid_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE plan jsonb;
BEGIN
 IF coalesce(NEW.status,'') NOT IN('registered','playing') THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=NEW.user_id AND is_horse IS TRUE)
   OR NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=NEW.tournament_id
     AND t.format_contract='sng-v1' AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(t))) THEN RETURN NEW; END IF;
 plan:=smarter_private.sng_horse_plan(NEW.tournament_id,true);
 IF coalesce((plan->>'ok')::boolean,false) IS NOT TRUE THEN
   RAISE EXCEPTION 'SNG_HORSE_ADMISSION: %',plan->>'reason' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_fixed_sng_horse_paid_admission() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
