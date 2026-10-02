-- A PAGE RECOMPUTE READS ONLY THE EVIDENCE THAT CHANGED (20260927160709)
--
-- The page path of fn_calculate_cash_rakeback_periods now answers its three
-- week-level cash counts from a per club-week checkpoint of frozen shares, plus
-- the batches recorded since and the records with no batch, instead of reading
-- the whole week. This fixture proves, on this cluster:
--
--   1. ORACLE. The whole-period path's own query, lifted verbatim from the
--      installed calculator, and fn_cash_period_evidence_since agree on every
--      count for every club and week the cluster carries, and a checkpoint split
--      at any horizon adds back to the oracle exactly.
--   2. PROPERTY. The same holds for randomized weeks (three seeds) that carry
--      every kind of evidence defect the counts look for, before AND after the
--      week changes the ways the platform allows it to (new hands, edits to
--      hands that have no batch yet, batches and sources arriving).
--   3. CALCULATOR. A page call returns the same receipt and writes the same
--      certificates as the whole-period call for the same payees, first when it
--      builds its checkpoint and again when it advances it.
--   4. BEFORE / AFTER. A week holding a batchless hand older than the newest 200
--      records is refused by the page without the tournament gate; the
--      installed predecessor sent the same page through the gate and the whole
--      week. A checkpointed page reads a bounded slice of rake_attributions.
--   5. WHOLE PERIOD. The whole-period call still runs the gate and never reads
--      or writes a checkpoint.
--   6. GUARDS. A batch that does not carry its record's time, or is recorded
--      before its own transaction began, and a source that does not carry its
--      batch's time, are refused.
--
-- Every scenario that writes rolls itself back.
SET search_path=fixture_clock,public,pg_catalog,pg_temp;
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

-- ===== the oracle: the whole-period path's own query, verbatim =====
DO $$ DECLARE src text; a int; b int; q text; BEGIN
 src:=pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure);
 a:=position(' WITH week_records AS MATERIALIZED (' IN src);
 b:=position(' SELECT evidence.n,incomplete.n,drifted.n INTO evidence_issues,incomplete_issues,drifted_issues' IN src);
 PERFORM fixture.assert(a>0 AND b>a,'The installed whole-period query is found in the calculator');
 q:=substr(src,a,b-a);
 PERFORM fixture.assert(position('club_attributions AS MATERIALIZED' IN q)>0 AND position('drifted AS (' IN q)>0,
  'The lifted oracle is the whole three-count query');
 EXECUTE 'CREATE FUNCTION pg_temp.oracle_counts(p_club_id uuid,v_from timestamptz,v_to timestamptz,scope_union uuid)
  RETURNS TABLE(e bigint,i bigint,d bigint) LANGUAGE plpgsql STABLE SET search_path TO ''public'' AS $o$ BEGIN RETURN QUERY '
  ||q||' SELECT evidence.n,incomplete.n,drifted.n FROM evidence,incomplete,drifted; END $o$';
END $$;

CREATE FUNCTION pg_temp.window_from(week date) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT week::timestamp AT TIME ZONE 'America/Los_Angeles'$$;
CREATE FUNCTION pg_temp.window_to(week date) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT (week+7)::timestamp AT TIME ZONE 'America/Los_Angeles'$$;

-- Every club, every week: oracle = all frozen + batchless, and every split of
-- the frozen set at a batch's own recorded_at adds back exactly.
CREATE FUNCTION pg_temp.check_additivity(label text) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE club record; week date; o record; t record; s record; h timestamptz; checked int:=0; splits int:=0;
BEGIN
 FOR club IN SELECT c.id,c.union_id FROM clubs c ORDER BY c.id LOOP
  FOREACH week IN ARRAY ARRAY['2026-08-31','2026-09-07','2026-09-14','2026-09-21','2026-09-28']::date[] LOOP
   SELECT * INTO o FROM pg_temp.oracle_counts(club.id,pg_temp.window_from(week),pg_temp.window_to(week),club.union_id);
   SELECT * INTO t FROM public.fn_cash_period_evidence_since(club.id,pg_temp.window_from(week),pg_temp.window_to(week),club.union_id,'-infinity','infinity');
   PERFORM fixture.assert((t.o_evidence,t.o_incomplete,t.o_drifted)=(o.e,o.i,o.d),
    format('%s: club %s week %s counts: incremental %s/%s/%s, whole-period %s/%s/%s',label,club.id,week,
     t.o_evidence,t.o_incomplete,t.o_drifted,o.e,o.i,o.d));
   PERFORM fixture.assert(t.o_settled_evidence+t.o_unbatched_evidence=t.o_evidence
     AND t.o_settled_incomplete+t.o_unbatched_incomplete=t.o_incomplete AND t.o_settled_drifted=t.o_drifted,
    format('%s: club %s week %s: with every batch settled, frozen plus batchless is the total',label,club.id,week));
   -- Every batch time when there are few, otherwise twenty of them chosen by a
   -- fixed hash, and both ends.
   FOR h IN (SELECT x.recorded_at FROM (SELECT DISTINCT b.recorded_at FROM accounting_cash_accrual_batches b
     WHERE b.earned_at>=pg_temp.window_from(week) AND b.earned_at<pg_temp.window_to(week)) x
     ORDER BY md5(x.recorded_at::text) LIMIT 20)
     UNION SELECT '-infinity'::timestamptz UNION SELECT 'infinity'::timestamptz LOOP
    SELECT * INTO s FROM public.fn_cash_period_evidence_since(club.id,pg_temp.window_from(week),pg_temp.window_to(week),club.union_id,'-infinity',h);
    SELECT * INTO t FROM public.fn_cash_period_evidence_since(club.id,pg_temp.window_from(week),pg_temp.window_to(week),club.union_id,h,h);
    PERFORM fixture.assert((s.o_settled_evidence+t.o_evidence,s.o_settled_incomplete+t.o_incomplete,s.o_settled_drifted+t.o_drifted)=(o.e,o.i,o.d),
     format('%s: club %s week %s split at %s: checkpoint %s/%s/%s + since %s/%s/%s <> whole-period %s/%s/%s',label,club.id,week,h,
      s.o_settled_evidence,s.o_settled_incomplete,s.o_settled_drifted,t.o_evidence,t.o_incomplete,t.o_drifted,o.e,o.i,o.d));
    splits:=splits+1;
   END LOOP;
   checked:=checked+1;
  END LOOP;
 END LOOP;
 RAISE NOTICE '% additivity: % club-weeks, % checkpoint splits',label,checked,splits;
 RETURN splits;
END $f$;

SELECT fixture.assert(pg_temp.check_additivity('Cluster book')>0,'The cluster book was split at least once');
SELECT fixture.assert((SELECT count(*)>0 FROM accounting_cash_accrual_batches),'The cluster carries accrued batches, so the splits above were not vacuous');

-- ===== property: randomized weeks, then the week moves on =====
-- Three seeds. Each builds a week of synthetic cash evidence for its own four
-- clubs (a standalone club, a union member, its union house and a second
-- member), with every defect the counts look for that the tables' own constraints
-- admit: missing hands, ghost twins, tournament and zero rows, attributions
-- that are missing, negative, on the wrong hand, or do not add up, batches that are legacy or
-- absent, and sources that are missing or drifted. The rows are the counts'
-- INPUT, written with the write-side guards suspended (session_replication_role)
-- and within the platform's own invariants: earned_at is the record's time, a
-- source exists only beside its batch, and a record with a batch never changes.
CREATE FUNCTION pg_temp.seed_week(seed double precision,week date,generation int,after timestamptz) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r record; n int; k int; club uuid; clubs uuid[]:=ARRAY[fixture.u(9101),fixture.u(9102),fixture.u(9100),fixture.u(9103)];
 players uuid[]; rake numeric; credit numeric; left_over numeric; rid uuid; hid uuid; tid uuid; at timestamptz; recorded timestamptz; status text;
BEGIN
 PERFORM setseed(seed);
 FOR n IN 1..70 LOOP
  rid:=gen_random_uuid(); hid:=CASE WHEN random()<0.05 THEN NULL ELSE gen_random_uuid() END;
  tid:=fixture.u(9200+(random()*6)::int);
  at:=pg_temp.window_from(week)+random()*(pg_temp.window_to(week)-pg_temp.window_from(week));
  rake:=round((random()*4+0.5)::numeric,2);
  club:=clubs[1+floor(random()*4)::int];
  INSERT INTO rake_records(id,hand_id,table_id,club_id,rake_amount,created_at,is_tournament,tournament_id,metadata,source,rake_method)
  VALUES(rid,hid,tid,club,CASE WHEN random()<0.03 THEN 0 ELSE rake END,at,random()<0.04,NULL,
   jsonb_build_object('hand_number',(1000000+(random()*40)::int)::text),'cash_game','WEIGHTED_CONTRIBUTED');
  k:=CASE WHEN random()<0.05 THEN 0 ELSE 1+(random()*2.999)::int END;
  players:=ARRAY(SELECT fixture.u(9300+g) FROM generate_series(1,12) g ORDER BY random() LIMIT k);
  left_over:=rake;
  FOR j IN 1..k LOOP
   credit:=CASE WHEN j=k THEN left_over ELSE round(rake/k,2) END; left_over:=left_over-credit;
   IF random()<0.03 THEN credit:=credit+0.01; END IF;
   IF random()<0.02 THEN credit:=-credit; END IF;
   INSERT INTO rake_attributions(hand_id,player_id,rake_record_id,table_id,club_id,weighted_rake_credit,rake_amount,rake_method)
   VALUES(CASE WHEN hid IS NULL OR random()<0.02 THEN gen_random_uuid() ELSE hid END,players[j],
    rid,tid,clubs[1+floor(random()*4)::int],credit,abs(credit),'WEIGHTED_CONTRIBUTED');
  END LOOP;
 END LOOP;
 -- Batches and sources for most records that could carry them.
 FOR r IN SELECT x.* FROM rake_records x WHERE x.table_id BETWEEN fixture.u(9200) AND fixture.u(9206)
    AND x.created_at>=pg_temp.window_from(week) AND x.created_at<pg_temp.window_to(week) AND x.hand_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM accounting_cash_accrual_batches b WHERE b.rake_record_id=x.id) LOOP
  IF random()<0.25 THEN CONTINUE; END IF;
  recorded:=greatest(after,r.created_at)+random()*interval '2 days';
  status:=CASE WHEN random()<0.05 THEN 'legacy_unverified' ELSE 'accrued' END;
  INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan,recorded_at)
  VALUES(r.id,r.hand_id,r.created_at,md5(r.id::text),status,CASE WHEN status='accrued' THEN '{}'::jsonb END,recorded);
  INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract,recorded_at)
  SELECT a.rake_record_id,a.player_id,a.club_id,
    CASE WHEN a.club_id IN(fixture.u(9100),fixture.u(9102)) THEN fixture.u(9100) END,
    CASE WHEN a.club_id IN(fixture.u(9100),fixture.u(9102)) THEN fixture.u(9100) END,
    r.created_at,CASE WHEN random()<0.04 THEN a.weighted_rake_credit+0.01 ELSE a.weighted_rake_credit END,
    jsonb_build_object('attribution_id',CASE WHEN random()<0.03 THEN gen_random_uuid() ELSE a.id END,'player_id',a.player_id,'club_id',a.club_id,
     'union_id',CASE WHEN a.club_id IN(fixture.u(9100),fixture.u(9102)) THEN fixture.u(9100) END,
     'coordinator_union_id',CASE WHEN random()<0.03 THEN fixture.u(9999) WHEN a.club_id IN(fixture.u(9100),fixture.u(9102)) THEN fixture.u(9100) END,
     'is_union_house',(a.club_id=fixture.u(9100))::text),
    recorded
   FROM rake_attributions a WHERE a.rake_record_id=r.id AND a.weighted_rake_credit>=0 AND random()>0.03
   ON CONFLICT (rake_record_id,player_id) DO NOTHING;
 END LOOP;
END $f$;

-- The ways the platform lets a week move on: edits to hands that have no batch
-- yet, and batches (with their sources) arriving for some of them.
CREATE FUNCTION pg_temp.move_week(seed double precision,week date,after timestamptz) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
 PERFORM setseed(seed);
 UPDATE rake_attributions a SET weighted_rake_credit=weighted_rake_credit+0.01
  WHERE a.rake_record_id IN(SELECT x.id FROM rake_records x WHERE x.table_id BETWEEN fixture.u(9200) AND fixture.u(9206)
    AND NOT EXISTS(SELECT 1 FROM accounting_cash_accrual_batches b WHERE b.rake_record_id=x.id)) AND random()<0.3;
 DELETE FROM rake_attributions a
  WHERE a.rake_record_id IN(SELECT x.id FROM rake_records x WHERE x.table_id BETWEEN fixture.u(9200) AND fixture.u(9206)
    AND NOT EXISTS(SELECT 1 FROM accounting_cash_accrual_batches b WHERE b.rake_record_id=x.id)) AND random()<0.1;
 PERFORM pg_temp.seed_week(seed-0.5,week,2,after);
END $f$;

BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO clubs(id,name,owner_id,chip_treasury,asset,is_union,union_id) VALUES
 (fixture.u(9101),'Property standalone',fixture.u(901),0,'chips',false,NULL),
 (fixture.u(9100),'Property union house',fixture.u(900),0,'chips',true,fixture.u(9100)),
 (fixture.u(9102),'Property union member',fixture.u(901),0,'chips',false,fixture.u(9100)),
 (fixture.u(9103),'Property second member',fixture.u(901),0,'chips',false,fixture.u(9100));
DO $$ DECLARE seed double precision; club record; h timestamptz; cp record; since record; o record; checked int:=0; BEGIN
 FOREACH seed IN ARRAY ARRAY[0.11,0.42,0.73] LOOP
  PERFORM pg_temp.seed_week(seed,'2026-09-14','1','2026-09-14 07:00Z');
  h:='2026-09-20 00:00Z';
  FOR club IN SELECT c.id,c.union_id FROM clubs c WHERE c.id IN(fixture.u(9100),fixture.u(9101),fixture.u(9102),fixture.u(9103),fixture.u(104)) LOOP
   -- The checkpoint as a page would leave it at horizon h ...
   SELECT * INTO cp FROM public.fn_cash_period_evidence_since(club.id,pg_temp.window_from('2026-09-14'),pg_temp.window_to('2026-09-14'),club.union_id,'-infinity',h);
   CREATE TEMP TABLE IF NOT EXISTS property_cp(cp_club uuid primary key,e bigint,i bigint,d bigint);
   INSERT INTO property_cp VALUES(club.id,cp.o_settled_evidence,cp.o_settled_incomplete,cp.o_settled_drifted)
    ON CONFLICT (cp_club) DO UPDATE SET e=EXCLUDED.e,i=EXCLUDED.i,d=EXCLUDED.d;
  END LOOP;
  -- ... then the week moves on: only batches recorded after h can appear.
  PERFORM pg_temp.move_week(seed,'2026-09-14',h);
  FOR club IN SELECT c.id,c.union_id FROM clubs c WHERE c.id IN(fixture.u(9100),fixture.u(9101),fixture.u(9102),fixture.u(9103),fixture.u(104)) LOOP
   SELECT * INTO o FROM pg_temp.oracle_counts(club.id,pg_temp.window_from('2026-09-14'),pg_temp.window_to('2026-09-14'),club.union_id);
   SELECT * INTO since FROM public.fn_cash_period_evidence_since(club.id,pg_temp.window_from('2026-09-14'),pg_temp.window_to('2026-09-14'),club.union_id,h,'infinity');
   SELECT * INTO cp FROM property_cp WHERE property_cp.cp_club=club.id;
   PERFORM fixture.assert((cp.e+since.o_evidence,cp.i+since.o_incomplete,cp.d+since.o_drifted)=(o.e,o.i,o.d),
    format('Seed %s club %s: checkpoint %s/%s/%s + since %s/%s/%s = whole-period %s/%s/%s after the week moved',seed,club.id,
     cp.e,cp.i,cp.d,since.o_evidence,since.o_incomplete,since.o_drifted,o.e,o.i,o.d));
   checked:=checked+1;
  END LOOP;
 END LOOP;
 PERFORM fixture.assert(checked=15,'Fifteen seeded club-weeks were checked after the week moved');
 -- Not vacuous: the seeded weeks reached every kind of count.
 PERFORM fixture.assert((SELECT bool_and(x.e+x.i+x.d>0) FROM (SELECT oc.* FROM clubs c,
   LATERAL pg_temp.oracle_counts(c.id,pg_temp.window_from('2026-09-14'),pg_temp.window_to('2026-09-14'),c.union_id) oc
   WHERE c.id IN(fixture.u(9100),fixture.u(9101),fixture.u(9102))) x),'Every seeded club carries evidence defects');
 PERFORM fixture.assert((SELECT sum(oc.d)>0 AND sum(oc.e)>0 AND sum(oc.i)>0 FROM clubs c,
   LATERAL pg_temp.oracle_counts(c.id,pg_temp.window_from('2026-09-14'),pg_temp.window_to('2026-09-14'),c.union_id) oc
   WHERE c.id IN(fixture.u(9100),fixture.u(9101),fixture.u(9102),fixture.u(9103))),'The seeded weeks carry evidence, incomplete and drifted defects');
END $$;
SET LOCAL session_replication_role=origin;
SELECT fixture.assert(pg_temp.check_additivity('Seeded book')>0,'The seeded book was split at every batch');
ROLLBACK;

-- ===== the calculator: a page answers what the whole period answers =====
-- For one club-week, the whole-period receipt and certificates, a fresh page
-- for every payee of the week, and a page whose checkpoint was already primed
-- (an empty page writes the checkpoint and no certificate). Each run is undone
-- before the next (a subtransaction the block aborts), so all three see the
-- same book. Only a whole-period refusal by the tournament gate may be named
-- differently by a page - a page refused by its cash evidence is not also sent
-- through the gate - and even then the status and the writes are the same.
CREATE FUNCTION pg_temp.certs(club uuid,week date) RETURNS jsonb LANGUAGE sql AS $f$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id',c.player_id,'rake_generated',c.rake_generated,
   'rakeback_amount',c.rakeback_amount,'display_rate',c.display_rate,'payer_kind',c.payer_kind,'payer_user_id',c.payer_user_id,
   'coordinator_union_id',c.coordinator_union_id,'source_fingerprint',c.source_fingerprint,'allocations',c.source_allocations,
   'period',jsonb_build_object('rake_generated',rp.rake_generated,'rakeback_rate',rp.rakeback_rate,
     'rakeback_amount',rp.rakeback_amount,'status',rp.status)) ORDER BY c.player_id,c.id),'[]')
  FROM accounting_rakeback_period_calculations c JOIN rakeback_periods rp ON rp.id=c.period_id
  WHERE c.club_id=club AND c.period_start=week $f$;
CREATE FUNCTION pg_temp.run(club uuid,week date,players uuid[],prime boolean) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE result jsonb; certs jsonb; BEGIN
 BEGIN
  BEGIN
   IF prime THEN PERFORM public.fn_calculate_cash_rakeback_periods(club,week,week+6,'{}'::uuid[]); END IF;
   result:=public.fn_calculate_cash_rakeback_periods(club,week,week+6,players);
  EXCEPTION WHEN OTHERS THEN IF SQLSTATE='RB002' THEN RAISE; END IF; result:=jsonb_build_object('raised',SQLSTATE,'message',SQLERRM); END;
  certs:=pg_temp.certs(club,week);
  RAISE EXCEPTION USING ERRCODE='RB002',MESSAGE='undo';
 EXCEPTION WHEN SQLSTATE 'RB002' THEN NULL;
 END;
 RETURN jsonb_build_object('receipt',result,'certs',certs);
END $f$;
CREATE FUNCTION pg_temp.compare_calculator(label text,weeks date[]) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE club uuid; week date; players uuid[]; whole jsonb; fresh jsonb; primed jsonb; compared int:=0; ready int:=0; gate_reason boolean;
BEGIN
 FOR club IN SELECT id FROM clubs ORDER BY id LOOP
  FOREACH week IN ARRAY weeks LOOP
   SELECT COALESCE(array_agg(DISTINCT s.player_id),'{}') INTO players FROM accounting_payable_earning_sources s
    WHERE s.club_id=club AND s.earned_at>=pg_temp.window_from(week) AND s.earned_at<pg_temp.window_to(week);
   whole:=pg_temp.run(club,week,NULL,false);
   fresh:=pg_temp.run(club,week,players,false);
   primed:=pg_temp.run(club,week,players,true);
   gate_reason:=whole->'receipt'->>'reason' LIKE 'tournament%';
   PERFORM fixture.assert(fresh->'receipt'->>'status' IS NOT DISTINCT FROM whole->'receipt'->>'status'
     AND primed->'receipt'->>'status' IS NOT DISTINCT FROM whole->'receipt'->>'status'
     AND fresh->'receipt'->>'written' IS NOT DISTINCT FROM whole->'receipt'->>'written'
     AND primed->'receipt'->>'written' IS NOT DISTINCT FROM whole->'receipt'->>'written',
    format('%s: club %s week %s status and writes: whole %s, fresh page %s, primed page %s',label,club,week,whole->'receipt',fresh->'receipt',primed->'receipt'));
   PERFORM fixture.assert(fresh->'certs'=whole->'certs' AND primed->'certs'=whole->'certs',
    format('%s: club %s week %s certificates are byte-identical: whole %s, fresh %s, primed %s',label,club,week,whole->'certs',fresh->'certs',primed->'certs'));
   IF NOT gate_reason THEN
    PERFORM fixture.assert(fresh->'receipt'=whole->'receipt' AND primed->'receipt'=whole->'receipt',
     format('%s: club %s week %s a page returns the whole-period receipt exactly: whole %s, fresh page %s, primed page %s',
      label,club,week,whole->'receipt',fresh->'receipt',primed->'receipt'));
   END IF;
   compared:=compared+1;
   IF whole->'receipt'->>'status'='ready' AND jsonb_array_length(whole->'certs')>0 THEN ready:=ready+1; END IF;
  END LOOP;
 END LOOP;
 RAISE NOTICE '% calculator comparison: % club-weeks, % certified',label,compared,ready;
 RETURN ready;
END $f$;

CREATE TEMP TABLE checkpoints_before AS SELECT * FROM accounting_rakeback_period_evidence_checkpoints;
SELECT fixture.assert(pg_temp.compare_calculator('Cluster book',ARRAY['2026-09-07','2026-09-14','2026-09-21']::date[])>=1,
 'The page/whole-period comparison reached at least one certified club-week of the cluster');
SELECT fixture.assert((SELECT count(*)>=1 FROM accounting_rakeback_period_calculations c JOIN rakeback_periods rp ON rp.id=c.period_id
  WHERE c.period_start='2026-09-21' AND c.rakeback_amount=0),
 'The certified weeks compared include the zero-entitlement payee round 3 depends on');
SELECT fixture.assert((SELECT count(*) FROM (SELECT * FROM accounting_rakeback_period_evidence_checkpoints
   EXCEPT SELECT * FROM checkpoints_before) x)=0 AND (SELECT count(*) FROM accounting_rakeback_period_evidence_checkpoints)=(SELECT count(*) FROM checkpoints_before),
 'Every comparison undid its checkpoint as well');
SELECT fixture.assert((SELECT count(*)>=1 FROM checkpoints_before WHERE club_id=fixture.u(104) AND period_start='2026-09-21'),
 'The settler-page drain of period-coverage-regression left its checkpoint, written by the page path it ran');

-- ...and on the seeded weeks, where every refusal is a cash one, before and
-- after the week moves on under a checkpoint.
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO clubs(id,name,owner_id,chip_treasury,asset,is_union,union_id) VALUES
 (fixture.u(9101),'Property standalone',fixture.u(901),0,'chips',false,NULL),
 (fixture.u(9100),'Property union house',fixture.u(900),0,'chips',true,fixture.u(9100)),
 (fixture.u(9102),'Property union member',fixture.u(901),0,'chips',false,fixture.u(9100)),
 (fixture.u(9103),'Property second member',fixture.u(901),0,'chips',false,fixture.u(9100));
SELECT pg_temp.seed_week(0.27,'2026-09-14','1','2026-09-14 07:00Z');
SET LOCAL session_replication_role=origin;
SELECT pg_temp.compare_calculator('Seeded book',ARRAY['2026-09-14']::date[]);
-- A checkpoint primed now, then the week moves on underneath it.
DO $$ DECLARE club uuid; BEGIN
 FOR club IN SELECT id FROM clubs WHERE id IN(fixture.u(9100),fixture.u(9101),fixture.u(9102),fixture.u(9103)) LOOP
  PERFORM public.fn_calculate_cash_rakeback_periods(club,'2026-09-14','2026-09-20','{}'::uuid[]);
 END LOOP;
END $$;
SELECT fixture.assert((SELECT count(*)=4 FROM accounting_rakeback_period_evidence_checkpoints WHERE period_start='2026-09-14'),
 'Four seeded club-weeks hold a checkpoint');
SET LOCAL session_replication_role=replica;
SELECT pg_temp.move_week(0.61,'2026-09-14',(SELECT max(horizon) FROM accounting_rakeback_period_evidence_checkpoints));
SET LOCAL session_replication_role=origin;
DO $$ DECLARE club record; page jsonb; whole jsonb; BEGIN
 FOR club IN SELECT c.id FROM clubs c WHERE c.id IN(fixture.u(9100),fixture.u(9101),fixture.u(9102),fixture.u(9103)) LOOP
  whole:=pg_temp.run(club.id,'2026-09-14',NULL,false)->'receipt';
  page:=public.fn_calculate_cash_rakeback_periods(club.id,'2026-09-14','2026-09-20','{}'::uuid[]);
  PERFORM fixture.assert(page=whole OR (whole->>'status'='ready' AND page->>'status'='ready'),
   format('Seeded club %s after the week moved under its checkpoint: page %s, whole %s',club.id,page,whole));
 END LOOP;
END $$;
ROLLBACK;

-- ===== before / after =====
-- A week holding one batchless hand of the club older than the newest 200
-- cash records, all of which are accrued. The installed predecessor sends a
-- page of it through the tournament gate and the whole week; the page path now
-- refuses it without the gate.
BEGIN;
SET LOCAL track_functions='pl';
SET LOCAL session_replication_role=replica;
INSERT INTO clubs(id,name,owner_id,chip_treasury,asset,is_union,union_id) VALUES
 (fixture.u(9101),'Property standalone',fixture.u(901),0,'chips',false,NULL);
INSERT INTO rake_records(id,hand_id,table_id,club_id,rake_amount,created_at,is_tournament,metadata,source,rake_method)
 SELECT fixture.u(9500+g),fixture.u(9800+g),fixture.u(9200),fixture.u(9101),2,'2026-09-14 08:00Z'::timestamptz+g*interval '1 minute',false,'{}','cash_game','WEIGHTED_CONTRIBUTED'
   FROM generate_series(0,1999) g;
INSERT INTO rake_attributions(hand_id,player_id,rake_record_id,table_id,club_id,weighted_rake_credit,rake_amount,rake_method)
 SELECT r.hand_id,fixture.u(9301),r.id,r.table_id,r.club_id,2,2,'WEIGHTED_CONTRIBUTED' FROM rake_records r WHERE r.table_id=fixture.u(9200);
INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan,recorded_at)
 SELECT r.id,r.hand_id,r.created_at,md5(r.id::text),'accrued','{}','2026-09-14 12:00Z' FROM rake_records r WHERE r.table_id=fixture.u(9200) AND r.id<>fixture.u(9500);
INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,earned_at,rake_credit,contract,recorded_at)
 SELECT a.rake_record_id,a.player_id,a.club_id,r.created_at,2,jsonb_build_object('attribution_id',a.id,'player_id',a.player_id,'club_id',a.club_id,'union_id',NULL,'coordinator_union_id',NULL),'2026-09-14 12:00Z'
   FROM rake_attributions a JOIN rake_records r ON r.id=a.rake_record_id WHERE r.table_id=fixture.u(9200) AND r.id<>fixture.u(9500);
SET LOCAL session_replication_role=origin;
ANALYZE rake_records; ANALYZE rake_attributions; ANALYZE accounting_cash_accrual_batches; ANALYZE accounting_cash_rake_sources;
CREATE FUNCTION pg_temp.gate_calls() RETURNS bigint LANGUAGE sql AS
 $f$SELECT COALESCE(sum(calls),0) FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='fn_accounting_tournament_week_quality'$f$;
CREATE FUNCTION pg_temp.attribution_reads() RETURNS bigint LANGUAGE sql AS
 $f$SELECT COALESCE(sum(seq_tup_read+idx_tup_fetch),0) FROM pg_stat_xact_user_tables WHERE schemaname='public' AND relname='rake_attributions'$f$;
DO $$ DECLARE g0 bigint; g1 bigint; g2 bigint; before_page jsonb; after_page jsonb; BEGIN
 PERFORM fixture.assert((SELECT count(*) FROM rake_records r WHERE r.created_at>'2026-09-14 08:00Z' AND r.created_at<pg_temp.window_to('2026-09-14')
   AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.hand_id IS NOT NULL)>200,
  'The batchless hand is older than the newest 200 cash records of its week');
 g0:=pg_temp.gate_calls();
 before_page:=fixture.predecessor_page_calculator(fixture.u(9101),'2026-09-14','2026-09-20',ARRAY[fixture.u(9301)]);
 g1:=pg_temp.gate_calls();
 after_page:=public.fn_calculate_cash_rakeback_periods(fixture.u(9101),'2026-09-14','2026-09-20',ARRAY[fixture.u(9301)]);
 g2:=pg_temp.gate_calls();
 PERFORM fixture.assert(before_page->>'status'='blocked' AND after_page->>'status'='blocked'
   AND after_page->>'reason'='cash_source_receipts_incomplete',
  format('Both refuse the week: before %s, after %s (for its batchless hand)',before_page,after_page));
 PERFORM fixture.assert(g1-g0=1,format('BEFORE: the predecessor sent the page through the tournament gate (%s call)',g1-g0));
 PERFORM fixture.assert(g2-g1=0,format('AFTER: the page is refused without the tournament gate (%s calls)',g2-g1));
 PERFORM fixture.assert((SELECT count(*)=1 FROM accounting_rakeback_period_evidence_checkpoints WHERE club_id=fixture.u(9101)),
  'The refused page still leaves its checkpoint, so the next page reads only what changed');
END $$;
-- The hand is accrued; the week is clean. The checkpoint the refused page left
-- is advanced by the next pages, which read only what was recorded since.
SET LOCAL session_replication_role=replica;
-- Recorded now, after the refused page's horizon, as any later batch is.
INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan,recorded_at)
 VALUES(fixture.u(9500),fixture.u(9800),'2026-09-14 08:00Z',md5('x'),'accrued','{}',clock_timestamp());
INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,earned_at,rake_credit,contract,recorded_at)
 SELECT a.rake_record_id,a.player_id,a.club_id,'2026-09-14 08:00Z',2,jsonb_build_object('attribution_id',a.id,'player_id',a.player_id,'club_id',a.club_id,'union_id',NULL,'coordinator_union_id',NULL),clock_timestamp()
   FROM rake_attributions a WHERE a.rake_record_id=fixture.u(9500);
SET LOCAL session_replication_role=origin;
-- An hour passes: the next horizon lies after the late batch.
UPDATE fixture.native_clock SET at_time=at_time+interval '1 hour';
DO $$ DECLARE r0 bigint; r1 bigint; r2 bigint; r3 bigint; g0 bigint; first_page jsonb; second_page jsonb; whole jsonb; cp record; BEGIN
 r0:=pg_temp.attribution_reads();
 PERFORM pg_temp.oracle_counts(fixture.u(9101),pg_temp.window_from('2026-09-14'),pg_temp.window_to('2026-09-14'),NULL);
 r1:=pg_temp.attribution_reads();
 first_page:=public.fn_calculate_cash_rakeback_periods(fixture.u(9101),'2026-09-14','2026-09-20','{}'::uuid[]);
 SELECT * INTO cp FROM accounting_rakeback_period_evidence_checkpoints WHERE club_id=fixture.u(9101);
 PERFORM fixture.assert(cp.settled_records>=2000 AND cp.settled_evidence=0 AND cp.settled_incomplete=0 AND cp.settled_drifted=0,
  'The checkpoint holds every batch of the week, the late one included, and no defect: '||row_to_json(cp)::text);
 r2:=pg_temp.attribution_reads();
 g0:=pg_temp.gate_calls();
 second_page:=public.fn_calculate_cash_rakeback_periods(fixture.u(9101),'2026-09-14','2026-09-20','{}'::uuid[]);
 r3:=pg_temp.attribution_reads();
 PERFORM fixture.assert(first_page=second_page AND second_page->>'status'='ready',
  format('An empty page is ready on the clean week, before and after the checkpoint advanced: %s, %s',first_page,second_page));
 -- The payee's own page, on the advanced checkpoint, against the whole period.
 whole:=pg_temp.run(fixture.u(9101),'2026-09-14',NULL,false)->'receipt';
 PERFORM fixture.assert(pg_temp.run(fixture.u(9101),'2026-09-14',ARRAY[fixture.u(9301)],false)->'receipt'=whole,
  format('The payee''s page on the advanced checkpoint answers what the whole period answers: whole %s',whole));
 PERFORM fixture.assert(pg_temp.gate_calls()-g0>=1,'A page the cash evidence does not refuse still asks the tournament gate');
 PERFORM fixture.assert(r1-r0>=2000 AND r3-r2<(r1-r0)/10,
  format('A checkpointed page reads %s attribution rows where the whole-period query reads %s',r3-r2,r1-r0));
 PERFORM fixture.assert((SELECT advances=3 FROM accounting_rakeback_period_evidence_checkpoints WHERE club_id=fixture.u(9101)),
  'The refused page and the two pages after it advanced one checkpoint (the compared runs undid their own advances)');
END $$;
-- ===== the whole period keeps its own full verification =====
DO $$ DECLARE g0 bigint; r0 bigint; cp_before jsonb; whole jsonb; BEGIN
 SELECT jsonb_agg(to_jsonb(c) ORDER BY club_id) INTO cp_before FROM accounting_rakeback_period_evidence_checkpoints c;
 g0:=pg_temp.gate_calls(); r0:=pg_temp.attribution_reads();
 whole:=public.fn_calculate_cash_rakeback_periods(fixture.u(9101),'2026-09-14','2026-09-20',NULL);
 PERFORM fixture.assert(pg_temp.gate_calls()-g0=1,'The whole-period call asks the tournament gate');
 PERFORM fixture.assert(pg_temp.attribution_reads()-r0>=2000,'The whole-period call reads the whole week');
 PERFORM fixture.assert((SELECT jsonb_agg(to_jsonb(c) ORDER BY club_id) FROM accounting_rakeback_period_evidence_checkpoints c) IS NOT DISTINCT FROM cp_before,
  'The whole-period call neither reads nor writes a checkpoint');
END $$;
ROLLBACK;

-- ===== the two facts the checkpoint rests on are refused, not assumed =====
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO rake_records(id,hand_id,table_id,club_id,rake_amount,created_at,is_tournament,metadata,source,rake_method)
 VALUES(fixture.u(9600),fixture.u(9601),fixture.u(9200),fixture.u(104),2,'2026-09-14 09:00Z',false,'{}','cash_game','WEIGHTED_CONTRIBUTED');
SET LOCAL session_replication_role=origin;
DO $$ BEGIN
 BEGIN
  INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
   VALUES(fixture.u(9600),fixture.u(9601),'2026-09-14 09:00:01Z','x','accrued','{}');
  RAISE EXCEPTION 'a batch that does not carry its record''s time was accepted';
 EXCEPTION WHEN SQLSTATE '23514' THEN
  PERFORM fixture.assert(SQLERRM='cash_accrual_batch_earned_at_is_not_its_record','A batch off its record''s time is refused: '||SQLERRM);
 END;
 BEGIN
  INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan,recorded_at)
   VALUES(fixture.u(9600),fixture.u(9601),'2026-09-14 09:00Z','x','accrued','{}',now()-interval '1 second');
  RAISE EXCEPTION 'a batch recorded before its own transaction began was accepted';
 EXCEPTION WHEN SQLSTATE '23514' THEN
  PERFORM fixture.assert(SQLERRM='cash_accrual_batch_recorded_before_its_transaction','A backdated batch is refused: '||SQLERRM);
 END;
 INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
  VALUES(fixture.u(9600),fixture.u(9601),'2026-09-14 09:00Z','x','accrued','{}');
 BEGIN
  INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,earned_at,rake_credit,contract)
   VALUES(fixture.u(9600),fixture.u(907),fixture.u(104),'2026-09-14 09:00:01Z',2,'{}');
  RAISE EXCEPTION 'a source that does not carry its batch''s time was accepted';
 EXCEPTION WHEN SQLSTATE '23514' THEN
  PERFORM fixture.assert(SQLERRM='cash_source_earned_at_is_not_its_batch','A source off its batch''s time is refused: '||SQLERRM);
 END;
 INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,earned_at,rake_credit,contract)
  VALUES(fixture.u(9600),fixture.u(907),fixture.u(104),'2026-09-14 09:00Z',2,'{}');
 PERFORM fixture.assert(true,'A batch and a source written as the accrual writes them are accepted');
END $$;
ROLLBACK;

-- ===== the horizon =====
DO $$ DECLARE h timestamptz; BEGIN
 h:=public.fn_accounting_commit_horizon();
 PERFORM fixture.assert(h IS NOT NULL AND h<=(SELECT min(xact_start) FROM pg_stat_activity WHERE xact_start IS NOT NULL)-interval '2 minutes'
   AND h<=clock_timestamp()-interval '2 minutes',
  format('The horizon %s is at least two minutes before the oldest running transaction and the clock',h));
END $$;
