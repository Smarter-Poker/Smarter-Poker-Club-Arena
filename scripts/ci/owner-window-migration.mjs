/** A later explicit owner order may admit named migrations in the existing
 * certified emergency freeze. This carries authority, never requests a break. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
export function validateOwnerMigrationWindow(w, file, at = Date.now()) {
  if (
    !w ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(w.id ?? '') ||
    !/^[0-9a-f]{40}$/.test(w.contains ?? '') ||
    typeof w.ownerOrder !== 'string' ||
    w.ownerOrder.trim().length < 10
  )
    throw new Error('invalid owner migration window');
  const start = Date.parse(w.notBefore),
    end = Date.parse(w.notAfter);
  if (!(start <= at && at < end && end - start > 0 && end - start <= 6 * 3600000))
    throw new Error('owner migration window expired or invalid');
  if (
    !Array.isArray(w.migrations) ||
    !w.migrations.length ||
    w.migrations.some((f) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f)) ||
    (file && !w.migrations.includes(file))
  )
    throw new Error('migration is not named by the owner window');
  return w;
}
export function readOwnerMigrationWindow(id, file) {
  const doc = JSON.parse(readFileSync('server/release/owner-maintenance-windows.json', 'utf8'));
  if (doc.version !== 1) throw new Error('invalid owner manifest version');
  const w = validateOwnerMigrationWindow(
    doc.windows?.find((w) => w.id === id),
    file
  );
  execFileSync('git', ['merge-base', '--is-ancestor', w.contains, 'HEAD'], { stdio: 'pipe' });
  return w;
}
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
export function ownerWindowPredicate(reserve, w) {
  validateOwnerMigrationWindow(w);
  if (!Number.isInteger(reserve) || reserve < 0 || reserve > 300)
    throw new Error('invalid reserve');
  return `(public.fn_platform_frozen() AND EXISTS (
    SELECT 1 FROM public.engine_maintenance_break b
    WHERE b.enforce_freeze AND b.phase = 'counting_down'
      AND b.reason = 'Deployment Recovery' AND b.ownership_token IS NOT NULL
      AND b.break_started_at <= clock_timestamp()
      AND b.break_started_at >= ${quote(w.notBefore)}::timestamptz
      AND b.break_ends_at <= ${quote(w.notAfter)}::timestamptz
      AND clock_timestamp() < ${quote(w.notAfter)}::timestamptz
      AND b.break_ends_at - b.break_started_at <= interval '5 minutes'
      AND b.break_ends_at - clock_timestamp() >= make_interval(secs => ${reserve})))`;
}
export function ownerWindowState(w, reserve) {
  return `SELECT ${ownerWindowPredicate(reserve, w)} AS open,
    public.fn_platform_frozen() AS frozen,
    (SELECT row_to_json(b)::text FROM public.engine_maintenance_break b) AS break_row,
    clock_timestamp() AS observed_at`;
}
