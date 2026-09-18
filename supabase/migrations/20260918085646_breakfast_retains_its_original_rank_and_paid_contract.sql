-- The original Breakfast engine requested rank 21 and zero prize on September 8.
-- Its live-seat roster rejection rolled that attempt back. Later retries must not
-- replace that witness or the 32 already-recorded ranks. Four immutable payouts
-- agree on the original five-place contract; only the later PENDING entry-close
-- snapshot has four places. This explicit transaction restores that pending
-- contract and invokes the existing terminal payer. It creates no old hand,
-- knockout candidate, historical sequence, fee terms or chip adjustment.
-- The unexplained 22,255 chip excess remains unchanged, recorded, not legitimized.
-- The prerequisite v3 terminal keeps the original 17 fee chips in custody;
-- final player results do not certify unknown historical earning terms.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $installed$ DECLARE r jsonb; BEGIN
 FOR r IN SELECT value FROM jsonb_array_elements('[{"signature":"public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)","md5":"9af966f69a2d1d9d79ee4327c9433721","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"public.fn_settle_tournament_places(uuid,uuid)","md5":"c412c8b17186976df139f73a706175f2","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public","statement_timeout=30s"]},{"signature":"public.fn_ca_tournament_terminal_receipt(uuid,uuid)","md5":"6dc3fc304eb4b106c1d150ac71d3d9ba","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public","statement_timeout=30s"]},{"signature":"public.fn_complete_tournament_terminal(uuid,uuid,text)","md5":"c64e049911fd99c1d784cdb042ca714b","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public, pg_temp","statement_timeout=45s"]},{"signature":"public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)","md5":"1b03285a00dc01df0f177e25ebe57147","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public, pg_temp"]},{"signature":"public.fn_complete_tournament_entry_reprice(uuid)","md5":"4e20eed880471c67343fe1ec705dc47d","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public, pg_temp"]},{"signature":"public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)","md5":"de4a79604fed8edcd5b94aea968516bc","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public","statement_timeout=45s"]},{"signature":"public.fn_non_satellite_completed_requires_terminal_receipt()","md5":"f2da9a0bcf45eec68489fe51fd6f224b","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"public.fn_stamp_tournament_terminal_evidence_markers()","md5":"eeec4e4610901fe4b44b0b8f270d1ef7","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"public.fn_guard_tournament_prize_math_contract()","md5":"9db38ea56f880456fdbbc29394c4cb27","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public, pg_temp"]},{"signature":"public.fn_retire_manager_wakes_after_terminal_status()","md5":"2fa4c2d4bb63ece41ed78c3f11cd770c","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public, pg_temp"]},{"signature":"public.trg_freeze_finalized_tournament_prize_pool()","md5":"d58236d778465cfd5f4c1e25933f77f4","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public, pg_temp"]},{"signature":"public.trg_tournament_pool_finalization_window_guard()","md5":"6ba00817ea7d386e3c1d37212b9c9866","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"public.trg_lock_atomic_final_table_deal_status()","md5":"b16256830158e669defcff8751cb5be7","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"public.trg_atomic_final_table_deal_completion_guard()","md5":"38bf96ba348994fd40264584c26107d8","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"smarter_private.f06_source_guard()","md5":"de1b25f96d2c08bf20213c0e194ae261","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"public.fn_terminal_tournament_seat_is_immutable()","md5":"10a5d9082f7770127359f9eca7068ed6","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"public.fn_log_seat_stack_exit()","md5":"9ef7dad056ad5b5e745200ca83170c04","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public, pg_temp"]},{"signature":"public.fn_poker_diamond_seat_keeps_custody()","md5":"d80aed613a97e567268cb2bf6fdfd094","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public, pg_temp"]},{"signature":"public.fn_terminal_tournament_evidence_is_immutable()","md5":"5eb12239ece45d08eb32dbaa9e3028dd","owner":"postgres","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"public.trg_refuse_finalized_tournament_entry()","md5":"d86d79923949a7f5434c5d2a286fdb49","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]}]'::jsonb) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(r->>'signature')
 AND md5(pg_get_functiondef(p.oid))=r->>'md5' AND pg_get_userbyid(p.proowner)=r->>'owner'
 AND to_jsonb(p.proconfig) IS NOT DISTINCT FROM r->'config'
 AND (SELECT jsonb_agg(x::text ORDER BY x::text) FROM unnest(p.proacl) x) IS NOT DISTINCT FROM r->'acl') THEN
 RAISE EXCEPTION 'BREAKFAST_INSTALLED_AUTHORITY_CHANGED: %',r->>'signature' USING ERRCODE='55000'; END IF; END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements('[{"table":"tournaments","name":"non_satellite_completed_requires_terminal_receipt","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER non_satellite_completed_requires_terminal_receipt AFTER INSERT OR UPDATE OF status ON public.tournaments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_non_satellite_completed_requires_terminal_receipt()"},{"table":"tournaments","name":"stamp_tournament_terminal_evidence_markers","enabled":"O","definition":"CREATE TRIGGER stamp_tournament_terminal_evidence_markers AFTER INSERT OR UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_terminal_evidence_markers()"},{"table":"tournaments","name":"tournament_prize_math_contract","enabled":"O","definition":"CREATE TRIGGER tournament_prize_math_contract BEFORE INSERT OR UPDATE OF payout_math_version, payout_unit_cents, club_id ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_prize_math_contract()"},{"table":"tournaments","name":"trg_retire_manager_wakes_after_terminal_status","enabled":"O","definition":"CREATE TRIGGER trg_retire_manager_wakes_after_terminal_status AFTER UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_retire_manager_wakes_after_terminal_status()"},{"table":"tournaments","name":"zzzz_freeze_finalized_tournament_prize_pool","enabled":"D","definition":"CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool BEFORE UPDATE OF prize_pool, guaranteed_prize, prize_pool_finalized, payout_structure, spin_multiplier ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_freeze_finalized_tournament_prize_pool()"},{"table":"tournaments","name":"zzzz_tournament_pool_finalization_window_guard","enabled":"D","definition":"CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard BEFORE UPDATE OF prize_pool_finalized ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_pool_finalization_window_guard()"},{"table":"tournaments","name":"zzzzy_lock_atomic_final_table_deal_status","enabled":"O","definition":"CREATE TRIGGER zzzzy_lock_atomic_final_table_deal_status BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN ((new.status IS DISTINCT FROM old.status)) EXECUTE FUNCTION trg_lock_atomic_final_table_deal_status()"},{"table":"tournaments","name":"zzzzz_tournaments_atomic_final_table_deal_completion_guard","enabled":"D","definition":"CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = ''COMPLETED''::text) AND (old.status IS DISTINCT FROM ''COMPLETED''::text))) EXECUTE FUNCTION trg_atomic_final_table_deal_completion_guard()"},{"table":"table_seats","name":"a00_f06_source_seat","enabled":"O","definition":"CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()"},{"table":"table_seats","name":"terminal_tournament_seat_is_immutable","enabled":"O","definition":"CREATE TRIGGER terminal_tournament_seat_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_terminal_tournament_seat_is_immutable()"},{"table":"table_seats","name":"trg_log_seat_stack_exit","enabled":"O","definition":"CREATE TRIGGER trg_log_seat_stack_exit BEFORE DELETE OR UPDATE OF left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_log_seat_stack_exit()"},{"table":"table_seats","name":"zzz_diamond_seat_keeps_custody","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER zzz_diamond_seat_keeps_custody AFTER INSERT OR DELETE OR UPDATE ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_seat_keeps_custody()"},{"table":"tournament_players","name":"a00_f06_source_roster","enabled":"O","definition":"CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()"},{"table":"tournament_players","name":"terminal_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER terminal_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_terminal_tournament_evidence_is_immutable()"},{"table":"tournament_players","name":"zzzz_refuse_finalized_tournament_entry","enabled":"O","definition":"CREATE TRIGGER zzzz_refuse_finalized_tournament_entry BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_refuse_finalized_tournament_entry()"}]'::jsonb) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=to_regclass('public.'||(r->>'table'))
 AND g.tgname=r->>'name' AND g.tgenabled::text=r->>'enabled' AND pg_get_triggerdef(g.oid)=r->>'definition') THEN
 RAISE EXCEPTION 'BREAKFAST_INSTALLED_GUARD_CHANGED: %',r->>'name' USING ERRCODE='55000'; END IF; END LOOP;
END $installed$;
CREATE FUNCTION smarter_private.breakfast_retained_case() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $case$ SELECT '{"roster":[{"id":"125efe3a-fb57-44d8-8a6b-526b5114655b","user_id":"7e464f21-760d-4682-a6df-f8d89030d519","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":5,"chips":0,"chip_count":0,"prize":14.26,"table_id":null,"seat_number":null,"registered_at":"2026-09-08T08:38:47.693634+00:00","eliminated_at":"2026-09-08T14:40:03.412+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"146eed43-d106-411d-b602-88704d2df123","user_id":"c058ae6e-8331-4d25-8245-4da7fbfa3fd5","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":32,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-08T08:03:53.908441+00:00","eliminated_at":"2026-09-08T14:16:15.282+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"2289317b-7459-4db1-8943-66af7c339095","user_id":"ad7951e6-88d8-4b9e-807c-bd9753790e66","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":17,"chips":0,"chip_count":0,"prize":0,"table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","seat_number":2,"registered_at":"2026-09-06T02:25:14.248976+00:00","eliminated_at":"2026-09-08T14:30:26.176+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"30fe0aac-4b09-4ca7-bc3b-cd51ff01bd20","user_id":"ae0bc48d-f98c-4b25-a9fa-e3522f986173","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"playing","position":null,"chips":430255,"chip_count":0,"prize":0,"table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","seat_number":3,"registered_at":"2026-09-07T03:40:09.761554+00:00","eliminated_at":null,"elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"35519224-f962-4686-b4d1-2a6ef76f2d58","user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":4,"chips":0,"chip_count":0,"prize":19.83,"table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","seat_number":9,"registered_at":"2026-09-08T13:18:30.175663+00:00","eliminated_at":"2026-09-08T14:38:54.104+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"40a62034-e9c5-4c7d-b151-4f9dbd05828a","user_id":"bbca3b33-152a-44da-91f2-d63e5a2354d5","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":28,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-07T19:27:12.484959+00:00","eliminated_at":"2026-09-08T14:25:14.913+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"4f9aad43-a947-493c-b7e9-112f421263a7","user_id":"586f1543-8f0b-4486-bde5-cb937657ca30","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":16,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-08T01:26:23.113494+00:00","eliminated_at":"2026-09-08T14:31:50.111+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"5440ccb9-e198-4576-9750-e2d1b7698118","user_id":"91dfbccd-e521-4821-9cdc-3d058a0060e4","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":30,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-07T14:15:22.800577+00:00","eliminated_at":"2026-09-08T14:22:17.922+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"5d042652-0c85-4e0b-8bd0-b0c6f74e2451","user_id":"b82cb704-5ea3-469e-b05a-88e768e8834c","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":19,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-07T19:27:04.439588+00:00","eliminated_at":"2026-09-08T14:29:42.013+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"5da843db-d64d-40b5-abf3-e9cd5c3b4ba8","user_id":"dec9ad0a-55c3-4dfe-9ece-5315f9a44544","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":8,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-07T12:25:24.800761+00:00","eliminated_at":"2026-09-08T14:37:34.605+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"68d03669-8601-472b-8f50-514e7d5f018c","user_id":"bb01946f-5753-44d8-93f1-5c32062c3d6b","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":27,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-06T20:31:28.519861+00:00","eliminated_at":"2026-09-08T14:25:22.798+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"6e5fcd32-3027-4874-927b-ea7e6974086a","user_id":"9dc34048-3e89-4d93-8fcb-d3cac17474c5","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":12,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-06T11:24:35.455288+00:00","eliminated_at":"2026-09-08T14:34:11.868+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"7319c142-18f9-4ca7-bb9b-7a139cedc8cc","user_id":"e96f6e72-57c2-4881-8fb3-6cd29e587b8e","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":24,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-07T01:37:17.474718+00:00","eliminated_at":"2026-09-08T14:27:56.955+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"78aa4107-6075-4587-897b-9cfab1e18095","user_id":"761b4352-ee05-4423-a791-65303d364989","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":26,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-08T11:11:43.374702+00:00","eliminated_at":"2026-09-08T14:25:29.891+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"7981dd9f-42c0-4ec7-bac3-43c7f2742582","user_id":"c1ecb590-e6bb-4a7a-87de-95bb44673efc","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":25,"chips":0,"chip_count":0,"prize":0,"table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","seat_number":1,"registered_at":"2026-09-06T23:36:54.66855+00:00","eliminated_at":"2026-09-08T14:26:30.816+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"80f3428d-7b0a-4d87-85bd-bb40d928a3a3","user_id":"13133bc4-9139-4066-8b55-8edd31ef2318","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":9,"chips":0,"chip_count":0,"prize":0,"table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","seat_number":6,"registered_at":"2026-09-07T08:52:40.810129+00:00","eliminated_at":"2026-09-08T14:36:50.374+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"8841329a-a5b5-4ae3-ab36-0fc7d246512d","user_id":"e8cca6bc-24c0-43ac-9b03-58fe82fd59a1","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":23,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-07T10:48:02.960447+00:00","eliminated_at":"2026-09-08T14:28:00.163+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"8e8ccbb5-cc1a-4700-aadc-6dd19ed9dcea","user_id":"bf7f659b-0e5f-44c9-aace-bf6ae2cf035f","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":33,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-08T08:03:52.793968+00:00","eliminated_at":"2026-09-08T14:16:04.999+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"98be61f2-eb64-4ead-ae16-dd0552b86db7","user_id":"7a74d9fe-baef-4224-b20e-cea476853795","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":20,"chips":0,"chip_count":0,"prize":0,"table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","seat_number":6,"registered_at":"2026-09-07T07:17:03.520165+00:00","eliminated_at":"2026-09-08T14:28:12.302+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"9c37bcde-24bc-4262-8a8e-e72bd729b40f","user_id":"8a7faa73-bf76-4940-9b80-39e95163ffd1","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":6,"chips":0,"chip_count":0,"prize":0,"table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","seat_number":5,"registered_at":"2026-09-06T15:24:21.099291+00:00","eliminated_at":"2026-09-08T14:38:48.442+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"a0bdeee1-aea1-4f81-befb-10b8d3fbd483","user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":2,"chips":0,"chip_count":0,"prize":38.25,"table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","seat_number":8,"registered_at":"2026-09-06T19:51:04.718857+00:00","eliminated_at":"2026-09-08T14:43:07.569+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"a37af743-a6e0-41b7-b09f-6bbbad9c999e","user_id":"b439692b-fd8f-4a99-85fa-38f37111e733","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":29,"chips":0,"chip_count":0,"prize":0,"table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","seat_number":4,"registered_at":"2026-09-07T23:28:15.15624+00:00","eliminated_at":"2026-09-08T14:25:05.75+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"b2095d44-d9f8-42e9-ae76-a393d3543d98","user_id":"6258f768-cb01-4edf-9508-a40fedcdd49e","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":14,"chips":0,"chip_count":0,"prize":0,"table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","seat_number":7,"registered_at":"2026-09-08T11:51:23.49865+00:00","eliminated_at":"2026-09-08T14:42:14.516+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"b39c3931-1cdc-43b7-b4e4-2f42c43babbb","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":3,"chips":0,"chip_count":0,"prize":27.54,"table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","seat_number":4,"registered_at":"2026-09-07T06:41:57.361875+00:00","eliminated_at":"2026-09-08T14:42:22.425+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"b3de7729-b5f8-4897-a296-cc24cff4172a","user_id":"e24c3dca-e63f-4275-a1df-f7d6c6599b6e","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":10,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-05T19:50:24.119856+00:00","eliminated_at":"2026-09-08T14:37:12.605+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"c259c24e-f49c-4023-a669-d8acfe7a445b","user_id":"56dd101e-392b-4811-b662-ae64551770cd","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":7,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-08T01:26:21.936165+00:00","eliminated_at":"2026-09-08T14:38:07.482+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"c2a20615-7920-4eb0-8a6b-2c32237a6eae","user_id":"d7b99137-4394-41e0-909c-5211c5ad1f20","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":15,"chips":0,"chip_count":0,"prize":0,"table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","seat_number":4,"registered_at":"2026-09-08T03:29:56.333384+00:00","eliminated_at":"2026-09-08T14:31:52.937+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"c99b0f87-a9ad-4f7f-94f2-6fcf71d10150","user_id":"9e5abf96-3fe6-4bd5-8641-d6c95d5b64bf","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":13,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-08T05:39:59.001105+00:00","eliminated_at":"2026-09-08T14:33:04.367+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"ca28040c-381a-48da-bc79-36af9c2e4ab2","user_id":"99d046ab-7753-49ef-b33f-aad003f397fa","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":18,"chips":0,"chip_count":0,"prize":0,"table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","seat_number":5,"registered_at":"2026-09-07T20:27:17.768018+00:00","eliminated_at":"2026-09-08T14:44:27.861+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"d3d852fb-2a01-4e75-9e7c-653693c8282d","user_id":"b46c6190-ded0-4da6-8a51-b327cb3ebc04","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":22,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-07T19:26:56.63477+00:00","eliminated_at":"2026-09-08T14:28:05.673+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"d8ed96a2-abb1-4f98-925a-63bd277b8bb1","user_id":"44f1ff92-b5de-44c5-9f7b-319318ff2a74","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":31,"chips":0,"chip_count":0,"prize":0,"table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","seat_number":8,"registered_at":"2026-09-06T07:31:46.938498+00:00","eliminated_at":"2026-09-08T14:19:55.547+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"e49fdaa8-3f02-44e3-9f40-59cfbb18f1b9","user_id":"9ee591b7-2360-4ea8-ad3b-942ef829fbda","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"playing","position":null,"chips":0,"chip_count":0,"prize":0,"table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","seat_number":1,"registered_at":"2026-09-08T05:40:00.081882+00:00","eliminated_at":null,"elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"e9649320-3324-4251-abf9-dca245b4a093","user_id":"aecab0a3-191a-4c26-8f72-cc0de7a975c6","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":34,"chips":0,"chip_count":0,"prize":0,"table_id":null,"seat_number":null,"registered_at":"2026-09-08T09:38:41.835994+00:00","eliminated_at":"2026-09-08T14:12:49.815+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false},{"id":"f699f079-53cc-4b48-9136-889ccb99cbe7","user_id":"c2bbe90b-bd79-43a2-8d22-5c60a0ec3855","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","status":"eliminated","position":11,"chips":0,"chip_count":0,"prize":0,"table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","seat_number":4,"registered_at":"2026-09-07T21:20:56.352809+00:00","eliminated_at":"2026-09-08T14:35:26.729+00:00","elimination_sequence":null,"rebuys":0,"add_on":false,"rebuy_prompt_until":null,"current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"source_satellite_id":null,"is_satellite_qualifier":false}],"entry":{"close_mode":"levels","created_at":"2026-09-14T00:11:24.973804+00:00","updated_at":"2026-09-14T00:11:24.977827+00:00","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","entry_closed_at":"2026-09-14T00:11:24.973804+00:00","manager_wake_id":34555,"final_prize_pool":153,"reprice_completed_at":null,"payout_structure_snapshot":[{"place":1,"percentage":43.12},{"place":2,"percentage":24.76},{"place":3,"percentage":17.9},{"place":4,"percentage":14.22}]},"payouts":[{"id":"12b5d125-bbdb-4031-91b0-4172c3c8e8e5","amount":14.26,"source":"structure","paid_at":"2026-09-08T14:40:04.926738+00:00","user_id":"7e464f21-760d-4682-a6df-f8d89030d519","metadata":null,"position":5,"created_at":"2026-09-08T14:40:04.926738+00:00","field_size":34,"prize_pool":153,"recorded_by":"credit_and_log","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","idempotency_key":"tourney:f370585d-40ea-4085-bb8f-c7e8c74f3fb4:obl:fca37fa1-2761-41f0-bd42-a633a7091205:0","tournament_type":"MTT","payout_structure":{"payout_structure":"[{\"place\":1,\"percentage\":34.72},{\"place\":2,\"percentage\":25},{\"place\":3,\"percentage\":18},{\"place\":4,\"percentage\":12.96},{\"place\":5,\"percentage\":9.32}]"},"terminal_closed_at":null},{"id":"43b9df05-913c-4649-8372-6c76cdb3e32b","amount":38.25,"source":"structure","paid_at":"2026-09-08T14:43:11.661462+00:00","user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","metadata":null,"position":2,"created_at":"2026-09-08T14:43:11.661462+00:00","field_size":34,"prize_pool":153,"recorded_by":"credit_and_log","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","idempotency_key":"tourney:f370585d-40ea-4085-bb8f-c7e8c74f3fb4:obl:7aab7c14-a861-481b-b06b-58886301a9d4:0","tournament_type":"MTT","payout_structure":{"payout_structure":"[{\"place\":1,\"percentage\":34.72},{\"place\":2,\"percentage\":25},{\"place\":3,\"percentage\":18},{\"place\":4,\"percentage\":12.96},{\"place\":5,\"percentage\":9.32}]"},"terminal_closed_at":null},{"id":"5fc01248-549f-4ad7-bed4-5bc4843d26f3","amount":19.83,"source":"structure","paid_at":"2026-09-08T14:38:57.332074+00:00","user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","metadata":null,"position":4,"created_at":"2026-09-08T14:38:57.332074+00:00","field_size":34,"prize_pool":153,"recorded_by":"credit_and_log","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","idempotency_key":"tourney:f370585d-40ea-4085-bb8f-c7e8c74f3fb4:obl:8e1e9c47-b7c8-4373-a8c6-30e5aab4ea99:0","tournament_type":"MTT","payout_structure":{"payout_structure":"[{\"place\":1,\"percentage\":34.72},{\"place\":2,\"percentage\":25},{\"place\":3,\"percentage\":18},{\"place\":4,\"percentage\":12.96},{\"place\":5,\"percentage\":9.32}]"},"terminal_closed_at":null},{"id":"bf2f7ff6-b84a-4404-a213-fc9bf320ec33","amount":27.54,"source":"structure","paid_at":"2026-09-08T14:42:23.468154+00:00","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","metadata":null,"position":3,"created_at":"2026-09-08T14:42:23.468154+00:00","field_size":34,"prize_pool":153,"recorded_by":"credit_and_log","tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","idempotency_key":"tourney:f370585d-40ea-4085-bb8f-c7e8c74f3fb4:obl:f2308fd1-4cbd-4520-ae39-53be160e044c:0","tournament_type":"MTT","payout_structure":{"payout_structure":"[{\"place\":1,\"percentage\":34.72},{\"place\":2,\"percentage\":25},{\"place\":3,\"percentage\":18},{\"place\":4,\"percentage\":12.96},{\"place\":5,\"percentage\":9.32}]"},"terminal_closed_at":null}],"obligations":[{"id":"7aab7c14-a861-481b-b06b-58886301a9d4","kind":"place","place":2,"source":"engine.eliminatePlayer","user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","created_at":"2026-09-08T14:43:11.661462+00:00","settled_at":"2026-09-08T14:43:11.661462+00:00","updated_at":"2026-09-08T14:43:11.661462+00:00","amount_owed":38.25,"amount_paid":38.25,"adjustment_id":null,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","terminal_closed_at":null},{"id":"8e1e9c47-b7c8-4373-a8c6-30e5aab4ea99","kind":"place","place":4,"source":"engine.eliminatePlayer","user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","created_at":"2026-09-08T14:38:57.332074+00:00","settled_at":"2026-09-08T14:38:57.332074+00:00","updated_at":"2026-09-08T14:38:57.332074+00:00","amount_owed":19.83,"amount_paid":19.83,"adjustment_id":null,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","terminal_closed_at":null},{"id":"f2308fd1-4cbd-4520-ae39-53be160e044c","kind":"place","place":3,"source":"engine.eliminatePlayer","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","created_at":"2026-09-08T14:42:23.468154+00:00","settled_at":"2026-09-08T14:42:23.468154+00:00","updated_at":"2026-09-08T14:42:23.468154+00:00","amount_owed":27.54,"amount_paid":27.54,"adjustment_id":null,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","terminal_closed_at":null},{"id":"fca37fa1-2761-41f0-bd42-a633a7091205","kind":"place","place":5,"source":"engine.eliminatePlayer","user_id":"7e464f21-760d-4682-a6df-f8d89030d519","created_at":"2026-09-08T14:40:04.926738+00:00","settled_at":"2026-09-08T14:40:04.926738+00:00","updated_at":"2026-09-08T14:40:04.926738+00:00","amount_owed":14.26,"amount_paid":14.26,"adjustment_id":null,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","terminal_closed_at":null}],"wallet_keys":[{"key":"tourney:f370585d-40ea-4085-bb8f-c7e8c74f3fb4:obl:7aab7c14-a861-481b-b06b-58886301a9d4:0","amount":38.25,"user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","created_at":"2026-09-08T14:43:11.661462+00:00"},{"key":"tourney:f370585d-40ea-4085-bb8f-c7e8c74f3fb4:obl:8e1e9c47-b7c8-4373-a8c6-30e5aab4ea99:0","amount":19.83,"user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","created_at":"2026-09-08T14:38:57.332074+00:00"},{"key":"tourney:f370585d-40ea-4085-bb8f-c7e8c74f3fb4:obl:f2308fd1-4cbd-4520-ae39-53be160e044c:0","amount":27.54,"user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","created_at":"2026-09-08T14:42:23.468154+00:00"},{"key":"tourney:f370585d-40ea-4085-bb8f-c7e8c74f3fb4:obl:fca37fa1-2761-41f0-bd42-a633a7091205:0","amount":14.26,"user_id":"7e464f21-760d-4682-a6df-f8d89030d519","created_at":"2026-09-08T14:40:04.926738+00:00"}],"fee_charges":[{"id":"0233ae78-4ea8-426d-b4b7-78353d6f396e","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"aecab0a3-191a-4c26-8f72-cc0de7a975c6","registration_id":"e9649320-3324-4251-abf9-dca245b4a093"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T09:38:41.835994+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23139875,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"aecab0a3-191a-4c26-8f72-cc0de7a975c6":0.5}},{"id":"048292c7-3c68-4679-866d-5de06a6c6060","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"bf7f659b-0e5f-44c9-aace-bf6ae2cf035f","registration_id":"8e8ccbb5-cc1a-4700-aadc-6dd19ed9dcea"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T08:03:52.793968+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23125546,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"bf7f659b-0e5f-44c9-aace-bf6ae2cf035f":0.5}},{"id":"0e4096f0-1f4f-4484-9e47-5bf5c093440d","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","registration_id":"a0bdeee1-aea1-4f81-befb-10b8d3fbd483"},"pot_size":5,"table_id":null,"created_at":"2026-09-06T19:51:04.718857+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":20947185,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"15d4ddbc-a5de-4de8-b5d8-8e928ded3740","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"b82cb704-5ea3-469e-b05a-88e768e8834c","registration_id":"5d042652-0c85-4e0b-8bd0-b0c6f74e2451"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T19:27:04.439588+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21866954,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"15fd7266-51b2-45d6-b2f0-b9523f55c2ae","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"c1ecb590-e6bb-4a7a-87de-95bb44673efc","registration_id":"7981dd9f-42c0-4ec7-bac3-43c7f2742582"},"pot_size":5,"table_id":null,"created_at":"2026-09-06T23:36:54.66855+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21038543,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"182ce009-f9a9-4676-91db-4fbbf351f4a8","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"7e464f21-760d-4682-a6df-f8d89030d519","registration_id":"125efe3a-fb57-44d8-8a6b-526b5114655b"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T08:38:47.693634+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23130565,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"7e464f21-760d-4682-a6df-f8d89030d519":0.5}},{"id":"1d7a6df8-d307-4917-89fc-e5f59aca320d","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"9dc34048-3e89-4d93-8fcb-d3cac17474c5","registration_id":"6e5fcd32-3027-4874-927b-ea7e6974086a"},"pot_size":5,"table_id":null,"created_at":"2026-09-06T11:24:35.455288+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":20481040,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"2b86dc27-57e1-4fdf-9cf5-123c68f152fc","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"e24c3dca-e63f-4275-a1df-f7d6c6599b6e","registration_id":"b3de7729-b5f8-4897-a296-cc24cff4172a"},"pot_size":5,"table_id":null,"created_at":"2026-09-05T19:50:24.119856+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":19734043,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"2fe41386-c8d7-4f9a-aa17-ab48ad56cb2e","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"56dd101e-392b-4811-b662-ae64551770cd","registration_id":"c259c24e-f49c-4023-a669-d8acfe7a445b"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T01:26:21.936165+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":22577944,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"573316cf-1b7f-428a-ba94-8b97006a6f72","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"761b4352-ee05-4423-a791-65303d364989","registration_id":"78aa4107-6075-4587-897b-9cfab1e18095"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T11:11:43.374702+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23162759,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"761b4352-ee05-4423-a791-65303d364989":0.5}},{"id":"5fd42f48-bf0a-4a97-b1cf-fcfa9dc671e7","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"c058ae6e-8331-4d25-8245-4da7fbfa3fd5","registration_id":"146eed43-d106-411d-b602-88704d2df123"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T08:03:53.908441+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23122349,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"c058ae6e-8331-4d25-8245-4da7fbfa3fd5":0.5}},{"id":"61c3737e-4543-4ed3-98b9-45e24d781ce8","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"c2bbe90b-bd79-43a2-8d22-5c60a0ec3855","registration_id":"f699f079-53cc-4b48-9136-889ccb99cbe7"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T21:20:56.352809+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":22085442,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"6fa5f7b5-515a-4811-beea-722fadef088a","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"586f1543-8f0b-4486-bde5-cb937657ca30","registration_id":"4f9aad43-a947-493c-b7e9-112f421263a7"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T01:26:23.113494+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":22577043,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"71ab1f94-b3ac-48c2-92a7-46e2ad183b46","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"13133bc4-9139-4066-8b55-8edd31ef2318","registration_id":"80f3428d-7b0a-4d87-85bd-bb40d928a3a3"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T08:52:40.810129+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21492449,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"7dffedba-359d-4527-b7e7-eb88b52c0ca1","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"ae0bc48d-f98c-4b25-a9fa-e3522f986173","registration_id":"30fe0aac-4b09-4ca7-bc3b-cd51ff01bd20"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T03:40:09.761554+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21221157,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"80eaf44a-3f87-4db6-98ab-85ee5f780637","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"9ee591b7-2360-4ea8-ad3b-942ef829fbda","registration_id":"e49fdaa8-3f02-44e3-9f40-59cfbb18f1b9"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T05:40:00.081882+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23059243,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"9ee591b7-2360-4ea8-ad3b-942ef829fbda":0.5}},{"id":"81500a3e-2d77-4f71-8293-6b626824c850","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"b46c6190-ded0-4da6-8a51-b327cb3ebc04","registration_id":"d3d852fb-2a01-4e75-9e7c-653693c8282d"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T19:26:56.63477+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21867349,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"848574a1-e456-4337-9bd2-61b647e20c84","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"e8cca6bc-24c0-43ac-9b03-58fe82fd59a1","registration_id":"8841329a-a5b5-4ae3-ab36-0fc7d246512d"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T10:48:02.960447+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21515056,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"849bdb90-9fff-4460-8634-3dd77e983bac","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"b439692b-fd8f-4a99-85fa-38f37111e733","registration_id":"a37af743-a6e0-41b7-b09f-6bbbad9c999e"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T23:28:15.15624+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":22358043,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"8ba87621-b0f7-4c97-a4d3-72e423474d4f","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"9e5abf96-3fe6-4bd5-8641-d6c95d5b64bf","registration_id":"c99b0f87-a9ad-4f7f-94f2-6fcf71d10150"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T05:39:59.001105+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23058049,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"9e5abf96-3fe6-4bd5-8641-d6c95d5b64bf":0.5}},{"id":"931ee262-80be-418c-8bc3-499ac142fe51","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"dec9ad0a-55c3-4dfe-9ece-5315f9a44544","registration_id":"5da843db-d64d-40b5-abf3-e9cd5c3b4ba8"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T12:25:24.800761+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21541441,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"9db577ba-58d2-4c75-ba88-31e48978688f","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"44f1ff92-b5de-44c5-9f7b-319318ff2a74","registration_id":"d8ed96a2-abb1-4f98-925a-63bd277b8bb1"},"pot_size":5,"table_id":null,"created_at":"2026-09-06T07:31:46.938498+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":20285657,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"9df31f79-9eac-4284-8335-269faf5f5c48","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"bbca3b33-152a-44da-91f2-d63e5a2354d5","registration_id":"40a62034-e9c5-4c7d-b151-4f9dbd05828a"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T19:27:12.484959+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21867554,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"a61e4b43-e576-46d2-992b-c5e32ffb8759","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"8a7faa73-bf76-4940-9b80-39e95163ffd1","registration_id":"9c37bcde-24bc-4262-8a8e-e72bd729b40f"},"pot_size":5,"table_id":null,"created_at":"2026-09-06T15:24:21.099291+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":20773047,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"b0d60739-9368-43e3-849f-de26e463c0b7","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"7a74d9fe-baef-4224-b20e-cea476853795","registration_id":"98be61f2-eb64-4ead-ae16-dd0552b86db7"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T07:17:03.520165+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21406142,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"b4440ad8-648b-4d34-baba-7839dfa5de55","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"91dfbccd-e521-4821-9cdc-3d058a0060e4","registration_id":"5440ccb9-e198-4576-9750-e2d1b7698118"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T14:15:22.800577+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21563855,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"b47a6fdd-8ad2-4ccf-93a1-218f5b9165df","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"d7b99137-4394-41e0-909c-5211c5ad1f20","registration_id":"c2a20615-7920-4eb0-8a6b-2c32237a6eae"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T03:29:56.333384+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":22839345,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"d7b99137-4394-41e0-909c-5211c5ad1f20":0.5}},{"id":"ba17c7bf-90a2-479f-ad25-339d97d76d25","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"99d046ab-7753-49ef-b33f-aad003f397fa","registration_id":"ca28040c-381a-48da-bc79-36af9c2e4ab2"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T20:27:17.768018+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":22012344,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"bf24d157-330f-43ba-9c1a-32ebeac89d68","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"bb01946f-5753-44d8-93f1-5c32062c3d6b","registration_id":"68d03669-8601-472b-8f50-514e7d5f018c"},"pot_size":5,"table_id":null,"created_at":"2026-09-06T20:31:28.519861+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":20964540,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"bf6bd38a-1b70-47c9-8e0a-dd1c1077c5a1","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"6258f768-cb01-4edf-9508-a40fedcdd49e","registration_id":"b2095d44-d9f8-42e9-ae76-a393d3543d98"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T11:51:23.49865+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23202442,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"6258f768-cb01-4edf-9508-a40fedcdd49e":0.5}},{"id":"cacb3051-197f-42c9-b6cd-6f5d096c784c","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"e96f6e72-57c2-4881-8fb3-6cd29e587b8e","registration_id":"7319c142-18f9-4ca7-bb9b-7a139cedc8cc"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T01:37:17.474718+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21121375,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"d0e71531-9de8-48b7-b2d3-e20884638903","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"ad7951e6-88d8-4b9e-807c-bd9753790e66","registration_id":"2289317b-7459-4db1-8943-66af7c339095"},"pot_size":5,"table_id":null,"created_at":"2026-09-06T02:25:14.248976+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":20187841,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null},{"id":"d42e5a85-e7a3-4c7f-b371-0cc298c5326c","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","registration_id":"35519224-f962-4686-b4d1-2a6ef76f2d58"},"pot_size":5,"table_id":null,"created_at":"2026-09-08T13:18:30.175663+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":23325041,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":{"4f0bbf2a-7a7e-43f1-bc19-c0f937419388":0.5}},{"id":"e7c486fd-1d25-4514-bcdd-6399034d57bf","source":"fn_register_horse_for_tournament","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_id":null,"metadata":{"kind":"tournament_entry_fee","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","registration_id":"b39c3931-1cdc-43b7-b4e4-2f42c43babbb"},"pot_size":5,"table_id":null,"created_at":"2026-09-07T06:41:57.361875+00:00","num_players":1,"rake_amount":0.5,"rake_method":"DEALT_EQUAL","is_tournament":true,"tournament_id":"f370585d-40ea-4085-bb8f-c7e8c74f3fb4","global_hand_id":21381440,"bbj_contribution":0,"returned_uncalled":null,"terminal_closed_at":null,"player_contributions":null}],"seats":[{"id":"1169ffb5-3cd9-49ca-891d-ee60f727ef8f","stack":430255,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":null,"user_id":"ae0bc48d-f98c-4b25-a9fa-e3522f986173","horse_id":"ae0bc48d-f98c-4b25-a9fa-e3522f986173","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:00:59.235+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":3,"occupancy_id":"127870ec-9a7c-4206-b8d1-315c8f6e5ee6","leave_pending":false,"is_sitting_out":false,"active_game_scope":"table:dd835bad-d3c8-4984-ab2f-5ed52d1fb664","active_parent_key":"tournament:f370585d-40ea-4085-bb8f-c7e8c74f3fb4","entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"1c17a4a3-7695-4ca1-8a68-0d9b369770d0","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:19:34.445+00:00","user_id":"44f1ff92-b5de-44c5-9f7b-319318ff2a74","horse_id":"44f1ff92-b5de-44c5-9f7b-319318ff2a74","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:01:13.116+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":8,"occupancy_id":"0de77b2d-7d35-4cf2-8485-f10876747e28","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"20bd391b-b5e8-4f30-af20-851f8b5a3c35","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:42:14.149+00:00","user_id":"6258f768-cb01-4edf-9508-a40fedcdd49e","horse_id":"6258f768-cb01-4edf-9508-a40fedcdd49e","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:38:27.754+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":7,"occupancy_id":"066e058c-2b34-4edc-8691-5fc7d216e256","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"24d4373c-49e2-4828-aff8-a5b837f34a81","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:39:08.387+00:00","user_id":"9ee591b7-2360-4ea8-ad3b-942ef829fbda","horse_id":"9ee591b7-2360-4ea8-ad3b-942ef829fbda","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:38:43.564+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":2,"occupancy_id":"fc23b042-65c5-4c1c-89c7-86dc4b547cbc","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"27f4da0b-0038-423b-a751-9386dfda5bb5","stack":35694,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:38:33.316+00:00","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","horse_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:27:31.56+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":8,"occupancy_id":"043790ec-2792-499d-9088-4087613a071e","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"29301a99-ec8a-4712-8a31-1e4669ca8771","stack":33055,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:32:29.247+00:00","user_id":"dec9ad0a-55c3-4dfe-9ece-5315f9a44544","horse_id":"dec9ad0a-55c3-4dfe-9ece-5315f9a44544","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:30:40.319+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":9,"occupancy_id":"0ef9a8e6-1dda-42a4-a4ba-74c572c9b2ac","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"322f9a8c-783d-44da-a2ea-62fad49161c9","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:44:26.973+00:00","user_id":"99d046ab-7753-49ef-b33f-aad003f397fa","horse_id":"99d046ab-7753-49ef-b33f-aad003f397fa","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:01:08.824+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":5,"occupancy_id":"72ff910a-92f0-4a13-9d76-b5d75d2d0793","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"40d2f77e-a5ba-42e0-829b-29a1c7f97ded","stack":11871,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:12:33.947+00:00","user_id":"d7b99137-4394-41e0-909c-5211c5ad1f20","horse_id":"d7b99137-4394-41e0-909c-5211c5ad1f20","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:01:08.358+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":5,"occupancy_id":"041a8176-d82b-4e5f-b67d-d8d5215b154c","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"4162200e-78ea-4e98-911c-648e5034ecf9","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:42:14.149+00:00","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","horse_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:39:05.431+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":4,"occupancy_id":"01edf372-6e59-44b0-a7e0-8bd90586901a","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"41cef73d-6c47-4241-a2da-9ed9572059ad","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":null,"user_id":"9ee591b7-2360-4ea8-ad3b-942ef829fbda","horse_id":"9ee591b7-2360-4ea8-ad3b-942ef829fbda","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:39:08.502+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":1,"occupancy_id":"c0c9eafb-c3e7-4f21-aad9-79ca69e2e88b","leave_pending":false,"is_sitting_out":false,"active_game_scope":"table:dd835bad-d3c8-4984-ab2f-5ed52d1fb664","active_parent_key":"tournament:f370585d-40ea-4085-bb8f-c7e8c74f3fb4","entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"47747703-8de2-4d6c-bef8-d30183ca7d55","stack":29341,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:27:27.232+00:00","user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","horse_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:00:55.903+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":2,"occupancy_id":"2b41a63e-f983-4c36-adf4-b19eb05b3085","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"48bcd9c3-67ce-418e-ad5f-43fc7ba32f06","stack":13858,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:27:19.465+00:00","user_id":"586f1543-8f0b-4486-bde5-cb937657ca30","horse_id":"586f1543-8f0b-4486-bde5-cb937657ca30","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:01:11.459+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":7,"occupancy_id":"743380c8-7f64-4508-b115-eb7b562a7524","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"4c185118-571e-4632-8079-7bb6a4d09be6","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:40:01.346+00:00","user_id":"7e464f21-760d-4682-a6df-f8d89030d519","horse_id":"7e464f21-760d-4682-a6df-f8d89030d519","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:39:07.56+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":6,"occupancy_id":"784b9543-9e35-482e-bf29-f16f12461773","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"4debd60c-0b4c-4091-96c4-67f909c6f1be","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:38:29.776+00:00","user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","horse_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:32:20.66+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":9,"occupancy_id":"f15656c1-afa7-4407-942b-1f222d13c3ed","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"51ad4e90-30f7-40c4-8ec1-5f7b6b1da910","stack":47950,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:39:07.339+00:00","user_id":"7e464f21-760d-4682-a6df-f8d89030d519","horse_id":"7e464f21-760d-4682-a6df-f8d89030d519","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:38:42.456+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":1,"occupancy_id":"000c4a1e-20eb-4cde-8c73-f454ecdc3a9d","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"678355f2-8cd4-42bb-b5d1-134d82271a41","stack":24088,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:27:23.306+00:00","user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","horse_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:01:22.137+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":9,"occupancy_id":"9127796e-8e01-4ae7-a176-0fd475ee1165","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"75360acd-d7c6-48ff-953f-432605042812","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:27:47.877+00:00","user_id":"7a74d9fe-baef-4224-b20e-cea476853795","horse_id":"7a74d9fe-baef-4224-b20e-cea476853795","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:01:10.748+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":6,"occupancy_id":"47cba126-3d03-474a-9288-9d6dc3691820","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"8387c115-6d4e-4c4a-b9ba-3e54f5fa3f8e","stack":18262,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:27:34.533+00:00","user_id":"9e5abf96-3fe6-4bd5-8641-d6c95d5b64bf","horse_id":"9e5abf96-3fe6-4bd5-8641-d6c95d5b64bf","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:01:10.048+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":6,"occupancy_id":"eda45a18-19d4-496f-89d2-80e7f05df4aa","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"843e3b1b-467f-4786-a32a-7a60ca1b37af","stack":8434,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:29:28.41+00:00","user_id":"ad7951e6-88d8-4b9e-807c-bd9753790e66","horse_id":"ad7951e6-88d8-4b9e-807c-bd9753790e66","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:01:11.097+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":7,"occupancy_id":"20a0518f-fd1b-4321-b9eb-bd5197bee020","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"84cd22b4-c940-443b-beb5-bd0d1754a47d","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:30:18.986+00:00","user_id":"ad7951e6-88d8-4b9e-807c-bd9753790e66","horse_id":"ad7951e6-88d8-4b9e-807c-bd9753790e66","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:29:29.349+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":2,"occupancy_id":"96955b0e-6a89-4388-a773-52a6aa26f63e","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"87c527a1-4a3c-4e0a-a5cf-9057b10488ee","stack":34888,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:32:20.152+00:00","user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","horse_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:27:23.855+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":3,"occupancy_id":"a55bb66f-98a5-45b4-b975-e8ce3b0e5d65","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"97e45bd6-7e93-4410-9e94-8f63aa18f563","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:24:23.942+00:00","user_id":"b439692b-fd8f-4a99-85fa-38f37111e733","horse_id":"b439692b-fd8f-4a99-85fa-38f37111e733","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:01:00.9+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":4,"occupancy_id":"f6861504-aeb9-476c-b615-1dc76bcc69b6","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"9d0f33cb-a92d-45e5-b0f1-d042ac068edd","stack":60218,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:32:33.076+00:00","user_id":"8a7faa73-bf76-4940-9b80-39e95163ffd1","horse_id":"8a7faa73-bf76-4940-9b80-39e95163ffd1","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:00:52.686+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":1,"occupancy_id":"214faaa5-8a1f-4768-8aeb-1aaf4afcda53","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"a43168b7-b1d5-4492-b42b-08789d3e23ac","stack":48271,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:38:00.634+00:00","user_id":"8a7faa73-bf76-4940-9b80-39e95163ffd1","horse_id":"8a7faa73-bf76-4940-9b80-39e95163ffd1","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:32:33.669+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":5,"occupancy_id":"3c34f380-21c8-4a38-9608-d822fa4df5c8","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"a5134b4f-2816-4184-b88b-d4c62a50df2f","stack":80144,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:38:42.27+00:00","user_id":"7e464f21-760d-4682-a6df-f8d89030d519","horse_id":"7e464f21-760d-4682-a6df-f8d89030d519","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:38:31.358+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":9,"occupancy_id":"f752e810-8683-412f-941e-98227d8ce5e5","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"acc7b9c8-a40e-424b-8ecb-f422f6c0f966","stack":35694,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:38:44.437+00:00","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","horse_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:38:33.654+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":2,"occupancy_id":"ec8844f7-ef14-4384-a301-7a04d5026cae","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"b873ee39-6967-4a86-9f5d-f8b459ab137c","stack":67888,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:39:04.945+00:00","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","horse_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:38:44.579+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":3,"occupancy_id":"4465ce94-4647-4d7a-b28c-0e7f041ec50d","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"c04e645a-8240-42c3-abbe-d28006ad8e55","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:27:46.434+00:00","user_id":"9ee591b7-2360-4ea8-ad3b-942ef829fbda","horse_id":"9ee591b7-2360-4ea8-ad3b-942ef829fbda","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:01:09.193+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":5,"occupancy_id":"d7dd9ccc-b21f-4b6c-b4c9-88603ae82c18","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"c9020c2f-18c7-4b9c-8f26-b7859c053a7c","stack":30572,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:32:22.749+00:00","user_id":"7e464f21-760d-4682-a6df-f8d89030d519","horse_id":"7e464f21-760d-4682-a6df-f8d89030d519","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:01:12.297+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":7,"occupancy_id":"316c3201-2446-4c08-b761-f242a4487fe9","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"cd5d98fa-3d99-49ab-a420-648a65337cba","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:43:03.88+00:00","user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","horse_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","table_id":"dd835bad-d3c8-4984-ab2f-5ed52d1fb664","joined_at":"2026-09-08T14:32:26.375+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":8,"occupancy_id":"9aa3c771-cf8d-456b-a2be-466ac9e47ebf","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"cee9aa4a-95a2-44c8-bf05-704de3dfe52e","stack":36275,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:32:25.811+00:00","user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","horse_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:27:27.734+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":8,"occupancy_id":"157b5c2b-042f-4b3b-8c4b-1c2a29618c52","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"e1daa55e-a11a-4362-aced-035deb33a2a2","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:31:48.131+00:00","user_id":"d7b99137-4394-41e0-909c-5211c5ad1f20","horse_id":"d7b99137-4394-41e0-909c-5211c5ad1f20","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","joined_at":"2026-09-08T14:29:32.32+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":4,"occupancy_id":"ae0a93f2-ff77-48a7-9795-1eba21bedf14","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"eab60e3f-491d-4599-919f-9fc9da347bb3","stack":10580,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:27:30.767+00:00","user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","horse_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:00:58.859+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":3,"occupancy_id":"d7036e12-b18a-405e-a715-737feb1000fc","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"f363d955-9879-41f4-bd16-a2189badcbcc","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:35:18.571+00:00","user_id":"c2bbe90b-bd79-43a2-8d22-5c60a0ec3855","horse_id":"c2bbe90b-bd79-43a2-8d22-5c60a0ec3855","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:01:00.452+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":4,"occupancy_id":"ae6c965c-1876-4cb7-baf3-79f7e1985a59","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":140,"scheduled_leave_hands":null,"time_bank_uses_remaining":7},{"id":"f4409a1d-4524-4ba9-a1de-b27b783821d4","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:26:19.76+00:00","user_id":"c1ecb590-e6bb-4a7a-87de-95bb44673efc","horse_id":"c1ecb590-e6bb-4a7a-87de-95bb44673efc","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","joined_at":"2026-09-08T14:00:51.764+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":1,"occupancy_id":"68ac0a02-daf6-4a0a-9559-ea27984c2ee7","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":20,"scheduled_leave_hands":null,"time_bank_uses_remaining":1},{"id":"f78aab4a-733b-4819-b871-b5b70b6fc443","stack":0,"status":"active","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","is_away":false,"left_at":"2026-09-08T14:36:42.656+00:00","user_id":"13133bc4-9139-4066-8b55-8edd31ef2318","horse_id":"13133bc4-9139-4066-8b55-8edd31ef2318","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","joined_at":"2026-09-08T14:01:09.588+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":6,"occupancy_id":"87a2fa09-ac20-4f2d-92de-df7c52386895","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":0,"scheduled_leave_hands":null,"time_bank_uses_remaining":0}],"historical_snapshots":[{"id":"1d18086f-1d92-416f-a305-a91de022a032","stage":"preflop","table_id":"de7d292b-b356-4574-a1fc-6395c8180c82","created_at":"2026-09-08T14:32:22.95441+00:00","state_json":{"pot":8000,"pots":[],"stage":"preflop","players":[{"bet":2000,"seat":1,"cards":[{"rank":"4","suit":"diamonds"},{"rank":"4","suit":"spades"}],"stack":58218,"user_id":"8a7faa73-bf76-4940-9b80-39e95163ffd1","is_horse":true,"username":"FoldPhantom","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/vip_basketball@2x.webp","deadInvested":0,"equipped_aura":"","totalInvested":2000,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0},{"bet":4000,"seat":7,"cards":[{"rank":"K","suit":"clubs"},{"rank":"T","suit":"hearts"}],"stack":24572,"user_id":"7e464f21-760d-4682-a6df-f8d89030d519","is_horse":true,"username":"FloatRanger","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/free_android@2x.webp","deadInvested":2000,"equipped_aura":"","totalInvested":6000,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0},{"bet":0,"seat":8,"cards":[{"rank":"Q","suit":"clubs"},{"rank":"2","suit":"hearts"}],"stack":36275,"user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","is_horse":true,"username":"CheckWarden","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/vip_viking_warrior@2x.webp","deadInvested":0,"equipped_aura":"","totalInvested":0,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0},{"bet":0,"seat":9,"cards":[{"rank":"J","suit":"diamonds"},{"rank":"3","suit":"diamonds"}],"stack":33055,"user_id":"dec9ad0a-55c3-4dfe-9ece-5315f9a44544","is_horse":true,"username":"FloatQueenRush","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/vip_luchador@2x.webp","deadInvested":0,"equipped_aura":"","totalInvested":0,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0}],"sawFlop":false,"minRaise":4000,"lastRaise":4000,"currentBet":4000,"dealerSeat":9,"actionHistory":[],"communityCards":[],"communityCards2":[],"communityCards3":[],"currentPlayerSeat":8,"lastAggressorSeat":-1},"updated_at":"2026-09-08T14:32:22.95441+00:00","config_json":{"ante":500,"tableId":"de7d292b-b356-4574-a1fc-6395c8180c82","bigBlind":4000,"bbjConfig":{"feeBB":0.03,"enabled":false,"minPotBB":10,"minPlayersDealt":3},"handNumber":8211594,"rakeConfig":{"cap":0,"percent":0,"noFlopNoDrop":true},"smallBlind":2000,"gameVariant":"nlh"},"dealer_seat":9,"hand_number":8211594,"is_complete":false,"players_json":[{"seat":1,"stack":58218,"user_id":"8a7faa73-bf76-4940-9b80-39e95163ffd1","is_horse":true,"username":"FoldPhantom"},{"seat":7,"stack":24572,"user_id":"7e464f21-760d-4682-a6df-f8d89030d519","is_horse":true,"username":"FloatRanger"},{"seat":8,"stack":36275,"user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","is_horse":true,"username":"CheckWarden"},{"seat":9,"stack":33055,"user_id":"dec9ad0a-55c3-4dfe-9ece-5315f9a44544","is_horse":true,"username":"FloatQueenRush"}],"disconnect_states":{"4f0bbf2a-7a7e-43f1-bc19-c0f937419388":{"state":"CONNECTED","sinceMs":1788877937597,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"6258f768-cb01-4edf-9508-a40fedcdd49e":{"state":"DISCONNECTED","sinceMs":1788877625702,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877670702,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877670702,"reconnectGrantedAtMs":1788877625702},"761b4352-ee05-4423-a791-65303d364989":{"state":"DISCONNECTED","sinceMs":1788877494989,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877539989,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877539989,"reconnectGrantedAtMs":1788877494989},"7a720598-8e36-48e1-9826-7bc99a81bdb6":{"state":"CONNECTED","sinceMs":1788877937597,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"7a74d9fe-baef-4224-b20e-cea476853795":{"state":"DISCONNECTED","sinceMs":1788877696207,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877741207,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877741207,"reconnectGrantedAtMs":1788877696207},"7e464f21-760d-4682-a6df-f8d89030d519":{"state":"CONNECTED","sinceMs":1788877937597,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"8a7faa73-bf76-4940-9b80-39e95163ffd1":{"state":"CONNECTED","sinceMs":1788877937597,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"91dfbccd-e521-4821-9cdc-3d058a0060e4":{"state":"DISCONNECTED","sinceMs":1788877364084,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877409084,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877409084,"reconnectGrantedAtMs":1788877364084},"9ee591b7-2360-4ea8-ad3b-942ef829fbda":{"state":"DISCONNECTED","sinceMs":1788877696207,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877741207,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877741207,"reconnectGrantedAtMs":1788877696207},"ad7951e6-88d8-4b9e-807c-bd9753790e66":{"state":"DISCONNECTED","sinceMs":1788877846993,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877891993,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877891993,"reconnectGrantedAtMs":1788877846993},"b82cb704-5ea3-469e-b05a-88e768e8834c":{"state":"DISCONNECTED","sinceMs":1788877726298,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877771298,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877771298,"reconnectGrantedAtMs":1788877726298},"d7b99137-4394-41e0-909c-5211c5ad1f20":{"state":"MISSING","sinceMs":1788877937597,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877982597,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877982597,"reconnectGrantedAtMs":1788877937597},"dec9ad0a-55c3-4dfe-9ece-5315f9a44544":{"state":"CONNECTED","sinceMs":1788877937597,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"e8cca6bc-24c0-43ac-9b03-58fe82fd59a1":{"state":"DISCONNECTED","sinceMs":1788877696207,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877741207,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877741207,"reconnectGrantedAtMs":1788877696207}},"pending_deadlines":[{"eventId":"timer_countdown:10000","deadlineMs":1788877946468},{"eventId":"timer_countdown:5000","deadlineMs":1788877951468},{"eventId":"timer_countdown:3000","deadlineMs":1788877953468},{"eventId":"timer_countdown:2000","deadlineMs":1788877954468},{"eventId":"timer_countdown:1000","deadlineMs":1788877955468},{"eventId":"heartbeat_check","deadlineMs":1788877947597}]},{"id":"b563669d-16fe-4d1b-90f3-dde43810aa4d","stage":"preflop","table_id":"fd319d05-3a4b-4032-a8a4-3724652764fa","created_at":"2026-09-08T14:39:03.105196+00:00","state_json":{"pot":26500,"pots":[],"stage":"preflop","players":[{"bet":7500,"seat":1,"cards":[{"rank":"T","suit":"spades"},{"rank":"A","suit":"hearts"}],"stack":40450,"user_id":"7e464f21-760d-4682-a6df-f8d89030d519","is_horse":true,"username":"FloatRanger","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/free_android@2x.webp","deadInvested":0,"equipped_aura":"","totalInvested":7500,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0},{"bet":15000,"seat":3,"cards":[{"rank":"3","suit":"hearts"},{"rank":"6","suit":"diamonds"}],"stack":48888,"user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","is_horse":true,"username":"CallKing","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/vip_artist@2x.webp","deadInvested":4000,"equipped_aura":"","totalInvested":19000,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0}],"sawFlop":false,"minRaise":15000,"lastRaise":15000,"currentBet":15000,"dealerSeat":1,"actionHistory":[],"communityCards":[],"communityCards2":[],"communityCards3":[],"currentPlayerSeat":1,"lastAggressorSeat":-1},"updated_at":"2026-09-08T14:39:03.105196+00:00","config_json":{"ante":2000,"tableId":"fd319d05-3a4b-4032-a8a4-3724652764fa","bigBlind":15000,"bbjConfig":{"feeBB":0.03,"enabled":false,"minPotBB":10,"minPlayersDealt":3},"handNumber":8214017,"rakeConfig":{"cap":0,"percent":0,"noFlopNoDrop":true},"smallBlind":7500,"gameVariant":"nlh"},"dealer_seat":1,"hand_number":8214017,"is_complete":false,"players_json":[{"seat":1,"stack":40450,"user_id":"7e464f21-760d-4682-a6df-f8d89030d519","is_horse":true,"username":"FloatRanger"},{"seat":3,"stack":48888,"user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","is_horse":true,"username":"CallKing"}],"disconnect_states":{"13133bc4-9139-4066-8b55-8edd31ef2318":{"state":"DISCONNECTED","sinceMs":1788878228896,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788878273896,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788878273896,"reconnectGrantedAtMs":1788878228896},"4f0bbf2a-7a7e-43f1-bc19-c0f937419388":{"state":"MISSING","sinceMs":1788878339701,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788878384701,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788878384701,"reconnectGrantedAtMs":1788878339701},"586f1543-8f0b-4486-bde5-cb937657ca30":{"state":"DISCONNECTED","sinceMs":1788877937596,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877982596,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877982596,"reconnectGrantedAtMs":1788877937596},"6258f768-cb01-4edf-9508-a40fedcdd49e":{"state":"DISCONNECTED","sinceMs":1788878339701,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877026849,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877026849,"reconnectGrantedAtMs":1788876981849},"7e464f21-760d-4682-a6df-f8d89030d519":{"state":"CONNECTED","sinceMs":1788878339701,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"8a7faa73-bf76-4940-9b80-39e95163ffd1":{"state":"MISSING","sinceMs":1788878309514,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788878354514,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788878354514,"reconnectGrantedAtMs":1788878309514},"9dc34048-3e89-4d93-8fcb-d3cac17474c5":{"state":"DISCONNECTED","sinceMs":1788878068077,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788878113077,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788878113077,"reconnectGrantedAtMs":1788878068077},"ad7951e6-88d8-4b9e-807c-bd9753790e66":{"state":"DISCONNECTED","sinceMs":1788877816927,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877861927,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877861927,"reconnectGrantedAtMs":1788877816927},"bb01946f-5753-44d8-93f1-5c32062c3d6b":{"state":"DISCONNECTED","sinceMs":1788877515096,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877560096,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877560096,"reconnectGrantedAtMs":1788877515096},"bbca3b33-152a-44da-91f2-d63e5a2354d5":{"state":"DISCONNECTED","sinceMs":1788877515096,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877560096,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877560096,"reconnectGrantedAtMs":1788877515096},"c058ae6e-8331-4d25-8245-4da7fbfa3fd5":{"state":"DISCONNECTED","sinceMs":1788876931625,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788876976625,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788876976625,"reconnectGrantedAtMs":1788876931625},"c2bbe90b-bd79-43a2-8d22-5c60a0ec3855":{"state":"DISCONNECTED","sinceMs":1788878148445,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788878193445,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788878193445,"reconnectGrantedAtMs":1788878148445},"dec9ad0a-55c3-4dfe-9ece-5315f9a44544":{"state":"DISCONNECTED","sinceMs":1788877867162,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877912162,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877912162,"reconnectGrantedAtMs":1788877867162},"e8b32dc2-6c5b-407e-ab46-451422d0a6c5":{"state":"CONNECTED","sinceMs":1788878339701,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false}},"pending_deadlines":[{"eventId":"timer_countdown:5000","deadlineMs":1788878342783},{"eventId":"timer_countdown:3000","deadlineMs":1788878344783},{"eventId":"timer_countdown:2000","deadlineMs":1788878345783},{"eventId":"timer_countdown:1000","deadlineMs":1788878346783},{"eventId":"heartbeat_check","deadlineMs":1788878349701}]},{"id":"e13564aa-fcd9-413b-b4be-f5649f09a134","stage":"preflop","table_id":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","created_at":"2026-09-08T14:27:20.583059+00:00","state_json":{"pot":3250,"pots":[],"stage":"preflop","players":[{"bet":0,"seat":2,"cards":[{"rank":"4","suit":"hearts"},{"rank":"9","suit":"spades"}],"stack":29341,"user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","is_horse":true,"username":"CheckWarden","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/vip_viking_warrior@2x.webp","deadInvested":0,"equipped_aura":"","totalInvested":0,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0},{"bet":0,"seat":3,"cards":[{"rank":"5","suit":"hearts"},{"rank":"8","suit":"clubs"}],"stack":10580,"user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","is_horse":true,"username":"CallKing","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/vip_artist@2x.webp","deadInvested":0,"equipped_aura":"","totalInvested":0,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0},{"bet":0,"seat":6,"cards":[{"rank":"4","suit":"clubs"},{"rank":"6","suit":"hearts"}],"stack":18262,"user_id":"9e5abf96-3fe6-4bd5-8641-d6c95d5b64bf","is_horse":true,"username":"ValueQueen","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/free_cowboy@2x.webp","deadInvested":0,"equipped_aura":"","totalInvested":0,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0},{"bet":750,"seat":7,"cards":[{"rank":"6","suit":"clubs"},{"rank":"T","suit":"clubs"}],"stack":13108,"user_id":"586f1543-8f0b-4486-bde5-cb937657ca30","is_horse":true,"username":"BlockerPhantom","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/vip_fire_demon@2x.webp","deadInvested":0,"equipped_aura":"","totalInvested":750,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0},{"bet":1500,"seat":9,"cards":[{"rank":"J","suit":"clubs"},{"rank":"A","suit":"clubs"}],"stack":21588,"user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","is_horse":true,"username":"CoolerWarden","is_all_in":false,"is_folded":false,"avatar_url":"/avatars/table/vip_pug@2x.webp","deadInvested":1000,"equipped_aura":"","totalInvested":2500,"equipped_frame":"","is_sitting_out":false,"returnedUncalled":0}],"sawFlop":false,"minRaise":1500,"lastRaise":1500,"currentBet":1500,"dealerSeat":6,"actionHistory":[],"communityCards":[],"communityCards2":[],"communityCards3":[],"currentPlayerSeat":2,"lastAggressorSeat":-1},"updated_at":"2026-09-08T14:27:20.583059+00:00","config_json":{"ante":200,"tableId":"fa6d8c35-3f0d-47af-bb85-422aa2869a16","bigBlind":1500,"bbjConfig":{"feeBB":0.03,"enabled":false,"minPotBB":10,"minPlayersDealt":3},"handNumber":8209641,"rakeConfig":{"cap":0,"percent":0,"noFlopNoDrop":true},"smallBlind":750,"gameVariant":"nlh"},"dealer_seat":6,"hand_number":8209641,"is_complete":false,"players_json":[{"seat":2,"stack":29341,"user_id":"7a720598-8e36-48e1-9826-7bc99a81bdb6","is_horse":true,"username":"CheckWarden"},{"seat":3,"stack":10580,"user_id":"e8b32dc2-6c5b-407e-ab46-451422d0a6c5","is_horse":true,"username":"CallKing"},{"seat":6,"stack":18262,"user_id":"9e5abf96-3fe6-4bd5-8641-d6c95d5b64bf","is_horse":true,"username":"ValueQueen"},{"seat":7,"stack":13108,"user_id":"586f1543-8f0b-4486-bde5-cb937657ca30","is_horse":true,"username":"BlockerPhantom"},{"seat":9,"stack":21588,"user_id":"4f0bbf2a-7a7e-43f1-bc19-c0f937419388","is_horse":true,"username":"CoolerWarden"}],"disconnect_states":{"44f1ff92-b5de-44c5-9f7b-319318ff2a74":{"state":"DISCONNECTED","sinceMs":1788877203425,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877248425,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877248425,"reconnectGrantedAtMs":1788877203425},"4f0bbf2a-7a7e-43f1-bc19-c0f937419388":{"state":"CONNECTED","sinceMs":1788877635731,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"586f1543-8f0b-4486-bde5-cb937657ca30":{"state":"CONNECTED","sinceMs":1788877635731,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"7a720598-8e36-48e1-9826-7bc99a81bdb6":{"state":"CONNECTED","sinceMs":1788877635731,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"9e5abf96-3fe6-4bd5-8641-d6c95d5b64bf":{"state":"CONNECTED","sinceMs":1788877635731,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false},"b439692b-fd8f-4a99-85fa-38f37111e733":{"state":"DISCONNECTED","sinceMs":1788877494989,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877539989,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877539989,"reconnectGrantedAtMs":1788877494989},"c1ecb590-e6bb-4a7a-87de-95bb44673efc":{"state":"MISSING","sinceMs":1788877605600,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788877650600,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788877650600,"reconnectGrantedAtMs":1788877605600},"d7b99137-4394-41e0-909c-5211c5ad1f20":{"state":"DISCONNECTED","sinceMs":1788876780592,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":1788876825592,"awayBlindBbCharged":false,"awayBlindSbCharged":false,"reconnectDeadlineMs":1788876825592,"reconnectGrantedAtMs":1788876780592},"e8b32dc2-6c5b-407e-ab46-451422d0a6c5":{"state":"CONNECTED","sinceMs":1788877635731,"strikes":0,"pageLeftAtMs":null,"sitOutOrbits":0,"sitOutReason":null,"sitOutSinceMs":null,"graceDeadlineMs":null,"awayBlindBbCharged":false,"awayBlindSbCharged":false}},"pending_deadlines":[{"eventId":"timer_countdown:5000","deadlineMs":1788877644278},{"eventId":"timer_countdown:3000","deadlineMs":1788877646278},{"eventId":"timer_countdown:2000","deadlineMs":1788877647278},{"eventId":"timer_countdown:1000","deadlineMs":1788877648278},{"eventId":"heartbeat_check","deadlineMs":1788877645731}]}],"original_structure":[{"place":1,"percentage":34.72},{"place":2,"percentage":25},{"place":3,"percentage":18},{"place":4,"percentage":12.96},{"place":5,"percentage":9.32}]}'::jsonb $case$;
REVOKE ALL ON FUNCTION smarter_private.breakfast_retained_case() FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES('fn_complete_breakfast_original_witness','approved','Exact original Breakfast witness; unchanged terminal payers and immutable receipt; no generic adjudication') ON CONFLICT(proname) DO NOTHING;
-- The immutable witness records a failed original request, not a committed hand.
-- Only the exact retained Breakfast case can use this door. Ordinary tournaments
-- retain their existing hand/sequence authority and every financial payer.
CREATE TABLE smarter_private.breakfast_original_witness (
 tournament_id uuid PRIMARY KEY CHECK(tournament_id='f370585d-40ea-4085-bb8f-c7e8c74f3fb4'),
 operation_id uuid NOT NULL UNIQUE,
 expected jsonb NOT NULL,
 expected_hash text NOT NULL CHECK(expected_hash=md5(expected::text)),
 original_archive_sha256 text NOT NULL CHECK(original_archive_sha256='bec825a59f7ced2063d2ddc7c5d1859c30bbd1412178fc6535e25700d525366f'),
 original_line integer NOT NULL CHECK(original_line=164263),
 original_observed_at timestamptz NOT NULL CHECK(original_observed_at='2026-09-08T14:28:11.325815271Z'),
 original_error text NOT NULL CHECK(original_error='TOURNAMENT_SEAT_ROSTER_REQUIRED'),
 original_place integer NOT NULL CHECK(original_place=21),
 original_prize numeric NOT NULL CHECK(original_prize=0),
 target_postimage jsonb NOT NULL,
 admitted_xid bigint NOT NULL DEFAULT txid_current(),
 admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE smarter_private.breakfast_original_witness OWNER TO postgres;
ALTER TABLE smarter_private.breakfast_original_witness ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.breakfast_original_witness FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.breakfast_witness_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'BREAKFAST_ORIGINAL_WITNESS_IMMUTABLE' USING ERRCODE='55000'; END
$body$;
CREATE TRIGGER breakfast_witness_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.breakfast_original_witness FOR EACH ROW
 EXECUTE FUNCTION smarter_private.breakfast_witness_immutable();
CREATE TRIGGER breakfast_witness_no_truncate BEFORE TRUNCATE
 ON smarter_private.breakfast_original_witness FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.breakfast_witness_immutable();
REVOKE ALL ON FUNCTION smarter_private.breakfast_witness_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.breakfast_roster(p_tournament uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',p.id,'user_id',p.user_id,'club_id',p.club_id,'tournament_id',p.tournament_id,
  'status',p.status,'position',p.position,'chips',p.chips,'chip_count',p.chip_count,
  'prize',p.prize,'table_id',p.table_id,'seat_number',p.seat_number,
  'registered_at',p.registered_at,'eliminated_at',p.eliminated_at,
  'elimination_sequence',p.elimination_sequence,'rebuys',p.rebuys,'add_on',p.add_on,
  'rebuy_prompt_until',p.rebuy_prompt_until,'current_bounty',p.current_bounty,
  'bounty_winnings',p.bounty_winnings,'bounties_collected',p.bounties_collected,
  'source_satellite_id',p.source_satellite_id,'is_satellite_qualifier',p.is_satellite_qualifier
 ) ORDER BY p.id),'[]'::jsonb) FROM public.tournament_players p WHERE p.tournament_id=p_tournament
$body$;
REVOKE ALL ON FUNCTION smarter_private.breakfast_roster(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Called after the unchanged cash owner derives/promotes its sole survivor.
-- It authenticates the original 32 standings without fabricating old sequence
-- values or reordering them by later retry timestamps.
CREATE FUNCTION smarter_private.breakfast_standings_witness(p_tournament uuid,p_winner uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE r smarter_private.breakfast_original_witness%ROWTYPE; actual jsonb; original jsonb; target jsonb;
BEGIN
 SELECT * INTO r FROM smarter_private.breakfast_original_witness WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_tournament<>'f370585d-40ea-4085-bb8f-c7e8c74f3fb4'
 OR p_winner<>'ae0bc48d-f98c-4b25-a9fa-e3522f986173'
 OR r.expected_hash IS DISTINCT FROM md5(r.expected::text) THEN
  RAISE EXCEPTION 'BREAKFAST_WITNESS_IDENTITY' USING ERRCODE='P0404'; END IF;
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO original FROM jsonb_array_elements(r.expected->'roster') v
 WHERE v->>'user_id' NOT IN('9ee591b7-2360-4ea8-ad3b-942ef829fbda','ae0bc48d-f98c-4b25-a9fa-e3522f986173');
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO actual FROM jsonb_array_elements(smarter_private.breakfast_roster(p_tournament)) v
 WHERE v->>'user_id' NOT IN('9ee591b7-2360-4ea8-ad3b-942ef829fbda','ae0bc48d-f98c-4b25-a9fa-e3522f986173');
 SELECT v INTO target FROM jsonb_array_elements(smarter_private.breakfast_roster(p_tournament)) v
 WHERE v->>'user_id'='9ee591b7-2360-4ea8-ad3b-942ef829fbda';
 IF jsonb_array_length(original)<>32 OR actual IS DISTINCT FROM original
 OR target IS DISTINCT FROM r.target_postimage
 OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament
  AND user_id=p_winner AND status='winner' AND position=1 AND chips=430255)
 OR (SELECT count(DISTINCT position) FROM public.tournament_players WHERE tournament_id=p_tournament)<>34
 OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament AND (position IS NULL OR position<1 OR position>34)) THEN
  RAISE EXCEPTION 'BREAKFAST_ORIGINAL_STANDINGS_CHANGED' USING ERRCODE='P0404'; END IF;
 RETURN jsonb_build_object('operation_id',r.operation_id,'expected_hash',r.expected_hash,
  'archive_sha256',r.original_archive_sha256,'original_line',r.original_line,
  'original_place',r.original_place,'original_prize',r.original_prize,
  'original_outcome','failed_request','admitted_at',r.admitted_at);
END $body$;
REVOKE ALL ON FUNCTION smarter_private.breakfast_standings_witness(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_complete_breakfast_original_witness(p_operation_id uuid,p_expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private
SET statement_timeout='30s' SET lock_timeout='3s' AS $body$
DECLARE
 t constant uuid:='f370585d-40ea-4085-bb8f-c7e8c74f3fb4';
 u constant uuid:='9ee591b7-2360-4ea8-ad3b-942ef829fbda';
 survivor constant uuid:='ae0bc48d-f98c-4b25-a9fa-e3522f986173';
 v_original jsonb; v_current jsonb; v_token uuid; v_result jsonb; v_reprice jsonb;
 v_receipt smarter_private.breakfast_original_witness%ROWTYPE;
 v_t public.tournaments%ROWTYPE; v_entry public.tournament_entry_close_receipts%ROWTYPE;
 v_structure jsonb; v_target jsonb; v_old_seats jsonb; v_old_snapshots jsonb;
BEGIN
 IF public.fn_caller_is_engine() IS DISTINCT FROM true THEN RAISE EXCEPTION 'service authority required' USING ERRCODE='28000'; END IF;
 IF p_operation_id IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'BREAKFAST_REQUEST_REQUIRED' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_ca_lock_settlement_lane_for_finish(t);
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT * INTO v_t FROM public.tournaments WHERE id=t FOR UPDATE;
 SELECT * INTO v_receipt FROM smarter_private.breakfast_original_witness WHERE tournament_id=t;
 IF FOUND THEN
  IF v_receipt.operation_id IS DISTINCT FROM p_operation_id OR v_receipt.expected IS DISTINCT FROM p_expected THEN
   RAISE EXCEPTION 'BREAKFAST_REPLAY_MISMATCH' USING ERRCODE='40001'; END IF;
  v_result:=public.fn_ca_tournament_terminal_receipt(t,survivor);
  IF (SELECT cash_receipt->'original_witness' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
    IS DISTINCT FROM smarter_private.breakfast_standings_witness(t,survivor) THEN
   RAISE EXCEPTION 'BREAKFAST_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
  RETURN v_result;
 END IF;
 IF v_t.id IS NULL OR v_t.status<>'RUNNING' OR v_t.club_id<>'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
 OR v_t.prize_pool IS DISTINCT FROM 153::numeric OR v_t.total_rake IS DISTINCT FROM 17::numeric
 OR v_t.bounty_pool IS DISTINCT FROM 0::numeric OR v_t.current_players<>2
 OR v_t.prize_pool_finalized IS DISTINCT FROM true OR v_t.entry_contract_locked IS DISTINCT FROM true
 OR coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false) OR coalesce(v_t.is_mystery_bounty,false)
 OR coalesce(v_t.bubble_protection,false) OR v_t.tournament_type IS DISTINCT FROM 'MTT'
 OR v_t.starting_chips IS DISTINCT FROM 12000 OR v_t.satellite_target_id IS NOT NULL THEN
  RAISE EXCEPTION 'BREAKFAST_EVENT_CHANGED' USING ERRCODE='40001'; END IF;
 -- The old snapshot manager is still present. Lock its actual current identity;
 -- expiry/heartbeat are liveness fields, never absence or historical authority.
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE;
 SELECT coalesce(jsonb_agg(to_jsonb(l)-ARRAY['heartbeat_at','acquired_at'] ORDER BY lease_generation),'[]') INTO v_current
 FROM public.engine_tournament_leases l WHERE tournament_id=t;
 IF v_current IS DISTINCT FROM p_expected->'manager' THEN RAISE EXCEPTION 'BREAKFAST_MANAGER_CHANGED' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tournament_obligations WHERE tournament_id=t ORDER BY kind,place,id FOR UPDATE;
 PERFORM 1 FROM public.tournament_payouts WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=t ORDER BY s.id FOR UPDATE OF s;
 SELECT * INTO v_entry FROM public.tournament_entry_close_receipts WHERE tournament_id=t FOR UPDATE;
 v_original:=smarter_private.breakfast_retained_case();
 IF smarter_private.breakfast_roster(t) IS DISTINCT FROM v_original->'roster'
 OR p_expected->'roster' IS DISTINCT FROM v_original->'roster'
 OR to_jsonb(v_entry) IS DISTINCT FROM v_original->'entry'
 OR to_jsonb(v_entry) IS DISTINCT FROM p_expected->'entry'
 OR public.fn_safe_jsonb_array(v_t.payout_structure::text) IS DISTINCT FROM v_entry.payout_structure_snapshot
 OR v_entry.reprice_completed_at IS NOT NULL THEN
  RAISE EXCEPTION 'BREAKFAST_ORIGINAL_ROSTER_OR_ENTRY_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') INTO v_current FROM public.tournament_payouts p WHERE tournament_id=t;
 IF v_current IS DISTINCT FROM v_original->'payouts' THEN RAISE EXCEPTION 'BREAKFAST_PAID_EVIDENCE_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]') INTO v_current FROM public.tournament_obligations o WHERE tournament_id=t;
 IF v_current IS DISTINCT FROM v_original->'obligations' THEN RAISE EXCEPTION 'BREAKFAST_OBLIGATIONS_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY key),'[]') INTO v_current FROM public.wallet_credit_idempotency k WHERE key LIKE 'tourney:'||t||':%';
 IF v_current IS DISTINCT FROM v_original->'wallet_keys' THEN RAISE EXCEPTION 'BREAKFAST_CREDIT_EVIDENCE_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_current FROM public.rake_records r WHERE tournament_id=t;
 IF v_current IS DISTINCT FROM v_original->'fee_charges' THEN RAISE EXCEPTION 'BREAKFAST_FEE_CHARGE_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') INTO v_old_seats FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=t;
 IF v_old_seats IS DISTINCT FROM v_original->'seats' OR v_old_seats IS DISTINCT FROM p_expected->'seats'
 OR (SELECT count(*) FROM public.tables WHERE tournament_id=t)<>4
 OR (SELECT count(*) FROM public.tables WHERE tournament_id=t AND status='running')<>1
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id='dd835bad-d3c8-4984-ab2f-5ed52d1fb664' AND tournament_id=t AND status='running' AND f06_lifecycle=9657) THEN
  RAISE EXCEPTION 'BREAKFAST_PHYSICAL_ROSTER_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') INTO v_old_snapshots FROM public.hand_state_snapshots s
 WHERE NOT is_complete AND table_id IN(SELECT id FROM public.tables WHERE tournament_id=t);
 -- Three unchanged Sept8 snapshots belong to CLOSED tables. They remain
 -- unfinished historical evidence. This operation never completes/clears them.
 IF v_old_snapshots IS DISTINCT FROM v_original->'historical_snapshots'
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots s JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=t AND NOT s.is_complete AND tb.status<>'closed')
 OR EXISTS(SELECT 1 FROM public.engine_table_leases l JOIN public.tables tb ON tb.id=l.table_id WHERE tb.tournament_id=t)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a JOIN public.tables tb ON tb.id=a.table_id WHERE tb.tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=t) THEN
  RAISE EXCEPTION 'BREAKFAST_LATER_AUTHORITY_OR_HAND_STATE' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=t
  AND e.gross_in=170 AND e.fee_entries_in=17 AND e.prize_out=99.88
  AND e.prize_balance=53.12 AND e.fee_balance=17 AND e.bounty_balance=0
  AND e.refund_prize=0 AND e.refund_fee=0 AND e.refund_bounty=0
  AND e.fee_out=0 AND e.bounty_out=0 AND e.reserve_in=0 AND e.reserve_out=0
  AND e.overlay_in=0 AND e.satellite_in=0 AND e.satellite_fee_in=0
  AND e.closed_at IS NULL) THEN
  RAISE EXCEPTION 'BREAKFAST_FUNDING_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT public.fn_safe_jsonb_array((p.payout_structure->>'payout_structure')) INTO v_structure FROM public.tournament_payouts p WHERE tournament_id=t ORDER BY id LIMIT 1;
 IF v_structure IS DISTINCT FROM v_original->'original_structure'
 OR EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE tournament_id=t AND public.fn_safe_jsonb_array(p.payout_structure->>'payout_structure') IS DISTINCT FROM v_structure) THEN
  RAISE EXCEPTION 'BREAKFAST_ORIGINAL_PAID_CONTRACT_CONFLICT' USING ERRCODE='P0404'; END IF;
 v_token:=public.fn_ca_open_tournament_seat_exit_authority(t,'elimination',u);
 UPDATE public.table_seats SET left_at=clock_timestamp(),status='left',active_game_scope=NULL,active_parent_key=NULL,
  leave_pending=false,is_sitting_out=false,is_away=false
 WHERE id='41cef73d-6c47-4241-a2da-9ed9572059ad' AND user_id=u AND left_at IS NULL AND stack=0;
 IF NOT FOUND THEN RAISE EXCEPTION 'BREAKFAST_ZERO_SEAT_EXIT_LOST' USING ERRCODE='40001'; END IF;
 UPDATE public.tournament_players SET status='eliminated',position=21,prize=0,eliminated_at=clock_timestamp(),table_id=NULL,seat_number=NULL
 WHERE id='e49fdaa8-3f02-44e3-9f40-59cfbb18f1b9' AND user_id=u AND status='playing' AND chips=0 AND position IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'BREAKFAST_ORIGINAL_RANK_LOST' USING ERRCODE='40001'; END IF;
 PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,true);
 SELECT v INTO v_target FROM jsonb_array_elements(smarter_private.breakfast_roster(t)) v WHERE v->>'user_id'=u::text;
 INSERT INTO smarter_private.breakfast_original_witness(tournament_id,operation_id,expected,expected_hash,
 original_archive_sha256,original_line,original_observed_at,original_error,original_place,original_prize,target_postimage)
 VALUES(t,p_operation_id,p_expected,md5(p_expected::text),
 'bec825a59f7ced2063d2ddc7c5d1859c30bbd1412178fc6535e25700d525366f',164263,
 '2026-09-08T14:28:11.325815271Z','TOURNAMENT_SEAT_ROSTER_REQUIRED',21,0,v_target);
 UPDATE public.tournaments SET payout_structure=v_structure::text,current_players=1 WHERE id=t;
 UPDATE public.tournament_entry_close_receipts SET payout_structure_snapshot=v_structure,updated_at=clock_timestamp() WHERE tournament_id=t;
 v_reprice:=public.fn_complete_tournament_entry_reprice(t);
 IF (v_reprice->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'BREAKFAST_REPRICE_REFUSED: %',v_reprice USING ERRCODE='P0404'; END IF;
 -- This unchanged authority derives its sole survivor, pays only the remaining
 -- 53.12, and preserves unresolved original fees through its explicit v3
 -- custody contract. Failure rolls back the new rank, contract, witness and
 -- every attempted payment together.
 v_result:=public.fn_complete_tournament_terminal(t,survivor,'places');
 IF (SELECT cash_receipt->'original_witness' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
  IS DISTINCT FROM smarter_private.breakfast_standings_witness(t,survivor) THEN
  RAISE EXCEPTION 'BREAKFAST_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
 IF (v_result->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'BREAKFAST_TERMINAL_REFUSED: %',v_result USING ERRCODE='P0404'; END IF;
 IF (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM public.hand_state_snapshots s WHERE NOT is_complete AND table_id IN(SELECT id FROM public.tables WHERE tournament_id=t)) IS DISTINCT FROM v_old_snapshots THEN
  RAISE EXCEPTION 'BREAKFAST_HISTORICAL_SNAPSHOT_CHANGED' USING ERRCODE='P0404'; END IF;
 RETURN v_result;
END $body$;
REVOKE ALL ON FUNCTION public.fn_complete_breakfast_original_witness(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_breakfast_original_witness(uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_status text;
  v_live_count integer;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric := 0;
  v_bubble_payout_count integer := 0;
  v_bubble_paid numeric := 0;
  v_bubble_ob_count integer := 0;
  v_bubble_ob public.tournament_obligations%ROWTYPE;
  v_bubble_result jsonb;
  v_winner public.tournament_players%ROWTYPE;
  v_row record;
  v_place integer;
  v_amount numeric;
  v_user_id uuid;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_total_expected numeric := 0;
  v_winner_amount numeric := 0;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_rows integer;
  v_unwitnessed_busts integer;
  v_misplaced_busts integer;
  v_original_witness jsonb;
BEGIN
  -- Every rolling and terminal money authority enters one transaction lane
  -- before it can own an event, obligation, bank, or recipient row.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'place settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical lock order. Re-locks inside owner-only callees are rows already
  -- owned by this transaction and therefore cannot invert a wait dependency.
  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_status := upper(COALESCE(v_t.status,''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not an ordinary cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id
                AND lower(COALESCE(p.source,'')) = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RAISE EXCEPTION
      'tournament % carries final-table-deal evidence; use the deal authority',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Funding the advertised guarantee is part of this settlement transaction,
  -- not a best-effort request made by the game process immediately beforehand.
  -- fn_apply_prize_guarantee re-locks the row already owned here and either
  -- debits the event-owned bank plus finalizes the pool, or raises. Prove its
  -- receipt against the refreshed row before deriving even the first place; a
  -- refusal therefore rolls back the overlay, every payout and the finish.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_places');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'registered') THEN
    RAISE EXCEPTION 'tournament % still has a registered unresolved player',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- The helper counts the final field, so derive only after the complete
  -- roster has joined the canonical tournament -> roster lock sequence.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty ladder', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_live_count FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'tournament % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    -- The observed last survivor may already have crossed through
    -- `eliminated` in an all-in race. The committed transition sequence, not
    -- a wall clock, proves that this row was the final elimination.
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'tournament % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
              OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'observed winner % does not match locked winner % for tournament %',
      p_observed_winner_id, v_winner.user_id, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  -- Lock the whole set once, before validation or the ascending-place walk.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (o.place IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = o.place))
  ) THEN
    RAISE EXCEPTION
      'tournament % has a place obligation outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  IF v_status = 'COMPLETED' THEN
    IF v_winner.status::text <> 'winner' OR v_winner.position <> 1 THEN
      RAISE EXCEPTION
        'COMPLETED tournament % is not an exact replay: winner is not durable',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Recorded finish positions are the engine's live witness. Never rebuild
    -- an all-busted field from timestamps. Promotion may fill first place, but
    -- it cannot displace another recorded first or vacate a ladder place.
    IF EXISTS (SELECT 1 FROM public.tournament_players tp
                WHERE tp.tournament_id = p_tournament_id
                  AND tp.position = 1
                  AND tp.user_id <> v_winner.user_id) THEN
      RAISE EXCEPTION 'tournament % assigns first place to another player',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF v_winner.position IS NOT NULL AND v_winner.position <> 1
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder) a
                    WHERE (a->>'place')::integer = v_winner.position) THEN
      RAISE EXCEPTION
        'promoting winner % would vacate cash place % in tournament %',
        v_winner.user_id, v_winner.position, p_tournament_id
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournament_players
       SET status = 'winner', position = 1,
           eliminated_at = NULL, elimination_sequence = NULL
     WHERE id = v_winner.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament % could not promote exactly one winner',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    v_original_witness:=smarter_private.breakfast_standings_witness(p_tournament_id,p_observed_winner_id);
    IF v_original_witness IS NULL THEN
    -- Final numeric positions are derived from the transition witness, not
    -- from the field size that happened to exist when each player busted.
    -- This is the root fix for late registration enlarging the field after an
    -- early elimination. Existing money evidence is never relabelled: a
    -- legacy event whose paid place would move fails closed for explicit
    -- adjudication instead of rewriting settled history.
    SELECT count(*), count(tp.elimination_sequence),
           count(DISTINCT tp.elimination_sequence)
      INTO v_eliminated_count, v_sequenced_count, v_rows
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    IF v_eliminated_count <> v_field_size - 1
       OR v_sequenced_count <> v_eliminated_count
       OR v_rows <> v_eliminated_count THEN
      RAISE EXCEPTION
        'tournament % has no complete durable elimination sequence (%/% of %)',
        p_tournament_id, v_sequenced_count, v_rows, v_eliminated_count
        USING ERRCODE = 'P0404';
    END IF;

    /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). Places were
       numbered in elimination_sequence order, which a trigger stamps when
       the knockout door RECORDS a bust, so a bust the door recorded hours
       late was paid a place it did not finish in. Each eliminated row is now
       ranked by when its bust happened, derived in the statement that uses
       it from what the door proved: the commit time of the accepted hand of
       the player's latest 'eliminated' knockout generation, plus one
       microsecond per earlier rank in that hand (smaller hand-start stack
       first, then user id - the rule the door stamps eliminated_at with).
       Busts in different hands are ordered by those hands' commit times.
       The hand-history prune deletes a horse-only hand's commit row after
       its retention window, and only a PENDING generation protects it; the
       generation rows themselves are never pruned, so a hand whose commit
       is gone is timed by when its first generation was captured (the
       earliest created_at of that hand's generations, written before the
       commit) - one time for the whole hand, so the same-hand stack rank
       still decides within it - never by when a bust was recorded. A row
       with no such witness keeps its eliminated_at; a row with neither is
       refused, never guessed. Equal times fall back to
       elimination_sequence, then id. elimination_sequence alone still names
       the last elimination, and so the winner, above. The same order decides
       whether anything moves, so a ladder already in true order is left
       exactly as it is. */
    WITH busts AS (
      SELECT tp.id, tp.position, tp.elimination_sequence,
             COALESCE((
               SELECT COALESCE(a.committed_at,
                               (SELECT min(g.created_at)
                                  FROM public.tournament_knockout_candidates g
                                 WHERE g.tournament_id = c.tournament_id
                                   AND g.table_id = c.table_id
                                   AND g.hand_number = c.hand_number
                                   AND g.hand_id = c.hand_id))
                      + (SELECT count(*)
                           FROM public.tournament_knockout_candidates s
                          WHERE s.tournament_id = c.tournament_id
                            AND s.table_id = c.table_id
                            AND s.hand_number = c.hand_number
                            AND s.hand_id = c.hand_id
                            AND (s.stack_before, s.eliminated_user_id)
                                < (c.stack_before, c.eliminated_user_id))::integer
                        * interval '1 microsecond'
                 FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                              k.hand_id, k.stack_before, k.eliminated_user_id
                         FROM public.tournament_knockout_candidates k
                        WHERE k.tournament_id = tp.tournament_id
                          AND k.eliminated_user_id = tp.user_id
                          AND k.state = 'eliminated'
                        ORDER BY k.hand_number DESC, k.id DESC
                        LIMIT 1) c
                 LEFT JOIN public.hand_atomic_commits a
                   ON a.table_id = c.table_id
                  AND a.hand_number = c.hand_number
                  AND a.hand_id = c.hand_id
             ), tp.eliminated_at) AS bust_at
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ),
    ranked AS (
      SELECT b.id, b.position, b.bust_at,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS expected_position
        FROM busts b
    )
    SELECT count(*) FILTER (WHERE ranked.bust_at IS NULL),
           count(*) FILTER (WHERE ranked.position IS DISTINCT FROM ranked.expected_position)
      INTO v_unwitnessed_busts, v_misplaced_busts
      FROM ranked;
    IF v_unwitnessed_busts > 0 THEN
      RAISE EXCEPTION
        'tournament % has % eliminated player(s) with no bust witness and no eliminated_at',
        p_tournament_id, v_unwitnessed_busts USING ERRCODE = 'P0404';
    END IF;

    IF v_misplaced_busts > 0 THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p."position" IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'place'
      ) THEN
        /* Paid places are never relabelled. A COMPLETING event whose
           places are exactly the recording-order ladder was settled by the
           rule this replaces, and is replayed as it was paid, not refused. */
        IF v_status <> 'COMPLETING' OR EXISTS (
          SELECT 1
            FROM (
              SELECT tp.position,
                     row_number() OVER (
                       ORDER BY tp.elimination_sequence DESC, tp.id ASC
                     )::integer + 1 AS expected_position
                FROM public.tournament_players tp
               WHERE tp.tournament_id = p_tournament_id
                 AND tp.status::text = 'eliminated'
            ) recorded
           WHERE recorded.position IS DISTINCT FROM recorded.expected_position
        ) THEN
          RAISE EXCEPTION
            'tournament % needs a late-entry position normalization but already carries settled place evidence',
            p_tournament_id USING ERRCODE = 'P0404';
        END IF;
      ELSE
        UPDATE public.tournament_players tp
           SET position = NULL
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated';

        WITH busts AS (
        SELECT tp.id, tp.position, tp.elimination_sequence,
               COALESCE((
                 SELECT COALESCE(a.committed_at,
                                 (SELECT min(g.created_at)
                                    FROM public.tournament_knockout_candidates g
                                   WHERE g.tournament_id = c.tournament_id
                                     AND g.table_id = c.table_id
                                     AND g.hand_number = c.hand_number
                                     AND g.hand_id = c.hand_id))
                        + (SELECT count(*)
                             FROM public.tournament_knockout_candidates s
                            WHERE s.tournament_id = c.tournament_id
                              AND s.table_id = c.table_id
                              AND s.hand_number = c.hand_number
                              AND s.hand_id = c.hand_id
                              AND (s.stack_before, s.eliminated_user_id)
                                  < (c.stack_before, c.eliminated_user_id))::integer
                          * interval '1 microsecond'
                   FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                                k.hand_id, k.stack_before, k.eliminated_user_id
                           FROM public.tournament_knockout_candidates k
                          WHERE k.tournament_id = tp.tournament_id
                            AND k.eliminated_user_id = tp.user_id
                            AND k.state = 'eliminated'
                          ORDER BY k.hand_number DESC, k.id DESC
                          LIMIT 1) c
                   LEFT JOIN public.hand_atomic_commits a
                     ON a.table_id = c.table_id
                    AND a.hand_number = c.hand_number
                    AND a.hand_id = c.hand_id
               ), tp.eliminated_at) AS bust_at
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated'
        ),
        ranked AS (
          SELECT b.id,
                 row_number() OVER (
                   ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
                 )::integer + 1 AS expected_position
            FROM busts b
        )
        UPDATE public.tournament_players tp
           SET position = ranked.expected_position
          FROM ranked
         WHERE tp.id = ranked.id;
      END IF;
    END IF;
    END IF;
  END IF;

  -- Derive the single pool-funded bubble promise after standings are final.
  -- The percentage helper has already reserved this exact amount from its
  -- ladder. Satellites never enter this authority: their bubble is paid the
  -- residual that cannot buy a full seat by the satellite settle path.
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF COALESCE(v_t.bubble_protection, false)
     AND v_bubble_place IS NOT NULL
     AND v_bubble_place <= v_field_size THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_t.prize_pool THEN
      RAISE EXCEPTION 'tournament % bubble amount % exceeds pool %',
        p_tournament_id, v_bubble_amount, v_t.prize_pool
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*), min(tp.user_id::text)::uuid
      INTO v_rows, v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.status::text = 'eliminated';
    IF v_rows <> 1 OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no single eliminated stone bubble at place %',
        p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_bubble_payout_count, v_bubble_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  SELECT count(*) INTO v_bubble_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';

  IF v_bubble_amount = 0 THEN
    IF v_bubble_payout_count <> 0 OR v_bubble_paid <> 0
       OR v_bubble_ob_count <> 0 THEN
      RAISE EXCEPTION 'tournament % carries bubble evidence but no bubble is due',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_bubble_paid > v_bubble_amount
       OR EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND (p.user_id IS DISTINCT FROM v_bubble_user_id
              OR p."position" IS NOT NULL
              OR p.amount IS NULL
              OR p.amount::text IN ('NaN','Infinity','-Infinity')
              OR p.amount <= 0
              OR p.amount IS DISTINCT FROM round(p.amount, 2)
              OR p.idempotency_key IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM public.wallet_credit_idempotency k
                 WHERE k.key = p.idempotency_key
                   AND k.user_id = p.user_id
                   AND k.amount = p.amount))) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_bubble_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.user_id = v_bubble_user_id;
    IF v_bubble_ob_count > 0
       AND (v_bubble_ob_count <> 1 OR v_bubble_ob.id IS NULL
         OR v_bubble_ob.place IS NOT NULL
         OR v_bubble_ob.amount_owed IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_paid
         OR v_bubble_ob.amount_paid < 0
         OR v_bubble_ob.amount_paid > v_bubble_ob.amount_owed
         OR (v_bubble_ob.amount_paid = v_bubble_ob.amount_owed) IS DISTINCT FROM
            (v_bubble_ob.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_bubble_ob_count = 0
       AND (v_bubble_payout_count <> 0 OR v_bubble_paid <> 0) THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_status = 'COMPLETED'
       AND (v_bubble_ob_count <> 1
         OR v_bubble_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.settled_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = v_bubble_user_id
              AND tp.position = v_bubble_place
              AND tp.prize IS NOT DISTINCT FROM v_bubble_amount)) THEN
      RAISE EXCEPTION 'COMPLETED tournament % has no exact bubble replay',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  END IF;

  -- Anything paid from the prize bank outside the derived ladder makes a full
  -- structure payout unsafe. Bounty/seat sources belong to other authorities.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND COALESCE(p.source,'') NOT IN
           ('bounty','own_bounty','mystery_bounty','mystery_bounty_residual',
            'bounty_residual','satellite_seat','bubble_protection')
       AND (p."position" IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = p."position"))
  ) THEN
    RAISE EXCEPTION 'tournament % has prize evidence outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Obligation-shaped wallet identity with no exact payout row is mixed
  -- evidence. It is checked globally before any place can move.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id AND p.amount = k.amount)
  ) THEN
    RAISE EXCEPTION
      'tournament % has wallet-credit identity without payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Preflight every place before settling the first one.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    v_place := v_row.place; v_amount := v_row.amount; v_user_id := v_row.user_id;
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no finisher for cash place %',
        p_tournament_id, v_place USING ERRCODE = '23502';
    END IF;
    IF v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount < 0
       OR v_amount IS DISTINCT FROM round(v_amount,2) THEN
      RAISE EXCEPTION 'tournament % derived invalid amount % for place %',
        p_tournament_id, v_amount, v_place USING ERRCODE = '22003';
    END IF;
    v_total_expected := v_total_expected + v_amount;
    IF v_place = 1 THEN v_winner_amount := v_amount; END IF;
    IF v_status = 'COMPLETED'
       AND v_row.cached_prize IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION
        'COMPLETED tournament %, place % has stale prize cache % (expected %)',
        p_tournament_id, v_place, v_row.cached_prize, v_amount
        USING ERRCODE = '55000';
    END IF;

    -- Each payout row is also required to name an exact wallet-credit identity.
    IF EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id AND p."position" = v_place
         AND (p.user_id IS DISTINCT FROM v_user_id OR p.amount IS NULL
           OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount < 0
           OR p.amount IS DISTINCT FROM round(p.amount,2)
           OR p.idempotency_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key AND k.user_id = p.user_id
                AND k.amount = p.amount))
    ) THEN
      RAISE EXCEPTION
        'tournament %, place % has mixed/malformed/wrong-recipient evidence',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*), COALESCE(sum(p.amount),0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p."position" = v_place;
    v_evidence := round(v_evidence,2);
    IF v_evidence > v_amount THEN
      RAISE EXCEPTION 'tournament %, place % records % above entitlement %',
        p_tournament_id, v_place, v_evidence, v_amount USING ERRCODE = '23514';
    END IF;

    v_ob := NULL;
    SELECT * INTO v_ob FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = v_place;
    IF FOUND THEN
      IF v_ob.user_id IS DISTINCT FROM v_user_id OR v_ob.amount_owed IS NULL
         OR v_ob.amount_paid IS NULL
         OR v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_owed IS DISTINCT FROM round(v_ob.amount_owed,2)
         OR v_ob.amount_paid IS DISTINCT FROM round(v_ob.amount_paid,2)
         OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
         OR v_ob.amount_paid > v_ob.amount_owed
         OR v_ob.amount_owed > v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_evidence THEN
        RAISE EXCEPTION 'tournament %, place % has incompatible obligation',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_amount = 0 THEN
      -- Zero-valued ladder places are standings, not debts.
      IF v_evidence <> 0 OR (v_ob.id IS NOT NULL
         AND (v_ob.amount_owed <> 0 OR v_ob.amount_paid <> 0)) THEN
        RAISE EXCEPTION 'zero-value place % in tournament % carries money evidence',
          v_place, p_tournament_id USING ERRCODE = '23514';
      END IF;
    ELSIF v_status = 'COMPLETED' THEN
      IF v_ob.id IS NULL OR v_ob.amount_owed IS DISTINCT FROM v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_amount
         OR v_evidence IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'COMPLETED tournament %, place % is not an exact replay',
          p_tournament_id, v_place USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;

  IF round(v_total_expected + v_bubble_amount, 2)
       IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % ladder % plus bubble % does not equal locked pool %',
      p_tournament_id, v_total_expected, v_bubble_amount, v_t.prize_pool
      USING ERRCODE = '23514';
  END IF;

  IF v_status <> 'COMPLETED' THEN
    -- Materialize the bubble and the entire positive ladder before the first
    -- wallet credit. The payment walk is driven from one complete locked debt
    -- set, so failure on any recipient rolls every obligation and credit back.
    IF v_bubble_amount > 0 AND v_bubble_ob_count = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
      VALUES
        (p_tournament_id,'bubble_protection',NULL,v_bubble_user_id,
         v_bubble_amount,0,'engine.fn_settle_tournament_places',NULL)
      RETURNING * INTO v_bubble_ob;
      v_bubble_ob_count := 1;
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place;

      IF v_original_witness IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id=p_tournament_id AND o.kind='place' AND o.place=v_row.place
        AND o.amount_owed=v_row.amount AND o.amount_paid=v_row.amount AND o.settled_at IS NOT NULL) THEN
        v_rows:=1; -- Preserve already-paid original obligation metadata.
      ELSE
      UPDATE public.tournament_obligations o
         SET amount_owed = v_row.amount,
             source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
             updated_at = now()
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      END IF;
      IF v_rows = 0 THEN
        INSERT INTO public.tournament_obligations
          (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
        VALUES
          (p_tournament_id,'place',v_row.place,v_row.user_id,v_row.amount,
           v_evidence,'engine.fn_settle_tournament_places',
           CASE WHEN v_evidence = v_row.amount THEN now() ELSE NULL END);
      ELSIF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament %, place % matched % obligations',
          p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
      END IF;
    END LOOP;

    -- Re-lock/prove the complete set immediately before any raw payer runs.
    PERFORM 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind IN ('bubble_protection','place')
     ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

    IF v_bubble_amount > 0 THEN
      v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
        p_tournament_id, v_bubble_user_id, v_bubble_amount);
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      v_result := public.fn_ca_settle_tournament_place_raw(
        p_tournament_id,v_row.place,v_row.user_id,v_row.amount);
      IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'tournament %, place % returned a partial settlement',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    -- tournament_players.prize is presentation cache, stamped only from the
    -- successfully settled DB ladder and in this same transaction.
    UPDATE public.tournament_players SET prize = 0
     WHERE tournament_id = p_tournament_id;
    FOR v_row IN SELECT (a->>'place')::integer AS place,
                         (a->>'amount')::numeric AS amount
                   FROM jsonb_array_elements(v_ladder) a
    LOOP
      UPDATE public.tournament_players SET prize = v_row.amount
       WHERE tournament_id = p_tournament_id AND position = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'could not stamp one prize cache for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    IF v_bubble_amount > 0 THEN
      UPDATE public.tournament_players
         SET prize = v_bubble_amount
       WHERE tournament_id = p_tournament_id
         AND user_id = v_bubble_user_id
         AND position = v_bubble_place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION
          'could not stamp one bubble prize cache for tournament %, place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_status = 'RUNNING' THEN
      UPDATE public.tournaments SET status = 'COMPLETING'
       WHERE id = p_tournament_id AND status = 'RUNNING';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament % lost its RUNNING finish claim',
          p_tournament_id USING ERRCODE = '40001';
      END IF;
      v_status := 'COMPLETING';
    END IF;
  END IF;

  IF v_bubble_amount > 0 AND v_status = 'COMPLETED' THEN
    -- Exact replay only: the completed preflight above proved this call cannot
    -- move money, while the raw helper proves every durable receipt again.
    v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
  END IF;

  IF v_bubble_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = v_bubble_user_id
       AND tp.position = v_bubble_place
       AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
  ) THEN
    RAISE EXCEPTION
      'post-settlement bubble prize-cache proof failed for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;

  -- Prove the durable end-state and build the presentation-only receipt.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    IF v_row.cached_prize IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'post-settlement prize-cache proof failed for tournament %, place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
    IF v_row.amount > 0 THEN
      v_ob := NULL;
      SELECT * INTO v_ob FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place AND p.user_id = v_row.user_id;
      IF v_ob.id IS NULL OR v_ob.user_id IS DISTINCT FROM v_row.user_id
         OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
         OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
         OR v_evidence IS DISTINCT FROM v_row.amount THEN
        RAISE EXCEPTION 'post-settlement proof failed for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END IF;
    v_payouts := v_payouts || jsonb_build_object(
      'place',v_row.place,'user_id',v_row.user_id,'amount',v_row.amount);
  END LOOP;

  v_original_witness:=smarter_private.breakfast_standings_witness(p_tournament_id,p_observed_winner_id);
  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status',v_status,
    'payouts',v_payouts,
    'bubble_protection',CASE WHEN v_bubble_amount > 0 THEN
      jsonb_build_object('user_id',v_bubble_user_id,'position',v_bubble_place,
                         'amount',v_bubble_amount)
      ELSE 'null'::jsonb END,
    'winner_amount',v_winner_amount) || CASE WHEN v_original_witness IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('original_witness',v_original_witness) END;
END;
$function$
;
COMMIT;
