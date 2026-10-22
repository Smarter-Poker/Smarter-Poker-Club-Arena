-- THE LOCKED LEVEL CLOCK TRIGGER IS DECLARED (2026-10-21)
--
-- What fired. UndeclaredTriggerOnAMoneyTable (critical, "Money Check Failed:
-- 1 undeclared trigger(s) on a money or seat table") at about 22:21 UTC.
-- fn_undeclared_money_triggers() named tournaments.tournaments_lock_level_clock,
-- created by 20261021222049_lock_tournament_level_clocks, which created the
-- trigger on a money table without declaring it in the same transaction.
--
-- What it does (live text, reviewed): BEFORE INSERT OR UPDATE OF
-- blind_structure ON tournaments, fn_ca_tournament_lock_level_clock() rewrites
-- only blind_structure level durations (and late_reg_mins derived from them)
-- for MTTs and satellites that have not started. It reads no balance and
-- writes no money table or other row. Legitimate; only the declaration was
-- missing. A hand-written declaration closed the alert at 22:24:13 UTC; this
-- migration records it so the repository and production agree.
--
-- @live-proof: (SELECT count(*) = 1 FROM public.ca_declared_money_triggers WHERE table_name = 'tournaments' AND trigger_name = 'tournaments_lock_level_clock')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $bound$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'public.tournaments'::regclass
                    AND t.tgname = 'tournaments_lock_level_clock'
                    AND p.proname = 'fn_ca_tournament_lock_level_clock') THEN
    RAISE EXCEPTION 'tournaments_lock_level_clock is not the reviewed trigger';
  END IF;
END $bound$;

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES
  ('tournaments', 'tournaments_lock_level_clock',
   'Dan 2026-10-21: every MTT/satellite level runs one fixed clock (freeroll/turbo 5, standard/bounty 8, deep stack 10). BEFORE INSERT, and BEFORE UPDATE OF blind_structure while not started, rewrites only blind_structure durations and late_reg_mins derived from them. Moves no money, writes no other row; Spins and Sit & Gos untouched.')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

DO $declared$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_undeclared_money_triggers() u
              WHERE u.table_name = 'tournaments'
                AND u.trigger_name = 'tournaments_lock_level_clock') THEN
    RAISE EXCEPTION 'tournaments_lock_level_clock is still undeclared';
  END IF;
END $declared$;

COMMIT;
