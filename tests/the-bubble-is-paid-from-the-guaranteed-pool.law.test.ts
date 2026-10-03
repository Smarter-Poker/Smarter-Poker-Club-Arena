/**
 * LAW: THE BUBBLE IS PAID FROM THE GUARANTEED POOL (2026-10-03).
 *
 * A bubble-protected event reserves one base buy-in for its stone bubble out
 * of the prize pool before the ladder is priced, and the event page says so.
 * The guarantee check summed only ladder sources, so f84852af (19,820.00 to
 * places 1-2 plus 180.00 to the bubble: the whole 20,000.00) read 180.00
 * short. The bubble refund and an overlay backpay are money the guarantee
 * paid out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { migrationCorpus } from './helpers/migrationCorpus';

const FILE = '20261003141003_the_bubble_is_paid_from_the_guaranteed_pool.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');

function declaration(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_tournament_guarantee_check(');
  expect(start, 'the function is declared').toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start)) + '$function$\n';
}

function newestFile(): string {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?fn_tournament_guarantee_check\s*\(/i;
  let hit = '';
  for (const m of migrationCorpus()) if (re.test(m.sql)) hit = m.name;
  return hit;
}

const FN = declaration(MIG);

describe('the bubble is paid from the guaranteed pool', () => {
  it('is one pinned transaction whose live proof is the declared text', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    const md5 = createHash('md5').update(FN).digest('hex');
    expect(md5).toBe('1a00e689f8b09aca406dda7ae462b25c');
    expect(MIG).toContain(`= '${md5}')`);
    expect(MIG).toContain("IS DISTINCT FROM 'c86160ed0a10f5a5c94db0b934b7c19f'");
    for (const c of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'RESULT_CHANGED'])
      expect(MIG).toContain('GUARANTEE_CHECK_' + c);
    expect(MIG).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
  });

  it('carries the change', () => {
    expect(FN).toContain('\'spin_backpay\',\'bubble_protection\',');
    expect(FN).toContain('\'overlay_backpay\')');
    expect(FN).toContain('CONTINUE WHEN round(r.paid, 2) >= round(r.guaranteed_prize, 2);');
  });

  it('still never counts a bounty as guarantee money', () => {
    const list = FN.match(/p\.source IN \(([^)]*)\)/);
    expect(list).not.toBeNull();
    expect(list![1]).not.toMatch(/bounty/);
  });

  it('is closed to browsers and is the newest declaration on disk', () => {
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.fn_tournament_guarantee_check(integer) FROM PUBLIC, anon, authenticated;');
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.fn_tournament_guarantee_check(integer) TO service_role;');
    expect(newestFile()).toBe(FILE);
  });
});
