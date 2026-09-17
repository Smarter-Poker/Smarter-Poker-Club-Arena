-- UNRUN before/after source regression for the existing isolated fixture.
-- Load preserved0141 and candidate0144 only within that fixture's private schema.
-- No production installation or financial authority; both return accepted=false.
DO $before_after$
DECLARE
 j jsonb := $j${"original":{"cashAssociation":{"originalAdmission":{"participants":[{"userId":"00000000-0000-0000-0000-000000000001","seatId":"00000000-0000-0000-0000-000000000011","occupancyId":"00000000-0000-0000-0000-000000000021","seatJoinedAt":"2026-09-15T00:00:00.123456Z","seatNumber":1,"clubId":"00000000-0000-0000-0000-000000000031"},{"userId":"00000000-0000-0000-0000-000000000002","seatId":"00000000-0000-0000-0000-000000000012","occupancyId":"00000000-0000-0000-0000-000000000022","seatJoinedAt":"2026-09-15T00:00:00.123456Z","seatNumber":2,"clubId":"00000000-0000-0000-0000-000000000031"}]}},"seats":[{"user_id":"00000000-0000-0000-0000-000000000001","seat_id":"00000000-0000-0000-0000-000000000011","occupancy_id":"00000000-0000-0000-0000-000000000021","seat_joined_at":"2026-09-15T00:00:00.123456Z","seat_number":1},{"user_id":"00000000-0000-0000-0000-000000000002","seat_id":"00000000-0000-0000-0000-000000000012","occupancy_id":"00000000-0000-0000-0000-000000000022","seat_joined_at":"2026-09-15T00:00:00.123456Z","seat_number":2}]},"records":[{"playerId":"00000000-0000-0000-0000-000000000001","kind":"insurance","premium":10,"payout":20}],"stages":[{"userId":"00000000-0000-0000-0000-000000000001","kind":"payout","ordinal":0,"before":9000,"after":11000,"debit":0,"credit":2000,"intended":2000,"disposition":"applied"},{"userId":"00000000-0000-0000-0000-000000000001","kind":"ordinary_premium","ordinal":1,"before":11000,"after":10000,"debit":1000,"credit":0,"intended":1000,"disposition":"applied"}]}$j$::jsonb;
 q jsonb := $q${"p_table_id":null,"p_hand_number":null,"p_stacks":null,"p_rake":null,"p_bbj":null,"p_ref":null,"p_inflow":null,"p_hand_row":{"_accepted_post_commit_facts":{"insurance":[{"player_id":"00000000-0000-0000-0000-000000000001","kind":"insurance","premium":10,"payout":20,"club_id":"00000000-0000-0000-0000-000000000031","equity_percent":50,"insured_amount":10,"player_won":true}]}},"p_units":null,"p_instance_id":null,"p_lease_generation":null,"p_post_commit_obligations":{"insurance":[{"player_id":"00000000-0000-0000-0000-000000000001","kind":"insurance","premium":10,"payout":20,"club_id":"00000000-0000-0000-0000-000000000031","equity_percent":50,"insured_amount":10,"player_won":true}]}}$q$::jsonb;
 bad jsonb; old_result jsonb; observed text;
BEGIN
 bad:=jsonb_set(j,'{stages,0,intended}','0');
 old_result:=smarter_private.insurance_projection_0141(bad,q);
 IF old_result->'accepted' IS DISTINCT FROM 'false'::jsonb
  OR old_result->'global_stages'->0->'intended' IS DISTINCT FROM '0'::jsonb
  OR old_result->'global_stages'->0->'credit' IS DISTINCT FROM '2000'::jsonb THEN
  RAISE EXCEPTION 'IP0144_PREDECESSOR_COUNTEREXAMPLE_NOT_REPRODUCED';
 END IF;
 observed:=NULL;
 BEGIN PERFORM smarter_private.insurance_projection_0144(bad,q);
 EXCEPTION WHEN OTHERS THEN observed:=SQLERRM; END;
 IF observed IS DISTINCT FROM 'IP0144_STAGE_INTENT' THEN
  RAISE EXCEPTION 'IP0144_SUCCESSOR_COUNTEREXAMPLE_NOT_REFUSED: %',observed;
 END IF;
END
$before_after$;
