import { createHash } from 'node:crypto';
export const STUCK_THAW_MIGRATION =
  '20261013133012_scoped_launch_operator_accepts_authoritative_json_claims.sql';
const SOURCE_SHA = '89b1671cf9aa507248b7620f734855fa03cdf586d133a1caa9890530fbd04df3';
const ANNOUNCED = '2026-10-13T13:53:00.001Z';
const STARTED = '2026-10-13T13:55:00.001Z';
const ENDED = '2026-10-13T14:00:00.001Z';
export function stuckThawRequest(file, sql, reason, token, conflicting) {
  if (!reason && !token) return null;
  if (
    file !== STUCK_THAW_MIGRATION ||
    createHash('sha256').update(sql).digest('hex') !== SOURCE_SHA ||
    conflicting
  )
    throw new Error(
      'stuck thaw admission permits only the exact merged trigger repair without other operations'
    );
  if (
    typeof reason !== 'string' ||
    reason.trim().length < 20 ||
    reason.length > 500 ||
    /[\x00-\x1f]/.test(reason)
  )
    throw new Error('stuck thaw admission requires an explicit audited emergency reason');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token ?? ''))
    throw new Error('stuck thaw admission requires the inspected durable ownership token');
  return Object.freeze({ reason: reason.trim(), token: token.toLowerCase() });
}
export const STUCK_THAW_STATE = `SELECT b.*, clock_timestamp() AS observed_at,
 (SELECT count(*)::int FROM public.engine_maintenance_thaws t WHERE t.freeze_started_at=b.break_started_at) AS thaw_count
 FROM public.engine_maintenance_break b WHERE b.id=true`;
export function validateStuckThaw(rows, request) {
  const b = rows?.[0];
  const instant = (v) => new Date(v).toISOString();
  if (
    rows.length !== 1 ||
    !b ||
    b.phase !== 'counting_down' ||
    b.enforce_freeze !== true ||
    b.ownership_token?.toLowerCase() !== request.token ||
    instant(b.announced_at) !== ANNOUNCED ||
    instant(b.break_started_at) !== STARTED ||
    instant(b.break_ends_at) !== ENDED ||
    Number(b.thaw_count) !== 0 ||
    new Date(b.observed_at).getTime() < Date.parse(ENDED) + 900000
  )
    throw new Error('the exact inspected stuck thaw identity is no longer current; nothing sent');
  const minute = new Date(b.observed_at).getUTCMinutes();
  if (minute >= 50 || minute <= 3)
    throw new Error('stuck thaw repair preserves the fixed :50-:03 DDL window');
}
const literal = (v) => "'" + v.replaceAll("'", "''") + "'";
export function bindStuckThawTransaction(sql, request) {
  const guard = `
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='2s';
DO $ca_stuck_thaw_admission$ BEGIN
 PERFORM pg_advisory_xact_lock(530090,1);
 PERFORM 1 FROM public.engine_maintenance_break WHERE id=true FOR UPDATE;
 IF extract(minute FROM clock_timestamp())>=50 OR extract(minute FROM clock_timestamp())<=3
 OR NOT EXISTS(SELECT 1 FROM public.engine_maintenance_break b WHERE b.id=true
 AND b.phase='counting_down' AND b.enforce_freeze
 AND b.announced_at=${literal(ANNOUNCED)}::timestamptz
 AND b.break_started_at=${literal(STARTED)}::timestamptz
 AND b.break_ends_at=${literal(ENDED)}::timestamptz
 AND b.ownership_token=${literal(request.token)}::uuid
 AND clock_timestamp()>=b.break_ends_at+interval '15 minutes')
 OR EXISTS(SELECT 1 FROM public.engine_maintenance_thaws WHERE freeze_started_at=${literal(STARTED)}::timestamptz)
 THEN RAISE EXCEPTION 'STUCK_THAW_ADMISSION_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM set_config('ca.break_window_migration_override',${literal(request.reason)},true);
END $ca_stuck_thaw_admission$;
`;
  return sql.replace(/^\s*BEGIN\s*;/im, (match) => match + guard);
}
