ALTER TABLE club_members ADD COLUMN chip_balance numeric DEFAULT 0;
CREATE TABLE accounting_rakeback_period_calculations(club_id uuid,coordinator_union_id uuid,period_start date,period_end date);
CREATE TABLE accounting_routed_settlement_runs(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,round_no int,result jsonb);
INSERT INTO accounting_routed_settlement_runs
 SELECT 'union',u(1),'2026-09-07T07:00Z','2026-09-14T07:00Z',n,
  jsonb_build_object('success',true,'routing_version',3,'source_version',2,'shortfalls',0,'amount',CASE n WHEN 2 THEN 20 ELSE 5 END,'payees',1)
  FROM generate_series(2,3)n;
CREATE FUNCTION conservation(replay boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$
 SELECT fn_union_settlement_conservation_assert(u(1),'2026-09-07T07:00Z','2026-09-14T07:00Z',
  CASE WHEN replay THEN '{"error":"already_executed"}'::jsonb ELSE '{"success":true,"period_rake":350,"total_rakeback":245,"union_retained":105}'::jsonb END,
  (SELECT result FROM accounting_routed_settlement_runs WHERE round_no=2),
  (SELECT result FROM accounting_routed_settlement_runs WHERE round_no=3))
$$;
SELECT assert_true(conservation()->>'conservation'='asserted','conservation verifies actual canonical close and exact routed receipt witnesses');
SELECT assert_true((conservation(true)->>'round1_paid')::numeric=245,'retry recovers exactly the immutable paid close');
SELECT assert_true(NOT has_function_privilege('authenticated','fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb)','EXECUTE'),'full union wallet verification stays private to the coordinator');
BEGIN;
UPDATE clubs SET chip_treasury=-1 WHERE id=u(3);
SELECT assert_true(refuses('SELECT conservation()','P0001'),'negative departed club treasury cannot disappear from its earned week');
ROLLBACK;
BEGIN;
INSERT INTO clubs(id,name,union_id,chip_treasury) VALUES(u(99),'New club',u(1),-1);
INSERT INTO union_clubs VALUES(u(1),u(99));
INSERT INTO accounting_agreement_history VALUES(999,'union_clubs',u(999)::text,u(99),'2026-09-15T00:00Z',jsonb_build_object('id',u(999),'club_id',u(99),'union_id',u(1)));
SELECT assert_true(conservation()->>'conservation'='asserted','a club that joined after the closed week is outside that accounting book');
ROLLBACK;
BEGIN;
DELETE FROM union_wallets WHERE union_id=u(1);
SELECT assert_true(refuses('SELECT conservation()','P0001'),'a missing union wallet is unknown, never a zero balance');
ROLLBACK;
BEGIN;
UPDATE union_wallets SET chip_balance='NaN' WHERE union_id=u(1);
SELECT assert_true(refuses('SELECT conservation()','P0001'),'non-finite balances cannot pass conservation');
ROLLBACK;
BEGIN;
INSERT INTO club_members(club_id,user_id,role,status,chip_balance) VALUES(u(3),u(105),'member','active',-1);
SELECT assert_true(refuses('SELECT conservation()','P0001'),'departed club member wallets remain in the earned book');
ROLLBACK;
BEGIN;
UPDATE accounting_routed_settlement_runs SET scope_id=u(99) WHERE round_no=2;
SELECT assert_true(refuses('SELECT conservation()','P0001'),'another union receipt cannot certify this union');
ROLLBACK;
BEGIN;
UPDATE accounting_routed_settlement_runs SET result=jsonb_set(result,'{shortfalls}','1') WHERE round_no=3;
SELECT assert_true(refuses('SELECT conservation()','P0001'),'a stored partial route cannot certify completion');
ROLLBACK;
BEGIN;
UPDATE ca_settlements SET totals=jsonb_set(totals,'{payout_total}','244') WHERE settlement_type='union_rakeback_close';
SELECT assert_true(refuses('SELECT conservation()','P0001'),'reported close totals must match the actual immutable close');
ROLLBACK;
