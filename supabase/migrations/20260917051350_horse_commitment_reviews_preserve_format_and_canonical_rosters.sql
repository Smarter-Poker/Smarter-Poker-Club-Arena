-- Horse commitment reviews must not count differently cased spellings of one
-- UUID as distinct dealt players, or label documented two-player SNGs as a
-- generic SNG. Preserve original review rows and report later format conflicts.
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-16 06:15:37 UTC.
-- Read-only installed preimage: body MD5 0f4895601a3c6bc039de8960ad8e582d,
-- postgres owner, service-only execution, original three function settings.
-- Replace only this diagnostic function; do not replay the historical table
-- migration (recorded live as20260914161209), rewrite reviews, or change the
-- settlement writer, audit schedule, private ACLs, coverage or GTO verdicts.
-- The directly triggered PostgreSQL regression gate owns execution evidence.
BEGIN;
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '5s';
DO $preimage$
DECLARE existing record;
BEGIN
  SELECT p.*, pg_get_userbyid(p.proowner) AS owner_name, l.lanname INTO existing
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure('public.fn_horse_commitment_audit_step()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'horse_commitment_audit_preimage_missing';
  END IF;
  IF md5(existing.prosrc) NOT IN (
       '0f4895601a3c6bc039de8960ad8e582d',
       '45ffa0eff534e385828b0316bd4268e8'
     )
     OR existing.owner_name <> 'postgres'
     OR existing.prosecdef IS DISTINCT FROM true
     -- These defaults are observed live, not assumed. CREATE OR REPLACE would
     -- otherwise reset an unreviewed header change while preserving its body.
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
    RAISE EXCEPTION 'horse_commitment_audit_preimage_changed';
  END IF;
END;
$preimage$;

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
      flagged_horse_hands=0,unknown_horse_hands=0,hand_gaps=0 WHERE day=d.day RETURNING * INTO d;
  END IF;
  FOR h IN
    SELECT x.id,x.table_id,x.created_at,x.game_variant,x.big_blind,x.players,x.tournament_id,
      t.tournament_type,t.table_size,t.max_players,c.payload_hash,c.post_commit_payload_hash,
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
  UPDATE public.horse_commitment_audit_days SET after_created_at=coalesce(last_created,after_created_at),after_hand_id=coalesce(last_id,after_hand_id),
    last_batch_at=transaction_timestamp(),finished_at=CASE WHEN scanned<256 THEN transaction_timestamp() END,
    scanned_hands=scanned_hands+scanned,horse_hands=horse_hands+horses,flagged_horse_hands=flagged_horse_hands+flagged,
    unknown_horse_hands=unknown_horse_hands+unknowns,hand_gaps=hand_gaps+gap_hands WHERE day=d.day;
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

COMMIT;
