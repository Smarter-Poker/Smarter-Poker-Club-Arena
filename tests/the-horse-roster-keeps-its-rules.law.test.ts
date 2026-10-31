/** Superseded October 26: the full scheduled fleet may play every game its bankroll
 * supports. Activity schedules remain. Historical cash/PLO rankings and persona
 * game restrictions cannot restore a fifty-horse cash limit. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

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

describe('the top half of measured cash performers plays cash', () => {
  const R = flat(lastDefinition('fn_ca_horse_roster_refresh').body);
  const G = flat(lastDefinition('fn_ca_horse_roster_seat_guard').body);

  it('selects half the eligible fleet using measured cash performance', () => {
    expect(R).toContain('floor(count(*) * 0.5)');
    expect(R).toContain('hands >= greatest(5000, p_min_hands)');
    expect(R).toContain('ca_horse_fleet_register');
    expect(R).not.toContain('v_size := 50;');
    expect(R).toContain('order by bb100 desc nulls last, hands desc, id');
    expect(R).not.toContain('order by plo_profitable desc');
  });
  it('uses the same roster for PLO and preserves saved tag values on restoration', () => {
    expect(R).toContain('from public.ca_horse_active_roster');
    expect(R).toContain('mode=b.mode');
    expect(R).toContain("set mode='tourney'");
    expect(R).not.toContain('update public.profiles');
  });
  it('enforces cash membership while preserving tournaments and ongoing updates', () => {
    expect(G).toContain('return new;');
    expect(G).toContain('horse_not_on_cash_roster');
    expect(G).toContain('t.tournament_id is not null');
    expect(G).toContain("tg_op='update'");
    expect(G).not.toContain('horse_not_on_plo_roster');
    expect(G).not.toContain('v_bb <= 0.5');
  });
  it('the engine never uses the historical PLO list to refuse a seat', () => {
    const source = readFileSync(resolve(REPO, 'server/src/services/HorsePloRoster.ts'), 'utf8');
    expect(source).toMatch(/export function ploRosterAllows[\s\S]*?\): boolean \{\s*return true;/);
  });
});

describe('scheduled hours remain authoritative for the full fleet', () => {
  it('does not bypass hours for ranked cash horses', () => {
    const source = readFileSync(resolve(REPO, 'server/src/services/HorseFleetManager.ts'), 'utf8');
    expect(source).toMatch(
      /let pool = sittable\.filter\(\s*\(h\) => isActiveNow\(h\.id, hourUTC\)/
    );
    expect(source).not.toContain('cashRosterAllows(h.id) === true || isActiveNow');
    expect(source).toContain('if (!humanNeedsRescue && isRestDayFor(st, chicagoWeekday))');
    expect(source).toContain('if (!humanNeedsRescue && dailyCapReached(st, todayKey))');
  });
});

describe('all cash cluster capacity is halved at the original opening decision', () => {
  it('includes feeders and retains a playable minimum without a second writer', () => {
    const body = flat(lastDefinition('fn_cash_cluster_tick').body);
    expect(body).toContain('v_table_cap := g.cap_mains + 1');
    expect(body).toContain('if g.allow_second_feeder then v_table_cap := v_table_cap + 1; end if;');
    expect(body).toContain('v_table_cap := greatest(1, floor(v_table_cap * 0.5)::integer)');
  });
});

it('native input edits select the existing required accounting qualification', () => {
  const selected = classifyChangedPaths(['scripts/qualification/test-cash-half-top-horses.py']);
  expect(selected.server).toBe(true);
  expect(selected.tests).toBe(true);
});

it('the selected cash roster cannot bypass the daily occupancy cap', () => {
  const source = readFileSync(resolve(REPO, 'server/src/services/HorseFleetManager.ts'), 'utf8');
  expect(source).not.toMatch(/!bankrollOnly\s*&&\s*!hostAllowsNewBody/);
  const executor = readFileSync(resolve(REPO, 'server/src/services/StableHandExecutor.ts'), 'utf8');
  expect(executor).not.toContain('!bankrollOnlyCashHorse(o.horseId)');
});

it('the existing daily refresh no longer restores the obsolete fifty-horse roster', () => {
  const migration = read(
    '20261026231712_halve_cash_capacity_and_rank_cash_horses_by_performance.sql'
  );
  expect(migration).toContain("command := 'select public.fn_ca_horse_roster_refresh()'");
  expect(migration).toContain("WHERE jobname='ca-horse-roster-refresh'");
  expect(migration).not.toContain('cron.schedule(');
});

it('limits the cash selection to Club Arena, keeping funded Diamond eligibility for all registered horses', () => {
  const G = flat(lastDefinition('fn_ca_horse_roster_seat_guard').body);
  expect(G).toContain("c.asset='diamonds'");
  expect(G).toContain('c.is_platform is true');
  expect(G).toContain('t.union_id is null');
  expect(G).toContain('c.union_id is null');
  expect(G).toContain('r.retired_at is null');
  expect(G).toContain("coalesce(p.horse_status,'available') <> 'disabled'");
  const manager = readFileSync(resolve(REPO, 'server/src/services/HorseFleetManager.ts'), 'utf8');
  const rotator = readFileSync(resolve(REPO, 'server/src/services/HorseSessionRotator.ts'), 'utf8');
  expect(manager).toContain('const bankrollOnly = cashRosterAllows(h.id, table) === true;');
  expect(manager).toContain('cashRosterAllows(h.id, table) === false');
  expect(rotator).toContain('cashRosterAllows(uid, t) === false');
  expect(rotator).toContain('arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id)');
  expect(rotator).toContain('benchedIds.has(uid) ||');
});
