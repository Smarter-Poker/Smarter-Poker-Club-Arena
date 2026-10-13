import { createHash } from 'node:crypto';

export const THAW_REPAIR_FILE =
  '20261013133012_scoped_launch_operator_accepts_authoritative_json_claims.sql';
export const THAW_REPAIR_SHA = '89b1671cf9aa507248b7620f734855fa03cdf586d133a1caa9890530fbd04df3';
export const THAW_REPAIR_REASON =
  'Install source-bound 33012 typed-row and authoritative-claims repair because the expired maintenance thaw is blocked by its original NEW.metadata trigger failure; preserve the freeze and complete its original thaw afterward';
export const THAW_REPAIR_ADMISSION = `
SELECT current_user = 'postgres' AND
 (session_user = 'postgres' OR pg_catalog.pg_has_role(session_user,'postgres','SET')) AND
 public.fn_ca_break_window_refuses_migrations(clock_timestamp()) =
 'an announced engine maintenance window or its thaw is active; apply after its durable release' AND
 public.fn_active_maintenance_release_boundary() IS NULL AND
 (SELECT count(*) = 1 AND bool_and(
   b.enforce_freeze AND b.phase = 'counting_down' AND b.ownership_token IS NOT NULL AND
   b.announced_at < clock_timestamp() AND b.break_started_at >= b.announced_at AND
   b.break_ends_at > b.break_started_at AND
   b.break_ends_at < b.announced_at + interval '15 minutes' AND
   b.break_ends_at <= clock_timestamp()
 ) FROM public.engine_maintenance_break b) AS admitted`;

export function validateThawRepair(
  file,
  sql,
  { dryRun, settlementLane, recovery, batches, preamble }
) {
  if (
    file !== THAW_REPAIR_FILE ||
    createHash('sha256').update(sql).digest('hex') !== THAW_REPAIR_SHA ||
    dryRun ||
    settlementLane ||
    recovery ||
    batches ||
    preamble.length
  ) {
    throw new Error(
      'maintenance thaw repair requires the exact 33012 source without dry run or other operations'
    );
  }
}

export function thawRepairSQL(atomicSQL) {
  const proof = THAW_REPAIR_ADMISSION.replace(/ AS admitted\s*$/, '');
  const admission = `\nDO $ca_thaw_repair_admission$ BEGIN
 IF pg_catalog.pg_try_advisory_xact_lock_shared(530090,1) IS NOT TRUE THEN
  RAISE EXCEPTION 'maintenance announcement owns repair boundary' USING ERRCODE='55000';
 END IF;
 IF (${proof.trim().replace(/^SELECT /, '')}) IS NOT TRUE THEN
  RAISE EXCEPTION 'maintenance thaw repair requires an expired coherent owned freeze' USING ERRCODE='55000';
 END IF;
END $ca_thaw_repair_admission$;
SET LOCAL ca.break_window_migration_override = '${THAW_REPAIR_REASON}';\n`;
  const audit = `\nDO $ca_thaw_repair_audit$ BEGIN
 IF (SELECT count(*) FROM public.ca_break_window_migration_overrides
 WHERE txid=txid_current() AND reason='${THAW_REPAIR_REASON}'
 AND session_role=session_user AND application_name='apply-recorded-migration') <> 1 THEN
  RAISE EXCEPTION 'maintenance thaw repair original audit missing' USING ERRCODE='55000';
 END IF;
END $ca_thaw_repair_audit$;\n`;
  return atomicSQL
    .replace(/^(\s*BEGIN\s*;)/im, (_match, begin) => begin + admission)
    .replace(/COMMIT\s*;\s*$/i, () => audit + 'COMMIT;');
}
