\set ON_ERROR_STOP on
-- This cluster carries the exact INSTALLED weekly base, which is what the
-- migration's preimage guard names. What is proved here is that the floor the
-- coordinator now consults rounds, refuses and reconciles correctly on the real
-- installed definitions. The club scope's discovery BEHAVIOUR is proved after
-- this file, in tests/fixtures/club-settlement-floor-behaviour, which first
-- brings the captured union-only union_accounting_runs to the installed shared
-- scope shape that the 2026-09-14 catalog capture predates.
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

INSERT INTO rakeback_periods(club_id,user_id,period_start,period_end,rakeback_amount,status)
SELECT fixture.u(151),fixture.u(903),d.s,d.e,a,'pending'
  FROM (VALUES('2026-08-31'::date,'2026-09-06'::date,10.00),
              ('2026-09-01'::date,'2026-09-06'::date,7.25)) d(s,e,a);
INSERT INTO rakeback_periods(club_id,user_id,period_start,period_end,rakeback_amount,status)
VALUES(fixture.u(151),fixture.u(903),'2026-09-07','2026-09-13',5.00,'pending');

-- Counted from the real rows, never invented.
INSERT INTO accounting_deferred_obligations
  (scope_kind,scope_id,period_start,period_end,pending_periods,pending_amount,observed_at,reason)
SELECT 'club',rp.club_id,'2026-08-31 07:00Z','2026-09-07 07:00Z',
       count(*),sum(rp.rakeback_amount)::numeric(20,2),public.test_clock(),
       'Native fixture: deferred below the club settlement floor and still owed.'
  FROM rakeback_periods rp
 WHERE rp.status='pending' AND rp.club_id=fixture.u(151)
   AND fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')='2026-08-31 07:00Z'
 GROUP BY rp.club_id;

INSERT INTO club_settlement_floor(club_id,earliest_period_start,reason)
VALUES(fixture.u(151),'2026-09-07 07:00Z',
 'Native fixture: the week of 2026-08-31 precedes the observed source cutover and can never certify, so it is history. 2026-09-07 is the first settleable week.');
-- A floor set mid-week must round forward to the NEXT whole week, exactly as
-- union_floors rounds a mid-week union floor.
INSERT INTO club_settlement_floor(club_id,earliest_period_start,reason)
VALUES(fixture.u(152),'2026-09-09 13:45Z','Native fixture: a deliberately mid-week floor.');
