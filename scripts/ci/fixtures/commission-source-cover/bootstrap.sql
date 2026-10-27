CREATE SCHEMA fixture;CREATE ROLE service_role;CREATE ROLE anon;CREATE ROLE authenticated;
 CREATE FUNCTION fixture.u(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT md5('r2-fixture-'||n)::uuid$$;
 CREATE TABLE accounting_payable_earning_sources(source_type text,source_id uuid,club_id uuid,earned_at timestamptz,coordinator_union_id uuid,contract jsonb);
 CREATE TABLE agent_commissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_type text,source_id uuid,club_id uuid,user_id uuid,amount numeric,commission_rate numeric,settled_at timestamptz,created_at timestamptz);
 CREATE UNIQUE INDEX uq_agent_commissions_source ON agent_commissions(user_id,source_id,source_type) WHERE source_id IS NOT NULL;
 CREATE INDEX idx_agent_commissions_source_lookup ON agent_commissions(source_id,source_type,club_id) WHERE source_id IS NOT NULL;
 CREATE INDEX idx_agent_commissions_club_created ON agent_commissions(club_id,created_at) INCLUDE(user_id,amount,settled_at);
 CREATE FUNCTION fixture.tier(a integer,u integer,own numeric,rate numeric,parent integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('agent_id',fixture.u(a),'user_id',fixture.u(u),'amount',own,'rate',rate,'role','agent','agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',fixture.u(parent))))$$;
 INSERT INTO accounting_payable_earning_sources VALUES
 ('cash_rake_accrual',fixture.u(101),fixture.u(1),'2026-10-19 08:00Z',fixture.u(99),jsonb_build_object('club_id',fixture.u(1),'tiers',jsonb_build_array(fixture.tier(10,110,1.25,.2,20),fixture.tier(20,120,2.75,.3)))) ,
 ('tournament_fee_accrual',fixture.u(102),fixture.u(2),'2026-10-19 08:30Z',fixture.u(99),jsonb_build_object('club_id',fixture.u(2),'tiers',jsonb_build_array(fixture.tier(30,130,.7,.1)))),
 ('cash_rake_accrual',fixture.u(103),fixture.u(1),'2026-10-19 08:45Z',fixture.u(99),jsonb_build_object('club_id',fixture.u(1),'tiers','[]'::jsonb)),
 ('cash_rake_accrual',fixture.u(104),fixture.u(1),'2026-10-19 09:00Z',fixture.u(99),jsonb_build_object('club_id',fixture.u(1),'tiers','[]'::jsonb));
 INSERT INTO agent_commissions(source_type,source_id,club_id,user_id,amount,commission_rate,created_at)
 SELECT s.source_type,s.source_id,s.club_id,(j->>'user_id')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric,s.earned_at
 FROM accounting_payable_earning_sources s CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers')j;
 ANALYZE;