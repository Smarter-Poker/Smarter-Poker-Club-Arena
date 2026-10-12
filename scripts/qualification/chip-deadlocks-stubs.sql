-- scripts/qualification/chip-deadlocks-stubs.sql
--
-- The only functions chip-deadlocks.py does NOT load from production. Each one is
-- called by a live door in the cycles reproduced here, and none of them takes a
-- lock: they read (a plan, a proof, a scope) and return. They answer from harness
-- tables the fixture fills, so the live doors around them run their real code.
--
--   fn_accounting_cash_commission_plan(uuid)   the cash accrual plan (who earns
--       which tier). Production builds it from the agreement history; here the
--       fixture writes it. The accrual reads it and locks nothing through it.
--   fn_accounting_tournament_fee_net_plan(uuid) the tournament fee plan (which
--       sources are active). Same reason.
--   fn_accounting_tournament_bank_proof(...)    proves the bank leg of a finish
--       that this harness does not run; the recognition only needs it to return.
--   fn_cash_source_refusal_scope(uuid)          describes a refusal for the receipt,
--       after the accrual; reads only.
--   fn_cash_earning_club(...)                   which club a contributor earns in;
--       here the table's club, as for a standalone club game.
-- The arena switches the migrations assert are still closed (both false, as in production).
CREATE TABLE IF NOT EXISTS public.ca_arena_settings (cash_games_enabled boolean NOT NULL DEFAULT false, tournaments_enabled boolean NOT NULL DEFAULT false);
INSERT INTO public.ca_arena_settings DEFAULT VALUES;
CREATE TABLE IF NOT EXISTS public.harness_cash_plans (rake_record_id uuid PRIMARY KEY, plan jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS public.harness_fee_plans (tournament_id uuid PRIMARY KEY, plan jsonb NOT NULL);
CREATE OR REPLACE FUNCTION public.fn_accounting_cash_commission_plan(p_rake_record_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE AS $$ SELECT plan FROM public.harness_cash_plans WHERE rake_record_id = p_rake_record_id $$;
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_net_plan(p_tournament_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE AS $$ SELECT plan FROM public.harness_fee_plans WHERE tournament_id = p_tournament_id $$;
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_bank_proof(uuid, timestamptz, uuid, uuid, numeric, uuid, uuid) RETURNS jsonb
  LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.fn_cash_source_refusal_scope(uuid) RETURNS jsonb
  LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.fn_cash_earning_club(p_hand_id uuid, p_table_id uuid, p_user_id uuid, p_club_id uuid, p_union_id uuid) RETURNS uuid
  LANGUAGE sql AS $$ SELECT p_club_id $$;
-- Pause gates (instrumentation, not a door): a session that names a key in
-- harness.pause_before waits on advisory lock 424242 (held by the runner) just
-- before it writes that key's row, so two sessions can be stopped at the exact
-- point production's interleaving reaches. A session that names nothing is
-- never stopped. The doors' bodies are untouched.
CREATE OR REPLACE FUNCTION public.harness_pause_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text := COALESCE(current_setting('harness.pause_before', true), ''); v_key text;
BEGIN
  IF TG_TABLE_NAME = 'horse_mind_pairs' THEN v_key := NEW.attacker_id; ELSE v_key := NEW.user_id::text; END IF;
  IF k <> '' AND k = v_key THEN
    PERFORM set_config('harness.pause_before', '', true);
    PERFORM pg_advisory_xact_lock_shared(424242);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aaa_harness_pause BEFORE INSERT ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION public.harness_pause_gate();
CREATE TRIGGER aaa_harness_pause BEFORE INSERT ON public.player_stats FOR EACH ROW EXECUTE FUNCTION public.harness_pause_gate();
CREATE TRIGGER aaa_harness_pause BEFORE INSERT ON public.horse_mind_pairs FOR EACH ROW EXECUTE FUNCTION public.harness_pause_gate();
CREATE TRIGGER aaa_harness_pause BEFORE INSERT ON public.horse_mind_stats FOR EACH ROW EXECUTE FUNCTION public.harness_pause_gate();
CREATE TRIGGER aaa_harness_pause BEFORE INSERT ON public.horse_mind_stats_scoped FOR EACH ROW EXECUTE FUNCTION public.harness_pause_gate();
