ALTER TABLE public.tables ADD COLUMN union_id uuid, ADD COLUMN tournament_id uuid,
 ADD COLUMN game_variant text DEFAULT 'nlh';
CREATE TABLE public.table_seats(id uuid PRIMARY KEY, table_id uuid NOT NULL REFERENCES tables(id),
 user_id uuid NOT NULL REFERENCES profiles(id), seat_number integer, stack numeric,
 joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz,
 occupancy_id uuid NOT NULL DEFAULT gen_random_uuid(),club_id uuid);
\ir poker-diamond-cash-stack-prerequisite.sql
\ir ../../supabase/migrations/20260910022036_diamond_cash_custody_settles_exact_seat_generations.sql
INSERT INTO public.profiles(id,diamonds) VALUES ('10000000-0000-0000-0000-000000000002',1000);
CREATE TEMP TABLE game_custody AS
 SELECT '10000000-0000-0000-0000-000000000001'::uuid user_id,
 public.fn_poker_diamond_reserve('10000000-0000-0000-0000-000000000001','cash_seat',
 '30000000-0000-0000-0000-000000000001','game-a',300,
 '40000000-0000-0000-0000-000000000002') receipt;
INSERT INTO game_custody SELECT '10000000-0000-0000-0000-000000000002'::uuid,
 public.fn_poker_diamond_reserve('10000000-0000-0000-0000-000000000002','cash_seat',
 '30000000-0000-0000-0000-000000000001','game-b',300,
 '40000000-0000-0000-0000-000000000003');
INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id)
 SELECT (receipt->>'custody_id')::uuid,'30000000-0000-0000-0000-000000000001',
 user_id,row_number() OVER(ORDER BY user_id),300,'2026-09-10T01:00:00Z',
 '20000000-0000-0000-0000-000000000001' FROM game_custody;
UPDATE poker_diamond_custody c SET state='active',seat_id=s.id,
 seat_joined_at=s.joined_at,occupancy_id=s.occupancy_id FROM table_seats s WHERE c.id=s.id;
CREATE TABLE fixture_diamond_hand_input AS SELECT jsonb_agg(jsonb_build_object(
 'user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,
 'stack_before',300,'stack',CASE WHEN seat_number=1 THEN 0 ELSE 600 END)
 ORDER BY user_id) stacks FROM table_seats;
CREATE FUNCTION fixture_refuses(q text,expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE failed boolean:=false; detail text;
BEGIN
 BEGIN EXECUTE q;
 EXCEPTION WHEN OTHERS THEN
  detail:=SQLERRM;
  IF detail NOT LIKE '%'||expected||'%' THEN RAISE; END IF;
  failed:=true;
 END;
 PERFORM fixture_assert(failed,expected);
END $$;
SELECT fixture_assert(NOT has_function_privilege('authenticated',
 'fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)','EXECUTE')
 AND NOT has_function_privilege('service_role',
 'fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)','EXECUTE'),
 'custody hand primitive is owner only');
SELECT fixture_assert(NOT has_table_privilege('authenticated','poker_diamond_hand_receipts','SELECT'),
 'private hand receipts are not exposed to clients');
SELECT fixture_refuses($q$SELECT fn_ca_settle_hand_stacks_absolute(
 '30000000-0000-0000-0000-000000000001',1000001,
 jsonb_set(stacks,'{0,stack}','0.5'),0,0,null,0) FROM fixture_diamond_hand_input$q$,
 'diamond_invalid_hand_amount_or_generation');
SELECT fixture_refuses($q$SELECT fn_ca_settle_hand_stacks_absolute(
 '30000000-0000-0000-0000-000000000001',1000001,
 jsonb_set(stacks,'{0,stack}','1'),0,0,null,0) FROM fixture_diamond_hand_input$q$,
 'diamond_hand_does_not_conserve');
SELECT fixture_refuses($q$SELECT fn_ca_settle_hand_stacks_absolute(
 '30000000-0000-0000-0000-000000000001',1000001,
 jsonb_set(stacks,'{0,seat_joined_at}','"2026-09-10T02:00:00Z"'),0,0,null,0)
 FROM fixture_diamond_hand_input$q$,'diamond_hand_stale_seat');
SELECT fixture_refuses($q$SELECT fn_ca_settle_hand_stacks_absolute(
 '30000000-0000-0000-0000-000000000001',1000001,stacks,1,0,null,0)
 FROM fixture_diamond_hand_input$q$,'diamond_plain_cash_hand_required');
SELECT fixture_refuses($q$SELECT fn_poker_diamond_release(
 (SELECT id FROM poker_diamond_custody WHERE state='active' ORDER BY user_id LIMIT 1),
 '50000000-0000-0000-0000-000000000002')$q$,'diamond_custody_requires_settlement');
-- Failure on the second player's custody write must undo the first player's
-- lot consumption and both seat/custody updates, not return a partial success.
CREATE FUNCTION fixture_fail_second_custody() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.user_id='10000000-0000-0000-0000-000000000002' AND NEW.balance<>OLD.balance
 THEN RAISE EXCEPTION 'fixture_second_custody_write'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fixture_fail_second_custody BEFORE UPDATE ON poker_diamond_custody
 FOR EACH ROW EXECUTE FUNCTION fixture_fail_second_custody();
SELECT fixture_refuses($q$SELECT fn_ca_settle_hand_stacks_absolute(
 '30000000-0000-0000-0000-000000000001',1000001,stacks,0,0,null,0)
 FROM fixture_diamond_hand_input$q$,'fixture_second_custody_write');
SELECT fixture_assert((SELECT bool_and(balance=300) FROM poker_diamond_custody WHERE state='active')
 AND (SELECT bool_and(stack=300) FROM table_seats)
 AND (SELECT bool_and(consumed=0 AND arena_reserved=300) FROM diamond_purchase_lots),
 'failed second write rolls back all balances and purchase lots');
SELECT fixture_assert((SELECT count(*)=0 FROM poker_diamond_hand_receipts),
 'failed hand retains no success receipt');
DROP TRIGGER fixture_fail_second_custody ON poker_diamond_custody;
