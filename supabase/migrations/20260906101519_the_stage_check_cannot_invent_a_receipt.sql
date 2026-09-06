-- Superseded in full by 20260906101611_the_stage_check_judges_only_the_stage.sql.
-- Second cut. It tried to defend against the invented name by requiring the
-- receipt to have fired at least once in history - and immediately accused
-- itself over v48_straddle_enrolled, a REAL registered receipt that has never
-- fired for exactly the reason the function exists to report: no stage. A
-- guard that cannot tell a fake name from a real thing that never got a
-- chance is not a guard.
select 1;
