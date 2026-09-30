-- Diamond Phase 11 line 5: the columns the live plain-cash rule and top-up door read, added to the
-- isolated tests/sql accepted-hand fixture before scripts/qualification/diamond-lock-waits.py loads the
-- live doors (a SQL function's row argument is checked when it is created). Values are the plain-cash
-- defaults every Diamond table carries. The local arena's cash switch is opened ONLY inside this
-- throwaway cluster, as tests/sql/poker-diamond-cash-admission-setup.sql does for the buy-in door;
-- the top-up door refuses by name while it is closed, and the production switch is Dan's.
DO $$ BEGIN
 IF current_database()<>'poker_diamond_phase6_accepted_test' OR inet_server_addr() IS NOT NULL
    OR current_setting('port')<>'55472' THEN RAISE EXCEPTION 'isolated diamond lock-wait fixture only'; END IF;
END $$;
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS small_blind numeric DEFAULT 1, ADD COLUMN IF NOT EXISTS big_blind numeric DEFAULT 2,
  ADD COLUMN IF NOT EXISTS ante numeric DEFAULT 0, ADD COLUMN IF NOT EXISTS cluster_id uuid,
  ADD COLUMN IF NOT EXISTS is_template boolean DEFAULT false, ADD COLUMN IF NOT EXISTS rake_percent numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rake_cap_bb numeric DEFAULT 0, ADD COLUMN IF NOT EXISTS bbj_percent numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurance_enabled boolean DEFAULT false, ADD COLUMN IF NOT EXISTS run_it_twice boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_run_it_twice boolean DEFAULT false, ADD COLUMN IF NOT EXISTS seven_deuce_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS nit_game boolean DEFAULT false, ADD COLUMN IF NOT EXISTS all_in_or_fold boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pineapple_holdem boolean DEFAULT false, ADD COLUMN IF NOT EXISTS cap_enabled boolean DEFAULT false;
ALTER TABLE public.ca_arena_settings ADD COLUMN IF NOT EXISTS cash_games_enabled boolean DEFAULT false;
UPDATE public.ca_arena_settings SET cash_games_enabled = true WHERE id = 1;
