import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dan 2026-10-18: Midway Union read 1,480 members when its three clubs held
 * 954 distinct people - 522 of them belong to both Club JAQK and Shark Club.
 * The union member count must count a person once, however many of the
 * union's clubs they belong to. This pins the newest definition of the
 * function so a later rewrite cannot quietly go back to counting rows.
 */
const DIR = join(__dirname, '..', 'supabase', 'migrations');
const FN = 'fn_batch_union_realtime_member_counts';

function newestDefinition(): { file: string; body: string } {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { file: string; body: string } | null = null;
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), 'utf8');
    const at = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${FN}\\s*\\(`, 'i'));
    if (at < 0) continue;
    // The body runs to the function's own closing dollar-quote.
    const open = sql.indexOf('$function$', at);
    const close = open < 0 ? -1 : sql.indexOf('$function$', open + 1);
    if (close > open) found = { file: f, body: sql.slice(at, close) };
  }
  if (!found) throw new Error(`${FN} is never defined`);
  return found;
}

describe('a union counts each member once', () => {
  it('counts distinct people, not membership rows', () => {
    const { body } = newestDefinition();
    expect(body).toMatch(/count\(\s*DISTINCT\s+cm\.user_id\s*\)/i);
  });

  it('still counts every member club, horses included', () => {
    const { body } = newestDefinition();
    expect(body).toContain('public.union_clubs');
    expect(body).not.toMatch(/is_horse/i);
  });
});
