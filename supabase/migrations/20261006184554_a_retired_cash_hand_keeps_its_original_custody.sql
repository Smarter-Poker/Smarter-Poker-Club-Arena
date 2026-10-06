-- Current restitution for five immutable original occupancies in four hands.
-- The lost-felt snapshot remains historical evidence. This explicitly labelled
-- issuance and the original native hand commit succeed or roll back together.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
CREATE TABLE smarter_private.retired_cash_hand_qualification(
 submission_id uuid PRIMARY KEY,request_hash text NOT NULL,table_id uuid NOT NULL,
 hand_number bigint NOT NULL,expected jsonb NOT NULL);
CREATE TABLE smarter_private.retired_cash_hand_custody(
 submission_id uuid NOT NULL,user_id uuid NOT NULL,table_id uuid NOT NULL,
 hand_number bigint NOT NULL,seat_id uuid NOT NULL,occupancy_id uuid NOT NULL UNIQUE,
 seat_joined_at timestamptz NOT NULL,stack_before numeric NOT NULL,stack_after numeric NOT NULL,
 funding_club_id uuid NOT NULL,original_left_at timestamptz NOT NULL,
 original_inventory_event bigint NOT NULL,request_hash text NOT NULL,
 transaction_id bigint NOT NULL,restore_key text NOT NULL UNIQUE,issuance_ledger uuid NOT NULL,
 original_time_bank jsonb NOT NULL,state text NOT NULL CHECK(state IN('held','consumed')),
 settlement_id uuid,accepted_time_bank jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(submission_id,user_id));
ALTER TABLE smarter_private.retired_cash_hand_qualification OWNER TO postgres;
ALTER TABLE smarter_private.retired_cash_hand_custody OWNER TO postgres;
REVOKE ALL ON smarter_private.retired_cash_hand_qualification,smarter_private.retired_cash_hand_custody
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.retired_cash_qualification_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'RETIRED_CASH_QUALIFICATION_IMMUTABLE' USING ERRCODE='55000'; END $body$;
ALTER FUNCTION smarter_private.retired_cash_qualification_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.retired_cash_qualification_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER retired_cash_qualification_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.retired_cash_hand_qualification FOR EACH ROW EXECUTE FUNCTION smarter_private.retired_cash_qualification_immutable();
CREATE TRIGGER retired_cash_qualification_no_truncate BEFORE TRUNCATE
 ON smarter_private.retired_cash_hand_qualification FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.retired_cash_qualification_immutable();
CREATE FUNCTION smarter_private.retired_cash_custody_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'RETIRED_CASH_CUSTODY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF NEW.transaction_id IS DISTINCT FROM txid_current() THEN RAISE EXCEPTION 'RETIRED_CASH_CUSTODY_TRANSACTION_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state IS DISTINCT FROM 'held' OR NEW.settlement_id IS NOT NULL OR NEW.accepted_time_bank IS NOT NULL THEN
   RAISE EXCEPTION 'RETIRED_CASH_CUSTODY_INITIAL_STATE_REQUIRED' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','settlement_id','accepted_time_bank']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','settlement_id','accepted_time_bank'])
   OR (OLD.state='consumed' AND (NEW.state IS DISTINCT FROM 'consumed' OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id))
   OR (OLD.state='held' AND (NEW.state IS DISTINCT FROM 'consumed' OR NEW.settlement_id IS NULL OR NEW.accepted_time_bank IS NOT NULL))
   OR (NEW.accepted_time_bank IS NOT NULL AND NEW.accepted_time_bank IS DISTINCT FROM NEW.original_time_bank) THEN
    RAISE EXCEPTION 'RETIRED_CASH_CUSTODY_TRANSITION_REFUSED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $body$;
ALTER FUNCTION smarter_private.retired_cash_custody_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.retired_cash_custody_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER retired_cash_custody_guard BEFORE INSERT OR UPDATE OR DELETE
 ON smarter_private.retired_cash_hand_custody FOR EACH ROW EXECUTE FUNCTION smarter_private.retired_cash_custody_guard();
CREATE TRIGGER retired_cash_custody_no_truncate BEFORE TRUNCATE
 ON smarter_private.retired_cash_hand_custody FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.retired_cash_custody_guard();
INSERT INTO smarter_private.retired_cash_hand_qualification VALUES ('16cd2682-cca3-4ea4-a8d9-04931a5153ba','2c29d1a4846eca399bd69cde28535c7dee813b53170d4888e1423394ad748b7f','8fee68cc-f2db-418f-9f35-ba63b876ab20',26114000,$qualified${"submission_id":"16cd2682-cca3-4ea4-a8d9-04931a5153ba","request_hash":"2c29d1a4846eca399bd69cde28535c7dee813b53170d4888e1423394ad748b7f","table_id":"8fee68cc-f2db-418f-9f35-ba63b876ab20","hand_number":26114000,"participants":[{"stack":{"stack":82.1,"seat_id":"91c7eed6-e1cd-4790-bf26-79d8d8041249","user_id":"00000000-0000-0000-0000-000000000051","occupancy_id":"db96bbc7-e883-4ec2-bb22-bd7718581daa","stack_before":83.1,"seat_joined_at":"2026-10-06T14:00:53.888629+00:00","funding_manifest_id":"9c4dab5f-b917-4cc2-9789-914f838277e4","funding_stack_before":83.1},"manifest_participant":{"seat_id":"91c7eed6-e1cd-4790-bf26-79d8d8041249","user_id":"00000000-0000-0000-0000-000000000051","is_horse":true,"occupancy_id":"db96bbc7-e883-4ec2-bb22-bd7718581daa","stack_before":83.1,"seat_joined_at":"2026-10-06T14:00:53.888629+00:00","funding_lineage":{"moves":[],"issues":[],"version":1,"observed_at":"2026-10-06T15:32:55.727258+00:00","funding_receipts":[{"id":"72ec2b1b-a3e4-4898-95fd-0e5b4f928f5e","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000051"},{"id":"d4861033-ca50-4c4c-8f3f-2372fc86a168","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":"75554da9-0587-4a35-ad5a-008803fe5974","account_entity_id":"00000000-0000-0000-0000-000000000051"}]},"funding_receipts":[{"id":"72ec2b1b-a3e4-4898-95fd-0e5b4f928f5e","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000051"},{"id":"d4861033-ca50-4c4c-8f3f-2372fc86a168","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":"75554da9-0587-4a35-ad5a-008803fe5974","account_entity_id":"00000000-0000-0000-0000-000000000051"}]},"manifest_request_md5":null,"manifest_funding_complete":true,"inventory_event_id":42227067,"inventory_before":{"id":"91c7eed6-e1cd-4790-bf26-79d8d8041249","stack":83.1,"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","left_at":"2026-10-06T15:33:04.813747+00:00","user_id":"00000000-0000-0000-0000-000000000051","table_id":"8fee68cc-f2db-418f-9f35-ba63b876ab20","joined_at":"2026-10-06T14:00:53.888629+00:00","occupancy_id":"db96bbc7-e883-4ec2-bb22-bd7718581daa"},"funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","time_bank":{"seat_id":"91c7eed6-e1cd-4790-bf26-79d8d8041249","user_id":"00000000-0000-0000-0000-000000000051","occupancy_id":"db96bbc7-e883-4ec2-bb22-bd7718581daa","seat_joined_at":"2026-10-06T14:00:53.888629+00:00","uses_remaining":1,"seconds_remaining":20,"funding_manifest_id":"9c4dab5f-b917-4cc2-9789-914f838277e4","funding_stack_before":83.1}}]}$qualified$::jsonb);
INSERT INTO smarter_private.retired_cash_hand_qualification VALUES ('342aed62-7c7b-42e6-9d96-dd0abbe93ae5','74b7900d76192fe391e25b329731151f6b190f410ac0f2caa5f00556f989893e','4b2c6694-241d-47ef-8513-6983045dbc94',26114084,$qualified${"submission_id":"342aed62-7c7b-42e6-9d96-dd0abbe93ae5","request_hash":"74b7900d76192fe391e25b329731151f6b190f410ac0f2caa5f00556f989893e","table_id":"4b2c6694-241d-47ef-8513-6983045dbc94","hand_number":26114084,"participants":[{"stack":{"stack":496.75,"seat_id":"cdd8e436-eaa2-48ea-8f2c-bc70df162f84","user_id":"00000000-0000-0000-0000-000000000048","occupancy_id":"4af8a9d3-31b8-4ea9-a3d6-9e88d8dc8a9b","stack_before":496.75,"seat_joined_at":"2026-10-06T13:15:50.222138+00:00","funding_manifest_id":"83162c60-f4f6-4ee0-afa9-238040eb9941","funding_stack_before":496.75},"manifest_participant":{"seat_id":"cdd8e436-eaa2-48ea-8f2c-bc70df162f84","user_id":"00000000-0000-0000-0000-000000000048","is_horse":true,"occupancy_id":"4af8a9d3-31b8-4ea9-a3d6-9e88d8dc8a9b","stack_before":496.75,"seat_joined_at":"2026-10-06T13:15:50.222138+00:00","funding_lineage":{"moves":[],"issues":[],"version":1,"observed_at":"2026-10-06T15:32:59.889228+00:00","funding_receipts":[{"id":"b2093ddd-7fad-499b-a26b-93621198cfb8","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000048"},{"id":"c5720fc6-9843-4b6b-b1af-3605f3a6f7e6","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":"fca8101f-e10a-41b4-be11-cfea2a3d833c","account_entity_id":"00000000-0000-0000-0000-000000000048"},{"id":"4f021214-5777-40aa-a474-269bdb543cf3","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000048"}]},"funding_receipts":[{"id":"b2093ddd-7fad-499b-a26b-93621198cfb8","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000048"},{"id":"c5720fc6-9843-4b6b-b1af-3605f3a6f7e6","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":"fca8101f-e10a-41b4-be11-cfea2a3d833c","account_entity_id":"00000000-0000-0000-0000-000000000048"},{"id":"4f021214-5777-40aa-a474-269bdb543cf3","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000048"}]},"manifest_request_md5":null,"manifest_funding_complete":true,"inventory_event_id":42226972,"inventory_before":{"id":"cdd8e436-eaa2-48ea-8f2c-bc70df162f84","stack":496.75,"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","left_at":"2026-10-06T15:33:04.813325+00:00","user_id":"00000000-0000-0000-0000-000000000048","table_id":"4b2c6694-241d-47ef-8513-6983045dbc94","joined_at":"2026-10-06T13:15:50.222138+00:00","occupancy_id":"4af8a9d3-31b8-4ea9-a3d6-9e88d8dc8a9b"},"funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","time_bank":{"seat_id":"cdd8e436-eaa2-48ea-8f2c-bc70df162f84","user_id":"00000000-0000-0000-0000-000000000048","occupancy_id":"4af8a9d3-31b8-4ea9-a3d6-9e88d8dc8a9b","seat_joined_at":"2026-10-06T13:15:50.222138+00:00","uses_remaining":0,"seconds_remaining":0,"funding_manifest_id":"83162c60-f4f6-4ee0-afa9-238040eb9941","funding_stack_before":496.75}}]}$qualified$::jsonb);
INSERT INTO smarter_private.retired_cash_hand_qualification VALUES ('5b38a47f-ed3a-46ed-a017-ffe6b5d0d06e','579b16992838a009fc5ca9a5312df1996467f8a736f155fe18027102b66e6bad','0183f083-e9cc-4951-9527-c2a114266f7c',26112716,$qualified${"submission_id":"5b38a47f-ed3a-46ed-a017-ffe6b5d0d06e","request_hash":"579b16992838a009fc5ca9a5312df1996467f8a736f155fe18027102b66e6bad","table_id":"0183f083-e9cc-4951-9527-c2a114266f7c","hand_number":26112716,"participants":[{"stack":{"stack":638.25,"seat_id":"82b3f620-424a-495d-bf60-e46de362fa8b","user_id":"00000000-0000-0000-0000-000000000036","occupancy_id":"3e83d443-0ad3-4897-89d2-374f7753ae2a","stack_before":644.25,"seat_joined_at":"2026-10-06T14:06:19.689001+00:00","funding_manifest_id":"6728a8b3-7580-45e4-8ea0-991c36965cc4","funding_stack_before":644.25},"manifest_participant":{"seat_id":"82b3f620-424a-495d-bf60-e46de362fa8b","user_id":"00000000-0000-0000-0000-000000000036","is_horse":true,"occupancy_id":"3e83d443-0ad3-4897-89d2-374f7753ae2a","stack_before":644.25,"seat_joined_at":"2026-10-06T14:06:19.689001+00:00","funding_lineage":{"moves":[{"amount":770.4,"club_id":"a0000000-0000-0000-0000-000000000001","game_id":"c79d8ec2-2281-411d-b4e1-42b5610849e2","move_id":"e35b2bd0-b8d0-4513-83fb-610ca56afebc","receipt":{"ok":true,"stack":770.4,"reason":"must_move","move_id":"e35b2bd0-b8d0-4513-83fb-610ca56afebc","player_id":"00000000-0000-0000-0000-000000000036","to_table_id":"0183f083-e9cc-4951-9527-c2a114266f7c","from_table_id":"f3c0198b-0ed0-413e-97e6-ca57fd80fdb0","to_seat_number":2,"idempotency_key":"seatmove:e35b2bd0-b8d0-4513-83fb-610ca56afebc","source_seat_number":6,"source_occupancy_id":"ad9a4624-ee83-48bd-af48-cb3a649f49c8","destination_occupancy_id":"3e83d443-0ad3-4897-89d2-374f7753ae2a"},"player_id":"00000000-0000-0000-0000-000000000036","created_at":"2026-10-06T14:15:47.041897+00:00","to_table_id":"0183f083-e9cc-4951-9527-c2a114266f7c","from_table_id":"f3c0198b-0ed0-413e-97e6-ca57fd80fdb0","to_seat_number":2,"transaction_id":"958945276","from_seat_number":6,"source_occupancy_id":"ad9a4624-ee83-48bd-af48-cb3a649f49c8","destination_occupancy_id":"3e83d443-0ad3-4897-89d2-374f7753ae2a"}],"issues":[],"version":1,"observed_at":"2026-10-06T15:31:34.140401+00:00","funding_receipts":[{"id":"35f8f724-fc7b-473a-b993-4abfb6a30b53","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000036"}]},"funding_receipts":[{"id":"35f8f724-fc7b-473a-b993-4abfb6a30b53","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000036"}]},"manifest_request_md5":null,"manifest_funding_complete":true,"inventory_event_id":42226309,"inventory_before":{"id":"82b3f620-424a-495d-bf60-e46de362fa8b","stack":644.25,"club_id":"a0000000-0000-0000-0000-000000000001","left_at":"2026-10-06T15:33:04.81182+00:00","user_id":"00000000-0000-0000-0000-000000000036","table_id":"0183f083-e9cc-4951-9527-c2a114266f7c","joined_at":"2026-10-06T14:06:19.689001+00:00","occupancy_id":"3e83d443-0ad3-4897-89d2-374f7753ae2a"},"funding_club_id":"a0000000-0000-0000-0000-000000000001","time_bank":{"seat_id":"82b3f620-424a-495d-bf60-e46de362fa8b","user_id":"00000000-0000-0000-0000-000000000036","occupancy_id":"3e83d443-0ad3-4897-89d2-374f7753ae2a","seat_joined_at":"2026-10-06T14:06:19.689001+00:00","uses_remaining":2,"seconds_remaining":40,"funding_manifest_id":"6728a8b3-7580-45e4-8ea0-991c36965cc4","funding_stack_before":644.25}}]}$qualified$::jsonb);
INSERT INTO smarter_private.retired_cash_hand_qualification VALUES ('be28131f-b4f6-4945-8155-325cba88fc80','e55a2d49438ce8019b0dc819e62f31c379a14ad87439ffba4a2a01de5750afdd','62e8657c-5e4c-44d1-8610-fc80890bc87a',26114005,$qualified${"submission_id":"be28131f-b4f6-4945-8155-325cba88fc80","request_hash":"e55a2d49438ce8019b0dc819e62f31c379a14ad87439ffba4a2a01de5750afdd","table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","hand_number":26114005,"participants":[{"stack":{"stack":185.3,"seat_id":"0d902c8f-e9e3-4433-86d2-94d4607e6ce9","user_id":"00000000-0000-0000-0000-000000000013","occupancy_id":"13b77968-ff66-4e84-bb45-af9deb2393ba","stack_before":185.3,"seat_joined_at":"2026-10-06T04:08:54.280707+00:00","funding_manifest_id":"6e28d5e3-1d7c-420e-8220-594a0f93d774","funding_stack_before":185.3},"manifest_participant":{"seat_id":"0d902c8f-e9e3-4433-86d2-94d4607e6ce9","user_id":"00000000-0000-0000-0000-000000000013","is_horse":true,"occupancy_id":"13b77968-ff66-4e84-bb45-af9deb2393ba","stack_before":185.3,"seat_joined_at":"2026-10-06T04:08:54.280707+00:00","funding_lineage":{"moves":[{"amount":188.1,"club_id":"a0000000-0000-0000-0000-000000000001","game_id":"bc1a347f-2b85-49df-b3b3-40a498a6e51b","move_id":"a7425b95-f8b7-48b1-97f1-5d09a2302af3","receipt":{"ok":true,"stack":188.1,"reason":"must_move","move_id":"a7425b95-f8b7-48b1-97f1-5d09a2302af3","player_id":"00000000-0000-0000-0000-000000000013","to_table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","from_table_id":"9b3d043a-e74c-432a-a179-b687ba433982","to_seat_number":2,"idempotency_key":"seatmove:a7425b95-f8b7-48b1-97f1-5d09a2302af3","source_seat_number":3,"source_occupancy_id":"864d8eea-2b11-4929-a981-565636368743","destination_occupancy_id":"13b77968-ff66-4e84-bb45-af9deb2393ba"},"player_id":"00000000-0000-0000-0000-000000000013","created_at":"2026-10-06T04:19:36.063245+00:00","to_table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","from_table_id":"9b3d043a-e74c-432a-a179-b687ba433982","to_seat_number":2,"transaction_id":"945126977","from_seat_number":3,"source_occupancy_id":"864d8eea-2b11-4929-a981-565636368743","destination_occupancy_id":"13b77968-ff66-4e84-bb45-af9deb2393ba"}],"issues":[],"version":1,"observed_at":"2026-10-06T15:32:56.043812+00:00","funding_receipts":[{"id":"31b1ba59-a170-4b8d-afd7-462fbb630689","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":"c9cdea35-606d-4e25-a1b4-9b167b7ebd55","account_entity_id":"00000000-0000-0000-0000-000000000013"},{"id":"c01f647c-64d8-496a-815b-fbc711cac829","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000013"},{"id":"e0d694d7-983c-4e3d-94af-81ae2b2e1e9d","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000013"},{"id":"85f3cc3e-ef99-4bac-b299-999924ebbac4","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000013"}]},"funding_receipts":[{"id":"31b1ba59-a170-4b8d-afd7-462fbb630689","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":"c9cdea35-606d-4e25-a1b4-9b167b7ebd55","account_entity_id":"00000000-0000-0000-0000-000000000013"},{"id":"c01f647c-64d8-496a-815b-fbc711cac829","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000013"},{"id":"e0d694d7-983c-4e3d-94af-81ae2b2e1e9d","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000013"},{"id":"85f3cc3e-ef99-4bac-b299-999924ebbac4","account_type":"player_wallet","funding_club_id":"a0000000-0000-0000-0000-000000000001","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"00000000-0000-0000-0000-000000000013"}]},"manifest_request_md5":null,"manifest_funding_complete":true,"inventory_event_id":42226993,"inventory_before":{"id":"0d902c8f-e9e3-4433-86d2-94d4607e6ce9","stack":185.3,"club_id":"a0000000-0000-0000-0000-000000000001","left_at":"2026-10-06T15:33:04.809445+00:00","user_id":"00000000-0000-0000-0000-000000000013","table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","joined_at":"2026-10-06T04:08:54.280707+00:00","occupancy_id":"13b77968-ff66-4e84-bb45-af9deb2393ba"},"funding_club_id":"a0000000-0000-0000-0000-000000000001","time_bank":{"seat_id":"0d902c8f-e9e3-4433-86d2-94d4607e6ce9","user_id":"00000000-0000-0000-0000-000000000013","occupancy_id":"13b77968-ff66-4e84-bb45-af9deb2393ba","seat_joined_at":"2026-10-06T04:08:54.280707+00:00","uses_remaining":0,"seconds_remaining":0,"funding_manifest_id":"6e28d5e3-1d7c-420e-8220-594a0f93d774","funding_stack_before":185.3}},{"stack":{"stack":125.65,"seat_id":"dfd9d6fc-8379-46bb-82a1-55d72988ad50","user_id":"face0000-0000-0000-0000-000000000004","occupancy_id":"883d0f87-efea-4d72-a9cf-cad8615388cb","stack_before":125.65,"seat_joined_at":"2026-10-06T00:27:22.470499+00:00","funding_manifest_id":"6e28d5e3-1d7c-420e-8220-594a0f93d774","funding_stack_before":125.65},"manifest_participant":{"seat_id":"dfd9d6fc-8379-46bb-82a1-55d72988ad50","user_id":"face0000-0000-0000-0000-000000000004","is_horse":true,"occupancy_id":"883d0f87-efea-4d72-a9cf-cad8615388cb","stack_before":125.65,"seat_joined_at":"2026-10-06T00:27:22.470499+00:00","funding_lineage":{"moves":[{"amount":542.75,"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","game_id":"bc1a347f-2b85-49df-b3b3-40a498a6e51b","move_id":"2e9340ae-c56d-4f24-af1c-37a654106387","receipt":{"ok":true,"stack":542.75,"reason":"must_move","move_id":"2e9340ae-c56d-4f24-af1c-37a654106387","player_id":"face0000-0000-0000-0000-000000000004","to_table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","from_table_id":"f8bb224d-a714-4da6-969f-006a0ed1b0df","to_seat_number":6,"idempotency_key":"seatmove:2e9340ae-c56d-4f24-af1c-37a654106387","source_seat_number":1,"source_occupancy_id":"a1a1133a-8a17-4110-a162-758a67598e8f","destination_occupancy_id":"883d0f87-efea-4d72-a9cf-cad8615388cb"},"player_id":"face0000-0000-0000-0000-000000000004","created_at":"2026-10-06T07:52:47.099115+00:00","to_table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","from_table_id":"f8bb224d-a714-4da6-969f-006a0ed1b0df","to_seat_number":6,"transaction_id":"950350149","from_seat_number":1,"source_occupancy_id":"a1a1133a-8a17-4110-a162-758a67598e8f","destination_occupancy_id":"883d0f87-efea-4d72-a9cf-cad8615388cb"},{"amount":544.75,"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","game_id":"bc1a347f-2b85-49df-b3b3-40a498a6e51b","move_id":"b5274e85-17bf-49d8-a3a4-88c3cd41df50","receipt":{"ok":true,"stack":544.75,"reason":"seat_change","move_id":"b5274e85-17bf-49d8-a3a4-88c3cd41df50","player_id":"face0000-0000-0000-0000-000000000004","to_table_id":"f8bb224d-a714-4da6-969f-006a0ed1b0df","from_table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","to_seat_number":1,"idempotency_key":"seatmove:b5274e85-17bf-49d8-a3a4-88c3cd41df50","source_seat_number":6,"source_occupancy_id":"cce06da4-08fd-4102-81df-cc3c8ac3ac8f","destination_occupancy_id":"a1a1133a-8a17-4110-a162-758a67598e8f"},"player_id":"face0000-0000-0000-0000-000000000004","created_at":"2026-10-06T07:52:17.331328+00:00","to_table_id":"f8bb224d-a714-4da6-969f-006a0ed1b0df","from_table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","to_seat_number":1,"transaction_id":"950339967","from_seat_number":6,"source_occupancy_id":"cce06da4-08fd-4102-81df-cc3c8ac3ac8f","destination_occupancy_id":"a1a1133a-8a17-4110-a162-758a67598e8f"},{"amount":700,"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","game_id":"bc1a347f-2b85-49df-b3b3-40a498a6e51b","move_id":"d60c88b7-2fe0-430c-9f47-985e40957cc0","receipt":{"ok":true,"stack":700,"reason":"must_move","move_id":"d60c88b7-2fe0-430c-9f47-985e40957cc0","player_id":"face0000-0000-0000-0000-000000000004","to_table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","from_table_id":"9b3d043a-e74c-432a-a179-b687ba433982","to_seat_number":6,"idempotency_key":"seatmove:d60c88b7-2fe0-430c-9f47-985e40957cc0","source_seat_number":1,"source_occupancy_id":"ae51186a-cf47-487d-a60c-b3fb776f86fd","destination_occupancy_id":"cce06da4-08fd-4102-81df-cc3c8ac3ac8f"},"player_id":"face0000-0000-0000-0000-000000000004","created_at":"2026-10-06T01:00:32.557401+00:00","to_table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","from_table_id":"9b3d043a-e74c-432a-a179-b687ba433982","to_seat_number":6,"transaction_id":"939707095","from_seat_number":1,"source_occupancy_id":"ae51186a-cf47-487d-a60c-b3fb776f86fd","destination_occupancy_id":"cce06da4-08fd-4102-81df-cc3c8ac3ac8f"}],"issues":[],"version":1,"observed_at":"2026-10-06T15:32:56.054677+00:00","funding_receipts":[{"id":"58a60976-9a72-4bca-a997-8ec7bfabc6ed","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":"a56de989-3657-46ef-adfa-e80968596b26","account_entity_id":"face0000-0000-0000-0000-000000000004"},{"id":"31f13977-e31c-4a14-bb1b-c722b866cf67","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"face0000-0000-0000-0000-000000000004"},{"id":"030c661b-73f2-4ab2-ae11-2b84dea06310","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"face0000-0000-0000-0000-000000000004"},{"id":"b37f8a0c-46ae-49d9-892c-d50032043ff3","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"face0000-0000-0000-0000-000000000004"}]},"funding_receipts":[{"id":"58a60976-9a72-4bca-a997-8ec7bfabc6ed","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":"a56de989-3657-46ef-adfa-e80968596b26","account_entity_id":"face0000-0000-0000-0000-000000000004"},{"id":"31f13977-e31c-4a14-bb1b-c722b866cf67","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"face0000-0000-0000-0000-000000000004"},{"id":"030c661b-73f2-4ab2-ae11-2b84dea06310","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"face0000-0000-0000-0000-000000000004"},{"id":"b37f8a0c-46ae-49d9-892c-d50032043ff3","account_type":"player_wallet","funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","funding_union_id":"fade0000-0000-0000-0000-000000000001","pending_addon_id":null,"account_entity_id":"face0000-0000-0000-0000-000000000004"}]},"manifest_request_md5":null,"manifest_funding_complete":true,"inventory_event_id":42227009,"inventory_before":{"id":"dfd9d6fc-8379-46bb-82a1-55d72988ad50","stack":125.65,"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","left_at":"2026-10-06T15:33:04.814274+00:00","user_id":"face0000-0000-0000-0000-000000000004","table_id":"62e8657c-5e4c-44d1-8610-fc80890bc87a","joined_at":"2026-10-06T00:27:22.470499+00:00","occupancy_id":"883d0f87-efea-4d72-a9cf-cad8615388cb"},"funding_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","time_bank":{"seat_id":"dfd9d6fc-8379-46bb-82a1-55d72988ad50","user_id":"face0000-0000-0000-0000-000000000004","occupancy_id":"883d0f87-efea-4d72-a9cf-cad8615388cb","seat_joined_at":"2026-10-06T00:27:22.470499+00:00","uses_remaining":0,"seconds_remaining":0,"funding_manifest_id":"6e28d5e3-1d7c-420e-8220-594a0f93d774","funding_stack_before":125.65}}]}$qualified$::jsonb);
CREATE FUNCTION smarter_private.adopt_retired_cash_original_hand(p_submission uuid,p_instance text,p_generation uuid)
 RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
DECLARE c smarter_private.retired_cash_hand_qualification;s smarter_private.hand_submissions;
 lease public.engine_table_leases;item jsonb;stack_item jsonb;fr jsonb;move jsonb;m public.cash_hand_participant_manifests;
 funding public.cash_participant_funding_receipts;seat public.table_seats;inventory public.union_pnl_inventory_events;
 restore_key_text text;result jsonb;uid uuid;club uuid;before_amount numeric;ledger uuid;
BEGIN
 SELECT * INTO c FROM smarter_private.retired_cash_hand_qualification WHERE submission_id=p_submission;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission FOR UPDATE;
 SELECT * INTO lease FROM public.engine_table_leases WHERE table_id=c.table_id FOR KEY SHARE;
 IF s.submission_id IS NULL OR s.request_hash IS DISTINCT FROM c.request_hash
 OR (s.table_id,s.hand_number) IS DISTINCT FROM(c.table_id,c.hand_number)
 OR s.lease_generation=p_generation OR lease.instance_id IS DISTINCT FROM p_instance
 OR lease.lease_generation IS DISTINCT FROM p_generation OR lease.protocol_version IS DISTINCT FROM 2
 OR lease.heartbeat_at IS NULL OR lease.heartbeat_at<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds())
 OR public.fn_platform_frozen() OR auth.role() IS DISTINCT FROM 'service_role'
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=c.table_id AND t.tournament_id IS NULL
   AND NOT coalesce(t.is_deleted,false) AND lower(t.status) IN('waiting','running') AND t.lifecycle='live')
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs h WHERE h.submission_id=p_submission)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals h WHERE h.table_id=c.table_id AND h.hand_number=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=c.table_id AND a.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.table_id=c.table_id AND h.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody r WHERE r.submission_id=p_submission) THEN
  RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_AUTHORITY_OR_CONSUMPTION_CHANGED' USING ERRCODE='55000'; END IF;
 -- All unaffected players still own the immutable before-stack. Lock in the
 -- native order before the first restitution; a replacement row is read only.
 FOR stack_item IN SELECT value FROM jsonb_array_elements(s.request->'p_stacks') ORDER BY value->>'seat_id' LOOP
  SELECT * INTO seat FROM public.table_seats WHERE id=(stack_item->>'seat_id')::uuid FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.expected->'participants')p WHERE p->'stack'=stack_item)
   AND (seat.id IS NULL OR seat.table_id IS DISTINCT FROM c.table_id OR seat.user_id IS DISTINCT FROM(stack_item->>'user_id')::uuid
    OR seat.joined_at IS DISTINCT FROM(stack_item->>'seat_joined_at')::timestamptz OR seat.left_at IS NOT NULL
    OR seat.stack IS DISTINCT FROM(stack_item->>'stack_before')::numeric) THEN
   RAISE EXCEPTION 'RETIRED_CASH_UNQUALIFIED_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'participants') ORDER BY value#>>'{stack,user_id}' LOOP
  uid:=(item#>>'{stack,user_id}')::uuid;club:=(item->>'funding_club_id')::uuid;
  before_amount:=(item#>>'{stack,stack_before}')::numeric;
  restore_key_text:='retired_cash_base:'||p_submission::text||':'||(item#>>'{stack,occupancy_id}');
  SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=(item#>>'{stack,funding_manifest_id}')::uuid;
  SELECT * INTO inventory FROM public.union_pnl_inventory_events WHERE event_id=(item->>'inventory_event_id')::bigint;
  SELECT * INTO seat FROM public.table_seats WHERE id=(item#>>'{stack,seat_id}')::uuid;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks')x WHERE x=item->'stack')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request#>'{p_post_commit_obligations,time_banks}')x WHERE x=item->'time_bank')
  OR m.id IS NULL OR (m.table_id,m.hand_number) IS DISTINCT FROM(c.table_id,c.hand_number)
  OR NOT m.funding_provenance_complete OR m.issues IS DISTINCT FROM '[]'::jsonb
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants)x WHERE x=item->'manifest_participant')
  OR inventory.event_id IS NULL OR inventory.source_name IS DISTINCT FROM 'table_seats'
  OR inventory.row_id::text IS DISTINCT FROM item#>>'{stack,seat_id}'
  OR inventory.operation NOT IN('DELETE','UPDATE')
  OR NOT (inventory.before_row @> (item->'inventory_before'))
  OR (inventory.before_row->>'left_at')::timestamptz NOT BETWEEN '2026-10-06 15:33:00Z' AND '2026-10-06 15:33:10Z'
  OR (inventory.before_row->>'stack')::numeric IS DISTINCT FROM before_amount
  OR (seat.id IS NOT NULL AND seat.occupancy_id=(item#>>'{stack,occupancy_id}')::uuid)
  OR NOT EXISTS(SELECT 1 FROM smarter_private.patterned_identity_retirements r WHERE r.old_id=uid AND r.retired_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.seat_cashout_receipts r WHERE r.occupancy_id=(item#>>'{stack,occupancy_id}')::uuid)
  OR EXISTS(SELECT 1 FROM public.table_cashout_history r WHERE r.user_id=uid AND r.table_id=c.table_id
    AND r.cashed_out_at>=(item#>>'{stack,seat_joined_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.to_type='player_wallet' AND l.to_entity_id=uid
    AND (l.from_entity_id=c.table_id OR l.table_id=c.table_id) AND l.created_at>=(item#>>'{stack,seat_joined_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.user_id=uid AND w.table_id=c.table_id
    AND w.type='credit' AND w.created_at>=(item#>>'{stack,seat_joined_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=restore_key_text)
  OR EXISTS(SELECT 1 FROM public.ca_mint_ledger w WHERE w.op_id=restore_key_text)
  OR NOT EXISTS(SELECT 1 FROM public.club_members w WHERE w.user_id=uid AND w.club_id=club
    AND w.is_active AND w.status='approved' AND w.departed_at IS NULL) THEN
   RAISE EXCEPTION 'RETIRED_CASH_IMMUTABLE_CUSTODY_OR_RETURN_CHANGED' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM public.club_members WHERE user_id=uid AND club_id=club FOR UPDATE;
  IF jsonb_array_length(item#>'{manifest_participant,funding_receipts}')=0 THEN
   RAISE EXCEPTION 'RETIRED_CASH_FUNDING_EMPTY' USING ERRCODE='55000'; END IF;
  FOR fr IN SELECT value FROM jsonb_array_elements(item#>'{manifest_participant,funding_receipts}') LOOP
   SELECT * INTO funding FROM public.cash_participant_funding_receipts WHERE id=(fr->>'id')::uuid;
   IF funding.id IS NULL OR funding.user_id IS DISTINCT FROM uid OR funding.account_type IS DISTINCT FROM 'player_wallet'
   OR funding.account_entity_id IS DISTINCT FROM uid OR funding.funding_club_id IS DISTINCT FROM club
   OR funding.amount<=0 OR funding.asset IS DISTINCT FROM 'chips'
   OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=funding.source_ledger_id
    AND l.from_type='player_wallet' AND l.from_entity_id=uid AND l.club_id=club AND l.amount=funding.amount)
   OR NOT EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.id=funding.wallet_transaction_id
    AND w.user_id=uid AND w.amount=funding.amount AND w.type='debit') THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_FUNDING_CHANGED' USING ERRCODE='55000'; END IF;
  END LOOP;
  FOR move IN SELECT value FROM jsonb_array_elements(item#>'{manifest_participant,funding_lineage,moves}') LOOP
   IF NOT EXISTS(SELECT 1 FROM public.cash_seat_move_receipts r WHERE r.move_id=(move->>'move_id')::uuid
    AND to_jsonb(r) @> move AND r.player_id=uid AND r.club_id=club) THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_MOVE_LINEAGE_CHANGED' USING ERRCODE='55000'; END IF;
  END LOOP;
 END LOOP;
 -- No arbitrary amount, member club, or wallet can enter this path.
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'participants') ORDER BY value#>>'{stack,user_id}' LOOP
  uid:=(item#>>'{stack,user_id}')::uuid;club:=(item->>'funding_club_id')::uuid;
  before_amount:=(item#>>'{stack,stack_before}')::numeric;
  restore_key_text:='retired_cash_base:'||p_submission::text||':'||(item#>>'{stack,occupancy_id}');
  result:=public.fn_ca_restore_erased_seat_credit(restore_key_text,uid,club,before_amount,c.table_id,
   'Current restitution of immutable cash custody erased during patterned-account retirement; original hand '||p_submission::text);
  ledger:=(result->>'chip_ledger_id')::uuid;
  IF result->>'restored' IS DISTINCT FROM 'true' OR result->>'key' IS DISTINCT FROM restore_key_text
   OR (result->>'user_id')::uuid IS DISTINCT FROM uid OR (result->>'club_id')::uuid IS DISTINCT FROM club
   OR (result->>'amount')::numeric IS DISTINCT FROM before_amount
   OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=ledger AND l.idempotency_key=restore_key_text
    AND l.category='refund' AND l.from_type='issuance_reserve' AND l.to_type='player_wallet'
    AND l.to_entity_id=uid AND l.club_id=club AND l.amount=before_amount)
   OR NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger l WHERE l.op_id=restore_key_text AND l.action='mint'
    AND l.asset='chips' AND l.holder_type='player' AND l.holder_id=uid AND l.amount=before_amount AND l.chip_ledger_id=ledger) THEN
   RAISE EXCEPTION 'RETIRED_CASH_RESTITUTION_INCOHERENT' USING ERRCODE='55000'; END IF;
  INSERT INTO smarter_private.retired_cash_hand_custody
   (submission_id,user_id,table_id,hand_number,seat_id,occupancy_id,seat_joined_at,stack_before,stack_after,
    funding_club_id,original_left_at,original_inventory_event,request_hash,transaction_id,restore_key,issuance_ledger,original_time_bank,state)
  VALUES(p_submission,uid,c.table_id,c.hand_number,(item#>>'{stack,seat_id}')::uuid,(item#>>'{stack,occupancy_id}')::uuid,
   (item#>>'{stack,seat_joined_at}')::timestamptz,before_amount,(item#>>'{stack,stack}')::numeric,club,
   (item#>>'{inventory_before,left_at}')::timestamptz,(item->>'inventory_event_id')::bigint,c.request_hash,txid_current(),restore_key_text,ledger,item->'time_bank','held');
 END LOOP;
 -- The original native settlement supplies its own ledger declaration.
 PERFORM set_config('app.ledger_category','',true);
 PERFORM set_config('app.ledger_counterparty','',true);
 PERFORM set_config('app.ledger_counterparty_entity','',true);
 PERFORM set_config('app.ledger_counterparty_label','',true);
 PERFORM set_config('app.ledger_settlement','',true);
 PERFORM set_config('app.ledger_idempotency_key','',true);
 RETURN true;
END $body$;
ALTER FUNCTION smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.retired_cash_original_stack(p_table uuid,p_hand bigint,p_user uuid,p_seat uuid,p_join timestamptz,p_before numeric,p_after numeric)
 RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $body$
 SELECT jsonb_build_object('funding_club_id',r.funding_club_id,'left_at',r.original_left_at)
 FROM smarter_private.retired_cash_hand_custody r JOIN smarter_private.hand_submissions s USING(submission_id)
 WHERE r.table_id=p_table AND r.hand_number=p_hand AND r.user_id=p_user AND r.seat_id=p_seat
 AND r.seat_joined_at=p_join AND r.stack_before=p_before AND r.stack_after=p_after
 AND r.state='held' AND r.transaction_id=txid_current() AND r.request_hash=s.request_hash
 -- The native retained-request door consumes its dispatch envelope before
 -- reaching this core. The immutable financial handoff is the durable owner.
 AND EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs d WHERE d.transaction_id=txid_current()
  AND d.submission_id=r.submission_id AND d.request_hash=r.request_hash)
$body$;
ALTER FUNCTION smarter_private.retired_cash_original_stack(uuid,bigint,uuid,uuid,timestamptz,numeric,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.retired_cash_original_stack(uuid,bigint,uuid,uuid,timestamptz,numeric,numeric)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.retired_cash_original_time_bank(p_table uuid,p_hand bigint,p_item jsonb)
 RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
DECLARE n integer;
BEGIN
 UPDATE smarter_private.retired_cash_hand_custody r SET accepted_time_bank=p_item
 WHERE r.table_id=p_table AND r.hand_number=p_hand AND r.state='consumed' AND r.transaction_id=txid_current()
 AND r.original_time_bank=p_item AND r.settlement_id IS NOT NULL;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n=1;
END $body$;
ALTER FUNCTION smarter_private.retired_cash_original_time_bank(uuid,bigint,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.retired_cash_original_time_bank(uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE d text;old text;replacement text;
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure))
  IS DISTINCT FROM '3571d2b9553a9b8832cdd8e72d2ab871' THEN RAISE EXCEPTION 'RETIRED_CASH_STACK_PREIMAGE_DRIFT'; END IF;
 d:=pg_get_functiondef('public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure);
 old:=$a$  v_exact_seat_found boolean;$a$;
 replacement:=old||E'\n  v_retired_cash_original jsonb;';
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_STACK_DECLARE_DRIFT'; END IF;
 d:=replace(d,old,replacement);
 old:=$a$      v_exact_seat_found := FOUND;$a$;
 replacement:=old||$a$
      IF v_exact_seat_generation AND (NOT v_exact_seat_found OR v_exact_seat_left_at IS NOT NULL) THEN
        v_retired_cash_original:=smarter_private.retired_cash_original_stack(p_table_id,p_hand_number,v_uid,
          v_exact_seat_id,v_exact_seat_joined_at,(e->>'stack_before')::numeric,v_new);
        IF v_retired_cash_original IS NOT NULL THEN
          -- A transaction-owned original obligation, not a replacement chair.
          v_exact_seat_found:=true;
          v_exact_seat_left_at:=(v_retired_cash_original->>'left_at')::timestamptz;
          v_exact_seat_club:=(v_retired_cash_original->>'funding_club_id')::uuid;
        END IF;
      END IF;$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_STACK_CUSTODY_DRIFT'; END IF;
 d:=replace(d,old,replacement);
 old:=$a$    UPDATE public.ca_settlements SET state='final' WHERE id = v_ca_id AND state='post_commit_verified';
    RETURN v_result;$a$;
 replacement:=$a$    UPDATE public.ca_settlements SET state='final' WHERE id = v_ca_id AND state='post_commit_verified';
    UPDATE smarter_private.retired_cash_hand_custody SET state='consumed',settlement_id=v_ca_id
     WHERE table_id=p_table_id AND hand_number=p_hand_number AND state='held' AND transaction_id=txid_current();
    RETURN v_result;$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_STACK_CONSUME_DRIFT'; END IF;
 EXECUTE replace(d,old,replacement);

 IF md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure))
  IS DISTINCT FROM 'e9d96bfefffef41bc22b6b6f2d5da452' THEN RAISE EXCEPTION 'RETIRED_CASH_ATOMIC_PREIMAGE_DRIFT'; END IF;
 d:=pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure);
 old:=$a$      /* ONE SEAT WRITE PER HAND (2026-09-10). The stack core carried these$a$;
 replacement:=$a$      IF smarter_private.retired_cash_original_time_bank(p_table_id,p_hand_number,v_item) THEN
        v_updated:=v_updated+1;
        CONTINUE;
      END IF;
      /* ONE SEAT WRITE PER HAND (2026-09-10). The stack core carried these$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_ATOMIC_BANK_DRIFT'; END IF;
 EXECUTE replace(d,old,replacement);

 -- The preceding tournament migration owns its serial resume postimage.
 IF md5(pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure))
  IS DISTINCT FROM '0f9432bbd2ac735c53731e6eec75449e' THEN RAISE EXCEPTION 'RETIRED_CASH_SERIAL_RESUME_PREIMAGE_DRIFT'; END IF;
 d:=pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure);
 old:=$a$ retirement_restored boolean:=false;$a$;
 replacement:=old||E'\n retired_cash_restored boolean:=false;';
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_RESUME_DECLARE_DRIFT'; END IF;
 d:=replace(d,old,replacement);
 old:=$a$  retirement_restored:=smarter_private.restore_retired_original_tournament_hand(s.submission_id,p_instance_id,p_lease_generation);$a$;
 replacement:=old||E'\n  retired_cash_restored:=smarter_private.adopt_retired_cash_original_hand(s.submission_id,p_instance_id,p_lease_generation);';
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_RESUME_ADOPT_DRIFT'; END IF;
 d:=replace(d,old,replacement);
 old:=$a$   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id$a$;
 replacement:=$a$   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM smarter_private.retired_cash_hand_custody r
      WHERE r.submission_id=s.submission_id AND r.request_hash=s.request_hash AND r.state='held'
       AND r.transaction_id=txid_current() AND r.user_id=(x->>'user_id')::uuid
       AND r.seat_id=(x->>'seat_id')::uuid AND r.occupancy_id=(x->>'occupancy_id')::uuid
       AND r.seat_joined_at=(x->>'seat_joined_at')::timestamptz
       AND r.stack_before=(x->>'stack_before')::numeric AND r.stack_after=(x->>'stack')::numeric)
    AND NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_RESUME_GUARD_DRIFT'; END IF;
 d:=replace(d,old,replacement);
 old:=$a$  IF retirement_restored AND (r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true') THEN$a$;
 replacement:=$a$  IF (retirement_restored OR retired_cash_restored) AND (r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true') THEN$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_RESUME_ROLLBACK_DRIFT'; END IF;
 d:=replace(d,old,replacement);
 old:=$a$   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;$a$;
 replacement:=$a$   IF retired_cash_restored THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_NOT_COMPLETED' USING ERRCODE='P0404';
   END IF;
   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_RESUME_POSTCOMMIT_RETURN_DRIFT'; END IF;
 d:=replace(d,old,replacement);
 old:=$a$  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);$a$;
 replacement:=$a$  IF retired_cash_restored THEN
   RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: % %',code,message USING ERRCODE='P0404';
  END IF;
  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_RESUME_POSTCOMMIT_EXCEPTION_DRIFT'; END IF;
 d:=replace(d,old,replacement);
 old:=$a$ RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,$a$;
 replacement:=$a$ IF retired_cash_restored AND EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody c
  WHERE c.submission_id=s.submission_id AND (c.state IS DISTINCT FROM 'consumed'
   OR c.accepted_time_bank IS DISTINCT FROM c.original_time_bank OR c.settlement_id IS NULL)) THEN
  RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_CUSTODY_NOT_CONSUMED' USING ERRCODE='P0404';
 END IF;
 RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,$a$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'RETIRED_CASH_RESUME_FINAL_CUSTODY_DRIFT'; END IF;
 EXECUTE replace(d,old,replacement);
END $patch$;
DO $postimage$
BEGIN
 IF ((SELECT md5(pg_get_functiondef(oid))='650b8ff04411a9974ae96ef245645705' AND md5(prosrc)='48767317bda361704da6b09b43def7a4' AND proowner='postgres'::regrole AND prosecdef=true AND proconfig=ARRAY['search_path=public, extensions, pg_temp'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure) IS TRUE
 AND (SELECT md5(pg_get_functiondef(oid))='7b7b090aa1d6eab13d677fcc5e821e77' AND md5(prosrc)='eed430c0f83de7c9fc679c86f0df3372' AND proowner='postgres'::regrole AND prosecdef=true AND proconfig=ARRAY['search_path=public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure) IS TRUE
 AND (SELECT md5(pg_get_functiondef(oid))='992019226ea1c06a3514a9087ac70be5' AND md5(prosrc)='bf733f16e7856dbbaac3e63a32edc304' AND proowner='postgres'::regrole AND prosecdef=true AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure) IS TRUE
 AND (SELECT md5(pg_get_functiondef(oid))='3fd8bc1b7a2a3e7fbf63ee64fb79dbc3' AND md5(prosrc)='8a00151604c4d6ee956eceed4730a4ed' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.retired_cash_original_stack(uuid,bigint,uuid,uuid,timestamp with time zone,numeric,numeric)'::regprocedure) IS TRUE
 AND (SELECT md5(pg_get_functiondef(oid))='6dc8ad43d7e89ab492985adabaccc51d' AND md5(prosrc)='c20856306cb4061702d63f4273aab865' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.retired_cash_original_time_bank(uuid,bigint,jsonb)'::regprocedure) IS TRUE
 AND (SELECT md5(pg_get_functiondef(oid))='90bf12c7aa691f199a0c79983ab04b02' AND md5(prosrc)='ee17e442dee35f2d2180c894dff85f30' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.retired_cash_qualification_immutable()'::regprocedure) IS TRUE
 AND (SELECT md5(pg_get_functiondef(oid))='c71ea822a1a5af7fe346ef709307a666' AND md5(prosrc)='f0d5fc5d86a022424d8857bd3452a3de' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.retired_cash_custody_guard()'::regprocedure) IS TRUE
 AND (SELECT md5(pg_get_functiondef(oid))='81fb89ad4db51ca9eb68754ebb8f384f' AND md5(prosrc)='c221ed9020feef70cf50c500f5910dd1' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)'::regprocedure) IS TRUE
 AND (SELECT count(*)=4 AND bool_and(tgenabled='O' AND pg_get_triggerdef(oid) IN('CREATE TRIGGER retired_cash_qualification_immutable BEFORE DELETE OR UPDATE ON smarter_private.retired_cash_hand_qualification FOR EACH ROW EXECUTE FUNCTION smarter_private.retired_cash_qualification_immutable()','CREATE TRIGGER retired_cash_qualification_no_truncate BEFORE TRUNCATE ON smarter_private.retired_cash_hand_qualification FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.retired_cash_qualification_immutable()','CREATE TRIGGER retired_cash_custody_guard BEFORE INSERT OR DELETE OR UPDATE ON smarter_private.retired_cash_hand_custody FOR EACH ROW EXECUTE FUNCTION smarter_private.retired_cash_custody_guard()','CREATE TRIGGER retired_cash_custody_no_truncate BEFORE TRUNCATE ON smarter_private.retired_cash_hand_custody FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.retired_cash_custody_guard()')) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN('smarter_private.retired_cash_hand_qualification'::regclass,'smarter_private.retired_cash_hand_custody'::regclass))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role'])r CROSS JOIN unnest(ARRAY['smarter_private.retired_cash_hand_qualification','smarter_private.retired_cash_hand_custody'])t WHERE has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
 AND (SELECT count(*)=4 AND sum(jsonb_array_length(expected->'participants'))=5 FROM smarter_private.retired_cash_hand_qualification)) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'RETIRED_CASH_SOURCE_SECURITY_OR_QUALIFICATION_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
END $postimage$;
COMMIT;

-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='650b8ff04411a9974ae96ef245645705' AND md5(prosrc)='48767317bda361704da6b09b43def7a4' AND proowner='postgres'::regrole AND prosecdef=true AND proconfig=ARRAY['search_path=public, extensions, pg_temp'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='7b7b090aa1d6eab13d677fcc5e821e77' AND md5(prosrc)='eed430c0f83de7c9fc679c86f0df3372' AND proowner='postgres'::regrole AND prosecdef=true AND proconfig=ARRAY['search_path=public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='992019226ea1c06a3514a9087ac70be5' AND md5(prosrc)='bf733f16e7856dbbaac3e63a32edc304' AND proowner='postgres'::regrole AND prosecdef=true AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='3fd8bc1b7a2a3e7fbf63ee64fb79dbc3' AND md5(prosrc)='8a00151604c4d6ee956eceed4730a4ed' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.retired_cash_original_stack(uuid,bigint,uuid,uuid,timestamp with time zone,numeric,numeric)'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='6dc8ad43d7e89ab492985adabaccc51d' AND md5(prosrc)='c20856306cb4061702d63f4273aab865' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.retired_cash_original_time_bank(uuid,bigint,jsonb)'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='90bf12c7aa691f199a0c79983ab04b02' AND md5(prosrc)='ee17e442dee35f2d2180c894dff85f30' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.retired_cash_qualification_immutable()'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='c71ea822a1a5af7fe346ef709307a666' AND md5(prosrc)='f0d5fc5d86a022424d8857bd3452a3de' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.retired_cash_custody_guard()'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='81fb89ad4db51ca9eb68754ebb8f384f' AND md5(prosrc)='c221ed9020feef70cf50c500f5910dd1' AND proowner='postgres'::regrole AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog, public'] AND proacl::text='{postgres=X/postgres}' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)'::regprocedure)
-- @live-proof: (SELECT count(*)=4 AND bool_and(tgenabled='O' AND pg_get_triggerdef(oid) IN('CREATE TRIGGER retired_cash_qualification_immutable BEFORE DELETE OR UPDATE ON smarter_private.retired_cash_hand_qualification FOR EACH ROW EXECUTE FUNCTION smarter_private.retired_cash_qualification_immutable()','CREATE TRIGGER retired_cash_qualification_no_truncate BEFORE TRUNCATE ON smarter_private.retired_cash_hand_qualification FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.retired_cash_qualification_immutable()','CREATE TRIGGER retired_cash_custody_guard BEFORE INSERT OR DELETE OR UPDATE ON smarter_private.retired_cash_hand_custody FOR EACH ROW EXECUTE FUNCTION smarter_private.retired_cash_custody_guard()','CREATE TRIGGER retired_cash_custody_no_truncate BEFORE TRUNCATE ON smarter_private.retired_cash_hand_custody FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.retired_cash_custody_guard()')) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN('smarter_private.retired_cash_hand_qualification'::regclass,'smarter_private.retired_cash_hand_custody'::regclass))
-- @live-proof: NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role'])r CROSS JOIN unnest(ARRAY['smarter_private.retired_cash_hand_qualification','smarter_private.retired_cash_hand_custody'])t WHERE has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
-- @live-proof: (SELECT count(*)=4 AND sum(jsonb_array_length(expected->'participants'))=5 FROM smarter_private.retired_cash_hand_qualification)
