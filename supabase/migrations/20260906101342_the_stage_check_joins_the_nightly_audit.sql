-- Wire the stage check into fn_run_horse_daily_audit, patched in place from
-- the live definition - the same idiom the tag registry, tuner and seat-clock
-- steps were wired with on 2026-09-05.
do $patch$
declare d text;
begin
  select pg_get_functiondef('public.fn_run_horse_daily_audit(date)'::regprocedure) into d;
  if position('fn_audit_behaviour_has_a_stage(p_day)' in d) = 0 then
    d := replace(d,
      'v_findings := v_findings || fn_audit_seat_clock(p_day);',
      'v_findings := v_findings || fn_audit_seat_clock(p_day);' || chr(10) ||
      '  -- 2026-09-06: a receipt can be zero because the behaviour is broken OR' || chr(10) ||
      '  -- because the world never presents the spot. Those want opposite fixes.' || chr(10) ||
      '  v_findings := v_findings || fn_audit_behaviour_has_a_stage(p_day);');
    execute d;
  end if;
end $patch$;
