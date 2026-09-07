/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RAKE IS ATTRIBUTED ONCE, AT SETTLEMENT (Phase 6, 2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_settle_tournament_rake -> fn_attribute_tournament_rake credits the VIP,
 * the agent commission and the player_stats of EVERY tournament rake row when
 * the tournament settles (117,163 settlements, 587,261.01 of 592,171.58
 * lifetime tournament rake). That is the one door.
 *
 * RakebackSettlerService also walked every rake_records row with
 * player_contributions and credited agent commission and player_stats per
 * row. Spin books carry contributions, so every spin was paid twice: on
 * 2026-09-05, 6,753 spins carrying 38,922.72 of rake earned agents 23,263.81
 * here ('tournament_fee') AND 26,742.03 at settlement - 90,396.99 of
 * 'tournament_fee' commission in the week of 2026-08-31. The database trigger
 * had the same shape for VIP (20260907214446).
 *
 * The law: the per-row commission and player_stats paths in this service are
 * for cash rows only. A tournament row is left to settlement.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isTournamentRakeRow } from './RakebackSettlerService.js';

const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/services/RakebackSettlerService.ts'),
  'utf8'
);
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('tournament rake is attributed once, at settlement', () => {
  it('recognises a tournament row by either flag', () => {
    expect(isTournamentRakeRow({ is_tournament: true })).toBe(true);
    expect(isTournamentRakeRow({ tournament_id: '4b2e6b3e-0000-4000-8000-000000000001' })).toBe(
      true
    );
    expect(isTournamentRakeRow({ is_tournament: false, tournament_id: null })).toBe(false);
    expect(isTournamentRakeRow({})).toBe(false);
  });

  it('reads tournament_id as well as is_tournament from rake_records', () => {
    expect(code).toMatch(
      /'id, is_tournament, tournament_id, hand_id, club_id, rake_amount, player_contributions, rake_method, created_at'/
    );
  });

  it('never pays a per-row agent commission on a tournament row', () => {
    const loop = code.indexOf('const commissionItems');
    const push = code.indexOf('commissionItems.push(', loop);
    const gate = code.indexOf('if (isTournamentRakeRow(row))', loop);
    expect(loop).toBeGreaterThan(-1);
    expect(gate, 'the commission loop has no tournament gate').toBeGreaterThan(loop);
    expect(gate, 'the tournament gate sits after the push').toBeLessThan(push);
    expect(code, "the 'tournament_fee' commission source is the second payment").not.toMatch(
      /tournament_fee/
    );
  });

  it('never applies per-row player_stats for a tournament row', () => {
    const loop = code.indexOf('const statsItems');
    const push = code.indexOf('statsItems.push(', loop);
    const gate = code.indexOf('if (isTournamentRakeRow(row)) continue;', loop);
    expect(loop).toBeGreaterThan(-1);
    expect(gate, 'the player_stats loop has no tournament gate').toBeGreaterThan(loop);
    expect(gate).toBeLessThan(push);
  });

  it('leaves the rakeback basis alone - that is a policy question, not a double-pay', () => {
    // The buckets loop feeds fn_rakeback_recompute_periods. It must not be
    // gated here: which rake earns player rakeback is Dan's to decide.
    const buckets = code.indexOf('const buckets = new Map');
    const commission = code.indexOf('const commissionItems');
    const between = code.slice(buckets, commission);
    expect(between).not.toMatch(/isTournamentRakeRow/);
  });
});
