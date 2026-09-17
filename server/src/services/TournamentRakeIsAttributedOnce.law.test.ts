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
 * The law: this service submits only cash source identities to the canonical
 * authority and never applies a second set of stats. Tournament rows remain
 * owned by terminal settlement.
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

  it('excludes tournament rows before submitting canonical cash source identities', () => {
    const gate = code.indexOf('.filter((row) => !isTournamentRakeRow(row))');
    const identities = code.indexOf('const sourceIds = cashRows.map((row) => row.id)', gate);
    const dispatch = code.indexOf("supabase.rpc('fn_credit_agent_commissions_batch'", identities);
    expect(gate, 'canonical source dispatch has no tournament exclusion').toBeGreaterThan(-1);
    expect(identities).toBeGreaterThan(gate);
    expect(dispatch).toBeGreaterThan(identities);
    expect(code).toContain(
      "p_items: ids.map((id) => ({ source_type: 'cash_rake_record', source_id: id }))"
    );
    expect(code, "the 'tournament_fee' commission source is the second payment").not.toMatch(
      /tournament_fee/
    );
  });

  it('never applies per-row player_stats for a tournament row', () => {
    expect(code).not.toContain('fn_apply_rakeback_player_stats_batch');
    expect(code).not.toContain('statsItems');
    expect(code).not.toMatch(/from\('player_stats'\)\.(?:upsert|insert|update)/);
  });

  it('leaves the rakeback basis to canonical source accounting without a second calculation', () => {
    // This reader carries no player/amount override and cannot re-derive a
    // tournament or cash earning basis. A verified source receipt is required.
    expect(code).toContain('readCashSourceBatch(data, ids)');
    expect(code).not.toContain('fn_rakeback_recompute_periods');
    expect(code).not.toContain('sharesForRakeRecord');
  });
});
