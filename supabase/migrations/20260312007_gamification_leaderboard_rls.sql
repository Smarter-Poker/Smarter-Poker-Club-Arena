-- 20260312007_gamification_leaderboard_rls.sql
-- Add public read access to user_lucky_wheel_spins for leaderboard display

BEGIN;

CREATE POLICY "Public read access for user_lucky_wheel_spins" 
ON "public"."user_lucky_wheel_spins" 
FOR SELECT USING (true);

COMMIT;
