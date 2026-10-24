CREATE UNIQUE INDEX cash_games_one_per_key ON cash_games(club_id,variant,sb,bb,template_name) WHERE enabled AND must_move;
ALTER TABLE tables ADD CONSTRAINT tables_dealing_halt_is_explained CHECK (
 ((dealing_halted_at IS NULL) AND (dealing_halted_reason IS NULL)) OR
 ((dealing_halted_at IS NOT NULL) AND (dealing_halted_reason IS NOT NULL)
 AND dealing_halted_reason=ANY(ARRAY['lightning_pending_on'::text,'lightning'::text])));
CREATE TABLE cash_game_waitlist(game_id uuid,user_id uuid,status text,updated_at timestamptz);
INSERT INTO cash_games(id,club_id,template_name,variant,sb,bb,ruleset_snapshot,name,cluster_mode,lightning_enabled)
VALUES('74000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','classic','pineapple',.25,.5,'{"canonical_existing":true}','Existing Classic','must_move',false);
INSERT INTO cash_games(id,club_id,template_name,variant,sb,bb,ruleset_snapshot,name,cluster_mode,lightning_enabled)
SELECT ('71000000-0000-4000-8000-00000000000'||n)::uuid,'40000000-0000-4000-8000-000000000001',
 CASE n WHEN 1 THEN 'action' ELSE 'madness' END,'pineapple',.25,.5,
 '{"min_buyin_bb":100,"max_buyin_bb":400,"stay_clock_min":17,"rejoin_window_min":180}',
 'Legacy Pineapple','must_move',false
FROM generate_series(1,2)n;
INSERT INTO tables(id,cluster_id,role,main_index,name,auto_start_players,lifecycle,game_variant)
SELECT ('72000000-0000-4000-8000-00000000000'||n)::uuid,('71000000-0000-4000-8000-00000000000'||n)::uuid,
 'main',1,'Legacy Pineapple',2,'live','pineapple' FROM generate_series(1,2)n;
INSERT INTO table_seats(table_id,user_id,seat_number,stack)
SELECT ('72000000-0000-4000-8000-00000000000'||n)::uuid,('73000000-0000-4000-8000-00000000000'||n)::uuid,1,57.35
FROM generate_series(1,2)n;
