import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cashRuleMedallions } from '../../src/components/lobby/lobbyEntries';

/**
 * NIT GAME — four columns the creation page wrote and nothing read.
 *
 * `nit_game`'s own tooltip in TableConfigPage says "Penalty for tight play",
 * and there was no penalty: no engine code, no SQL, no lobby chip ever touched
 * nit_game, career_percent_min, maintain_percent_min or maintain_hands.
 *
 * The rule now has two enforcers and one sign:
 *   the door      atomic_table_buyin -> NIT_GAME (career VPIP)
 *   between hands fn_nit_evictions, read by the dealing loop (table VPIP)
 *   the sign      this chip, which prints the actual thresholds
 *
 * These pin the sign and the wiring. The two enforcers were verified against
 * production inside rolled-back transactions; see the migration header.
 */

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the NIT GAME chip', () => {
  it('says nothing when the switch is off, whatever the numbers say', () => {
    // A table can carry stale numbers with the rule switched off. Advertising
    // them would promise a rule that will not fire.
    const rules = cashRuleMedallions({
      nit_game: false,
      career_percent_min: 25,
      maintain_percent_min: 20,
      maintain_hands: 30,
    });
    expect(rules.some((r) => r.key === 'nit_game')).toBe(false);
  });

  it('prints both thresholds when both are set', () => {
    const chip = cashRuleMedallions({
      nit_game: true,
      career_percent_min: 25,
      maintain_percent_min: 20,
      maintain_hands: 30,
    }).find((r) => r.key === 'nit_game');
    expect(chip?.label).toBe('NIT GAME');
    expect(chip?.detail).toBe('25% career / 20% here');
    expect(chip?.tip).toContain('career VPIP of 25%');
    expect(chip?.tip).toContain('under 20% VPIP over 30 hands');
  });

  it('prints only the threshold that is actually set', () => {
    const careerOnly = cashRuleMedallions({
      nit_game: true,
      career_percent_min: 15,
      maintain_percent_min: 0,
    }).find((r) => r.key === 'nit_game');
    expect(careerOnly?.detail).toBe('15% career');

    const maintainOnly = cashRuleMedallions({
      nit_game: true,
      career_percent_min: 0,
      maintain_percent_min: 18,
      maintain_hands: 40,
    }).find((r) => r.key === 'nit_game');
    expect(maintainOnly?.detail).toBe('18% here');
  });

  it('falls back to the plain claim when the switch is on but no number is', () => {
    const chip = cashRuleMedallions({ nit_game: true }).find((r) => r.key === 'nit_game');
    expect(chip?.detail).toBeUndefined();
    expect(chip?.tip).toBe('This table penalises tight play');
  });
});

describe('the rule is enforced where it can actually bite', () => {
  it('the engine asks the database, rather than counting VPIP a second time', () => {
    const svc = src('server/src/services/supabase/nitGame.ts');
    expect(svc).toContain('fn_nit_evictions');
    // A stats query that cannot answer must never remove a player from a live
    // game, so every failure path returns an empty list.
    expect(svc).toContain('return [];');
  });

  it('the eviction machinery it already had feeds the rule', () => {
    // MOVED 2026-08-25, and this test moved with it. The three eviction reasons
    // — sit-out timeout, away-blind cap, nit-game VPIP — used to live inline in
    // the dealing loop. They now live in ServerTableEngineBase.evictExpiredSitOuts,
    // because the dealing loop is NOT running in the case Dan reported: a table
    // below the minimum to deal parks in start()'s wait-for-players loop, so a
    // sitting-out player could hold the seat forever and no eviction rule of any
    // kind was consulted. The shared method is called from both loops, so this
    // rule now bites in strictly more places than it did.
    const evict = src('server/src/engine/ServerTableEngineBase.ts');
    expect(evict).toContain('collectNitEvictions');
    // Same atomicCashout + unregister path as sit-out and away-blind, with its
    // own reason on the seat_left event.
    expect(evict).toContain("'nit_game_vpip'");
    // Gated on the column: no round trip on a table without the rule.
    expect(evict).toContain('this.tableInfo?.nit_game === true');
    // And it is genuinely reachable from the loop that deals.
    const loop = src('server/src/engine/ServerTableEngineDealing.ts');
    expect(loop).toContain('evictExpiredSitOuts');
  });

  it('the engine is actually sent the column it gates on', () => {
    // The select list in loadTable is the whole contract: a column outside it
    // is undefined on tableInfo, so the gate above would never fire.
    const tables = src('server/src/services/supabase/tables.ts');
    expect(tables).toContain('nit_game');
    expect(tables).toContain('maintain_percent_min');
    expect(tables).toContain('maintain_hands');
    expect(tables).toContain('career_percent_min');
  });
});
