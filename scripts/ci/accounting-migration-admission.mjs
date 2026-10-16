import { createHash } from 'node:crypto';

// These qualified migrations already require this exact scheduler lock. Queue
// delay must not turn a free dispatch-time lane into a failed migration. Wait
// once inside the original transaction, before its unchanged guards and DDL.
export const ACCOUNTING_ADMISSION_SOURCES = Object.freeze({
  '20261015182133_a_proving_week_advances_on_its_own_tick.sql':
    '3cdd45ba7ee979c4fc8be0136e0797ebdd37b8b798c578305a7ebfec75c8e3de',
  '20261015221949_phase7_preserves_an_incident_already_resolved_before_install.sql':
    'e8920433d153aa632a39eb95c513ecfc6830c96ee71c62bba4d9cbb8697d763e',
  '20261015234926_a_completed_week_reads_its_earning_clubs_once.sql':
    'f15e41fb79e200497daeac17e0a389590fc711b9a964fdb208e9c897253da869',
});

export const ACCOUNTING_ADMISSION_SQL = `
SET LOCAL lock_timeout='245s';
SET LOCAL statement_timeout='250s';
DO $ca_accounting_admission$
DECLARE refusal text;
BEGIN
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'accounting_install_override_refused' USING ERRCODE='55000';
 END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
  RAISE EXCEPTION 'accounting_install_freeze_refused' USING ERRCODE='55000';
 END IF;
 -- Reserve the bounded wait and the original migration's 60s statement budget.
 refusal:=public.fn_ca_break_window_refuses_migrations(clock_timestamp());
 IF refusal IS NOT NULL THEN RAISE EXCEPTION 'accounting_install_ddl_refused' USING DETAIL=refusal;END IF;
 refusal:=public.fn_ca_break_window_refuses_migrations(clock_timestamp()+interval '310 seconds');
 IF refusal IS NOT NULL THEN RAISE EXCEPTION 'accounting_install_wait_runway_refused' USING DETAIL=refusal;END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));
 -- Everything can change while waiting. These checks precede the original
 -- migration, whose own operator/history/source/freeze/try-lock guards remain.
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
  RAISE EXCEPTION 'accounting_install_freeze_refused' USING ERRCODE='55000';
 END IF;
 refusal:=public.fn_ca_break_window_refuses_migrations(clock_timestamp());
 IF refusal IS NOT NULL THEN RAISE EXCEPTION 'accounting_install_ddl_refused' USING DETAIL=refusal;END IF;
 refusal:=public.fn_ca_break_window_refuses_migrations(clock_timestamp()+interval '60 seconds');
 IF refusal IS NOT NULL THEN RAISE EXCEPTION 'accounting_install_apply_runway_refused' USING DETAIL=refusal;END IF;
END $ca_accounting_admission$;
`;

export function accountingAdmissionSQL(file, source, atomicSQL) {
  const expected = ACCOUNTING_ADMISSION_SOURCES[file];
  if (!expected) return atomicSQL;
  if (createHash('sha256').update(source).digest('hex') !== expected) {
    throw new Error('accounting admission requires its exact qualified migration bytes');
  }
  if (!/^BEGIN;$/m.test(atomicSQL) || atomicSQL.includes('$ca_accounting_admission$')) {
    throw new Error(
      'accounting admission requires one original transaction without prior admission'
    );
  }
  return atomicSQL.replace(/^BEGIN;$/m, (begin) => begin + '\n' + ACCOUNTING_ADMISSION_SQL);
}
