-- Superseded in full by 20260906101611_the_stage_check_judges_only_the_stage.sql.
-- First cut of fn_audit_behaviour_has_a_stage. It judged BOTH "is there a
-- stage" and "did the receipt fire", and the second half accused run-it-twice
-- of being broken over a receipt name (v33_rit_decline) that I invented and
-- nothing has ever emitted.
select 1;
