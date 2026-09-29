/**
 * A FENCED MANAGER'S STOPPED CUSTODY GOES THROUGH THE PROCESS WRITE (2026-09-26)
 *
 * Engine cd5892e8 (sealed 09:08Z) predates #5323. Its terminal engines write
 * stopped time-bank custody as a POST upsert to engine_presence_parked under
 * the dead manager's data-actor headers, and the request hook fenced every one
 * (758 POSTs answered 403 at the 12:53Z fan-out). The census then reported
 * stopped_bank_custody_stuck for 630 tables at five consecutive countdowns,
 * the certificate stayed shut by design (#5288), and every release since
 * 09:08Z - including 3956bc0b49, which carries #5323 - died waiting for it.
 *
 * Migration 20260926131014 lets that one write land through the refusing
 * function #5323 already installed, and nothing else. These laws pin:
 *   - the hook admits only POST engine_presence_parked past the fence, under
 *     its own marker and never as a manager, and still raises the fence for
 *     everything else;
 *   - the trigger passes every other actor untouched, raises the SAME fence
 *     for any row that is not stopped custody, writes only through
 *     fn_park_stopped_time_bank_custody, suppresses the raw upsert only on
 *     ok, and raises on every refusal so the engine records no
 *     acknowledgement;
 *   - it is BEFORE INSERT only, one transaction, and bounded by lock_timeout;
 *   - the release script names a shut certificate instead of reporting only
 *     the budget, without changing its verdict.
 *
 * docs/changelog/2026-09-26-a-fenced-managers-stopped-custody-goes-through-the-process-write.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const FILE = readFileSync(
  join(
    ROOT,
    'supabase',
    'migrations',
    '20260926131014_a_fenced_manager_s_stopped_custody_park_goes_through_the_pro.sql'
  ),
  'utf8'
);
const RELEASE = readFileSync(
  join(ROOT, 'server', 'scripts', 'engine-release-transaction.sh'),
  'utf8'
);

// Applied to production 2026-09-26 13:14Z and recorded with these exact bytes.
const APPLIED_MD5 = 'cebc8f96d9af8358005802b7858ec8f4';

const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

function fn(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('AS $function$', start) + 'AS $function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const HOOK = fn(FILE, 'FUNCTION smarter_private.fn_smarter_data_api_pre_request()');
const TRIGGER = fn(FILE, 'FUNCTION smarter_private.fn_fenced_manager_stopped_custody_park()');

describe('a fenced manager stopped custody goes through the process write', () => {
  it('is the file production applied, in one transaction bounded by lock_timeout', () => {
    expect(createHash('md5').update(FILE, 'utf8').digest('hex')).toBe(APPLIED_MD5);
    const sql = code(FILE);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '3s';/);
    expect(sql).not.toMatch(/DROP TRIGGER|DROP FUNCTION|ALTER TABLE/);
  });

  it('the hook admits exactly one shape past the fence, under its own marker', () => {
    const fence = HOOK.slice(HOOK.indexOf('IF NOT FOUND THEN'));
    const branch = fence.slice(0, fence.indexOf('RAISE EXCEPTION'));
    expect(branch).toContain("IF v_method = 'POST' AND v_path = 'engine_presence_parked' THEN");
    expect(branch).toContain(
      "set_config('app.smarter_data_actor', 'fenced-manager-stopped-custody', true)"
    );
    expect(branch).not.toContain("'tournament-manager'");
    expect(branch.match(/\bRETURN;/g)).toHaveLength(1);
    // The fence itself still follows the one exception, unchanged.
    expect(fence).toMatch(
      /END IF;\s*RAISE EXCEPTION\s*'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'\s*USING ERRCODE = '42501';/
    );
    // Reads keep their exact validation; mutations keep FOR KEY SHARE.
    expect(HOOK).toContain("IF v_method IN ('GET', 'HEAD', 'OPTIONS')");
    expect(HOOK).toContain('FOR KEY SHARE;');
    expect(HOOK.match(/fenced-manager-stopped-custody/g)).toHaveLength(1);
  });

  it('the trigger passes every other actor untouched', () => {
    expect(TRIGGER).toMatch(
      /IF current_setting\('app\.smarter_data_actor', true\)\s*IS DISTINCT FROM 'fenced-manager-stopped-custody' THEN\s*RETURN NEW;/
    );
  });

  it('any row that is not stopped custody gets the same fence', () => {
    const shape = TRIGGER.slice(TRIGGER.indexOf('v_snapshot := NEW.time_bank_snapshot;'));
    const guard = shape.slice(0, shape.indexOf('END IF;'));
    for (const clause of [
      "right(COALESCE(NEW.engine_instance, ''), 16) IS DISTINCT FROM ':stopped_custody'",
      "jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'",
      "(v_snapshot -> 'version') IS DISTINCT FROM '1'::jsonb",
      "jsonb_typeof(v_hand) IS DISTINCT FROM 'number'",
      '(v_hand::text)::numeric < 0',
      "jsonb_typeof(v_snapshot -> 'players') IS DISTINCT FROM 'object'",
      "jsonb_typeof(NEW.disconnect_states) IS DISTINCT FROM 'object'",
    ]) {
      expect(guard).toContain(clause);
    }
    expect(guard).toContain("'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'");
  });

  it('writes only through fn_park_stopped_time_bank_custody, as the process, and restores the marker', () => {
    const asService = TRIGGER.indexOf("set_config('app.smarter_data_actor', 'service', true)");
    const call = TRIGGER.indexOf('public.fn_park_stopped_time_bank_custody(');
    const restore = TRIGGER.indexOf(
      "set_config('app.smarter_data_actor', 'fenced-manager-stopped-custody', true)"
    );
    expect(asService).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(asService);
    expect(restore).toBeGreaterThan(call);
    expect(code(TRIGGER)).not.toMatch(/INSERT INTO|UPDATE public|ON CONFLICT/i);
  });

  it('suppresses the raw upsert only on a confirmed write, and refuses every other answer', () => {
    expect(TRIGGER).toMatch(/IF \(v_result ->> 'ok'\) = 'true' THEN[\s\S]*?RETURN NULL;\s*END IF;/);
    expect(TRIGGER.match(/RETURN NULL;/g)).toHaveLength(1);
    expect(TRIGGER).toMatch(/RAISE EXCEPTION 'STOPPED_CUSTODY_REFUSED: %'/);
  });

  it('is a BEFORE INSERT row trigger, never UPDATE, and nobody can call it', () => {
    expect(FILE).toMatch(
      /CREATE TRIGGER trg_fenced_manager_stopped_custody_park\s+BEFORE INSERT ON public\.engine_presence_parked\s+FOR EACH ROW EXECUTE FUNCTION smarter_private\.fn_fenced_manager_stopped_custody_park\(\);/
    );
    expect(FILE).not.toMatch(/BEFORE (INSERT OR )?UPDATE ON public\.engine_presence_parked/);
    expect(FILE).toMatch(
      /REVOKE ALL ON FUNCTION smarter_private\.fn_fenced_manager_stopped_custody_park\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
  });

  it('the release script names a shut certificate below the budget without changing the verdict', () => {
    const start = RELEASE.indexOf('maintenance_certificate() {');
    const py = RELEASE.slice(start, RELEASE.indexOf('\n\')"', start));
    const below = py.slice(
      py.indexOf('if remaining<int('),
      py.indexOf('ok=(m.get("readyForRestart")')
    );
    expect(below).toContain('the restart certificate is also shut');
    expect(below).toContain('sys.stderr.write(');
    expect(below).toMatch(/print\(remaining\)\s*raise SystemExit\(2\)/);
    // stdout stays the verdict alone (2026-09-26, run 36211686180).
    expect(below).not.toMatch(/\bprint\((?!remaining\))/);
    // A single-quoted python -c body: an apostrophe would close the quote.
    expect(below).not.toContain("'");
  });
});
