\ir ../mystery-bust-phase/schema.sql
\ir ../mystery-bust-phase/functions.sql
\ir ../mystery-bust-phase/helpers.sql
CREATE TABLE public.clubs(id uuid PRIMARY KEY,asset text,is_platform boolean,union_id uuid);
ALTER TABLE public.tournaments ADD COLUMN club_id uuid;
ALTER TABLE public.tournaments ADD COLUMN union_id uuid;
-- Minimum shape read by the actual claim's existing rebuy-lineage check.
CREATE TABLE public.chip_ledger(from_entity_id uuid,tournament_id uuid,category text,
  from_type text,to_type text,status text,amount numeric,created_at timestamptz);
\ir ../settled-bounty-replay/current-functions.sql
\ir current-functions.sql
\ir ../../../../supabase/migrations/20260914122903_settled_bounty_replay_precedes_pending_order.sql
-- The inherited wallet payer is a documented pool-bounded test stand-in.
-- Adapt only the test bust builder to select the actual participant's table.
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('public.fixture_bust(uuid,uuid,uuid,bigint,timestamptz)'::regprocedure),
  'SELECT id INTO v_tb FROM public.tables WHERE tournament_id=p_t;',
  'SELECT table_id INTO v_tb FROM public.tournament_players WHERE tournament_id=p_t AND user_id=p_user;');
END $$;
ALTER FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fixture_pko_tables() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t uuid; t2 uuid:=gen_random_uuid(); r jsonb; h uuid; o uuid;
 a uuid:='a0000000-0000-4000-8000-000000000001'; b uuid:='b0000000-0000-4000-8000-000000000001';
 c uuid:='c0000000-0000-4000-8000-000000000001'; d uuid:='d0000000-0000-4000-8000-000000000001';
BEGIN
 t:=fixture_event('Independent PKO tables',ARRAY[a,b,c,d]::text[],5.01);
 UPDATE tournaments SET is_mystery_bounty=false,is_pko=true WHERE id=t;
 INSERT INTO tables(id,tournament_id,current_players) VALUES(t2,t,2);
 UPDATE table_seats SET table_id=t2 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id IN(c,d);
 UPDATE tournament_players SET table_id=t2 WHERE tournament_id=t AND user_id IN(c,d);
 PERFORM fixture_bust(t,c,d,5000002,clock_timestamp()-interval '5 seconds');
 r:=fixture_claim(t,c,d,4);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'bounty_blocked' IS NULL,'higher hand has a funded head claim');
 o:=(r->>'obligation_id')::uuid;
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'marker_verified'='true','higher-numbered disjoint hand settles first');
 h:=fixture_bust(t,a,b,5000001,clock_timestamp());
 RETURN jsonb_build_object('t',t,'a',a,'b',b,'c',c,'d',d,'higher',o,'lower_hand',h,
   'lower_table',(SELECT table_id FROM tournament_players WHERE tournament_id=t AND user_id=a));
END $$;
