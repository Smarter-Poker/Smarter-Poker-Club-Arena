-- 20261012040851_tournament_chat_is_off_by_default.sql
--
-- TOURNAMENT CHAT IS OFF BY DEFAULT; SPINS AND SIT N GOS MAY CHAT
-- (Dan, 2026-10-11 22:02 CDT). Full account:
-- docs/changelog/2026-10-11-tournament-chat-off-by-default.md.
--
-- Dan: "Off by default for all tournaments. Spins and Sit N Gos can have chat
-- on." and yes, existing schedules and tournaments are switched too. Every
-- tournament that is not a Spin (tournament_type SPIN) and not a Sit N Go
-- (SNG, heads-up included) starts with table chat banned: MTTs, satellites,
-- freerolls, bounty, progressive and mystery bounty events. It is a default,
-- not a lock: a caller that says banChat false is honoured.
--
-- Measured on production (kuklfnapbkmacvwxktbh), read-only, 2026-10-12
-- 04:00-04:10 UTC:
--   * Created in the last 14 days: 1,927 MTT-family events (838 SATELLITE
--     and 1,089 MTT rows) and 0 with chat banned. 1,428 of them came from no
--     schedule: the engine's recurring creator inserts tournaments WITHOUT a
--     ban_chat column, so the column default (false) decided. The schedule
--     spawner writes ban_chat = asBool(config.banChat), and none of the 338
--     tournament_schedules rows carries banChat. fn_create_tournament's
--     governed creator writes COALESCE((p_config->>'banChat')::boolean, false).
--   * tournament_schedules: 338 rows, 337 MTT-family (none target-linked to a
--     Sit N Go), 1 Spin; 0 carry banChat; 0 belong to a retired club.
--   * Not-yet-started MTT-family tournaments (status ANNOUNCED or REGISTERING)
--     with chat on: 104 (51 chip MTT, 41 Diamond MTT, 12 Diamond SATELLITE),
--     103 of them with registrants, 0 in a retired club, 0 whose union or club
--     the ownership trigger would move. 12 running ones (RUNNING) are left
--     alone, as is everything LATE_REG, COMPLETING, COMPLETED or CANCELLED.
--
-- WHAT THIS DOES, in one transaction, without an engine release:
--   1. tournaments.ban_chat loses its column default, and the BEFORE INSERT
--      trigger a00_tournaments_chat_default fills a ban_chat the INSERT did not
--      supply: true unless tournament_type is SPIN or SNG. The column stays
--      NOT NULL (checked after BEFORE triggers), so an omitted value is now
--      the only thing that can arrive as NULL, and an explicit false or true
--      is never touched. It is named to fire first, before
--      a1_tournaments_restart_source compares a restart clone with its source.
--   2. fn_create_tournament_governed_legacy (behind fn_create_tournament)
--      defaults an absent banChat by the type it is writing:
--      COALESCE((p_config->>'banChat')::boolean, v_type NOT IN ('sng','spin')).
--      One counted substitution over production's live body, md5-pinned
--      before and after; owner, SECURITY DEFINER, search_path and grants kept.
--   3. tournament_schedules gets the BEFORE INSERT OR UPDATE OF config trigger
--      a00_tournament_schedules_chat_default: an MTT-family config without a
--      banChat (absent or null) is given banChat true, so the spawner's
--      explicit asBool(config.banChat) bans chat on every future spawn. A
--      Spin or Sit N Go config (type spin, sng, hu_sng or heads_up, not linked
--      to a satellite target, exactly the spawner's rule) is left alone.
--   4. Existing schedules: every MTT-family config without banChat gets
--      banChat true (337 measured). Nothing else in the row changes.
--   5. Existing tournaments: every ANNOUNCED or REGISTERING MTT-family event
--      with chat on gets ban_chat true (104 measured). The update runs under
--      the service role for these statements only (precedent 20261002014954),
--      because fn_guard_managed_game_lifecycle locks a registered event's terms
--      for every other caller; no other column may move, which is checked row
--      by row, and the migration refuses if any did.
--
-- Not changed: fn_create_tournament (the wrapper), the engine, the chat
-- readers (fn_table_chat_is_silenced, useTableChat). A restart-every clone
-- copies its completed source's ban_chat because a1_tournaments_restart_source
-- requires the copy; completed rows are history and are not rewritten.
--
-- Replay-safe: a re-run finds the postimage and installs nothing twice, and the
-- data steps only touch rows still missing the flag. If the hourly break
-- window (:50-:03 UTC) refuses it, run it once after :03.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_create_tournament_governed_legacy(uuid,jsonb)'::regprocedure)) = '3d40ead690de9769287475c206341668')
-- @live-proof: (SELECT NOT a.atthasdef AND a.attnotnull FROM pg_attribute a WHERE a.attrelid = 'public.tournaments'::regclass AND a.attname = 'ban_chat' AND NOT a.attisdropped)
-- @live-proof: (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgenabled = 'O' AND ((t.tgrelid = 'public.tournaments'::regclass AND t.tgname = 'a00_tournaments_chat_default') OR (t.tgrelid = 'public.tournament_schedules'::regclass AND t.tgname = 'a00_tournament_schedules_chat_default')))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.tournament_schedules s WHERE NOT public.fn_ca_schedule_config_keeps_chat(s.config) AND COALESCE(s.config -> 'banChat', 'null'::jsonb) = 'null'::jsonb AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.club_id AND c.lifecycle_status = 'retired')))

BEGIN;
SET LOCAL lock_timeout = '1500ms';
SET LOCAL statement_timeout = '120s';

-- tournaments is the engine's hottest table. Take its lock first, alone, in
-- short bounded attempts, so no writer waits more than one attempt behind
-- this transaction (20261001204429). Everything after it is short.
DO $lock$
DECLARE attempt int;
BEGIN
  FOR attempt IN 1..40 LOOP
    BEGIN
      LOCK TABLE public.tournament_schedules IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE;
      RAISE NOTICE 'tournament_chat_default: tables locked on attempt %', attempt;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(0.4);
    END;
  END LOOP;
  RAISE EXCEPTION 'TOURNAMENT_CHAT_DEFAULT_LOCK: tournaments could not be locked in 40 bounded attempts'
    USING ERRCODE = '55P03';
END
$lock$;

-- 1 and 3. The classifier and the two default triggers.

-- The scheduled spawner's own rule (ScheduledTournamentService.buildInsertRow
-- and isUnlimitedMtt): a Spin or a Sit N Go label keeps chat, unless the
-- config names a satellite target, which makes the spawn an MTT satellite.
CREATE OR REPLACE FUNCTION public.fn_ca_schedule_config_keeps_chat(p_config jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $function$
  SELECT jsonb_typeof(p_config) = 'object'
     AND lower(btrim(COALESCE(p_config ->> 'type', 'mtt'))) IN ('spin', 'sng', 'hu_sng', 'heads_up')
     AND NOT (
          btrim(CASE WHEN jsonb_typeof(p_config -> 'satellite_target_id') = 'string' THEN p_config ->> 'satellite_target_id' ELSE '' END) <> ''
       OR btrim(CASE WHEN jsonb_typeof(p_config -> 'satelliteTargetId') = 'string' THEN p_config ->> 'satelliteTargetId' ELSE '' END) <> ''
       OR EXISTS (
            SELECT 1
              FROM (VALUES (p_config -> 'satellite_target'), (p_config -> 'satelliteTarget')) AS t(v)
             WHERE (jsonb_typeof(t.v) = 'string' AND btrim(t.v #>> '{}') <> '')
                OR (jsonb_typeof(t.v) = 'object'
                    AND (btrim(CASE WHEN jsonb_typeof(t.v -> 'tournamentId') = 'string' THEN t.v ->> 'tournamentId' ELSE '' END) <> ''
                      OR btrim(CASE WHEN jsonb_typeof(t.v -> 'tournament_id') = 'string' THEN t.v ->> 'tournament_id' ELSE '' END) <> ''))))
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_schedule_config_keeps_chat(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_schedule_config_keeps_chat(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_chat_default()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  -- TOURNAMENT CHAT IS OFF BY DEFAULT (2026-10-11). ban_chat has no column
  -- default, so NULL here means the INSERT did not say. Only a Spin or a Sit
  -- N Go starts with chat on; an explicit value is never changed.
  IF NEW.ban_chat IS NULL THEN
    NEW.ban_chat := upper(btrim(COALESCE(NEW.tournament_type, ''))) NOT IN ('SPIN', 'SNG');
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_chat_default() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_schedule_chat_default()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  -- TOURNAMENT CHAT IS OFF BY DEFAULT (2026-10-11). The spawner writes
  -- ban_chat = asBool(config.banChat), so an MTT-family config that does not
  -- say is given banChat true here. A Spin or a Sit N Go config, and any
  -- config that says (true or false), is left exactly as written.
  IF jsonb_typeof(NEW.config) = 'object'
     AND COALESCE(NEW.config -> 'banChat', 'null'::jsonb) = 'null'::jsonb
     AND NOT public.fn_ca_schedule_config_keeps_chat(NEW.config) THEN
    NEW.config := jsonb_set(NEW.config, '{banChat}', 'true'::jsonb, true);
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_schedule_chat_default() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.tournaments ALTER COLUMN ban_chat DROP DEFAULT;

CREATE OR REPLACE TRIGGER a00_tournaments_chat_default
  BEFORE INSERT ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_chat_default();

CREATE OR REPLACE TRIGGER a00_tournament_schedules_chat_default
  BEFORE INSERT OR UPDATE OF config ON public.tournament_schedules
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_schedule_chat_default();

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('tournaments', 'a00_tournaments_chat_default',
        'Tournament chat is off by default (20261012040851): fills ban_chat only when an INSERT omits it, true unless SPIN or SNG; reads and writes no money column')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

-- 2. The governed creator's default.
DO $creator$
DECLARE
  v_oid oid := 'public.fn_create_tournament_governed_legacy(uuid,jsonb)'::regprocedure;
  v_def text := pg_get_functiondef('public.fn_create_tournament_governed_legacy(uuid,jsonb)'::regprocedure);
  v_meta jsonb;
  v_anchor text := $a$    COALESCE((p_config->>'banChat')::boolean, false),
$a$;
  v_new text := $w$    -- TOURNAMENT CHAT IS OFF BY DEFAULT (2026-10-11): unless the host says,
    -- only a Spin or a Sit N Go starts with chat on.
    COALESCE((p_config->>'banChat')::boolean, v_type NOT IN ('sng', 'spin')),
$w$;
  v_n int;
BEGIN
  IF md5(v_def) = '3d40ead690de9769287475c206341668' THEN
    RAISE NOTICE 'fn_create_tournament_governed_legacy already carries the chat default; skipping';
    RETURN;
  END IF;
  IF md5(v_def) <> 'bf284ab7932447a7d2e49a1fa7deb9d8' THEN
    RAISE EXCEPTION 'TOURNAMENT_CHAT_DEFAULT_PREIMAGE_CHANGED: fn_create_tournament_governed_legacy md5 %', md5(v_def)
      USING ERRCODE = '55000';
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'TOURNAMENT_CHAT_DEFAULT_ANCHOR: found % time(s)', v_n USING ERRCODE = '55000';
  END IF;
  SELECT to_jsonb(p) - 'prosrc' INTO v_meta FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE replace(v_def, v_anchor, v_new);
  IF md5(pg_get_functiondef(v_oid)) <> '3d40ead690de9769287475c206341668' THEN
    RAISE EXCEPTION 'TOURNAMENT_CHAT_DEFAULT_POSTIMAGE: fn_create_tournament_governed_legacy md5 %',
      md5(pg_get_functiondef(v_oid)) USING ERRCODE = '55000';
  END IF;
  IF (SELECT to_jsonb(p) - 'prosrc' FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_meta THEN
    RAISE EXCEPTION 'TOURNAMENT_CHAT_DEFAULT_METADATA: the creator''s owner, grants or settings moved'
      USING ERRCODE = '55000';
  END IF;
END
$creator$;

-- 4. Existing schedules: an MTT-family config that does not say gets banChat
-- true. Retired clubs are read-only (fn_guard_retired_club_mutation); none
-- was measured, and they are left as they are.
UPDATE public.tournament_schedules s
   SET config = jsonb_set(s.config, '{banChat}', 'true'::jsonb, true)
 WHERE jsonb_typeof(s.config) = 'object'
   AND COALESCE(s.config -> 'banChat', 'null'::jsonb) = 'null'::jsonb
   AND NOT public.fn_ca_schedule_config_keeps_chat(s.config)
   AND NOT EXISTS (SELECT 1 FROM public.clubs c
                    WHERE c.id = s.club_id AND c.lifecycle_status = 'retired');

-- 5. Existing tournaments that have not started.
DO $existing$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_rows int;
BEGIN
  SELECT COALESCE(jsonb_object_agg(t.id::text, to_jsonb(t) - 'ban_chat'), '{}'::jsonb)
    INTO v_before
    FROM public.tournaments t
   WHERE t.status IN ('ANNOUNCED', 'REGISTERING')
     AND upper(btrim(COALESCE(t.tournament_type, ''))) NOT IN ('SPIN', 'SNG')
     AND t.ban_chat IS NOT TRUE
     AND NOT EXISTS (SELECT 1 FROM public.clubs c
                      WHERE c.id = t.club_id AND c.lifecycle_status = 'retired');

  -- The platform's own identity for these statements only: the managed-game
  -- lifecycle guard keeps a registered event's terms for every other caller.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  UPDATE public.tournaments t
     SET ban_chat = true
   WHERE t.id IN (SELECT k::uuid FROM jsonb_object_keys(v_before) AS k);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT COALESCE(jsonb_object_agg(t.id::text, to_jsonb(t) - 'ban_chat'), '{}'::jsonb)
    INTO v_after
    FROM public.tournaments t
   WHERE t.id IN (SELECT k::uuid FROM jsonb_object_keys(v_before) AS k);
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'TOURNAMENT_CHAT_DEFAULT_SIDE_EFFECT: a column other than ban_chat moved'
      USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'tournament_chat_default: % not-yet-started tournament(s) switched to chat off', v_rows;
END
$existing$;

COMMIT;
