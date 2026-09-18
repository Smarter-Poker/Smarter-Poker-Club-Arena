-- Rollback for 20260918091617_a_cash_cutover_cannot_split_an_open_union_week.sql
--
-- This removes the guard. It does not, and must not, remove the cutover row.
--
-- accounting_cash_accrual_cutover is a singleton protected by
-- accounting_cash_cutover_immutable and accounting_cash_cutover_no_truncate.
-- With no cutover row, fn_accounting_union_earned_plan refuses EVERY period as
-- uncertified rather than just the one straddling week, which turns a fourteen
-- hour outage on one union into a permanent one on all of them. Dropping the
-- guard restores the previous behaviour; deleting the row would be far worse
-- than the bug the guard was written for.

DROP TRIGGER IF EXISTS ca_cash_cutover_is_week_aligned ON public.accounting_cash_accrual_cutover;
DROP FUNCTION IF EXISTS public.fn_ca_guard_cash_cutover_week_aligned();
DROP FUNCTION IF EXISTS public.fn_ca_cash_cutover_week_split_by(timestamptz);
