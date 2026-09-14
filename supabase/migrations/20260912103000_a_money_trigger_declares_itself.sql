-- ═══════════════════════════════════════════════════════════════════════════
--  THE REGISTER OF MONEY TRIGGERS CATCHES UP WITH THE DATABASE, ONCE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (2026-09-12)
--
-- `UndeclaredTriggerOnAMoneyTable` is critical severity and pages by SMS. Its
-- description states the stake plainly:
--
--     "Either it is a legitimate change missing its declaration, or it is an
--      unreviewed one - and the last unreviewed one broke a third of all hand
--      settlements."
--
-- It has been firing continuously. It read 76 during this audit and had read 74
-- ninety minutes earlier in the same session, so the number is not a stuck
-- gauge; it is growing while the alarm is already on.
--
--     tournaments          26
--     table_seats          23
--     tournament_players   15
--     chip_ledger           8
--     club_members          3
--     club_wallets          1
--
-- The register itself is alive and used: 115 triggers ARE declared. What broke
-- is the discipline, and the alarm that should have enforced it saturated long
-- ago. A critical page that has been on for weeks is not a signal. The
-- seventy-seventh undeclared trigger will look exactly like the seventy-sixth,
-- which is to say invisible.
--
-- ── WHAT THIS DECLARATION MEANS, EXACTLY ──────────────────────────────────
--
-- It means: this trigger was live and in service on a money table on
-- 2026-09-12, and is the baseline the gate measures from. It does NOT mean
-- somebody re-read all seventy-six. Nobody did, and a note claiming otherwise
-- would be worth less than no note.
--
-- That honesty is the point. Seventy-six triggers cannot be reviewed
-- retroactively by anybody, but the seventy-seventh can be stopped before it
-- ships, and that is what `scripts/ci/check-money-trigger-declared.mjs` now
-- does: a migration that creates a trigger on one of the nine money tables is
-- refused unless it declares it in the SAME migration. A declaration in a later
-- one is a promise, and this register is already seventy-six broken promises
-- long.
--
-- ── WHY IT READS THE CATALOGUE INSTEAD OF LISTING SEVENTY-SIX NAMES ───────
--
-- A hand-written list is a snapshot of the moment it was typed. Two triggers
-- arrived between the first count and this migration being written; more may
-- arrive before it is applied. Reading `fn_undeclared_money_triggers()` at
-- apply time declares exactly what is live at apply time, which is the only set
-- this can honestly speak for.
--
-- ON CONFLICT DO NOTHING, so re-applying declares nothing twice and removes
-- nothing already recorded.

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT u.table_name,
       u.trigger_name,
       'In service on 2026-09-12, declared as the baseline for '
         || 'check-money-trigger-declared. Records that it was live and known at that '
         || 'date, not that it was re-reviewed then. Anything created after this date '
         || 'declares itself in its own migration.'
  FROM public.fn_undeclared_money_triggers() u
ON CONFLICT (table_name, trigger_name) DO NOTHING;

-- The register has to be EMPTY of undeclared triggers when this finishes, or
-- the gate it exists to enable starts life measuring from a moving baseline.
DO $$
DECLARE
  v_left integer;
  v_total integer;
BEGIN
  SELECT count(*)::int INTO v_left FROM public.fn_undeclared_money_triggers();
  SELECT count(*)::int INTO v_total FROM public.ca_declared_money_triggers;

  IF v_left <> 0 THEN
    RAISE EXCEPTION
      'ca_declared_money_triggers still reports % undeclared money trigger(s) after the baseline',
      v_left;
  END IF;

  RAISE NOTICE
    'money trigger register: 0 undeclared, % declared in total. UndeclaredTriggerOnAMoneyTable can fire on the next one.',
    v_total;
END $$;
