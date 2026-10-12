-- 20261007075304_horse_commitment_selection_receipts.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Horse Brain Phase 14.3 (plan package P14-B), database half. The daily
-- commitment audit (fn_horse_commitment_audit_step) is a bounded diagnostic
-- scan. Before this migration it could not say what one finished pass had
-- actually seen: a re-pass after 24 hours ZEROED the day counters, so every
-- earlier pass's counts were lost; a hand that reached hand_history after a
-- pass had finished was indistinguishable from one the pass had read; a hand
-- with no accepted commit was only a gap label; and the review reader showed
-- reviews only, so gap-only hands were invisible to the daily batch. The
-- batch also had no way to fetch the raw accepted row its exporter consumes.
--
--   1. public.horse_commitment_audit_passes: one immutable receipt per
--      completed (day, pass), written by the step in the SAME transaction
--      that completes the pass, before any later re-pass can reset the day
--      counters. It records the window, a cutover clock read after the final
--      scan snapshot, the final cursor (= the greatest scanned created_at),
--      every counter, start/finish, and pins source_coverage
--      'not_established' and identity_basis 'current_profile_is_horse'.
--      The identity basis is today's profiles.is_horse because the P14-A
--      accepted roster is NOT yet the audit's basis; this receipt says so
--      rather than implying otherwise. UPDATE, DELETE and TRUNCATE are
--      refused. RLS on, no API-role privileges, like the other three tables.
--   2. horse_commitment_audit_days gains three per-pass selection counters
--      (hands_without_commit, missing_source_hands, late_arrival_hands).
--      They are added NULL for existing rows and default 0 for new rows: a
--      pass that began before this migration was never counted from its
--      start, so it completes WITHOUT a receipt instead of with a partial one.
--      Its next re-pass resets them to 0 and is receipted from then on.
--   3. fn_horse_commitment_audit_step, preimage-guarded (exact live body md5,
--      header, owner, ACL). The body is the 20260917051350 body byte for byte
--      except four marked additions: the commit identity/clock is selected;
--      no-commit and missing/oversized-payload hands are counted (they keep
--      their existing gap rows; a hand with no commit row also gets
--      'hand_without_commit'); a hand the previous completed pass of the same
--      day could not have seen (it sorts after that pass's final cursor, or
--      its accepted commit clock is after that pass's cutover) is counted
--      late and gets the gap reason 'late_arrival_after_pass:<n>'; and the
--      receipt is written when a pass completes. The return contract (version
--      1, sourceCoverage 'not_established') is unchanged, key for key.
--      The late rule is SUFFICIENT, NOT COMPLETE: a hand committed late below
--      an earlier batch's cursor but before the cutover is not provably late,
--      is not labelled late, and source coverage stays not_established.
--   4. fn_horse_commitment_selection_receipt(p_day, p_after_played_at,
--      p_after_hand_id, p_limit=8): service-role-only, STABLE reader of the
--      day row, every pass receipt of the day (at most 32, ascending), and
--      one bounded page of gap-only hand coordinates (gap rows with no review
--      row), so the batch can emit explicit missing-source and late rows.
--   5. fn_horse_accepted_source_rows(p_hands): service-role-only, STABLE,
--      read-only. For 1..8 {hand_id, table_id} coordinates it returns exactly
--      the raw row ACCEPTED_SOURCE_SELECT (server/src/services/
--      horseAcceptedRoster/exporter.ts) describes, with the same joins and
--      size bounds, plus hand_submissions.lease_generation (null when there
--      is no retained submission), read in ONE statement. It never returns a
--      hand that was not asked for. Malformed input is refused with P0001
--      'hcsr_*'.
--
-- WHAT THIS IS NOT. Not a repair job, sweep or backfill (CLAUDE.md 10.11,
-- 10.12): no historical row is rewritten and nothing is re-driven. The step
-- keeps its existing schedule and caller. Receipts are observations, never
-- coverage, population or GTO authority. Horses are not excluded from
-- anything (10.5); is_horse is read only as identification, as before.
--
-- PREIMAGE (fn_horse_commitment_audit_step). md5(prosrc) 45ffa0eff534e385828b0316bd4268e8
-- is the md5 of the exact text between the $fn$ delimiters of
-- 20260917051350_horse_commitment_reviews_preserve_format_and_canonical_rosters.sql
-- (that migration's own guard admits it as the r2 postimage). It was derived
-- from the repository text, not read from production: the lead must re-read
-- the live md5(prosrc), header and ACL before merge. The header and ACL
-- guarded below are the ones 20260917051350 itself guards and re-creates.
-- POSTIMAGE md5(prosrc): 418ef5b18e2470629130e5074790878e
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- No foreign key to any hot table; the only relations locked are the four
-- private diagnostic tables this audit already owns.
--
-- @live-proof: (SELECT md5(prosrc)='418ef5b18e2470629130e5074790878e' AND prosecdef AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_horse_commitment_audit_step()'::regprocedure)
-- @live-proof: (SELECT relrowsecurity FROM pg_class WHERE oid='public.horse_commitment_audit_passes'::regclass)
-- @live-proof: NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,'public.horse_commitment_audit_passes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
-- @live-proof: (SELECT has_function_privilege('service_role','public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)','EXECUTE'))
-- @live-proof: (SELECT has_function_privilege('service_role','public.fn_horse_accepted_source_rows(jsonb)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_horse_accepted_source_rows(jsonb)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_horse_accepted_source_rows(jsonb)','EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '5s';

DO $preimage$
DECLARE existing record; relation_name text; role_name text; relation_oid oid; missing text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'horse_commitment_selection_owner_required';
  END IF;
  IF to_regclass('public.horse_commitment_audit_passes') IS NOT NULL
     OR to_regprocedure('public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)') IS NOT NULL
     OR to_regprocedure('public.fn_horse_accepted_source_rows(jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_horse_commitment_audit_pass_immutable()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.horse_commitment_audit_days')
                 AND attname IN ('hands_without_commit','missing_source_hands','late_arrival_hands') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'horse_commitment_selection_receipts_already_installed';
  END IF;
  SELECT p.*, pg_get_userbyid(p.proowner) AS owner_name, l.lanname INTO existing
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure('public.fn_horse_commitment_audit_step()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'horse_commitment_selection_preimage_missing';
  END IF;
  IF md5(existing.prosrc) <> '45ffa0eff534e385828b0316bd4268e8'
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
    RAISE EXCEPTION 'horse_commitment_selection_preimage_changed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('auth.role()'))
      IS DISTINCT FROM 'f31486fed08a7402e89d4aa71b0ad273' THEN
    RAISE EXCEPTION 'horse_commitment_selection_auth_preimage_changed';
  END IF;
  -- The private audit tables and the two smarter_private sources stay
  -- unreadable by every API role; this migration only adds definer readers.
  FOREACH relation_name IN ARRAY ARRAY['public.horse_commitment_audit_days','public.horse_commitment_reviews',
    'public.horse_commitment_audit_gaps','smarter_private.accepted_hand_rosters','smarter_private.hand_submissions'] LOOP
    relation_oid := to_regclass(relation_name);
    IF relation_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_class WHERE oid=relation_oid AND relrowsecurity
        AND relkind='r' AND pg_get_userbyid(relowner)='postgres'
    ) THEN
      RAISE EXCEPTION 'horse_commitment_selection_private_schema_required: %', relation_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'horse_commitment_selection_private_acl_changed: %', relation_name;
      END IF;
    END LOOP;
  END LOOP;
  -- Every source column the new readers name, with its type, so a drifted
  -- source refuses here instead of failing at first call.
  SELECT string_agg(want.rel||'.'||want.col, ',') INTO missing
  FROM (VALUES
    ('public.hand_history','id','{uuid}'),('public.hand_history','table_id','{uuid}'),
    ('public.hand_history','hand_number','{integer,bigint}'),('public.hand_history','created_at','{"timestamp with time zone"}'),
    ('public.hand_history','big_blind','{numeric}'),('public.hand_history','game_variant','{text}'),
    ('public.hand_history','tournament_id','{uuid}'),('public.hand_history','actions','{jsonb}'),
    ('public.hand_history','players','{jsonb}'),
    ('public.hand_atomic_commits','hand_id','{uuid}'),('public.hand_atomic_commits','table_id','{uuid}'),
    ('public.hand_atomic_commits','hand_number','{bigint}'),('public.hand_atomic_commits','payload_hash','{text}'),
    ('public.hand_atomic_commits','stack_result','{jsonb}'),('public.hand_atomic_commits','committed_at','{"timestamp with time zone"}'),
    ('public.hand_atomic_commits','post_commit_payload','{jsonb}'),('public.hand_atomic_commits','post_commit_request_hash','{text}'),
    ('public.hand_atomic_commits','post_commit_payload_hash','{text}'),('public.hand_atomic_commits','post_commit_completed_at','{"timestamp with time zone"}'),
    ('smarter_private.accepted_hand_rosters','table_id','{uuid}'),('smarter_private.accepted_hand_rosters','hand_number','{bigint}'),
    ('smarter_private.accepted_hand_rosters','hand_id','{uuid}'),('smarter_private.accepted_hand_rosters','post_commit_payload_hash','{text}'),
    ('smarter_private.accepted_hand_rosters','status','{text}'),('smarter_private.accepted_hand_rosters','producer_version','{text}'),
    ('smarter_private.accepted_hand_rosters','roster','{jsonb}'),
    ('smarter_private.hand_submissions','table_id','{uuid}'),('smarter_private.hand_submissions','hand_number','{bigint}'),
    ('smarter_private.hand_submissions','lease_generation','{uuid}')
  ) want(rel,col,types)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(want.rel) AND a.attname=want.col
      AND NOT a.attisdropped AND a.attnum>0 AND format_type(a.atttypid,NULL)=ANY(want.types::text[]));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'horse_commitment_selection_source_columns_changed: %', missing;
  END IF;
END;
$preimage$;

-- ===========================================================================
-- 1. IMMUTABLE PASS RECEIPTS. Written only by the step; never rewritten.
-- ===========================================================================
CREATE TABLE public.horse_commitment_audit_passes (
  day date NOT NULL,
  pass bigint NOT NULL CHECK (pass>0),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  cutover timestamptz NOT NULL,
  max_scanned_created_at timestamptz,
  final_after_created_at timestamptz,
  final_after_hand_id uuid,
  scanned_hands bigint NOT NULL,
  horse_hands bigint NOT NULL,
  flagged_horse_hands bigint NOT NULL,
  unknown_horse_hands bigint NOT NULL,
  hand_gaps bigint NOT NULL,
  hands_without_commit bigint NOT NULL,
  missing_source_hands bigint NOT NULL,
  late_arrival_hands bigint NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  source_coverage text NOT NULL DEFAULT 'not_established' CHECK (source_coverage='not_established'),
  identity_basis text NOT NULL DEFAULT 'current_profile_is_horse' CHECK (identity_basis='current_profile_is_horse'),
  PRIMARY KEY (day,pass),
  CHECK (window_start=(day::timestamp AT TIME ZONE 'UTC') AND window_end=((day+1)::timestamp AT TIME ZONE 'UTC')),
  CHECK ((final_after_created_at IS NULL)=(final_after_hand_id IS NULL)),
  CHECK (max_scanned_created_at IS NOT DISTINCT FROM final_after_created_at),
  CHECK (max_scanned_created_at IS NULL OR (max_scanned_created_at>=window_start AND max_scanned_created_at<window_end)),
  CHECK (started_at<=finished_at AND finished_at<=cutover),
  CHECK (scanned_hands>=0 AND horse_hands>=0 AND flagged_horse_hands>=0 AND unknown_horse_hands>=0
    AND hand_gaps>=0 AND hands_without_commit>=0 AND missing_source_hands>=0 AND late_arrival_hands>=0),
  CHECK (flagged_horse_hands+unknown_horse_hands<=horse_hands AND hand_gaps<=scanned_hands
    AND hands_without_commit<=missing_source_hands AND missing_source_hands<=scanned_hands
    AND late_arrival_hands<=scanned_hands AND (scanned_hands>0 OR max_scanned_created_at IS NULL))
);
ALTER TABLE public.horse_commitment_audit_passes OWNER TO postgres;
ALTER TABLE public.horse_commitment_audit_passes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_commitment_audit_passes FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.horse_commitment_audit_passes IS
  'P14.3 immutable receipt of one completed daily commitment-audit pass, written by fn_horse_commitment_audit_step in the transaction that completes the pass. An observation only: source_coverage not_established, identity_basis current_profile_is_horse.';

CREATE FUNCTION public.fn_horse_commitment_audit_pass_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $immutable$
BEGIN
  RAISE EXCEPTION 'horse_commitment_audit_pass_immutable' USING ERRCODE='55000';
END;
$immutable$;
ALTER FUNCTION public.fn_horse_commitment_audit_pass_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_audit_pass_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_commitment_audit_pass_immutable BEFORE UPDATE OR DELETE ON public.horse_commitment_audit_passes
  FOR EACH ROW EXECUTE FUNCTION public.fn_horse_commitment_audit_pass_immutable();
CREATE TRIGGER horse_commitment_audit_pass_no_truncate BEFORE TRUNCATE ON public.horse_commitment_audit_passes
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_horse_commitment_audit_pass_immutable();

-- ===========================================================================
-- 2. PER-PASS SELECTION COUNTERS on the day row. NULL on existing rows (that
--    pass was not counted from its start), 0 for every new row and re-pass.
-- ===========================================================================
ALTER TABLE public.horse_commitment_audit_days
  ADD COLUMN hands_without_commit bigint,
  ADD COLUMN missing_source_hands bigint,
  ADD COLUMN late_arrival_hands bigint;
ALTER TABLE public.horse_commitment_audit_days
  ALTER COLUMN hands_without_commit SET DEFAULT 0,
  ALTER COLUMN missing_source_hands SET DEFAULT 0,
  ALTER COLUMN late_arrival_hands SET DEFAULT 0,
  ADD CONSTRAINT horse_commitment_audit_days_selection_counters CHECK (
    (hands_without_commit IS NULL)=(missing_source_hands IS NULL)
    AND (missing_source_hands IS NULL)=(late_arrival_hands IS NULL)
    AND (hands_without_commit IS NULL OR (hands_without_commit>=0 AND missing_source_hands>=0 AND late_arrival_hands>=0)));
REVOKE ALL ON public.horse_commitment_audit_days FROM PUBLIC,anon,authenticated,service_role;

-- ===========================================================================
-- 3. THE STEP. 20260917051350's body with the four marked P14.3 additions.
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
  today date:=(transaction_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Separate owner from settlement: no source row locks or financial writes.
  -- One nonblocking transaction owns the cursor and every derived row/counter.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-commitment-audit-v1',0)) THEN
    RETURN jsonb_build_object('version',1,'status','busy','sourceCoverage','not_established','activationAuthorized',false);
  END IF;
  INSERT INTO public.horse_commitment_audit_days(day)
    SELECT today-i FROM generate_series(1,3) i ON CONFLICT DO NOTHING;
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
      hands_without_commit=0,missing_source_hands=0,late_arrival_hands=0 WHERE day=d.day RETURNING * INTO d;
  END IF;
  -- The receipt of the immediately previous pass of this day, if one was
  -- recorded. No receipt means no late-arrival basis, never 'no late hands'.
  SELECT * INTO prior FROM public.horse_commitment_audit_passes WHERE day=d.day AND pass=d.pass-1;
  FOR h IN
    SELECT x.id,x.table_id,x.created_at,x.game_variant,x.big_blind,x.players,x.tournament_id,
      t.tournament_type,t.table_size,t.max_players,c.payload_hash,c.post_commit_payload_hash,
      c.hand_id AS commit_hand_id,c.committed_at,
      c.post_commit_payload
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
    IF roster_ok THEN
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(h.players) p LEFT JOIN public.profiles pr ON pr.id=(p->>'userId')::uuid WHERE pr.id IS NULL OR pr.is_horse IS NULL) THEN
        gaps:=array_append(gaps,'horse_identity_unknown');
      END IF;
      FOR actor IN SELECT pr.id FROM jsonb_array_elements(h.players) p JOIN public.profiles pr ON pr.id=(p->>'userId')::uuid WHERE pr.is_horse IS TRUE ORDER BY pr.id LOOP
        horses:=horses+1;net:=NULL;refund:=NULL;gross:=NULL;valid_money:=false;
        reasons:=ARRAY['decision_replay_not_matched','reference_not_matched'];
        IF source_ok IS TRUE AND jsonb_typeof(contributions->actor.id::text)='number'
          AND (NOT refunds ? actor.id::text OR jsonb_typeof(refunds->actor.id::text)='number') THEN
          net:=(contributions->>actor.id::text)::numeric;
          refund:=coalesce((refunds->>actor.id::text)::numeric,0);
          valid_money:=net>=0 AND refund>=0 AND net<=90071992547409.91 AND refund<=90071992547409.91
            AND round(net,2)=net AND round(refund,2)=refund AND net+refund<=90071992547409.91;
        END IF;
        IF valid_money AND bb IS NOT NULL THEN gross:=net+refund;
        ELSE reasons:=reasons||gaps||ARRAY['commitment_eligibility_unknown']; END IF;
        IF gross IS NULL OR gross>10*bb THEN
          IF gross IS NULL THEN unknowns:=unknowns+1; ELSE flagged:=flagged+1; END IF;
          INSERT INTO public.horse_commitment_reviews(hand_id,horse_user_id,table_id,played_at,source_payload_hash,game_variant,format,seats,big_blind,net_contribution,returned_uncalled,committed_amount,committed_bb,eligibility,reasons)
          VALUES(h.id,actor.id,h.table_id,h.created_at,h.post_commit_payload_hash,variant,game_format,seats,bb,
            CASE WHEN valid_money THEN net END,CASE WHEN valid_money THEN refund END,gross,gross/bb,
            CASE WHEN gross IS NULL THEN 'unknown' ELSE 'over_10bb' END,reasons)
          ON CONFLICT DO NOTHING;
          SELECT source_payload_hash,format INTO old_hash,old_format FROM public.horse_commitment_reviews WHERE hand_id=h.id AND horse_user_id=actor.id;
          IF old_hash IS DISTINCT FROM h.post_commit_payload_hash THEN gaps:=array_append(gaps,'review_source_changed'); END IF;
          -- Preserve the first review. Current metadata or a new classifier
          -- cannot silently rewrite a historical diagnostic's original label.
          IF old_format IS DISTINCT FROM game_format THEN gaps:=array_append(gaps,'review_format_changed'); END IF;
        END IF;
      END LOOP;
    END IF;
    IF cardinality(gaps)>0 THEN
      gap_hands:=gap_hands+1;
      INSERT INTO public.horse_commitment_audit_gaps(hand_id,played_at,reasons) VALUES(h.id,h.created_at,gaps)
        ON CONFLICT(hand_id) DO UPDATE SET reasons=ARRAY(SELECT DISTINCT v FROM unnest(public.horse_commitment_audit_gaps.reasons||excluded.reasons) v),observed_at=transaction_timestamp();
    END IF;
  END LOOP;
  -- Read after the scan's snapshot was taken, so a commit clock later than
  -- this proves the commit was invisible to every batch of this pass.
  scan_cutover:=clock_timestamp();
  UPDATE public.horse_commitment_audit_days SET after_created_at=coalesce(last_created,after_created_at),after_hand_id=coalesce(last_id,after_hand_id),
    last_batch_at=transaction_timestamp(),finished_at=CASE WHEN scanned<256 THEN transaction_timestamp() END,
    scanned_hands=scanned_hands+scanned,horse_hands=horse_hands+horses,flagged_horse_hands=flagged_horse_hands+flagged,
    unknown_horse_hands=unknown_horse_hands+unknowns,hand_gaps=hand_gaps+gap_hands,
    hands_without_commit=hands_without_commit+no_commit,missing_source_hands=missing_source_hands+missing_source,
    late_arrival_hands=late_arrival_hands+late WHERE day=d.day RETURNING * INTO d;
  -- A completed pass leaves an immutable receipt in this same transaction,
  -- before any later re-pass can zero the day counters. A pass that began
  -- before receipts existed has NULL selection counters and gets none:
  -- its early batches were never counted, so no complete receipt exists.
  IF scanned<256 AND d.hands_without_commit IS NOT NULL AND d.missing_source_hands IS NOT NULL
    AND d.late_arrival_hands IS NOT NULL THEN
    INSERT INTO public.horse_commitment_audit_passes(day,pass,window_start,window_end,cutover,
      max_scanned_created_at,final_after_created_at,final_after_hand_id,scanned_hands,horse_hands,
      flagged_horse_hands,unknown_horse_hands,hand_gaps,hands_without_commit,missing_source_hands,
      late_arrival_hands,started_at,finished_at)
    VALUES(d.day,d.pass,d.day::timestamp AT TIME ZONE 'UTC',(d.day+1)::timestamp AT TIME ZONE 'UTC',scan_cutover,
      d.after_created_at,d.after_created_at,d.after_hand_id,d.scanned_hands,d.horse_hands,
      d.flagged_horse_hands,d.unknown_horse_hands,d.hand_gaps,d.hands_without_commit,d.missing_source_hands,
      d.late_arrival_hands,d.started_at,d.finished_at)
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
-- 4. SELECTION RECEIPT READER. Service role only; no writes.
-- ===========================================================================
CREATE FUNCTION public.fn_horse_commitment_selection_receipt(
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
    'sourceCoverage','not_established','identityBasis','current_profile_is_horse',
    'gtoVerified',false,'activationAllowed',false);
  IF octet_length(result::text)>65536 THEN
    RAISE EXCEPTION 'hcsr_receipt_exceeds_bounds';
  END IF;
  RETURN result;
END;
$reader$;
ALTER FUNCTION public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer) TO service_role;

-- ===========================================================================
-- 5. ACCEPTED SOURCE ROWS. Exactly ACCEPTED_SOURCE_SELECT, one statement.
-- ===========================================================================
CREATE FUNCTION public.fn_horse_accepted_source_rows(p_hands jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET statement_timeout='3s' SET timezone='UTC'
AS $source$
DECLARE n integer; reply jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'hcsr_role_required' USING ERRCODE='42501';
  END IF;
  IF p_hands IS NULL OR jsonb_typeof(p_hands)<>'array' OR octet_length(p_hands::text)>4096 THEN
    RAISE EXCEPTION 'hcsr_hands_invalid';
  END IF;
  n:=jsonb_array_length(p_hands);
  IF n<1 OR n>8 THEN
    RAISE EXCEPTION 'hcsr_hands_count_invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_hands) e
    WHERE jsonb_typeof(e)<>'object'
      OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(e)='object' THEN e ELSE '{}'::jsonb END))<>2
      OR jsonb_typeof(e->'hand_id') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'table_id') IS DISTINCT FROM 'string'
      OR (e->>'hand_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (e->>'table_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'hcsr_coordinate_invalid';
  END IF;
  IF (SELECT count(DISTINCT e->>'hand_id') FROM jsonb_array_elements(p_hands) e)<>n THEN
    RAISE EXCEPTION 'hcsr_coordinate_duplicate';
  END IF;
  -- ONE statement, so every row comes from one snapshot. The joins, the
  -- identity filter and the size bounds are ACCEPTED_SOURCE_SELECT's own; the
  -- only additions are the explicit coordinate list and lease_generation.
  SELECT jsonb_build_object('version',1,'rows',coalesce(jsonb_agg(jsonb_build_object(
      'hand_id',h.id::text,'table_id',h.table_id::text,'hand_number',h.hand_number::text,
      'atomic_hand_id',c.hand_id::text,'atomic_table_id',c.table_id::text,'atomic_hand_number',c.hand_number::text,
      'big_blind',h.big_blind::text,'game_variant',h.game_variant,'tournament_id',h.tournament_id::text,
      'actions_text',h.actions::text,'players_text',h.players::text,
      'payload_text',c.post_commit_payload::text,'payload_digest',c.post_commit_payload_hash,
      'core_payload_digest',c.payload_hash,'post_commit_request_digest',c.post_commit_request_hash,
      'stack_result_text',c.stack_result::text,'committed_at',c.committed_at::text,
      'post_commit_completed_at',c.post_commit_completed_at::text,
      'roster_hand_id',r.hand_id::text,'roster_status',r.status,'roster_payload_digest',r.post_commit_payload_hash,
      'roster_producer_version',r.producer_version,'roster_text',r.roster::text,
      'read_at',statement_timestamp()::text,'snapshot_id',pg_current_snapshot()::text,
      'lease_generation',s.lease_generation::text) ORDER BY k.ord),'[]'::jsonb))
  INTO reply
  FROM (SELECT (e->>'hand_id')::uuid AS hand_id,(e->>'table_id')::uuid AS table_id,o AS ord
        FROM jsonb_array_elements(p_hands) WITH ORDINALITY x(e,o)) k
  JOIN public.hand_history h ON h.id=k.hand_id AND h.table_id=k.table_id
  JOIN public.hand_atomic_commits c
    ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
  LEFT JOIN smarter_private.accepted_hand_rosters r
    ON r.table_id=c.table_id AND r.hand_number=c.hand_number
  LEFT JOIN smarter_private.hand_submissions s
    ON s.table_id=c.table_id AND s.hand_number=c.hand_number
  WHERE octet_length(c.post_commit_payload::text)<=262144
    AND octet_length(h.actions::text)<=262144
    AND octet_length(h.players::text)<=32768
    AND octet_length(c.stack_result::text)<=262144
    AND (r.roster IS NULL OR octet_length(r.roster::text)<=32768);
  -- The exporter refuses a serialized raw row above 1 MiB; bound the reply.
  IF octet_length(reply::text)>1048576*n+8192 THEN
    RAISE EXCEPTION 'hcsr_reply_exceeds_bounds';
  END IF;
  RETURN reply;
END;
$source$;
ALTER FUNCTION public.fn_horse_accepted_source_rows(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_horse_accepted_source_rows(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_accepted_source_rows(jsonb) TO service_role;

-- ===========================================================================
-- POSTIMAGE. Abort the whole transaction unless what was installed is exact.
-- ===========================================================================
DO $postimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.fn_horse_commitment_audit_step()'::regprocedure
      AND md5(prosrc)='418ef5b18e2470629130e5074790878e' AND prosecdef AND proowner='postgres'::regrole
      AND provolatile='v' AND procost=100
      AND proconfig=ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=2s','statement_timeout=5s']::text[]
      AND ARRAY(SELECT item::text FROM unnest(proacl) item ORDER BY item::text)
        =ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]) THEN
    RAISE EXCEPTION 'horse_commitment_selection_postimage_step';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)',
      'public.fn_horse_accepted_source_rows(jsonb)']) f
    WHERE NOT has_function_privilege('service_role',f::regprocedure,'EXECUTE')
      OR has_function_privilege('anon',f::regprocedure,'EXECUTE')
      OR has_function_privilege('authenticated',f::regprocedure,'EXECUTE')
      OR (SELECT NOT prosecdef OR provolatile<>'s' OR proowner<>'postgres'::regrole FROM pg_proc WHERE oid=f::regprocedure)) THEN
    RAISE EXCEPTION 'horse_commitment_selection_postimage_readers';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgrelid='public.horse_commitment_audit_passes'::regclass)<>2
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      CROSS JOIN unnest(ARRAY['public.horse_commitment_audit_passes','public.horse_commitment_audit_days']) t
      WHERE has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES')) THEN
    RAISE EXCEPTION 'horse_commitment_selection_postimage_tables';
  END IF;
END;
$postimage$;

-- Invalidate only the gateway schema cache after this transaction commits.
NOTIFY pgrst, 'reload schema';
COMMIT;
