# tests/proving-earned-plan-windows-is-a-whole-attempt.law.test.ts

A chunked weekly close attempt that proved any earned-plan window ends there (fn_accounting_union_earned_plan_advance returns false), even when it proved the last window, so the closing boundary and later steps start the next attempt with the whole budget instead of overrunning job 272's statement timeout and rolling back the windows for ever.
