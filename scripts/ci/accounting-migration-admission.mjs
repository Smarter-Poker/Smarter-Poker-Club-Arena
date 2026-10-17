import { createHash } from 'node:crypto';

// These qualified migrations already require this exact scheduler lock. Queue
// delay must not turn a free dispatch-time lane into a failed migration. Wait
// once inside the original transaction, before its unchanged guards and DDL.
export const ACCOUNTING_ADMISSION_SOURCES = Object.freeze({
  '20261015182133_a_proving_week_advances_on_its_own_tick.sql':
    '3cdd45ba7ee979c4fc8be0136e0797ebdd37b8b798c578305a7ebfec75c8e3de',
  '20261015221949_phase7_preserves_an_incident_already_resolved_before_install.sql':
    'c80c867622372cf5ac40f0b70dfd855ebad0313ec304e2d71395d6b2c84a8dc0',
  '20261015234926_a_completed_week_reads_its_earning_clubs_once.sql':
    'f15e41fb79e200497daeac17e0a389590fc711b9a964fdb208e9c897253da869',
  '20261016233224_weekly_routing_excludes_a_club_that_joined_after_its_week.sql':
    '5f7fdbcab36914ac583823fa1f78332b039519f2af6f757a4a60589641021a82',
  '20261017012658_weekly_coordinator_skips_redundant_earning_club_witnesses.sql':
    '0fb295017f747b366df7f8a06bc3293e034a9fb735ad4101b3f265b793188603',
  '20261017034258_weekly_touched_proof_reuses_tournament_and_registration_iden.sql':
    'd98ac6e29a843fbba7d5d8ff5adb4509fd0e94cbba8d0eb6d4d23e24d7d90dbb',
  '20261017053808_departed_members_retain_their_earned_accounting_wallet.sql':
    'c4bfe7a004845a8326a73896c451cb17b0262e2f41ed172e05203bf45267e6b1',
  '20261017065530_deleted_wallets_settle_recorded_weekly_obligations_before_fr.sql':
    '94701e2b83ffb5ce1eae34a683f93e882d238f8609616a43f543fa6e52b8e488',
  '20261017121500_an_in_progress_close_is_visited_without_the_whole_scan.sql':
    '0a3a41049501cc30211b570531db7fa3ef622e34da59522cd7873e6fd4f87a06',
  '20261017132500_only_a_chunked_tick_owns_the_in_progress_fast_path.sql':
    'd2b42a912270293fccf77fc2ddc152074318964b4ad1cfdb9cd5c893056f9e49',
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
 IF NOT pg_catalog.pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
  refusal:=public.fn_ca_break_window_refuses_migrations(clock_timestamp()+interval '310 seconds');
  IF refusal IS NOT NULL THEN RAISE EXCEPTION 'accounting_install_wait_runway_refused' USING DETAIL=refusal;END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));
 END IF;
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
