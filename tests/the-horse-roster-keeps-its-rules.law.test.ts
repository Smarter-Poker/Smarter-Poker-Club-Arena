/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HORSE ROSTER KEEPS ITS RULES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-23, binding:
 *   - "KEEP IT UNDER 35-50 TOTAL HORSES AT ANY TIME FOR ALL GAME TYPES"
 *     (cash; every horse still plays tournaments);
 *   - "ONLY ALLOW THE HORSES THAT HAVE SHOWN TO BE PROFITABLE PLAYING PLO PLAY
 *     THOSE GAMES";
 *   - "all horses can play the lower stakes plo games under .10-.25 and
 *     .25-.50";
 *   - "ALLOW MORE HORSES INTO THE GAME, BUT ONLY THE WINNING ONES."
 *
 * WHY THIS EXISTS. Three sessions rewrote fn_ca_horse_roster_refresh on that
 * one day, two from branches that never reached main, and one rewrite put
 * back the line that strips every PLO tag from a horse off the PLO list,
 * undoing the low-stakes opening 40 minutes after it shipped. Nothing caught
 * it. The rules live in SQL, so the pins read the migration that defines each
 * function LAST (the one a rebuild ends on), plus the engine's mirror of the
 * stake split and the job that runs the refresh.
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

/** The arguments of the LAST migration that points the refresh job at the function. */
function lastJobCall(): { file: string; args: number[] } {
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = read(files[i]);
    if (!/ca-horse-roster-refresh/.test(sql)) continue;
    const m = /select public\.fn_ca_horse_roster_refresh\(([^)]*)\)'/.exec(sql);
    if (!m) continue;
    const args = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    return { file: files[i], args };
  }
  throw new Error('no migration sets the ca-horse-roster-refresh job');
}

const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

describe('the horse roster keeps its rules', () => {
  const refresh = lastDefinition('fn_ca_horse_roster_refresh');
  const guard = lastDefinition('fn_ca_horse_roster_seat_guard');
  const R = flat(refresh.body);
  const G = flat(guard.body);

  it('keeps 35 to 50 horses at cash', () => {
    expect(R).toMatch(/v_size := greatest\(35, least\(50,/);
  });

  it('puts only proven PLO winners on the PLO list', () => {
    // A sample floor and a positive win rate, both required.
    expect(R).toMatch(/coalesce\(f\.ph, 0\) >= p_min_plo/);
    expect(R).toMatch(/f\.pn \* 100\.0 \/ f\.ph >= p_min_plo_bb100/);
    expect(R).toMatch(/insert into public\.ca_horse_plo_roster[\s\S]*where c\.plo_profitable/);
  });

  it('never strips a PLO tag and gives every roster cash tag the low stakes', () => {
    expect(R).not.toMatch(/v not like 'plo%'/);
    expect(R).toMatch(/array\[0\.25, ?0\.5\]::numeric\[\]/);
    expect(R).toMatch(/array\['plo4','plo5','plo6','plo8'\]/);
  });

  it('keeps the PLO winners on the cash lane', () => {
    expect(R).toContain("jsonb_build_object('lane', 'cash', 'plocashlane', true)");
  });

  it('opens PLO at 0.50 big blind and under to every cash horse, and gates the rest', () => {
    expect(G).toMatch(/not \(v_bb is not null and v_bb > 0 and v_bb <= 0\.5\)/);
    expect(G).toContain('horse_not_on_plo_roster');
    expect(G).toContain('horse_not_on_cash_roster');
  });

  it('runs the refresh with the winners rule: 50 at cash, 1 bb/100 or better', () => {
    const { args } = lastJobCall();
    expect(args).toHaveLength(5);
    const [size, , minPlo, minBb100] = args;
    expect(size).toBeGreaterThanOrEqual(35);
    expect(size).toBeLessThanOrEqual(50);
    expect(minPlo).toBeGreaterThanOrEqual(1000);
    expect(minBb100).toBeGreaterThan(0);
  });

  it('the engine mirrors the same 0.50 split', () => {
    const plo = readFileSync(resolve(REPO, 'server/src/services/HorsePloRoster.ts'), 'utf8');
    expect(plo).toContain('export const PLO_OPEN_MAX_BIG_BLIND = 0.5;');
  });
});
