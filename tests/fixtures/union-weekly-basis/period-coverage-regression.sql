-- The weekly close recomputes the WHOLE period, not the settler's page.
--
-- RakebackSettlerService drains a bounded page of rake_records
-- (FETCH_LIMIT x MAX_DRAIN_BATCHES), hands only that page's player ids to
-- fn_rakeback_recompute_periods, and then advances
-- daemon_state.rakeback_settler.high_water_mark past the whole page with a
-- strict >. A payee whose earnings fell outside that page is never revisited
-- by the settler, so mid-week the certificate set is a SUBSET of the week's
-- payees. Round 3 refuses exactly that book, by design: every source player in
-- the scope must hold an admitted certificate, including one owed nothing, or
-- the money is unaccounted.
--
-- What closes the book is that fn_prepare_accounting_week re-runs
-- fn_rakeback_recompute_periods for the period with p_user_ids NULL, for every
-- club of the week, before any payer stage - and fn_calculate_cash_rakeback_periods
-- with NULL draws its player set from accounting_payable_earning_sources for
-- the whole period rather than from any drained page. That NULL is load
-- bearing, in the club scope and the union scope alike. This fixture pins both
-- halves: the guard fires on a page-scoped book, and the installed weekly close
-- completes the book before round 3 ever sees it.
SET search_path=fixture_clock,public,pg_catalog,pg_temp;
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

-- ===== a week whose payees straddle the drain page =====
-- 901 is an active club-104 member with no agent and a zero player deal. Its
-- 0.09 of rake credit rounds to 0.00 of rakeback: the zero-entitlement payee
-- the guard still demands a certificate for.
UPDATE fixture.native_clock SET at_time='2026-09-22 12:00Z';
UPDATE club_members SET chip_balance=400 WHERE club_id=fixture.u(104) AND user_id=fixture.u(901);
UPDATE club_members SET player_rakeback_pct=0.0500 WHERE club_id=fixture.u(104) AND user_id=fixture.u(901);
UPDATE club_members SET player_rakeback_pct=0.0000 WHERE club_id=fixture.u(104) AND user_id=fixture.u(901);
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(901),fixture.u(305),3,100,false,fixture.u(104),NULL);

-- The raked week's own lease and instance are kept: this fixture adds a hand to
-- that table, it does not take the table over from a later fixture.
UPDATE fixture.native_clock SET at_time='2026-09-24 12:00Z';
UPDATE engine_table_leases SET heartbeat_at=clock_timestamp() WHERE table_id=fixture.u(305);

SELECT fn_cash_capture_hand_manifest(fixture.u(305),1000801,
 (SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'occupancy_id',s.occupancy_id,
   'seat_joined_at',s.joined_at,'stack_before',s.stack,'is_horse',p.is_horse) ORDER BY s.user_id)
  FROM table_seats s JOIN profiles p ON p.id=s.user_id
  WHERE s.table_id=fixture.u(305) AND s.left_at IS NULL),'weekly-raked-native',fixture.u(602));

DO $$ DECLARE stacks jsonb; result jsonb; BEGIN
 SELECT jsonb_agg(jsonb_build_object('user_id',x->'user_id','seat_id',x->'seat_id','occupancy_id',x->'occupancy_id',
  'seat_joined_at',x->'seat_joined_at','funding_manifest_id',m.id,'stack_before',x->'stack_before',
  'stack',(x->>'stack_before')::numeric+CASE x->>'user_id'
     WHEN fixture.u(907)::text THEN 9 WHEN fixture.u(908)::text THEN -6 ELSE -6 END)) INTO stacks
 FROM cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) x
 WHERE m.hand_number=1000801;
 result:=fn_ca_commit_hand_settlement_before_lease_generation(fixture.u(305),1000801,stacks,3,0,NULL,0,
  jsonb_build_object('table_id',fixture.u(305),'hand_number',1000801,'started_at',clock_timestamp()),'[]');
 PERFORM fixture.assert(result->>'success'='true','Coverage week raked hand conserves +9 -6 -6 with three rake: '||result::text);
END $$;

CREATE TEMP TABLE period_coverage_bank AS SELECT * FROM atomic_distribute_rake(fixture.u(305),fixture.u(203),
 (SELECT hand_id FROM hand_atomic_commits WHERE table_id=fixture.u(305) AND hand_number=1000801),1000801,3,0,150,3,
 jsonb_build_object(fixture.u(907)::text,60,fixture.u(908)::text,37,fixture.u(901)::text,3),NULL,NULL,'WEIGHTED_CONTRIBUTED');
SELECT fixture.assert((SELECT count(*)=1 AND bool_and(applied) FROM period_coverage_bank),'Coverage week rake banks once');
DO $$ DECLARE result jsonb; BEGIN
 SELECT fn_process_cash_accounting_source(rake_record_id) INTO result FROM period_coverage_bank;
 PERFORM fixture.assert(result->>'status'='accrued','Coverage week rake accrues: '||result::text);
END $$;

-- The settler's durable cursor, drained to the end of the week, as production
-- carries it. Without a row the union branch refuses every week outright.
INSERT INTO daemon_state(daemon,high_water_mark,high_water_mark_id)
SELECT 'rakeback_settler',max(r.created_at),(SELECT id FROM rake_records ORDER BY created_at DESC,id DESC LIMIT 1)
FROM rake_records r
ON CONFLICT (daemon) DO UPDATE SET high_water_mark=EXCLUDED.high_water_mark,high_water_mark_id=EXCLUDED.high_water_mark_id;

SELECT fixture.assert((SELECT count(*)=3 FROM accounting_payable_earning_sources
  WHERE earned_at>='2026-09-21 07:00Z' AND earned_at<'2026-09-28 07:00Z'),'Coverage week carries three payable sources');
SELECT fixture.assert((SELECT count(*)=2 FROM accounting_payable_earning_sources
  WHERE earned_at>='2026-09-21 07:00Z' AND earned_at<'2026-09-28 07:00Z'
    AND COALESCE((contract->>'is_union_house')::boolean,false) IS FALSE),'Two of them are ordinary payees the guard demands certificates for');

UPDATE fixture.native_clock SET at_time='2026-09-28 09:00Z';

-- ===== the settler drains a page holding only one of the two payees =====
DO $$ DECLARE page jsonb; BEGIN
 page:=fn_rakeback_recompute_periods(fixture.u(104),'2026-09-21','2026-09-27',ARRAY[fixture.u(907)]);
 PERFORM fixture.assert(page->>'status'='ready','A page-scoped drain reports ready for the page it drained: '||page::text);
 PERFORM fixture.assert(page->>'request_state'='pending','A page-scoped drain never marks the period request complete: '||page::text);
END $$;
SELECT fixture.assert((SELECT count(*)=1 FROM rakeback_periods rp JOIN accounting_rakeback_period_calculations c ON c.period_id=rp.id
  WHERE rp.period_start='2026-09-21' AND rp.period_end='2026-09-27'),'After the page drain only the drained payee holds a certificate');

DO $$ BEGIN
 BEGIN
  PERFORM fn_settle_accounting_rakeback_stage('union',fixture.u(203),'2026-09-21 07:00Z','2026-09-28 07:00Z');
  RAISE EXCEPTION 'Round 3 accepted a scope whose source player had no certificate';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  PERFORM fixture.assert(SQLERRM='routed_rakeback_player_period_missing',
   'Round 3 refuses a page-scoped book with routed_rakeback_player_period_missing: '||SQLERRM);
 END;
END $$;

-- ===== the period-complete recompute is what the weekly close performs =====
SELECT fixture.assert(position('result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);'
  IN pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))>0,
 'The weekly close recomputes each club for the whole period, with no user list');
SELECT fixture.assert(position('AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))'
  IN pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure))>0,
 'A NULL user list draws every payee of the period from accounting_payable_earning_sources');

-- The club scope reaches the same producer. Deep Stack Society settles through
-- exactly this call: fn_accounting_week_clubs returns the club itself, and the
-- period-complete recompute closes the page-drained gap before any payer stage.
BEGIN;
DO $$ DECLARE prepared jsonb; BEGIN
 prepared:=fn_prepare_accounting_week(NULL,fixture.u(104),'2026-09-21 07:00Z','2026-09-28 07:00Z');
 PERFORM fixture.assert(prepared->>'success'='true' AND prepared->>'clubs'='1',
  'A standalone-shaped club scope prepares its own week: '||prepared::text);
 PERFORM fixture.assert((SELECT count(*)=0 FROM (
   SELECT DISTINCT s.club_id,s.player_id FROM accounting_payable_earning_sources s
    WHERE s.club_id=fixture.u(104) AND s.earned_at>='2026-09-21 07:00Z' AND s.earned_at<'2026-09-28 07:00Z') src
  WHERE NOT EXISTS(SELECT 1 FROM rakeback_periods rp JOIN accounting_rakeback_period_calculations c ON c.period_id=rp.id
    WHERE rp.club_id=src.club_id AND rp.user_id=src.player_id AND rp.period_start='2026-09-21' AND rp.period_end='2026-09-27')),
  'The club-scope preparation leaves no source pair of its week uncovered');
END $$;
ROLLBACK;

-- A page-scoped weekly close is refused instead of paying an incomplete book.
-- This is the negative control for the NULL above.
BEGIN;
DO $$ DECLARE accepted text; paged text; prepared jsonb; problem jsonb; BEGIN
 accepted:=pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 paged:=replace(accepted,'result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);',
   format('result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,ARRAY[%L]::uuid[]);',fixture.u(907)::text));
 PERFORM fixture.assert(paged<>accepted,'Page-scoped negative control binds the exact period-complete call');
 EXECUTE paged;
 prepared:=fn_prepare_accounting_week(NULL,fixture.u(104),'2026-09-21 07:00Z','2026-09-28 07:00Z');
 PERFORM fixture.assert(prepared->>'success'='false','A page-scoped weekly close refuses its week: '||prepared::text);
 SELECT p INTO problem FROM jsonb_array_elements(prepared->'problems') p WHERE p->>'club_id'=fixture.u(104)::text;
 PERFORM fixture.assert(problem->>'reason'='weekly_calculation_receipt_not_confirmed',
  'The refusal names the unconfirmed period receipt: '||COALESCE(problem::text,'<no problem recorded>'));
END $$;
ROLLBACK;

-- ===== the real due coordinator, at a simulated 2026-09-28T09:00Z =====
-- fn_union_settlement_cascade_due() is the engine entry point and delegates
-- straight to fn_process_weekly_accounting(NULL); that delegate is what this
-- captured catalog carries, so it is what the fixture drives.
CREATE TEMP TABLE period_coverage_due AS SELECT fn_process_weekly_accounting(NULL) AS r;
DO $$ DECLARE scope jsonb; bad jsonb; BEGIN
 SELECT d INTO scope FROM period_coverage_due,LATERAL jsonb_array_elements(r->'detail') d
  WHERE d->>'union_id'=fixture.u(203)::text AND (d->>'period_start')::timestamptz='2026-09-21 07:00Z'::timestamptz;
 PERFORM fixture.assert(scope IS NOT NULL,'The due coordinator visits the raked union for the coverage week');
 PERFORM fixture.assert(scope->'result'->>'success'='true','The due coordinator closes the page-straddled week: '||scope::text);
 -- Round 3 routed BOTH certified periods of the week, not just the page the
 -- settler drained, and paid only the one actually owed anything.
 PERFORM fixture.assert(scope->'result'->'round3_agents_to_players'->>'periods'='2'
   AND scope->'result'->'round3_agents_to_players'->>'payees'='1'
   AND scope->'result'->'round3_agents_to_players'->'shortfalls'='0'::jsonb,
  'Round 3 routes every certified period of the week: '||(scope->'result'->'round3_agents_to_players')::text);
 -- Scopes this cluster's earlier fixtures deliberately left unfundable or with
 -- changed intra-week terms still refuse, on their own reasons. What no scope of
 -- the run may do is stall on a payee's missing or unconfirmed player period.
 SELECT jsonb_agg(d) INTO bad FROM period_coverage_due,LATERAL jsonb_array_elements(r->'detail') d
  WHERE position('routed_rakeback_player_period_missing' IN
        COALESCE(d->'result'->>'error','')||COALESCE(d->'result'->>'detail',''))>0
     OR position('weekly_calculation_receipt_not_confirmed' IN COALESCE(d->'result'->>'detail',''))>0;
 PERFORM fixture.assert(bad IS NULL,
  'No scope of the due run is stranded by a missing or unconfirmed player period: '||COALESCE(bad::text,'[]'));
END $$;

SELECT fixture.assert((SELECT count(*)=4 AND bool_and(detail->>'success'='true') FROM union_settlement_rounds
  WHERE union_id=fixture.u(203) AND period_start='2026-09-21 07:00Z'),'All four rounds of the coverage week succeed');
SELECT fixture.assert((SELECT count(*)=2 AND bool_and(result->>'success'='true' AND result->>'routing_version'='3'
   AND result->>'source_version'='2' AND result->'shortfalls'='0'::jsonb)
  FROM accounting_routed_settlement_runs WHERE scope_kind='union' AND scope_id=fixture.u(203)
   AND period_start='2026-09-21 07:00Z'),'Both routed payout stages of the coverage week retain complete receipts');

-- Every ordinary source pair of the week now holds exactly one certificate,
-- including the payee the drain page missed and the one owed nothing.
SELECT fixture.assert((SELECT count(*)=0 FROM (
   SELECT DISTINCT s.club_id,s.player_id FROM accounting_payable_earning_sources s
    WHERE s.earned_at>='2026-09-21 07:00Z' AND s.earned_at<'2026-09-28 07:00Z'
      AND COALESCE((s.contract->>'is_union_house')::boolean,false) IS FALSE) src
  WHERE NOT EXISTS(SELECT 1 FROM rakeback_periods rp JOIN accounting_rakeback_period_calculations c ON c.period_id=rp.id
    WHERE rp.club_id=src.club_id AND rp.user_id=src.player_id
      AND rp.period_start='2026-09-21' AND rp.period_end='2026-09-27')),
 'Every ordinary source pair of the coverage week holds an admitted certificate');
SELECT fixture.assert((SELECT rakeback_amount=0 AND status='paid' FROM rakeback_periods
  WHERE club_id=fixture.u(104) AND user_id=fixture.u(901) AND period_start='2026-09-21'),
 'The zero-entitlement payee the drain page missed is certified and closed at zero');
SELECT fixture.assert((SELECT rakeback_amount=0.18 AND status='paid' FROM rakeback_periods
  WHERE club_id=fixture.u(104) AND user_id=fixture.u(907) AND period_start='2026-09-21'),
 'The drained payee keeps its own exact entitlement');
SELECT fixture.assert((SELECT count(*)=0 FROM rakeback_periods
  WHERE club_id=fixture.u(203) AND period_start='2026-09-21'),
 'The retained union-house source still gets no player period');

-- ===== replay changes no money =====
DO $$ DECLARE fingerprint text; due jsonb; scope jsonb; BEGIN
 SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM chip_ledger x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM settlement_invoices x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM accounting_invoice_deliveries x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM rakeback_periods x))::text) INTO fingerprint;
 due:=fn_process_weekly_accounting(NULL);
 SELECT d INTO scope FROM jsonb_array_elements(due->'detail') d
  WHERE d->>'union_id'=fixture.u(203)::text AND (d->>'period_start')::timestamptz='2026-09-21 07:00Z'::timestamptz;
 PERFORM fixture.assert(scope IS NULL OR scope->'result'->>'success'='true',
  'A replayed due run does not fail the closed week: '||COALESCE(scope::text,'<not revisited>'));
 PERFORM fixture.assert(fingerprint=(SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM chip_ledger x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM settlement_invoices x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM accounting_invoice_deliveries x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM rakeback_periods x))::text)),
  'Replaying the due coordinator creates no further payment, invoice, delivery or period');
END $$;

-- Leave the shared cluster's calendar exactly where the raked week left it, so
-- the qualifications that follow capture their hands in their own week.
UPDATE fixture.native_clock SET at_time='2026-09-15 12:00Z';
SELECT fixture.assert(now()='2026-09-15 12:00Z'::timestamptz,'The coverage week restores the raked calendar for the fixtures after it');
