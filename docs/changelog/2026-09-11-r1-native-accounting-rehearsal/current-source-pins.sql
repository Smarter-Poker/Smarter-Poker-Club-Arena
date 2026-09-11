-- Exact currently-installed financial source pins. Read-only guard.
DO $pins$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES
('fn_settle_tournament_places(uuid,uuid)','6181734ff98555ecc04648186f6ebf24'),
('fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)','9447da284f1a3beb6d51dd87151c080f'),
('fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)','97abb184dc27e3c7a333a6160636f473'),
('fn_normalize_tournament_final_standings(uuid)','45b06c3f8be02940d130c427d5a32519'),
('fn_prepare_tournament_place_obligations(uuid,text)','ca0abbc6d297f3009143676261d8cf19'),
('fn_complete_tournament_terminal(uuid,uuid,text)','96a61ea5e16560735bcb70b355aa79ab'),
('fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','90f7506df2f1a94fe22952714fcd9f85'),
('fn_ca_latest_committed_knockout_candidate(uuid,uuid)','0602827901be20bbb6e0dce6ece17f94'),
('fn_emit_tournament_manager_wake(uuid,text)','bc71b7d556d72d7d85c7fb2f0ea22406'),
('fn_settle_tournament_rake(uuid,text)','be08a61e1a867519048c4692b41ab1fd'),
('fn_credit_player_wallet_once(uuid,numeric,text)','563d773ceb906695c150e9ced48db772')) AS expected(signature,body_md5) LOOP
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(r.signature)) IS DISTINCT FROM r.body_md5 THEN
 RAISE EXCEPTION 'current financial source pin changed: %',r.signature; END IF;
 END LOOP;
 IF (SELECT array_agg(tgname ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND NOT tgisinternal AND tgenabled='D') IS DISTINCT FROM ARRAY['aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion','zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate']::name[] THEN
 RAISE EXCEPTION 'installed guard generation changed; rerun the current-state rehearsal'; END IF;
END $pins$;
