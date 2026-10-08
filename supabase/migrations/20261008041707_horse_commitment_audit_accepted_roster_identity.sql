-- 20261008041707_horse_commitment_audit_accepted_roster_identity.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Horse Brain Phase 14 open limit: "The daily audit still classifies by
-- current profile until it adopts the P14-A roster." The daily commitment
-- audit (fn_horse_commitment_audit_step) decided which seats were horses by
-- reading today's profiles.is_horse, so a profile changed after a hand was
-- accepted silently changed that hand's diagnostic population. Since P14-A
-- (20261007024757) the settlement door records, inside the acceptance
-- transaction, who was seated and whether each seat was a horse
-- (smarter_private.accepted_hand_rosters). This migration makes the audit
-- classify from that record and say, per day and per pass, which basis it
-- used.
--
--   1. public.horse_commitment_roster_epoch: one immutable row, the first
--      accepted roster ever captured (its captured_at, table, hand number and
--      hand id), read once here from the roster record. The door writes
--      hand_history.created_at and the roster's captured_at from the same
--      transaction clock (read back in production: equal for every roster
--      sampled, 0 rosters before 2026-10-07T12:20:42.398511Z, 0 hands without
--      one after it in the install window), so a hand created before the
--      epoch was accepted before the roster existed. RLS on, no API grants.
--   2. public.fn_horse_commitment_identity_basis(day, used_profile,
--      used_roster): the one naming rule for the step and the two readers:
--        'current_profile_is_horse'             only the current profile;
--        'accepted_roster'                      only the accepted roster;
--        'current_profile_then_accepted_roster' both (the epoch day, or a
--                                               pass that began under the
--                                               old body and reached rostered
--                                               hands).
--      A pass names what it actually used; one that has classified no hand
--      yet names the basis its first hand will use (accepted_roster when its
--      day starts at or after the epoch). The readers ask for the whole UTC
--      day (both flags NULL): which of the day's hands fall before and after
--      the epoch.
--   3. fn_horse_commitment_audit_step, preimage-guarded on the live body md5
--      418ef5b18e2470629130e5074790878e (read back from production on
--      2026-10-08 before this file was written), header and ACL. Per hand:
--        created_at < epoch       current profile, exactly as before
--                                 (the pre-roster fallback);
--        roster captured, bound to this hand id and accepted payload hash,
--        well formed             the roster's own horse/human/unknown
--                                 classification; profiles are not read;
--        roster 'unavailable'    named 'accepted_roster_unavailable', no
--                                 horse is classified for the hand;
--        roster well formed but not usable
--                                 named 'accepted_roster_invalid';
--        no roster row           named 'accepted_roster_legacy_missing' (the
--                                 producer's own word for a receipt with no
--                                 roster);
--        roster bound to another hand id or payload hash
--                                 named 'accepted_roster_mismatch'.
--      An unavailable, invalid, missing or mismatched roster is never
--      replaced by the current profile. A roster whose seated set differs
--      from the dealt players list still classifies by the roster and adds
--      'accepted_roster_players_disagree'. Four per-pass counters
--      (roster_identity_hands, profile_identity_hands,
--      roster_unavailable_hands, roster_missing_hands) always sum to
--      scanned_hands for a pass counted from its start; the day row and the
--      P14.3 pass receipt carry them and the basis. A pass already under way
--      at install began under the profile-only body: its counters stay NULL
--      and its basis can only be 'current_profile_is_horse' or, once it
--      reaches a rostered hand, 'current_profile_then_accepted_roster'. Every other guard,
--      cursor, receipt rule, prune, the batch size 256, lock_timeout 2s,
--      statement_timeout 5s and the return contract are unchanged.
--   4. horse_commitment_audit_days / _passes: the identity_basis CHECK admits
--      the three names; the counters are added NULL for existing rows (a pass
--      already under way was not counted from its start), 0 by default, and 0
--      on the day rows whose current pass has not scanned anything yet, which
--      also take the basis their first hand will use.
--   5. fn_horse_commitment_selection_receipt (live md5
--      24ac066dc355f768b16adb6078a80fd9) and fn_horse_commitment_review_page
--      (live md5 769ff23dd4d9473a772a78585b12349b): the top-level
--      identityBasis, which was the constant 'current_profile_is_horse', is
--      now the day's basis by the same rule over the whole UTC day. Nothing
--      else in either body changes.
--
-- WHAT THIS IS NOT. Not a repair job, sweep or backfill (CLAUDE.md 10.11,
-- 10.12): no review, gap or receipt row is rewritten and nothing is
-- re-driven; reviews already written keep their first-write content. The
-- step keeps its schedule and caller. Nothing here is coverage, population,
-- GTO or activation authority. Horses are players (10.5): is_horse and the
-- roster's classification are read only as identification, as before.
--
-- The one full read of smarter_private.accepted_hand_rosters (the epoch,
-- about 2 s on 2026-10-08) runs before any lock on the audit tables or
-- functions is taken, holding only ACCESS SHARE on the roster record, which
-- never blocks the settlement door's insert.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- No foreign key to any hot table.
--
-- @live-proof: (SELECT md5(prosrc)='0f09e8b00b60a88a81452163fe76d097' AND prosecdef AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_horse_commitment_audit_step()'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='705109c742385d8889886b6580343e5f' FROM pg_proc WHERE oid='public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='fda55f4218c93e1ecc1f87ca79e77ac8' FROM pg_proc WHERE oid='public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer)'::regprocedure)
-- @live-proof: (SELECT count(*)=1 FROM public.horse_commitment_roster_epoch)
-- @live-proof: (SELECT relrowsecurity FROM pg_class WHERE oid='public.horse_commitment_roster_epoch'::regclass)
-- @live-proof: NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,'public.horse_commitment_roster_epoch','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_function_privilege(r,'public.fn_horse_commitment_identity_basis(date,boolean,boolean)','EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';

DO $preimage$
DECLARE existing record; relation_name text; role_name text; relation_oid oid; missing text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_owner_required';
  END IF;
  IF to_regclass('public.horse_commitment_roster_epoch') IS NOT NULL
     OR to_regprocedure('public.fn_horse_commitment_identity_basis(date,boolean,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_horse_commitment_roster_epoch_immutable()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN (to_regclass('public.horse_commitment_audit_days'),
                  to_regclass('public.horse_commitment_audit_passes'))
                 AND attname IN ('roster_identity_hands','profile_identity_hands','roster_unavailable_hands',
                   'roster_missing_hands') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_already_installed';
  END IF;
  -- The step: exact live body, header and ACL.
  SELECT p.*, pg_get_userbyid(p.proowner) AS owner_name, l.lanname INTO existing
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure('public.fn_horse_commitment_audit_step()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_preimage_missing';
  END IF;
  IF md5(existing.prosrc) <> '418ef5b18e2470629130e5074790878e'
     OR existing.owner_name <> 'postgres'
     OR existing.prosecdef IS DISTINCT FROM true
     OR existing.lanname <> 'plpgsql'
     OR existing.prorettype <> 'jsonb'::regtype
     OR existing.proretset IS DISTINCT FROM false
     OR existing.prokind <> 'f'
     OR existing.provolatile <> 'v'
     OR existing.proisstrict IS DISTINCT FROM false
     OR existing.proleakproof IS DISTINCT FROM false
     OR existing.proparallel <> 'u'
     OR existing.procost <> 100
     OR existing.prorows <> 0
     OR existing.prosupport <> 0
     OR existing.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, public, pg_temp', 'lock_timeout=2s', 'statement_timeout=5s'
     ]::text[]
     OR ARRAY(SELECT item::text FROM unnest(existing.proacl) item ORDER BY item::text)
       IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
  THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_preimage_changed';
  END IF;
  -- The two readers: exact live bodies, headers and ACLs.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)')
      AND md5(prosrc)='24ac066dc355f768b16adb6078a80fd9' AND prosecdef AND proowner='postgres'::regrole
      AND provolatile='s' AND procost=100
      AND proconfig=ARRAY['search_path=pg_catalog, pg_temp','statement_timeout=3s','TimeZone=UTC']::text[]
      AND ARRAY(SELECT item::text FROM unnest(proacl) item ORDER BY item::text)
        =ARRAY['postgres=X/postgres','service_role=X/postgres']::text[])
    OR NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer)')
      AND md5(prosrc)='769ff23dd4d9473a772a78585b12349b' AND prosecdef AND proowner='postgres'::regrole
      AND provolatile='s' AND procost=100
      AND proconfig=ARRAY['search_path=pg_catalog, public, pg_temp','statement_timeout=3s','TimeZone=UTC']::text[]
      AND ARRAY(SELECT item::text FROM unnest(proacl) item ORDER BY item::text)
        =ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]) THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_reader_preimage_changed';
  END IF;
  -- The private audit tables and the roster record stay unreadable by every
  -- API role; this migration only changes definer functions over them.
  FOREACH relation_name IN ARRAY ARRAY['public.horse_commitment_audit_days','public.horse_commitment_reviews',
    'public.horse_commitment_audit_gaps','public.horse_commitment_audit_passes','smarter_private.accepted_hand_rosters'] LOOP
    relation_oid := to_regclass(relation_name);
    IF relation_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_class WHERE oid=relation_oid AND relrowsecurity
        AND relkind='r' AND pg_get_userbyid(relowner)='postgres'
    ) THEN
      RAISE EXCEPTION 'horse_commitment_roster_identity_private_schema_required: %', relation_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'horse_commitment_roster_identity_private_acl_changed: %', relation_name;
      END IF;
    END LOOP;
  END LOOP;
  -- Every roster column the step and the epoch read, with its type, and the
  -- two identity_basis CHECKs this file replaces, exactly.
  SELECT string_agg(want.col, ',') INTO missing
  FROM (VALUES ('table_id','uuid'),('hand_number','bigint'),('hand_id','uuid'),
    ('post_commit_payload_hash','text'),('status','text'),('roster','jsonb'),
    ('captured_at','timestamp with time zone')) want(col,typ)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a WHERE a.attrelid='smarter_private.accepted_hand_rosters'::regclass
      AND a.attname=want.col AND NOT a.attisdropped AND a.attnum>0 AND format_type(a.atttypid,NULL)=want.typ);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_roster_columns_changed: %', missing;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conname IN
        ('horse_commitment_audit_days_identity_basis_check','horse_commitment_audit_passes_identity_basis_check')
        AND pg_get_constraintdef(oid)='CHECK ((identity_basis = ''current_profile_is_horse''::text))')<>2 THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_basis_constraint_changed';
  END IF;
  -- The audit cannot adopt a roster that has never been captured.
  IF NOT EXISTS (SELECT 1 FROM smarter_private.accepted_hand_rosters) THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_no_accepted_roster';
  END IF;
END;
$preimage$;

-- ===========================================================================
-- 1. THE ROSTER EPOCH. The first accepted roster ever captured. Immutable.
--    Read once, before any lock on the audit tables or functions is taken.
-- ===========================================================================
CREATE TABLE public.horse_commitment_roster_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  first_captured_at timestamptz NOT NULL,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE public.horse_commitment_roster_epoch OWNER TO postgres;
ALTER TABLE public.horse_commitment_roster_epoch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_commitment_roster_epoch FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.horse_commitment_roster_epoch IS
  'The first accepted roster captured by the settlement door (P14-A). A hand created before first_captured_at was accepted before the roster existed and is the only hand the daily commitment audit classifies by the current profile. Written once by 20261008041707; immutable.';
INSERT INTO public.horse_commitment_roster_epoch(singleton,first_captured_at,table_id,hand_number,hand_id)
SELECT true,r.captured_at,r.table_id,r.hand_number,r.hand_id
FROM smarter_private.accepted_hand_rosters r
ORDER BY r.captured_at,r.table_id,r.hand_number LIMIT 1;

CREATE FUNCTION public.fn_horse_commitment_roster_epoch_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $immutable$
BEGIN
  RAISE EXCEPTION 'horse_commitment_roster_epoch_immutable' USING ERRCODE='55000';
END;
$immutable$;
ALTER FUNCTION public.fn_horse_commitment_roster_epoch_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_roster_epoch_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_commitment_roster_epoch_immutable BEFORE UPDATE OR DELETE ON public.horse_commitment_roster_epoch
  FOR EACH ROW EXECUTE FUNCTION public.fn_horse_commitment_roster_epoch_immutable();
CREATE TRIGGER horse_commitment_roster_epoch_no_truncate BEFORE TRUNCATE ON public.horse_commitment_roster_epoch
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_horse_commitment_roster_epoch_immutable();

-- ===========================================================================
-- 2. THE BASIS RULE. One function, used by the step and both readers.
-- ===========================================================================
CREATE FUNCTION public.fn_horse_commitment_identity_basis(p_day date,p_used_profile boolean,p_used_roster boolean)
RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $basis$
DECLARE epoch timestamptz; window_start timestamptz; window_end timestamptz;
BEGIN
  SELECT e.first_captured_at INTO epoch FROM public.horse_commitment_roster_epoch e WHERE e.singleton;
  IF epoch IS NULL OR p_day IS NULL OR num_nonnulls(p_used_profile,p_used_roster)=1 THEN
    RAISE EXCEPTION 'horse_commitment_identity_basis_unavailable';
  END IF;
  window_start:=p_day::timestamp AT TIME ZONE 'UTC';
  window_end:=(p_day+1)::timestamp AT TIME ZONE 'UTC';
  -- The whole UTC day: its hands before the epoch use the profile, its
  -- hands at or after it use the roster.
  IF p_used_profile IS NULL THEN
    p_used_profile:=window_start<epoch;
    p_used_roster:=window_end>epoch;
  END IF;
  IF p_used_profile AND p_used_roster THEN
    RETURN 'current_profile_then_accepted_roster';
  ELSIF p_used_roster THEN
    RETURN 'accepted_roster';
  ELSIF p_used_profile THEN
    RETURN 'current_profile_is_horse';
  END IF;
  -- Nothing classified yet: the basis the first hand of the day will use.
  RETURN CASE WHEN window_start>=epoch THEN 'accepted_roster' ELSE 'current_profile_is_horse' END;
END;
$basis$;
ALTER FUNCTION public.fn_horse_commitment_identity_basis(date,boolean,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_identity_basis(date,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- ===========================================================================
-- 3. DAY ROWS AND PASS RECEIPTS: the basis names and the identity counters.
-- ===========================================================================
ALTER TABLE public.horse_commitment_audit_days
  ADD COLUMN roster_identity_hands bigint,
  ADD COLUMN profile_identity_hands bigint,
  ADD COLUMN roster_unavailable_hands bigint,
  ADD COLUMN roster_missing_hands bigint;
ALTER TABLE public.horse_commitment_audit_days
  ALTER COLUMN roster_identity_hands SET DEFAULT 0,
  ALTER COLUMN profile_identity_hands SET DEFAULT 0,
  ALTER COLUMN roster_unavailable_hands SET DEFAULT 0,
  ALTER COLUMN roster_missing_hands SET DEFAULT 0,
  DROP CONSTRAINT horse_commitment_audit_days_identity_basis_check,
  ADD CONSTRAINT horse_commitment_audit_days_identity_basis_check CHECK (identity_basis IN
    ('current_profile_is_horse','accepted_roster','current_profile_then_accepted_roster')),
  ADD CONSTRAINT horse_commitment_audit_days_identity_counters CHECK (
    num_nonnulls(roster_identity_hands,profile_identity_hands,roster_unavailable_hands,roster_missing_hands) IN (0,4)
    AND (roster_identity_hands IS NULL OR (roster_identity_hands>=0 AND profile_identity_hands>=0
      AND roster_unavailable_hands>=0 AND roster_missing_hands>=0
      AND roster_identity_hands+profile_identity_hands+roster_unavailable_hands+roster_missing_hands=scanned_hands)));
-- A current pass that has scanned nothing yet is counted from its start and
-- names the basis its first hand will use. Every other row's pass was
-- scanned only by the profile-only body and keeps 'current_profile_is_horse'.
UPDATE public.horse_commitment_audit_days
  SET roster_identity_hands=0,profile_identity_hands=0,roster_unavailable_hands=0,roster_missing_hands=0,
    identity_basis=public.fn_horse_commitment_identity_basis(day,false,false)
  WHERE after_created_at IS NULL AND finished_at IS NULL AND scanned_hands=0;
REVOKE ALL ON public.horse_commitment_audit_days FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.horse_commitment_audit_passes
  ADD COLUMN roster_identity_hands bigint,
  ADD COLUMN profile_identity_hands bigint,
  ADD COLUMN roster_unavailable_hands bigint,
  ADD COLUMN roster_missing_hands bigint;
ALTER TABLE public.horse_commitment_audit_passes
  DROP CONSTRAINT horse_commitment_audit_passes_identity_basis_check,
  ADD CONSTRAINT horse_commitment_audit_passes_identity_basis_check CHECK (identity_basis IN
    ('current_profile_is_horse','accepted_roster','current_profile_then_accepted_roster')),
  ADD CONSTRAINT horse_commitment_audit_passes_identity_counters CHECK (
    num_nonnulls(roster_identity_hands,profile_identity_hands,roster_unavailable_hands,roster_missing_hands) IN (0,4)
    AND (roster_identity_hands IS NULL OR (roster_identity_hands>=0 AND profile_identity_hands>=0
      AND roster_unavailable_hands>=0 AND roster_missing_hands>=0
      AND roster_identity_hands+profile_identity_hands+roster_unavailable_hands+roster_missing_hands=scanned_hands)));
COMMENT ON TABLE public.horse_commitment_audit_passes IS
  'P14.3 immutable receipt of one completed daily commitment-audit pass, written by fn_horse_commitment_audit_step in the transaction that completes the pass. An observation only: source_coverage not_established. identity_basis names how the pass classified horse seats (current_profile_is_horse before the accepted-roster epoch, accepted_roster from it, current_profile_then_accepted_roster across it); the four identity counters are NULL only for a pass under way when they were added.';

-- ===========================================================================
-- 4. THE STEP. 20261007075304's body with the marked accepted-roster
--    additions; everything else is that body byte for byte.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_horse_commitment_audit_step()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='2s' SET statement_timeout='5s'
AS $fn$
DECLARE
  d public.horse_commitment_audit_days%ROWTYPE;
  h record; actor record; facts jsonb; contributions jsonb; refunds jsonb;
  source_ok boolean; roster_ok boolean; valid_money boolean;
  gaps text[]; reasons text[]; variant text; game_format text;
  net numeric; refund numeric; gross numeric; bb numeric; seats integer;
  scanned integer:=0; horses integer:=0; flagged integer:=0; unknowns integer:=0; gap_hands integer:=0;
  last_created timestamptz; last_id uuid; old_hash text; old_format text;
  -- P14.3 selection receipt: per-batch selection counters, the previous
  -- pass receipt of this day, and the clock read after the scan snapshot.
  no_commit integer:=0; missing_source integer:=0; late integer:=0;
  prior public.horse_commitment_audit_passes%ROWTYPE; scan_cutover timestamptz;
  -- Accepted roster identity: the epoch, this hand's basis, its horse seats
  -- and the per-batch identity counters (they sum to the hands scanned).
  epoch timestamptz; hand_basis text; actors jsonb; horse_ids uuid[]; horse_id uuid; actors_ok boolean;
  used_profile boolean; used_roster boolean;
  roster_hands integer:=0; profile_hands integer:=0; roster_unavailable integer:=0; roster_missing integer:=0;
  today date:=(transaction_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Separate owner from settlement: no source row locks or financial writes.
  -- One nonblocking transaction owns the cursor and every derived row/counter.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-commitment-audit-v1',0)) THEN
    RETURN jsonb_build_object('version',1,'status','busy','sourceCoverage','not_established','activationAuthorized',false);
  END IF;
  -- The first accepted roster ever captured. Hands created before it were
  -- accepted before the roster existed; no other hand reads the profile.
  SELECT e.first_captured_at INTO epoch FROM public.horse_commitment_roster_epoch e WHERE e.singleton;
  IF epoch IS NULL THEN
    RAISE EXCEPTION 'horse_commitment_roster_epoch_missing';
  END IF;
  INSERT INTO public.horse_commitment_audit_days(day,identity_basis)
    SELECT today-i,public.fn_horse_commitment_identity_basis(today-i,false,false)
    FROM generate_series(1,3) i ON CONFLICT DO NOTHING;
  SELECT * INTO d FROM public.horse_commitment_audit_days
    WHERE day BETWEEN today-3 AND today-1
      AND (finished_at IS NULL OR finished_at<transaction_timestamp()-interval '24 hours')
    ORDER BY (finished_at IS NOT NULL),day FOR UPDATE LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('version',1,'status','idle','sourceCoverage','not_established','activationAuthorized',false);
  END IF;
  IF d.finished_at IS NOT NULL THEN
    UPDATE public.horse_commitment_audit_days SET pass=pass+1,after_created_at=NULL,after_hand_id=NULL,
      started_at=transaction_timestamp(),finished_at=NULL,scanned_hands=0,horse_hands=0,
      flagged_horse_hands=0,unknown_horse_hands=0,hand_gaps=0,
      hands_without_commit=0,missing_source_hands=0,late_arrival_hands=0,
      roster_identity_hands=0,profile_identity_hands=0,roster_unavailable_hands=0,roster_missing_hands=0,
      identity_basis=public.fn_horse_commitment_identity_basis(d.day,false,false) WHERE day=d.day RETURNING * INTO d;
  END IF;
  -- The receipt of the immediately previous pass of this day, if one was
  -- recorded. No receipt means no late-arrival basis, never 'no late hands'.
  SELECT * INTO prior FROM public.horse_commitment_audit_passes WHERE day=d.day AND pass=d.pass-1;
  FOR h IN
    SELECT x.id,x.table_id,x.created_at,x.game_variant,x.big_blind,x.players,x.tournament_id,
      t.tournament_type,t.table_size,t.max_players,c.payload_hash,c.post_commit_payload_hash,
      c.hand_id AS commit_hand_id,c.committed_at,
      c.post_commit_payload,
      r.hand_id AS roster_hand_id,r.post_commit_payload_hash AS roster_payload_hash,
      r.status AS roster_status,r.roster
    FROM (
      SELECT id,table_id,created_at,game_variant,big_blind,players,tournament_id
      FROM public.hand_history
      WHERE created_at >= coalesce(d.after_created_at,d.day::timestamp AT TIME ZONE 'UTC')
        AND created_at < (d.day+1)::timestamp AT TIME ZONE 'UTC'
        AND (d.after_created_at IS NULL OR (created_at,id)>(d.after_created_at,d.after_hand_id))
      ORDER BY created_at,id LIMIT 256
    ) x
    LEFT JOIN public.hand_atomic_commits c ON c.hand_id=x.id AND c.table_id=x.table_id
    LEFT JOIN public.tournaments t ON t.id=x.tournament_id
    LEFT JOIN smarter_private.accepted_hand_rosters r
      ON x.created_at>=epoch AND r.table_id=c.table_id AND r.hand_number=c.hand_number
    ORDER BY x.created_at,x.id
  LOOP
    scanned:=scanned+1;last_created:=h.created_at;last_id:=h.id;
    gaps:=ARRAY[]::text[];facts:=NULL;contributions:=NULL;refunds:=NULL;
    source_ok:=false;roster_ok:=false;
    IF h.post_commit_payload IS NULL THEN gaps:=array_append(gaps,'accepted_commitment_facts_missing');
    ELSIF pg_column_size(h.post_commit_payload)>262144 THEN gaps:=array_append(gaps,'accepted_payload_oversized');
    ELSIF h.post_commit_payload_hash IS DISTINCT FROM encode(extensions.digest(convert_to(h.post_commit_payload::text,'UTF8'),'sha256'),'hex') THEN
      gaps:=array_append(gaps,'accepted_payload_digest_mismatch');
    ELSE
      facts:=h.post_commit_payload->'accepted_hand_facts';
      contributions:=facts->'contributions';refunds:=facts->'returned_uncalled';
      source_ok:=jsonb_typeof(contributions)='object' AND jsonb_typeof(refunds)='object';
      IF source_ok IS DISTINCT FROM true THEN gaps:=array_append(gaps,'accepted_commitment_facts_invalid'); END IF;
    END IF;
    -- No accepted commit row at all is named separately from a commit row
    -- without usable facts. Both are missing source; neither is skipped.
    IF h.commit_hand_id IS NULL THEN
      no_commit:=no_commit+1;gaps:=array_append(gaps,'hand_without_commit');
    END IF;
    IF h.post_commit_payload IS NULL OR pg_column_size(h.post_commit_payload)>262144 THEN
      missing_source:=missing_source+1;
    END IF;
    -- Late arrival: the previous completed pass of this day could not have
    -- seen this hand. Either it sorts after that pass's final cursor (that
    -- pass ended on a short batch, so it saw every row then visible past
    -- it), or its accepted commit clock is after that pass's cutover, a
    -- clock read after the pass's last scan snapshot. Sufficient, not
    -- complete: a hand committed late below an earlier batch's cursor but
    -- before the cutover is not provably late and is not labelled late.
    IF prior.pass IS NOT NULL AND (prior.final_after_created_at IS NULL
      OR (h.created_at,h.id)>(prior.final_after_created_at,prior.final_after_hand_id)
      OR h.committed_at>prior.cutover) THEN
      late:=late+1;gaps:=array_append(gaps,'late_arrival_after_pass:'||prior.pass);
    END IF;
    seats:=0;
    IF jsonb_typeof(h.players)='array' AND jsonb_array_length(h.players) BETWEEN 2 AND 10 THEN
      seats:=jsonb_array_length(h.players);
      SELECT count(*)=seats AND count(DISTINCT lower(p->>'userId'))=seats INTO roster_ok
        FROM jsonb_array_elements(h.players) p
        WHERE jsonb_typeof(p)='object' AND p->>'userId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
    END IF;
    IF NOT roster_ok THEN gaps:=array_append(gaps,'dealt_roster_invalid'); END IF;
    -- Accepted roster identity. A hand created before the epoch was accepted
    -- before any roster existed and is the only hand classified by today's
    -- profile. From the epoch on, the roster recorded in the acceptance
    -- transaction is the only identity source; an unusable or absent roster
    -- is named and classifies no horse, never falls back to the profile.
    hand_basis:=NULL;horse_ids:=ARRAY[]::uuid[];
    IF h.created_at<epoch THEN
      hand_basis:='current_profile_is_horse';profile_hands:=profile_hands+1;
    ELSIF h.roster_hand_id IS NULL THEN
      roster_missing:=roster_missing+1;gaps:=array_append(gaps,'accepted_roster_legacy_missing');
    ELSIF h.roster_hand_id IS DISTINCT FROM h.id OR h.roster_payload_hash IS DISTINCT FROM h.post_commit_payload_hash THEN
      roster_missing:=roster_missing+1;gaps:=array_append(gaps,'accepted_roster_mismatch');
    ELSIF h.roster_status IS DISTINCT FROM 'captured' THEN
      roster_unavailable:=roster_unavailable+1;gaps:=array_append(gaps,'accepted_roster_unavailable');
    ELSE
      actors:=h.roster->'actors';actors_ok:=false;
      IF h.roster->>'handId'=h.id::text AND h.roster->>'tableId'=h.table_id::text
        AND jsonb_typeof(actors)='array' AND jsonb_array_length(actors) BETWEEN 2 AND 10 THEN
        SELECT count(*)=jsonb_array_length(actors) AND count(DISTINCT lower(a->>'userId'))=jsonb_array_length(actors) INTO actors_ok
          FROM jsonb_array_elements(actors) a
          WHERE jsonb_typeof(a)='object' AND a->>'classification' IN ('horse','human','unknown')
            AND a->>'userId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
      END IF;
      IF actors_ok IS DISTINCT FROM true THEN
        roster_unavailable:=roster_unavailable+1;gaps:=array_append(gaps,'accepted_roster_invalid');
      ELSE
        hand_basis:='accepted_roster';roster_hands:=roster_hands+1;
        IF roster_ok AND ARRAY(SELECT lower(p->>'userId') FROM jsonb_array_elements(h.players) p ORDER BY 1)
          IS DISTINCT FROM ARRAY(SELECT lower(a->>'userId') FROM jsonb_array_elements(actors) a ORDER BY 1) THEN
          gaps:=array_append(gaps,'accepted_roster_players_disagree');
        END IF;
      END IF;
    END IF;
    bb:=h.big_blind;
    IF bb IS NULL OR bb::text IN ('NaN','Infinity','-Infinity') OR bb<=0 OR bb>90071992547409.91 OR round(bb,2)<>bb THEN
      bb:=NULL;gaps:=array_append(gaps,'big_blind_invalid');
    END IF;
    variant:=coalesce(h.game_variant,'unknown');
    game_format:=CASE WHEN h.tournament_id IS NULL THEN CASE WHEN seats=2 THEN 'hu_cash' ELSE 'cash' END
      WHEN upper(h.tournament_type) IN ('SPIN','SPIN_AND_GO','SPIN_AND_GOLD') THEN 'spin'
      WHEN upper(h.tournament_type) IN ('HU_SNG','HEADS_UP_SNG') THEN 'hu_sng'
      -- Actual createSNG emits SNG with both counts=2. Older canonical rows
      -- used the schema default table_size=9 but still declared max_players=2.
      -- This diagnostic recognizes only those reviewed shapes, never the
      -- current hand's remaining players. Missing/conflicting other shapes
      -- retain generic SNG; no historical format authority is inferred.
      WHEN upper(h.tournament_type)='SNG' AND h.max_players=2
        AND h.table_size IN (2,9) THEN 'hu_sng'
      WHEN upper(h.tournament_type)='SNG' THEN 'sng'
      WHEN upper(h.tournament_type) IN ('MTT','SATELLITE') THEN 'mtt'
      ELSE 'tournament_unknown' END;
    IF game_format='tournament_unknown' THEN gaps:=array_append(gaps,'tournament_format_unknown'); END IF;
    -- Generic SNG is retained when the current metadata cannot distinguish a
    -- reviewed HU shape from a field. This gap is an observation, not a repair
    -- of historical tournament configuration or an authority upgrade.
    IF upper(h.tournament_type)='SNG' AND ((
      (h.max_players=2 AND h.table_size IN (2,9)) OR
      (h.max_players>2 AND h.table_size BETWEEN 3 AND 10)
    ) IS DISTINCT FROM true) THEN
      gaps:=array_append(gaps,'tournament_format_metadata_unqualified');
    END IF;
    IF hand_basis='current_profile_is_horse' AND roster_ok THEN
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(h.players) p LEFT JOIN public.profiles pr ON pr.id=(p->>'userId')::uuid WHERE pr.id IS NULL OR pr.is_horse IS NULL) THEN
        gaps:=array_append(gaps,'horse_identity_unknown');
      END IF;
      horse_ids:=ARRAY(SELECT pr.id FROM jsonb_array_elements(h.players) p JOIN public.profiles pr ON pr.id=(p->>'userId')::uuid WHERE pr.is_horse IS TRUE ORDER BY pr.id);
    ELSIF hand_basis='accepted_roster' THEN
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(actors) a WHERE a->>'classification'='unknown') THEN
        gaps:=array_append(gaps,'horse_identity_unknown');
      END IF;
      horse_ids:=ARRAY(SELECT (a->>'userId')::uuid FROM jsonb_array_elements(actors) a WHERE a->>'classification'='horse' ORDER BY 1);
    END IF;
    FOREACH horse_id IN ARRAY horse_ids LOOP
        horses:=horses+1;net:=NULL;refund:=NULL;gross:=NULL;valid_money:=false;
        reasons:=ARRAY['decision_replay_not_matched','reference_not_matched'];
        IF source_ok IS TRUE AND jsonb_typeof(contributions->horse_id::text)='number'
          AND (NOT refunds ? horse_id::text OR jsonb_typeof(refunds->horse_id::text)='number') THEN
          net:=(contributions->>horse_id::text)::numeric;
          refund:=coalesce((refunds->>horse_id::text)::numeric,0);
          valid_money:=net>=0 AND refund>=0 AND net<=90071992547409.91 AND refund<=90071992547409.91
            AND round(net,2)=net AND round(refund,2)=refund AND net+refund<=90071992547409.91;
        END IF;
        IF valid_money AND bb IS NOT NULL THEN gross:=net+refund;
        ELSE reasons:=reasons||gaps||ARRAY['commitment_eligibility_unknown']; END IF;
        IF gross IS NULL OR gross>10*bb THEN
          IF gross IS NULL THEN unknowns:=unknowns+1; ELSE flagged:=flagged+1; END IF;
          INSERT INTO public.horse_commitment_reviews(hand_id,horse_user_id,table_id,played_at,source_payload_hash,game_variant,format,seats,big_blind,net_contribution,returned_uncalled,committed_amount,committed_bb,eligibility,reasons)
          VALUES(h.id,horse_id,h.table_id,h.created_at,h.post_commit_payload_hash,variant,game_format,seats,bb,
            CASE WHEN valid_money THEN net END,CASE WHEN valid_money THEN refund END,gross,gross/bb,
            CASE WHEN gross IS NULL THEN 'unknown' ELSE 'over_10bb' END,reasons)
          ON CONFLICT DO NOTHING;
          SELECT source_payload_hash,format INTO old_hash,old_format FROM public.horse_commitment_reviews WHERE hand_id=h.id AND horse_user_id=horse_id;
          IF old_hash IS DISTINCT FROM h.post_commit_payload_hash THEN gaps:=array_append(gaps,'review_source_changed'); END IF;
          -- Preserve the first review. Current metadata or a new classifier
          -- cannot silently rewrite a historical diagnostic's original label.
          IF old_format IS DISTINCT FROM game_format THEN gaps:=array_append(gaps,'review_format_changed'); END IF;
        END IF;
    END LOOP;
    IF cardinality(gaps)>0 THEN
      gap_hands:=gap_hands+1;
      INSERT INTO public.horse_commitment_audit_gaps(hand_id,played_at,reasons) VALUES(h.id,h.created_at,gaps)
        ON CONFLICT(hand_id) DO UPDATE SET reasons=ARRAY(SELECT DISTINCT v FROM unnest(public.horse_commitment_audit_gaps.reasons||excluded.reasons) v),observed_at=transaction_timestamp();
    END IF;
  END LOOP;
  -- Read after the scan's snapshot was taken, so a commit clock later than
  -- this proves the commit was invisible to every batch of this pass.
  scan_cutover:=clock_timestamp();
  -- The basis this pass has actually used. A pass under way before the
  -- identity counters existed (NULL) began under the profile-only body.
  IF d.roster_identity_hands IS NULL THEN
    used_profile:=true;
    used_roster:=d.identity_basis='current_profile_then_accepted_roster' OR roster_hands+roster_unavailable+roster_missing>0;
  ELSE
    used_profile:=d.profile_identity_hands+profile_hands>0;
    used_roster:=d.roster_identity_hands+d.roster_unavailable_hands+d.roster_missing_hands
      +roster_hands+roster_unavailable+roster_missing>0;
  END IF;
  UPDATE public.horse_commitment_audit_days SET after_created_at=coalesce(last_created,after_created_at),after_hand_id=coalesce(last_id,after_hand_id),
    last_batch_at=transaction_timestamp(),finished_at=CASE WHEN scanned<256 THEN transaction_timestamp() END,
    scanned_hands=scanned_hands+scanned,horse_hands=horse_hands+horses,flagged_horse_hands=flagged_horse_hands+flagged,
    unknown_horse_hands=unknown_horse_hands+unknowns,hand_gaps=hand_gaps+gap_hands,
    hands_without_commit=hands_without_commit+no_commit,missing_source_hands=missing_source_hands+missing_source,
    late_arrival_hands=late_arrival_hands+late,
    roster_identity_hands=roster_identity_hands+roster_hands,profile_identity_hands=profile_identity_hands+profile_hands,
    roster_unavailable_hands=roster_unavailable_hands+roster_unavailable,roster_missing_hands=roster_missing_hands+roster_missing,
    identity_basis=public.fn_horse_commitment_identity_basis(day,used_profile,used_roster)
    WHERE day=d.day RETURNING * INTO d;
  -- A completed pass leaves an immutable receipt in this same transaction,
  -- before any later re-pass can zero the day counters. A pass that began
  -- before receipts existed has NULL selection counters and gets none:
  -- its early batches were never counted, so no complete receipt exists.
  -- Its identity counters are NULL when it began before they existed; its
  -- basis is always named.
  IF scanned<256 AND d.hands_without_commit IS NOT NULL AND d.missing_source_hands IS NOT NULL
    AND d.late_arrival_hands IS NOT NULL THEN
    INSERT INTO public.horse_commitment_audit_passes(day,pass,window_start,window_end,cutover,
      max_scanned_created_at,final_after_created_at,final_after_hand_id,scanned_hands,horse_hands,
      flagged_horse_hands,unknown_horse_hands,hand_gaps,hands_without_commit,missing_source_hands,
      late_arrival_hands,started_at,finished_at,identity_basis,roster_identity_hands,profile_identity_hands,
      roster_unavailable_hands,roster_missing_hands)
    VALUES(d.day,d.pass,d.day::timestamp AT TIME ZONE 'UTC',(d.day+1)::timestamp AT TIME ZONE 'UTC',scan_cutover,
      d.after_created_at,d.after_created_at,d.after_hand_id,d.scanned_hands,d.horse_hands,
      d.flagged_horse_hands,d.unknown_horse_hands,d.hand_gaps,d.hands_without_commit,d.missing_source_hands,
      d.late_arrival_hands,d.started_at,d.finished_at,d.identity_basis,d.roster_identity_hands,d.profile_identity_hands,
      d.roster_unavailable_hands,d.roster_missing_hands)
    ON CONFLICT (day,pass) DO NOTHING;
  END IF;
  -- Prune only this diagnostic store, in bounded chunks. No source retention changes.
  DELETE FROM public.horse_commitment_reviews WHERE (hand_id,horse_user_id) IN
    (SELECT hand_id,horse_user_id FROM public.horse_commitment_reviews WHERE played_at<transaction_timestamp()-interval '32 days' ORDER BY played_at,hand_id LIMIT 4096);
  DELETE FROM public.horse_commitment_audit_gaps WHERE hand_id IN
    (SELECT hand_id FROM public.horse_commitment_audit_gaps WHERE played_at<transaction_timestamp()-interval '32 days' ORDER BY played_at,hand_id LIMIT 4096);
  DELETE FROM public.horse_commitment_audit_days WHERE day<today-35;
  RETURN jsonb_build_object('version',1,'status',CASE WHEN scanned<256 THEN 'pass_complete' ELSE 'recorded' END,
    'day',d.day,'scannedHands',scanned,'horseHands',horses,'flaggedHorseHands',flagged,'unknownHorseHands',unknowns,'handGaps',gap_hands,
    'sourceCoverage','not_established','activationAuthorized',false,'gtoVerdict','unverified');
END;
$fn$;
-- Unchanged ACL, restated so the file carries its own closure.
REVOKE ALL ON FUNCTION public.fn_horse_commitment_audit_step() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_commitment_audit_step() TO service_role;

-- ===========================================================================
-- 5. THE TWO READERS. Each is its installed body byte for byte except the
--    top-level identityBasis, which names the day's basis over its whole UTC
--    day instead of the constant 'current_profile_is_horse'.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_horse_commitment_selection_receipt(
  p_day date,p_after_played_at timestamptz DEFAULT NULL,p_after_hand_id uuid DEFAULT NULL,p_limit integer DEFAULT 8)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET statement_timeout='3s' SET timezone='UTC'
AS $reader$
DECLARE
  captured_at timestamptz:=statement_timestamp();
  d public.horse_commitment_audit_days%ROWTYPE;
  day_state jsonb:=NULL; passes jsonb; gaps jsonb:='[]'::jsonb; item jsonb; next_cursor jsonb:=NULL;
  r record; count_rows integer:=0; more boolean:=false; reasons text[]; result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'hcsr_role_required' USING ERRCODE='42501';
  END IF;
  IF p_day IS NULL OR p_day<DATE '2000-01-01' OR p_day>=DATE '2100-01-01'
    OR p_day>=(captured_at AT TIME ZONE 'UTC')::date OR p_limit IS DISTINCT FROM 8
    OR num_nonnulls(p_after_played_at,p_after_hand_id)=1
    OR (p_after_played_at IS NOT NULL AND (NOT isfinite(p_after_played_at)
      OR (p_after_played_at AT TIME ZONE 'UTC')::date<>p_day)) THEN
    RAISE EXCEPTION 'hcsr_selection_request_invalid';
  END IF;
  SELECT * INTO d FROM public.horse_commitment_audit_days WHERE day=p_day;
  IF FOUND THEN
    day_state:=jsonb_build_object('pass',d.pass,
      'startedAt',to_char(d.started_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'lastBatchAt',to_char(d.last_batch_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'finishedAt',to_char(d.finished_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'cursor',CASE WHEN d.after_created_at IS NULL THEN NULL ELSE jsonb_build_object(
        'createdAt',to_char(d.after_created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'handId',d.after_hand_id) END,
      'scannedHands',d.scanned_hands,'horseHands',d.horse_hands,'flaggedHorseHands',d.flagged_horse_hands,
      'unknownHorseHands',d.unknown_horse_hands,'handGaps',d.hand_gaps);
  END IF;
  -- Every receipt of the day, newest 32 at most, returned ascending.
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.pass),'[]'::jsonb) INTO passes FROM (
    SELECT p.pass,jsonb_build_object('pass',p.pass,
      'windowStart',to_char(p.window_start,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'windowEnd',to_char(p.window_end,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'cutover',to_char(p.cutover,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'maxScannedCreatedAt',to_char(p.max_scanned_created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'scannedHands',p.scanned_hands,'horseHands',p.horse_hands,'flaggedHorseHands',p.flagged_horse_hands,
      'unknownHorseHands',p.unknown_horse_hands,'handGaps',p.hand_gaps,
      'handsWithoutCommit',p.hands_without_commit,'missingSourceHands',p.missing_source_hands,
      'lateArrivalHands',p.late_arrival_hands,
      'finalCursor',CASE WHEN p.final_after_created_at IS NULL THEN NULL ELSE jsonb_build_object(
        'createdAt',to_char(p.final_after_created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'handId',p.final_after_hand_id) END,
      'startedAt',to_char(p.started_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'finishedAt',to_char(p.finished_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'sourceCoverage',p.source_coverage,'identityBasis',p.identity_basis) AS item
    FROM public.horse_commitment_audit_passes p WHERE p.day=p_day ORDER BY p.pass DESC LIMIT 32) x;
  -- Gap-only hands: a gap row with no review row. Reviewed hands already
  -- carry their gaps on fn_horse_commitment_review_page.
  FOR r IN
    SELECT g.hand_id,g.played_at,
      CASE WHEN pg_column_size(g.reasons)<=8192 AND cardinality(g.reasons) BETWEEN 1 AND 32
        AND array_ndims(g.reasons)=1 THEN g.reasons END AS reasons,
      (SELECT h.table_id FROM public.hand_history h WHERE h.id=g.hand_id LIMIT 1) AS table_id
    FROM public.horse_commitment_audit_gaps g
    WHERE g.played_at>=p_day::timestamp AT TIME ZONE 'UTC' AND g.played_at<(p_day+1)::timestamp AT TIME ZONE 'UTC'
      AND (p_after_played_at IS NULL OR (g.played_at,g.hand_id)>(p_after_played_at,p_after_hand_id))
      AND NOT EXISTS (SELECT 1 FROM public.horse_commitment_reviews q WHERE q.hand_id=g.hand_id)
    ORDER BY g.played_at,g.hand_id LIMIT 9
  LOOP
    count_rows:=count_rows+1;
    IF count_rows=9 THEN more:=true; EXIT; END IF;
    reasons:=r.reasons;
    IF reasons IS NULL OR EXISTS(SELECT 1 FROM unnest(reasons) x WHERE x IS NULL OR x='' OR octet_length(x)>160) THEN
      reasons:=ARRAY['daily_gap_reasons_unavailable'];
    END IF;
    next_cursor:=jsonb_build_object('playedAt',to_char(r.played_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'handId',r.hand_id);
    item:=jsonb_build_object('handId',r.hand_id,'tableId',r.table_id,'playedAt',next_cursor->'playedAt','reasons',to_jsonb(reasons));
    -- JSON escaping can expand otherwise bounded text; bound before the wire.
    IF octet_length(item::text)>4096 THEN
      item:=jsonb_build_object('handId',r.hand_id,'tableId',r.table_id,'playedAt',next_cursor->'playedAt',
        'reasons',jsonb_build_array('daily_gap_reasons_unavailable'));
    END IF;
    gaps:=gaps||jsonb_build_array(item);
  END LOOP;
  result:=jsonb_build_object('version',1,'source','horse_commitment_selection_receipt','day',p_day,
    'readAt',to_char(captured_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'limit',8,
    'after',CASE WHEN p_after_played_at IS NULL THEN NULL ELSE jsonb_build_object(
      'playedAt',to_char(p_after_played_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'handId',p_after_hand_id) END,
    'dayState',day_state,'passes',passes,'gaps',gaps,'hasMore',more,'next',next_cursor,
    'sourceCoverage','not_established','identityBasis',public.fn_horse_commitment_identity_basis(p_day,NULL,NULL),
    'gtoVerified',false,'activationAllowed',false);
  IF octet_length(result::text)>65536 THEN
    RAISE EXCEPTION 'hcsr_receipt_exceeds_bounds';
  END IF;
  RETURN result;
END;
$reader$;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_commitment_review_page(
 p_day date,p_after_played_at timestamptz DEFAULT NULL,p_after_hand_id uuid DEFAULT NULL,
 p_after_horse_user_id uuid DEFAULT NULL,p_limit integer DEFAULT 8)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET statement_timeout='3s' SET timezone='UTC'
AS $fn$
DECLARE r record; item jsonb; items jsonb:='[]'; last_cursor jsonb:=NULL;
 count_rows integer:=0; more boolean:=false; safe boolean; captured_at timestamptz:=statement_timestamp();
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'private_daily_reader_role_required' USING ERRCODE='42501'; END IF;
 IF p_day IS NULL OR p_day<DATE '2000-01-01' OR p_day>=DATE '2100-01-01'
  OR p_day>=(captured_at AT TIME ZONE 'UTC')::date OR p_limit IS DISTINCT FROM 8
  OR num_nonnulls(p_after_played_at,p_after_hand_id,p_after_horse_user_id) NOT IN (0,3)
  OR (p_after_played_at IS NOT NULL AND (NOT isfinite(p_after_played_at) OR (p_after_played_at AT TIME ZONE 'UTC')::date<>p_day))
 THEN RAISE EXCEPTION 'invalid_private_daily_page_request' USING ERRCODE='22023'; END IF;
 FOR r IN
  SELECT q.hand_id,q.horse_user_id,q.table_id,q.played_at,
   CASE WHEN octet_length(q.source_payload_hash)<=64 THEN q.source_payload_hash END AS hash,
   CASE WHEN octet_length(q.game_variant)<=64 THEN q.game_variant END AS variant,
   CASE WHEN octet_length(q.format)<=64 THEN q.format END AS format,
   q.eligibility,q.big_blind IS NULL AS bb_null,q.committed_bb IS NULL AS committed_null,
   CASE WHEN pg_column_size(q.big_blind)<=128 THEN CASE WHEN length(q.big_blind::text)<=64 THEN q.big_blind::text END END AS bb,
   CASE WHEN pg_column_size(q.committed_bb)<=128 THEN CASE WHEN length(q.committed_bb::text)<=64 THEN q.committed_bb::text END END AS committed,
   CASE WHEN pg_column_size(q.reasons)<=8192 AND cardinality(q.reasons)<=32 AND (cardinality(q.reasons)=0 OR array_ndims(q.reasons)=1) THEN q.reasons END AS reasons,
   CASE WHEN g.hand_id IS NULL THEN ARRAY[]::text[] WHEN pg_column_size(g.reasons)<=8192 AND cardinality(g.reasons)<=32 AND (cardinality(g.reasons)=0 OR array_ndims(g.reasons)=1) THEN g.reasons END AS gaps
  FROM public.horse_commitment_reviews q
  LEFT JOIN public.horse_commitment_audit_gaps g ON g.hand_id=q.hand_id
  WHERE q.played_at>=p_day::timestamp AT TIME ZONE 'UTC' AND q.played_at<(p_day+1)::timestamp AT TIME ZONE 'UTC'
   AND (p_after_played_at IS NULL OR (q.played_at,q.hand_id,q.horse_user_id)>(p_after_played_at,p_after_hand_id,p_after_horse_user_id))
  ORDER BY q.played_at,q.hand_id,q.horse_user_id LIMIT 9
 LOOP
  count_rows:=count_rows+1; IF count_rows=9 THEN more:=true; EXIT; END IF;
  last_cursor:=jsonb_build_object('playedAt',to_char(r.played_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'handId',r.hand_id,'horseId',r.horse_user_id);
  safe:=r.hash~'^[0-9a-f]{64}$' AND r.variant IS NOT NULL AND r.format IS NOT NULL
   AND r.reasons IS NOT NULL AND r.gaps IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM unnest(r.reasons||r.gaps) x WHERE x IS NULL OR octet_length(x)>160)
   AND (r.bb IS NOT NULL OR r.bb_null) AND (r.committed IS NOT NULL OR r.committed_null)
   AND (r.bb IS NULL OR r.bb~'^(0|[1-9][0-9]*)(\.[0-9]+)?$')
   AND (r.committed IS NULL OR r.committed~'^(0|[1-9][0-9]*)(\.[0-9]+)?$');
  item:=last_cursor||jsonb_build_object('tableId',r.table_id,'status','payload_unavailable','payloadHash',NULL,
   'variant',NULL,'format',NULL,'eligibility','unknown','bigBlind',NULL,'committedBb',NULL,
   'reasons',jsonb_build_array('daily_payload_unavailable'),'gaps',jsonb_build_array());
  IF safe IS TRUE THEN
   item:=last_cursor||jsonb_build_object('tableId',r.table_id,'status','retained_diagnostic','payloadHash',r.hash,
    'variant',r.variant,'format',r.format,'eligibility',r.eligibility,'bigBlind',r.bb,'committedBb',r.committed,
    'reasons',r.reasons,'gaps',r.gaps);
   -- JSON escaping can expand otherwise bounded strings; bound before aggregation/wire.
   IF octet_length(item::text)>6000 THEN
    item:=last_cursor||jsonb_build_object('tableId',r.table_id,'status','payload_unavailable','payloadHash',NULL,
     'variant',NULL,'format',NULL,'eligibility','unknown','bigBlind',NULL,'committedBb',NULL,
     'reasons',jsonb_build_array('daily_payload_unavailable'),'gaps',jsonb_build_array());
   END IF;
  END IF;
  items:=items||jsonb_build_array(item);
 END LOOP;
 RETURN jsonb_build_object('version',1,'source','horse_commitment_reviews','day',p_day,'limit',8,
  'after',CASE WHEN p_after_played_at IS NULL THEN NULL ELSE jsonb_build_object('playedAt',to_char(p_after_played_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'handId',p_after_hand_id,'horseId',p_after_horse_user_id) END,
  'readAt',to_char(captured_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'rows',items,'hasMore',more,'next',last_cursor,
  'dayObservation',CASE WHEN EXISTS(SELECT 1 FROM public.horse_commitment_audit_days WHERE day=p_day) THEN 'present' ELSE 'missing' END,
  'sourceCoverage','not_established','identityBasis',public.fn_horse_commitment_identity_basis(p_day,NULL,NULL),'gtoVerified',false,'activationAllowed',false);
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer) TO service_role;

-- ===========================================================================
-- POSTIMAGE. Abort the whole transaction unless what was installed is exact.
-- ===========================================================================
DO $postimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.fn_horse_commitment_audit_step()'::regprocedure
      AND md5(prosrc)='0f09e8b00b60a88a81452163fe76d097' AND prosecdef AND proowner='postgres'::regrole
      AND provolatile='v' AND procost=100
      AND proconfig=ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=2s','statement_timeout=5s']::text[]
      AND ARRAY(SELECT item::text FROM unnest(proacl) item ORDER BY item::text)
        =ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]) THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_postimage_step';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)'::regprocedure
      AND md5(prosrc)='705109c742385d8889886b6580343e5f' AND prosecdef AND proowner='postgres'::regrole AND provolatile='s'
      AND proconfig=ARRAY['search_path=pg_catalog, pg_temp','statement_timeout=3s','TimeZone=UTC']::text[]
      AND ARRAY(SELECT item::text FROM unnest(proacl) item ORDER BY item::text)
        =ARRAY['postgres=X/postgres','service_role=X/postgres']::text[])
    OR NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer)'::regprocedure
      AND md5(prosrc)='fda55f4218c93e1ecc1f87ca79e77ac8' AND prosecdef AND proowner='postgres'::regrole AND provolatile='s'
      AND proconfig=ARRAY['search_path=pg_catalog, public, pg_temp','statement_timeout=3s','TimeZone=UTC']::text[]
      AND ARRAY(SELECT item::text FROM unnest(proacl) item ORDER BY item::text)
        =ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]) THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_postimage_readers';
  END IF;
  IF (SELECT count(*) FROM public.horse_commitment_roster_epoch)<>1
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
          AND tgrelid='public.horse_commitment_roster_epoch'::regclass)<>2
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.horse_commitment_roster_epoch'::regclass)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      CROSS JOIN unnest(ARRAY['public.horse_commitment_roster_epoch','public.horse_commitment_audit_passes',
        'public.horse_commitment_audit_days']) t
      WHERE has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES')
        OR has_function_privilege(r,'public.fn_horse_commitment_identity_basis(date,boolean,boolean)','EXECUTE')) THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_postimage_epoch';
  END IF;
  -- Every existing day row names the basis its pass has used: a counted
  -- pass by its counters, a pass under way at install the profile-only body.
  IF EXISTS (SELECT 1 FROM public.horse_commitment_audit_days
      WHERE identity_basis IS DISTINCT FROM CASE WHEN roster_identity_hands IS NULL THEN 'current_profile_is_horse'
        ELSE public.fn_horse_commitment_identity_basis(day,profile_identity_hands>0,
          roster_identity_hands+roster_unavailable_hands+roster_missing_hands>0) END) THEN
    RAISE EXCEPTION 'horse_commitment_roster_identity_postimage_day_basis';
  END IF;
END;
$postimage$;

-- Invalidate only the gateway schema cache after this transaction commits.
NOTIFY pgrst, 'reload schema';
COMMIT;
