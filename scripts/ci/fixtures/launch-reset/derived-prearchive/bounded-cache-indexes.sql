CREATE INDEX idx_cmds_club_date_hot ON public.club_member_daily_stats USING btree (club_id, stat_date) INCLUDE (user_id);
CREATE INDEX idx_cmds_club_user ON public.club_member_daily_stats USING btree (club_id, user_id);
CREATE INDEX idx_cmds_stat_date_table_club ON public.club_member_daily_stats USING btree (stat_date, table_id, club_id);
CREATE INDEX idx_cmds_user_stat_date_hot ON public.club_member_daily_stats USING btree (user_id, stat_date DESC) INCLUDE (table_id);
