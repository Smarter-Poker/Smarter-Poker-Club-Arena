\set ON_ERROR_STOP on
-- Four scopes, identical except for the one thing under test.
--
-- The clock seam is the one tests/fixtures/club-settlement-floor/load.sql
-- already installed on this cluster; every financial predicate below is the
-- one the installed migrations left behind. Opening treasuries are zero: this
-- fixture is about which week the coordinator reaches, and it introduces no
-- synthetic chip movement into the real ledger triggers.
--
--   u(160) union, floor 2026-09-07  - the union side of the same rule
--   u(161) club,  floor 2026-09-07  - the club under test
--   u(162) club,  NO floor          - the negative control: unchanged behaviour
--   u(163) club,  floor 2026-09-07  - a genuine transient fault ABOVE the floor
--   u(164) club,  floor 2026-09-21  - a floor at the current week edge
--
-- Every scope carries the production shape of the stall: a `failed` run row for
-- 2026-08-31 07:00Z -> 2026-09-07 07:00Z that can never certify, plus the real
-- pending rakeback rows that pull that same week back into discovery on every
-- tick. That is what head-of-line blocked the settler from 2026-09-14.
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
SET test.clock='2026-09-21T09:20:00Z';

INSERT INTO unions(id,name,slug,owner_id) VALUES
 (fixture.u(160),'Behaviour floored union','club-floor-behaviour-union',fixture.u(900));
INSERT INTO clubs(id,name,owner_id,chip_treasury,asset,is_union,union_id) VALUES
 (fixture.u(161),'Behaviour floored standalone',fixture.u(901),0,'chips',false,NULL),
 (fixture.u(162),'Behaviour floorless control',fixture.u(901),0,'chips',false,NULL),
 (fixture.u(163),'Behaviour floored with a fault above the floor',fixture.u(901),0,'chips',false,NULL),
 (fixture.u(164),'Behaviour floored at the current week edge',fixture.u(901),0,'chips',false,NULL);

INSERT INTO union_settlement_floor(union_id,earliest_period_start,reason) VALUES
 (fixture.u(160),'2026-09-07 07:00Z',
  'Native fixture: the 2026-08-31 week precedes the observed source cutover and can never certify on the v3 basis.');
INSERT INTO club_settlement_floor(club_id,earliest_period_start,reason) VALUES
 (fixture.u(161),'2026-09-07 07:00Z',
  'Native fixture: the 2026-08-31 week precedes the observed source cutover and can never certify on the v3 basis.'),
 (fixture.u(163),'2026-09-07 07:00Z','Native fixture: same floor, with a resolvable fault in the first week above it.'),
 (fixture.u(164),'2026-09-21 07:00Z','Native fixture: a floor on the week the discovery window itself ends.');

-- Real pending rakeback rows. For u(161), u(162) and u(164) they sit in the
-- 2026-08-31 week and are one of the discovery terms that re-offers it. For
-- u(163) the pending row sits in the first week ABOVE its floor, where the
-- installed preparation refuses it for reconciliation - a real, resolvable
-- fault, not an injected one.
INSERT INTO rakeback_periods(club_id,user_id,period_start,period_end,rakeback_amount,status) VALUES
 (fixture.u(161),fixture.u(903),'2026-08-31','2026-09-06',10.00,'pending'),
 (fixture.u(161),fixture.u(903),'2026-09-01','2026-09-06',7.25,'pending'),
 (fixture.u(162),fixture.u(903),'2026-08-31','2026-09-06',10.00,'pending'),
 (fixture.u(163),fixture.u(903),'2026-09-07','2026-09-13',21.00,'pending'),
 (fixture.u(164),fixture.u(903),'2026-08-31','2026-09-06',31.00,'pending');

INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result) VALUES
 (fixture.u(160),'2026-08-31 07:00Z','2026-09-07 07:00Z','2026-09-07 09:00Z','failed',9,
  '{"success":false,"accounting_version":3,"error":"weekly_accounting_calculation_incomplete"}');
INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,result)
SELECT c,'2026-08-31 07:00Z','2026-09-07 07:00Z','2026-09-07 09:00Z','failed',9,
 '{"success":false,"accounting_version":3,"error":"historical_week_before_observed_source_cutover"}'
 FROM unnest(ARRAY[fixture.u(161),fixture.u(162),fixture.u(163),fixture.u(164)]) c;

-- What the floor leaves permanently unsettled for u(161), counted from the real
-- pending rows at a recorded observation time. Never an invented balance.
INSERT INTO accounting_deferred_obligations
  (scope_kind,scope_id,period_start,period_end,pending_periods,pending_amount,observed_at,reason)
SELECT 'club',rp.club_id,'2026-08-31 07:00Z','2026-09-07 07:00Z',
       count(*),sum(rp.rakeback_amount)::numeric(20,2),public.test_clock(),
       'Native fixture: deferred below the club settlement floor and still owed.'
  FROM rakeback_periods rp
 WHERE rp.status='pending' AND rp.club_id=fixture.u(161)
   AND fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')='2026-08-31 07:00Z'
 GROUP BY rp.club_id;
