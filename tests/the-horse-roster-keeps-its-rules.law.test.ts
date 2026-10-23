/** Owner October 23: the fifty cash horses are restricted by bankroll,
 * never fixed variants/stakes, past PLO profits or activity personas.
 * This supersedes the earlier same-day winners-only rule. Read the LAST
 * migration definitions, so a later rewrite cannot quietly restore it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MIG_DIR = resolve(REPO, 'supabase/migrations');
const files = readdirSync(MIG_DIR)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const read = (f: string) => readFileSync(resolve(MIG_DIR, f), 'utf8');

/** The body of the LAST migration that (re)defines `fn`, from its CREATE to the end of its $fn$ body. */
function lastDefinition(fn: string): { file: string; body: string } {
  const needle = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'i');
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = read(files[i]);
    const m = needle.exec(sql);
    if (!m) continue;
    const rest = sql.slice(m.index);
    const open = rest.search(/as\s+\$(\w*)\$/i);
    const tag = /as\s+\$(\w*)\$/i.exec(rest)![1];
    const close = rest.indexOf(`$${tag}$`, open + 4 + tag.length);
    return { file: files[i], body: rest.slice(0, close) };
  }
  throw new Error(`no migration defines public.${fn}`);
}

const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

describe('the cash roster keeps the latest bankroll-only rule', () => {
  const R = flat(lastDefinition('fn_ca_horse_roster_refresh').body);
  const G = flat(lastDefinition('fn_ca_horse_roster_seat_guard').body);

  it('keeps exactly fifty ordinary cash horses without ranking on past profit', () => {
    expect(R).toContain('v_size := 50;');
    expect(R).toContain('order by roster_rank, bankroll desc, id');
    expect(R).not.toContain('order by plo_profitable desc');
  });
  it('puts every cash horse on the PLO list, regardless of sample size or win rate', () => {
    expect(R).toContain('join public.ca_horse_active_roster a on a.horse_id = c.id');
    expect(R).not.toContain('where c.plo_profitable');
  });
  it('gives the pool every variant and live stake, without a persona table ceiling', () => {
    expect(R).toContain("variants = array['nlh','plo4','plo5','plo6','plo8'");
    expect(R).toContain('select big_blind as bb from public.tables');
    expect(R).toContain('max_tables = 4');
    expect(R).not.toContain("jsonb_build_object('lane', 'cash', 'plocashlane', true)");
  });
  it('keeps the ordinary pool boundary and the newer unrestricted Lightning admission', () => {
    expect(G).toContain('horse_not_on_cash_roster');
    expect(G).toContain('g.lightning_enabled');
    expect(G).not.toContain('horse_not_on_plo_roster');
    expect(G).not.toContain('v_bb <= 0.5');
  });
  it('the engine never uses the historical PLO list to refuse a seat', () => {
    const source = readFileSync(resolve(REPO, 'server/src/services/HorsePloRoster.ts'), 'utf8');
    expect(source).toMatch(/export function ploRosterAllows[\s\S]*?\): boolean \{\s*return true;/);
  });
});
