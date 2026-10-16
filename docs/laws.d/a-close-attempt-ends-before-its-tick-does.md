# tests/a-close-attempt-ends-before-its-tick-does.law.test.ts

A close attempt ends before its tick does (2026-10-16): fn_weekly_accounting_attempt_begin sets the attempt deadline to the earlier of the scope budget and 60 seconds before the statement's own timeout, because a union visit that started two minutes into job 272's 240 s tick measured three minutes from its own start, was cancelled at the statement timeout and kept nothing.
