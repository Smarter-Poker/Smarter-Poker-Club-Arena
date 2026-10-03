/**
 * LAW: THE UNION SWEEP STOPS REBUILDING AN UNREAD SNAPSHOT (2026-10-03).
 *
 * fn_union_integrity_sweep_all rebuilt union_rake_basis_snapshot for the open
 * week after its money controls. The rebuild is linear in the week; from
 * 2026-09-29 it no longer finished inside the job's 300 s, so every hourly
 * run lasted exactly 300 s, was cancelled in the rebuild, and kept the
 * 2026-09-28 snapshot - about 250 s of a backend an hour for a table nothing
 * reads. 20261003225101 removes the rebuild and nothing else.
 *
 * What this pins: the sweep in force calls every money control and never the
 * refresh; nothing in the application reads the snapshot table (so removing
 * the rebuild cannot starve a reader); the change adds no schedule; and the
 * migration is pinned to the live pre-image and its post-image.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring } from './helpers/migrations';

const FILE = '20261003225101_the_union_sweep_stops_rebuilding_an_unread_snapshot.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('the union sweep stops rebuilding an unread snapshot', () => {
  it('the sweep in force runs every money control and never the rebuild', () => {
    const { name, sql } = latestDeclaring('fn_union_integrity_sweep_all');
    expect(name).toBe(FILE);
    const body = functionBody(sql, 'fn_union_integrity_sweep_all');
    for (const control of [
      'public.fn_union_integrity_sweep(u.id, p_hours)',
      'public.fn_union_age_invoices(u.id)',
      'public.fn_union_enforce_stop_loss(u.id)',
      'public.expire_settlement_locks()',
      'public.fn_settlement_lock_hygiene()',
      'public.fn_close_due_settlement_periods()',
    ])
      expect(body).toContain(control);
    expect(body).not.toMatch(/fn_union_rake_basis_refresh\s*\(/);
  });

  it('nothing in the application reads the snapshot', () => {
    const roots = ['src', 'server/src', 'supabase/functions'].map((d) => resolve(process.cwd(), d));
    const readers: string[] = [];
    for (const root of roots) {
      let files: string[] = [];
      try {
        files = sources(root);
      } catch {
        continue;
      }
      for (const f of files) if (readFileSync(f, 'utf8').includes('union_rake_basis_snapshot')) readers.push(f);
    }
    expect(readers).toEqual([]);
  });

  it('is one pinned transaction that adds no schedule', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("IS DISTINCT FROM '729a5617801d0038b1fa3c10f488c0bb'");
    expect(MIG).toContain("IS DISTINCT FROM '6000297c65bca53935705fbd6b8fd5d8'");
    expect(MIG).not.toMatch(/cron\.schedule/);
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep_all(integer) FROM PUBLIC, anon, authenticated;');
  });
});
